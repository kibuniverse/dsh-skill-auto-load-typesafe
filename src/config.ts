/** Validated deployment settings for the TypeSafe skill selector. */
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'

const options = z.object({
  apiKeyEnv: z.literal('TYPESAFE_API_KEY').default('TYPESAFE_API_KEY'),
  baseURL: z.url().default('https://api.typesafe.ai'),
  model: z.string().trim().min(1).default('jev-latest'),
  threshold: z.number().min(0).max(1).default(0.75),
  maxSkills: z.number().int().min(1).max(100).default(3),
  timeoutMs: z.number().int().min(1).max(2147483647).default(5000),
  maxRetries: z.number().int().min(0).max(5).default(0),
  maxInputBytes: z.number().int().positive().default(65536),
  maxInjectedBytes: z.number().int().positive().default(32768),
  presetIds: z.array(z.string().min(1)).default(['standard']),
  onSelectionError: z.enum(['continue', 'fail']).default('continue'),
}).strict()

/** Fully defaulted settings used by the running plugin. */
export type Options = z.output<typeof options>
/** Optional settings accepted by the Loader. */
export type Config = z.input<typeof options>

/** Loader form; the resolver also validates direct in-process mounting. */
export const Config = schema.object({
  apiKeyEnv: schema.const('TYPESAFE_API_KEY').role('credential-ref').default('TYPESAFE_API_KEY'),
  baseURL: schema.string().default('https://api.typesafe.ai'),
  model: schema.string().default('jev-latest'),
  threshold: schema.number().min(0).max(1).default(0.75),
  maxSkills: schema.number().step(1).min(1).max(100).default(3),
  timeoutMs: schema.number().step(1).min(1).max(2147483647).default(5000),
  maxRetries: schema.number().step(1).min(0).max(5).default(0),
  maxInputBytes: schema.number().step(1).min(1).default(65536),
  maxInjectedBytes: schema.number().step(1).min(1).default(32768),
  presetIds: schema.array(schema.string()).default(['standard']),
  onSelectionError: schema.union(['continue', 'fail']).default('continue'),
})

/** Resolve deployment settings; plaintext HTTP is allowed only on loopback for local tests. */
export function resolveConfig(input: Config): Options {
  const resolved = options.parse(input)
  const url = new URL(resolved.baseURL)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('baseURL must use HTTPS (or loopback HTTP), without credentials, query or fragment')
  }
  return resolved
}
