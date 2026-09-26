/** Host plugin that preloads skills through independent TypeSafe AI decisions. */
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Config, resolveConfig } from './config.js'
import { auditSpec } from './audit.js'
import { preload } from './preload.js'

export { Config } from './config.js'
/** Loader diagnostic name. */
export const name = 'skill-auto-load-typesafe'
/** The default base profile supplies these services; no Harness LLM adapter is used. */
export const inject = ['agents', 'skills', 'credentials', 'storageDomain']

/** Mount one host-wide instance. presetIds controls which Agents invoke TypeSafe. */
export async function apply(ctx: Context, input: Config = {}): Promise<void> {
  const config = resolveConfig(input)
  const domain = await ctx.storageDomain.open(auditSpec)
  const shutdown = new AbortController()
  const pending = new Set<Promise<PreStepDecision>>()
  ctx.effect(() => async () => {
    shutdown.abort(new Error('TypeSafe skill plugin unloaded'))
    await Promise.allSettled([...pending])
    await domain.close()
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const operation = (async (): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      signal.throwIfAborted()
      shutdown.signal.throwIfAborted()
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(new Error('TypeSafe skill selection deadline exceeded')), config.timeoutMs)
      const combined = AbortSignal.any([signal, shutdown.signal, deadline.signal])
      try {
        return await preload(ctx, config, (id, record) => domain.table('requests').put(id, record), agent, decision, combined)
      } catch (error) {
        signal.throwIfAborted()
        shutdown.signal.throwIfAborted()
        if (deadline.signal.aborted && error === deadline.signal.reason && config.onSelectionError === 'continue') {
          ctx.logger.warn('TypeSafe skill selection skipped: deadline exceeded')
          return decision
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    })()
    pending.add(operation)
    try {
      return await operation
    } finally {
      pending.delete(operation)
    }
  }, { prepend: true })
}
