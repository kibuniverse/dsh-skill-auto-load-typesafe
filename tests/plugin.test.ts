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
import { auditSpec } from '../src/audit.js'
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
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

it('an overall deadline continues the accepted step without injected skills', async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    started()
  })))
  await ctx.plugin(plugin, { timeoutMs: 100 })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const operation = dispatch()
  await ready
  await vi.advanceTimersByTimeAsync(100)
  const result = await operation
  expect(result.kind === 'enter' && result.messages.length).toBe(1)
  expect(result.kind === 'enter' && result.startsRequestSeries).toBe(true)
})
