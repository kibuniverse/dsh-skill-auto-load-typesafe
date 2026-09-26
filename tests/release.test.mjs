import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { analyzeCommits } from '@semantic-release/commit-analyzer'
import { generateNotes } from '@semantic-release/release-notes-generator'
import config from '../release.config.mjs'

const logger = { log() {} }
const analyzerOptions = config.plugins.find(([name]) => name === '@semantic-release/commit-analyzer')[1]
const notesOptions = config.plugins.find(([name]) => name === '@semantic-release/release-notes-generator')[1]
const commits = messages => messages.map((message, index) => ({
  hash: String(index + 1).padStart(40, '0'), message,
}))

describe('automatic release policy', () => {
  it('uses the exact official registry URL required by the npm plugin OIDC check', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.publishConfig.registry).toBe('https://registry.npmjs.org/')
  })
  it.each([
    [['fix: handle missing skills'], 'patch'],
    [['perf: reduce selection overhead'], 'patch'],
    [['feat: add preset selection'], 'minor'],
    [['feat!: change configuration format'], 'major'],
    [['refactor: change config\n\nBREAKING CHANGE: the old config is unsupported'], 'major'],
    [['docs: clarify setup', 'ci: automate releases', 'chore: update dependencies'], null],
    [['fix: repair loading', 'feat: add presets'], 'minor'],
  ])('analyzes %j as %s', async (messages, expected) => {
    expect(await analyzeCommits(analyzerOptions, {
      cwd: process.cwd(), commits: commits(messages), logger,
    })).toBe(expected)
  })

  it('generates notes for the computed release', async () => {
    const notes = await generateNotes(notesOptions, {
      cwd: process.cwd(), logger,
      options: { repositoryUrl: 'https://github.com/kibuniverse/dsh-skill-auto-load-typesafe.git' },
      lastRelease: { version: '0.0.5', gitTag: 'v0.0.5' },
      nextRelease: { version: '0.0.6', gitTag: 'v0.0.6' },
      commits: commits(['fix: handle missing skills']),
    })
    expect(notes).toContain('0.0.6')
    expect(notes).toContain('handle missing skills')
  })
})
