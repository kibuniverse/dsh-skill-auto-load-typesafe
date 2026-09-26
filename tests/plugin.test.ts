import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as plugin from '../src/index.js'
import { auditSpec, type AuditRecord } from '../src/audit.js'
import { answer, Credentials, makeAgent, user } from './helpers.js'

let ctx: Context
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typesafe-plugin-test-'))
  ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(Credentials)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.skills.register({ name: 'review', description: 'Review code', content: 'Read the diff.', source: 'runtime' })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

it.each([401, 403, 400, 422])('preserves HTTP %s failures when audit writing crosses the deadline', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'private provider details' }, { status })))
  const open = vi.spyOn(ctx.storageDomain, 'open')
  await ctx.plugin(plugin, { timeoutMs: 100 })
  const domain = await open.mock.results[0]!.value
  const table = domain.table('requests')
  const put = table.put.bind(table)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(table, 'put').mockImplementation(async (id, record) => {
    if ((record as AuditRecord).status === 'failed') await vi.advanceTimersByTimeAsync(100)
    await put(id, record)
  })
  await expect(dispatch()).rejects.toThrow('configuration-or-authentication')
})

it('does not hide an audit failure just because the deadline has elapsed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(answer([0.9]))))
  const open = vi.spyOn(ctx.storageDomain, 'open')
  await ctx.plugin(plugin, { timeoutMs: 100 })
  const domain = await open.mock.results[0]!.value
  const table = domain.table('requests')
  const put = table.put.bind(table)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(table, 'put').mockImplementation(async (id, record) => {
    if ((record as AuditRecord).status === 'completed') {
      await vi.advanceTimersByTimeAsync(100)
      throw new Error('audit storage unavailable')
    }
    await put(id, record)
  })
  await expect(dispatch()).rejects.toThrow('audit storage unavailable')
})

function dispatch(signal = new AbortController().signal) {
  const agent = makeAgent(ctx)
  const messages = [user()]
  return agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal },
    async (): Promise<PreStepDecision> => ({ kind: 'enter', messages, startsRequestSeries: true }))
}

it('mounts through Cordis, persists audit data and releases its domain on unload', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(answer([0.9]))))
  const fiber = ctx.plugin(plugin)
  await fiber
  const result = await dispatch()
  expect(result.kind === 'enter' && result.messages.length).toBe(2)
  if (result.kind !== 'enter') throw new Error('expected entry')
  const source = result.messages[1]!.source
  if (source.kind !== 'skill-auto-load-typesafe') throw new Error('expected injection')
  await fiber.dispose()
  const reopened = await ctx.storageDomain.open(auditSpec)
  expect(reopened.table('requests').get(source.requestId)?.loaded).toEqual(['review'])
  await reopened.close()
  const after = await dispatch()
  expect(after.kind === 'enter' && after.messages.length).toBe(1)
})

it('unloading aborts in-flight SDK work and waits before closing audit storage', async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let aborted = false
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => { aborted = true; reject(init.signal!.reason) }, { once: true })
    started()
  })))
  const fiber = ctx.plugin(plugin)
  await fiber
  const operation = dispatch().then(() => 'unexpected-success', () => 'aborted')
  await ready
  await fiber.dispose()
  expect(aborted).toBe(true)
  expect(await operation).toBe('aborted')
  const reopened = await ctx.storageDomain.open(auditSpec)
  await reopened.close()
})

it.each(['continue', 'fail'] as const)('handles an overall deadline with onSelectionError=%s', async onSelectionError => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    started()
  })))
  await ctx.plugin(plugin, { timeoutMs: 100, onSelectionError })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const operation = dispatch()
  const outcome = onSelectionError === 'fail'
    ? expect(operation).rejects.toThrow('deadline exceeded')
    : operation.then(result => {
      expect(result.kind === 'enter' && result.messages.length).toBe(1)
      expect(result.kind === 'enter' && result.startsRequestSeries).toBe(true)
    })
  await ready
  await vi.advanceTimersByTimeAsync(100)
  await outcome
})
