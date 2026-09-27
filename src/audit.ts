/** Durable TypeSafe request receipts stored outside the Session event vocabulary. */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const record = z.object({
  sessionId: z.string(),
  messageIds: z.array(z.string()),
  startedAt: z.number(),
  endpoint: z.string(),
  request: z.json(),
  /** UTF-8 byte size of the JSON request object before SDK dispatch. */
  requestBytes: z.number().int().nonnegative().optional(),
  /** Number of skill candidates represented by the request. */
  catalogSize: z.number().int().nonnegative().optional(),
  status: z.enum(['started', 'completed', 'failed', 'aborted']),
  finishedAt: z.number().optional(),
  response: z.json().optional(),
  selected: z.array(z.string()).optional(),
  loaded: z.array(z.string()).optional(),
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })).optional(),
  failure: z.string().optional(),
})

/** One request receipt; no SDK errors, headers or credentials are stored. */
export type AuditRecord = z.infer<typeof record>
/** Audit writer used by the orchestration and its tests. */
export type WriteAudit = (id: string, record: AuditRecord) => Promise<void>

/** One host-mounted plugin owns this domain and closes it on unload. */
export const auditSpec = defineDomain({
  name: 'skill_auto_load_typesafe',
  version: 1,
  layout: 'per-record',
  tables: { requests: domainTable(record) },
})
