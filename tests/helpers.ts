import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** In-memory credential provider; unused record operations have no stored values. */
export class Credentials extends CredentialProvider {
  key: string | undefined = 'test-secret'
  async resolve() { return this.key ? { value: this.key, source: 'test' } : undefined }
  async describe() { return { configured: !!this.key, writable: true } }
  async set(_ref: string, value: string) { this.key = value }
  async unset() { this.key = undefined }
  async readRecord() { return undefined }
  async describeRecord() { return { configured: false, writable: true } }
  async listRecords() { return [] }
  async modifyRecord() { return undefined }
  async deleteRecord() {}
}

function unsupported(): never { throw new Error('This fixture does not drive an Agent loop') }

export function makeAgent(ctx: Context, preset = 'standard'): Agent {
  const id = SessionId(randomUUID())
  return {
    id, ctx, options: {}, status: 'idle',
    session: Session.create(id, [], {
      version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: '/tmp', isSeeded: false, agentPreset: preset,
    }),
    inbox: { nextTurn: [], nextStep: [], clear: unsupported, append: unsupported, prepend: unsupported,
      replace: unsupported, remove: unsupported, splice: unsupported },
    send: unsupported, followup: unsupported, steer: unsupported, inject: unsupported,
    cancel: unsupported, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
  }
}

export function user(text = 'Review the code and its tests') {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

export function answer(probabilities: number[]) {
  return {
    model: 'test-model',
    answers: Object.fromEntries(probabilities.map((noul, index) => [`skill_${index}`, { type: 'noul', noul }])),
    usage: { input_tokens: 10, output_tokens: probabilities.length },
  }
}
