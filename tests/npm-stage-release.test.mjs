import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const run = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(() => {}, { [promisify.custom]: run }) }
})

import { publish, verifyConditions } from '../scripts/npm-stage-release.mjs'
import config from '../release.config.mjs'

let cwd
let context
const name = 'dsh-skill-auto-load-typesafe'

beforeEach(async () => {
  run.mockReset()
  cwd = await mkdtemp(resolve(tmpdir(), 'dsh-stage-test-'))
  await mkdir(resolve(cwd, '.release'))
  await writeFile(resolve(cwd, 'package.json'), JSON.stringify({ name, version: '0.0.7' }))
  context = {
    cwd, env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test' },
    stderr: { write: vi.fn() }, logger: { log: vi.fn() }, nextRelease: { version: '0.0.7', channel: null },
  }
})
afterEach(async () => { await rm(cwd, { recursive: true, force: true }) })

describe('npm staging release', () => {
  it('disables direct publishing and stages before the GitHub release', () => {
    expect(config.plugins).toContainEqual(['@semantic-release/npm', { npmPublish: false, tarballDir: '.release' }])
    expect(config.plugins.indexOf('./scripts/npm-stage-release.mjs'))
      .toBeLessThan(config.plugins.findIndex(p => p[0] === '@semantic-release/github'))
  })

  it('rejects missing OIDC before tagging', async () => {
    context.env = {}
    await expect(verifyConditions({}, context)).rejects.toThrow('id-token: write')
    expect(run).not.toHaveBeenCalled()
  })

  it('checks the pinned CLI', async () => {
    run.mockResolvedValue({ stdout: '11.20.0\n', stderr: '' })
    await verifyConditions({}, context)
    run.mockResolvedValue({ stdout: '10.9.4\n', stderr: '' })
    await expect(verifyConditions({}, context)).rejects.toThrow('Expected pinned npm')
  })

  it.each([null, 'rc', 'beta', 'next'])('stages %s with an explicit tarball and records the receipt', async channel => {
    const version = channel ? `0.0.7-${channel}.1` : '0.0.7'
    context.nextRelease = { version, channel }
    context.env.GITHUB_STEP_SUMMARY = resolve(cwd, 'summary.md')
    await writeFile(resolve(cwd, 'package.json'), JSON.stringify({ name, version }))
    run.mockResolvedValue({ stdout: JSON.stringify({ [name]: { name, version, stageId: 'stage-123' } }), stderr: '' })
    const result = await publish({}, context)
    const args = run.mock.calls[0][1]
    expect(args.slice(1, 4)).toEqual(['stage', 'publish', resolve(cwd, '.release', `${name}-${version}.tgz`)])
    expect(args.slice(-2)).toEqual(['--tag', channel || 'latest'])
    expect(args).toContain('--ignore-scripts')
    expect(result.stageId).toBe('stage-123')
    expect(JSON.parse(await readFile(resolve(cwd, '.release/staging.json'), 'utf8')))
      .toEqual({ name, version, stageId: 'stage-123', distTag: channel || 'latest' })
    expect(await readFile(context.env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('stage-123')
  })

  it.each([
    { name, version: '0.0.7' },
    { name, version: '0.0.6', stageId: 'stage-123' },
    { name: 'wrong-package', version: '0.0.7', stageId: 'stage-123' },
  ])('fails on a missing or mismatched staging receipt: %j', async receipt => {
    run.mockResolvedValue({ stdout: JSON.stringify(receipt), stderr: '' })
    await expect(publish({}, context)).rejects.toThrow('stageId')
    await expect(readFile(resolve(cwd, '.release/staging.json'))).rejects.toThrow()
  })

  it('fails on npm command errors', async () => {
    run.mockRejectedValue(Object.assign(new Error('npm failed'), { stderr: 'E403' }))
    await expect(publish({}, context)).rejects.toThrow('npm failed')
    expect(context.stderr.write).toHaveBeenCalledWith('E403')
  })

  it('refuses to upload the development baseline version', async () => {
    await writeFile(resolve(cwd, 'package.json'), JSON.stringify({ name, version: '0.0.5' }))
    await expect(publish({}, context)).rejects.toThrow('Prepared package version')
    expect(run).not.toHaveBeenCalled()
  })
})
