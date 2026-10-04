import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { preload } from '../src/preload.js'
import { resolveConfig } from '../src/config.js'
import type { AuditRecord } from '../src/audit.js'
import { answer, Credentials, makeAgent, user } from './helpers.js'

let ctx: Context
let records: AuditRecord[]
const signal = () => new AbortController().signal
const config = resolveConfig({})
const audit = async (_id: string, record: AuditRecord) => { records.push(structuredClone(record)) }

beforeEach(async () => {
  ctx = new Context()
  records = []
  await ctx.plugin(Credentials)
  await ctx.plugin(SkillRegistry)
  ctx.skills.register({ name: 'review', description: 'Code review', source: 'runtime', content: 'Review carefully.',
    resourceBase: { kind: 'directory', path: '/skills/review' } })
})
afterEach(async () => { await ctx.fiber.dispose(); vi.unstubAllGlobals() })

function reply(values: number[]) {
  const fetch = vi.fn(async () => Response.json(answer(values)))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('skill preloading', () => {
  it.each(['already-visible', 'unavailable', 'content-budget'])('fills the loading cap after skipping a %s skill', async reason => {
    ctx.skills.register({ name: 'tests', description: 'Write tests', source: 'runtime', content: 'Test carefully.' })
    ctx.skills.register({ name: 'slides', description: 'Make slides', source: 'runtime', content: 'Make slides.' })
    const agent = makeAgent(ctx)
    const lookup = { cwd: agent.session.header.cwd, scope: agent, signal: signal() }
    const review = (await ctx.skills.get('review', lookup))!
    const tests = (await ctx.skills.get('tests', lookup))!
    const snapshot = await ctx.skills.snapshot(lookup)
    reply(snapshot.skills.map(skill => skill.name === 'review' ? 0.99 : skill.name === 'tests' ? 0.9 : 0.8))
    if (reason === 'already-visible') {
      // Plain visible text exercises the post-selection safety net; skill-sourced
      // blocks are deduplicated before the request (covered by the test below).
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(review) }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    const get = vi.spyOn(ctx.skills, 'get')
    if (reason === 'unavailable') get.mockResolvedValueOnce(undefined)
    if (reason === 'content-budget') get.mockResolvedValueOnce({ ...review, content: 'x'.repeat(10000) })
    const options = resolveConfig({ maxSkills: 1, maxInjectedBytes: Buffer.byteLength(renderSkillContent(tests), 'utf8') })
    const result = await preload(ctx, options, audit, agent, { kind: 'enter', messages: [user()] }, signal())
    expect(result.kind === 'enter' && result.messages.length).toBe(2)
    expect(records.at(-1)).toMatchObject({ loaded: ['tests'], skipped: [{ name: 'review', reason }] })
    expect(get).toHaveBeenCalledTimes(2)
    get.mockRestore()
  })

  it.each(['started', 'completed', 'failed'] as const)('propagates an audit write failure at %s', async status => {
    const fetch = status === 'failed'
      ? vi.fn(async () => Response.json({}, { status: 503 }))
      : reply([0.9])
    vi.stubGlobal('fetch', fetch)
    const failure = new Error('audit storage unavailable')
    const write = async (id: string, record: AuditRecord) => {
      if (record.status === status) throw failure
      await audit(id, record)
    }
    const decision: PreStepDecision = { kind: 'enter', messages: [user()] }
    await expect(preload(ctx, config, write, makeAgent(ctx), decision, signal())).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledTimes(status === 'started' ? 0 : 1)
    expect(decision.messages).toHaveLength(1)
  })

  it('records and propagates a skill read failure without partially injecting messages', async () => {
    reply([0.9])
    const failure = new Error('skill read failed')
    const get = vi.spyOn(ctx.skills, 'get').mockRejectedValue(failure)
    const decision: PreStepDecision = { kind: 'enter', messages: [user()] }
    await expect(preload(ctx, config, audit, makeAgent(ctx), decision, signal())).rejects.toBe(failure)
    expect(records.at(-1)).toMatchObject({ status: 'failed', failure: 'skill-loading-failed' })
    expect(decision.messages).toHaveLength(1)
    get.mockRestore()
  })

  it('calls the real SDK, audits before dispatch and preserves the pre-step decision', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(records[0]?.status).toBe('started')
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-secret')
      expect(JSON.parse(String(init.body)).questions.skill_0.type).toBe('noul')
      return Response.json(answer([0.95]))
    })
    vi.stubGlobal('fetch', fetch)
    const agent = makeAgent(ctx)
    const input = user()
    const result = await preload(ctx, config, audit, agent, { kind: 'enter', messages: [input], startsRequestSeries: true }, signal())
    expect(result.kind).toBe('enter')
    if (result.kind !== 'enter') throw new Error('expected entry')
    expect(result.startsRequestSeries).toBe(true)
    expect(result.messages[0]).toBe(input)
    expect(result.messages[1]?.content).toEqual([{ type: 'text', text: expect.stringContaining('/skills/review') }])
    expect(records.at(-1)?.loaded).toEqual(['review'])
    expect(JSON.stringify(records)).not.toContain('test-secret')

    // The same standard message survives Session replay without a custom event type.
    for (const message of result.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    const restored = Session.create(agent.session.id, agent.session.snapshotEvents(), agent.session.header)
    expect(restored.deriveMessages()).toEqual(agent.session.deriveMessages())
  })

  it('resolves skills using the requesting Agent scope', async () => {
    const agent = makeAgent(ctx)
    const scope = createScope(ctx, agent)
    await scope.ctx.inject(['skills'], ctx => {
      ctx.skills.register({ name: 'review', description: 'Scoped review', source: 'runtime', content: 'Scoped instructions' })
    })
    reply([0.9])
    const result = await preload(ctx, config, audit, agent, { kind: 'enter', messages: [user()] }, signal())
    expect(JSON.stringify(result)).toContain('Scoped instructions')
    expect(JSON.stringify(result)).not.toContain('Review carefully.')
    await scope.dispose()
  })

  it('excludes user-only skills and explicit slash invocations', async () => {
    ctx.skills.register({ name: 'private', description: 'User-only', source: 'runtime', content: 'Do not auto-load',
      invocation: { modelInvocable: false, userInvocable: true } })
    const fetch = reply([0.9])
    const decision: PreStepDecision = { kind: 'enter', messages: [user('/review please')] }
    expect(await preload(ctx, config, audit, makeAgent(ctx), decision, signal())).toBe(decision)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not call TypeSafe for rejected, continuation-only or unselected-preset steps', async () => {
    const fetch = reply([0.9])
    const agent = makeAgent(ctx)
    await preload(ctx, config, audit, agent, { kind: 'reject' }, signal())
    await preload(ctx, config, audit, agent, { kind: 'enter', messages: [] }, signal())
    await preload(ctx, config, audit, makeAgent(ctx, 'minimal'), { kind: 'enter', messages: [user()] }, signal())
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rechecks loaded invocation policy after discovery', async () => {
    const get = vi.spyOn(ctx.skills, 'get')
    get.mockResolvedValue({ name: 'review', description: 'Review', source: 'runtime', provider: 'runtime', content: 'Hidden',
      invocation: { modelInvocable: false, userInvocable: true } })
    reply([0.9])
    const decision: PreStepDecision = { kind: 'enter', messages: [user()] }
    expect(await preload(ctx, config, audit, makeAgent(ctx), decision, signal())).toBe(decision)
    expect(records.at(-1)?.skipped).toEqual([{ name: 'review', reason: 'unavailable' }])
    get.mockRestore()
  })

  it('skips a redundant selection request for visible skills, but reloads for a fresh history', async () => {
    const fetch = reply([0.9])
    const agent = makeAgent(ctx)
    const decision: PreStepDecision = { kind: 'enter', messages: [user()] }
    const first = await preload(ctx, config, audit, agent, decision, signal())
    if (first.kind !== 'enter') throw new Error('expected entry')
    for (const message of first.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    const next: PreStepDecision = { kind: 'enter', messages: [user('Review again')] }
    expect(await preload(ctx, config, audit, agent, next, signal())).toBe(next)
    // Deduplication happens before the request: no second paid call, no new audit record.
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(records.at(-1)?.loaded).toEqual(['review'])
    const fresh = await preload(ctx, config, audit, makeAgent(ctx), next, signal())
    expect(fresh.kind === 'enter' && fresh.messages.length).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps skills whole when the injection budget is insufficient', async () => {
    reply([0.9])
    const decision: PreStepDecision = { kind: 'enter', messages: [user()] }
    expect(await preload(ctx, resolveConfig({ maxInjectedBytes: 1 }), audit, makeAgent(ctx), decision, signal())).toBe(decision)
    expect(records.at(-1)?.skipped?.[0]?.reason).toBe('content-budget')
  })

  it('does not repeat an explicit instruction block returned by another listener', async () => {
    const fetch = reply([0.9])
    const explicit = createUserMessage({ content: [{ type: 'text', text: 'Instructions' }],
      source: { kind: 'skill-invocation', name: 'review', form: 'instructions' } })
    await preload(ctx, config, audit, makeAgent(ctx), { kind: 'enter', messages: [user(), explicit] }, signal())
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails clearly for a missing key and never sends a network request', async () => {
    await ctx.credentials.unset(credentialRef('TYPESAFE_API_KEY'))
    const fetch = reply([0.9])
    await expect(preload(ctx, config, audit, makeAgent(ctx), { kind: 'enter', messages: [user()] }, signal())).rejects.toThrow('TYPESAFE_API_KEY')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('contains temporary failures without exposing provider error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'secret echo' }, { status: 503 })))
    const decision: PreStepDecision = { kind: 'enter', messages: [user()] }
    expect(await preload(ctx, config, audit, makeAgent(ctx), decision, signal())).toBe(decision)
    expect(records.at(-1)?.status).toBe('failed')
    expect(JSON.stringify(records)).not.toContain('secret echo')
  })

  it('does not downgrade authentication failures to an empty selection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'bad key' }, { status: 401 })))
    await expect(preload(ctx, config, audit, makeAgent(ctx), { kind: 'enter', messages: [user()] }, signal())).rejects.toThrow('authentication')
  })

  it('propagates caller cancellation and records an aborted request', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(new Error('user stopped')); throw controller.signal.reason }))
    await expect(preload(ctx, config, audit, makeAgent(ctx), { kind: 'enter', messages: [user()] }, controller.signal)).rejects.toThrow('user stopped')
    expect(records.at(-1)?.status).toBe('aborted')
  })

  it('skips incomplete catalogs without calling TypeSafe', async () => {
    const snapshot = vi.spyOn(ctx.skills, 'snapshot').mockResolvedValue({ skills: [], complete: false })
    const fetch = reply([0.9])
    const decision: PreStepDecision = { kind: 'enter', messages: [user()] }
    expect(await preload(ctx, config, audit, makeAgent(ctx), decision, signal())).toBe(decision)
    expect(fetch).not.toHaveBeenCalled()
    snapshot.mockRestore()
  })

  it('re-resolves a rotated key for the next request', async () => {
    const headers: (string | null)[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      headers.push(new Headers(init.headers).get('Authorization'))
      return Response.json(answer([0.9]))
    }))
    const decision: PreStepDecision = { kind: 'enter', messages: [user()] }
    await preload(ctx, config, audit, makeAgent(ctx), decision, signal())
    await ctx.credentials.set(credentialRef('TYPESAFE_API_KEY'), 'rotated-key')
    await preload(ctx, config, audit, makeAgent(ctx), decision, signal())
    expect(headers).toEqual(['Bearer test-secret', 'Bearer rotated-key'])
  })

  it('rejects malformed SDK answers and applies the configured failure mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ answers: { arbitrary: 'bad' } })))
    const decision: PreStepDecision = { kind: 'enter', messages: [user()] }
    expect(await preload(ctx, config, audit, makeAgent(ctx), decision, signal())).toBe(decision)
    await expect(preload(ctx, resolveConfig({ onSelectionError: 'fail' }), audit, makeAgent(ctx), decision, signal())).rejects.toThrow('selection-failed')
  })
})
