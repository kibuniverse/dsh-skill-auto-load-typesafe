import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { buildRequest, parseSelection } from '../src/selector.js'
import { answer } from './helpers.js'

const config = resolveConfig({ maxSkills: 2 })
const candidates = ['review', 'tests', 'slides'].map(name => ({ name, description: name, whenToUse: '' }))

describe('TypeSafe selection', () => {
  it('builds independent Noul questions and permits no relevant skill', () => {
    const request = buildRequest('Hello', candidates, config)!
    expect(Object.values(request.questions).map(q => q.type)).toEqual(['noul', 'noul', 'noul'])
    expect(parseSelection(answer([0.1, 0.2, 0.3]), candidates, config).selected).toEqual([])
    expect(buildRequest('Hello', [], config)).toBeNull()
  })

  it('ranks all skills above the threshold so skipped skills do not consume the loading cap', () => {
    expect(parseSelection(answer([0.8, 0.99, 0.9]), candidates, config).selected).toEqual([
      { name: 'tests', probability: 0.99 }, { name: 'slides', probability: 0.9 },
      { name: 'review', probability: 0.8 },
    ])
  })

  it.each([-1, 1.1, NaN, Infinity])('rejects invalid wire probability %s', probability => {
    expect(() => parseSelection(answer([probability, 0.1, 0.1]), candidates, config)).toThrow()
  })

  it('rejects missing and unexpected answer IDs', () => {
    expect(() => parseSelection(answer([0.9]), candidates, config)).toThrow()
    const raw = answer([0.9, 0.1, 0.1])
    delete raw.answers.skill_0
    raw.answers.unknown = { type: 'noul', noul: 1 }
    expect(() => parseSelection(raw, candidates, config)).toThrow(/omitted/)
  })

  it('bounds the complete request in bytes without silently truncating candidates', () => {
    expect(() => buildRequest('任务'.repeat(100), candidates, resolveConfig({ maxInputBytes: 50 }))).toThrow(/maxInputBytes/)
  })

  it('validates config and allows only HTTPS or local HTTP endpoints', () => {
    expect(() => resolveConfig({ threshold: 2 })).toThrow()
    expect(() => resolveConfig({ maxSkills: 0 })).toThrow()
    expect(() => resolveConfig({ baseURL: 'http://example.com' })).toThrow()
    expect(() => resolveConfig({ baseURL: 'https://user:secret@example.com' })).toThrow()
    expect(resolveConfig({ baseURL: 'http://127.0.0.1:9999' }).baseURL).toContain('127.0.0.1')
  })
})
