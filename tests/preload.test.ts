import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
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

  it('does not duplicate currently visible instructions, but reloads for a fresh history', async () => {
    reply([0.9])
    const agent = makeAgent(ctx)
    const decision: PreStepDecision = { kind: 'enter', messages: [user()] }
    const first = await preload(ctx, config, audit, agent, decision, signal())
    if (first.kind !== 'enter') throw new Error('expected entry')
    for (const message of first.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    const next: PreStepDecision = { kind: 'enter', messages: [user('Review again')] }
    expect(await preload(ctx, config, audit, agent, next, signal())).toBe(next)
    expect(records.at(-1)?.skipped?.[0]?.reason).toBe('already-visible')
    const fresh = await preload(ctx, config, audit, makeAgent(ctx), next, signal())
    expect(fresh.kind === 'enter' && fresh.messages.length).toBe(2)
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
