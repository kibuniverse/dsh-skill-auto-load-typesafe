/** Select and inject skills into an accepted step without mutating prior history. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { isModelInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import { AuthenticationError, PermissionDeniedError, BadRequestError, UnprocessableEntityError } from '@typesafe-ai/sdk'
import { z } from 'zod'
import type { Options } from './config.js'
import type { AuditRecord, WriteAudit } from './audit.js'
import { buildRequest, parseSelection, requestSelection, type Candidate } from './selector.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-auto-load-typesafe': {
      kind: 'skill-auto-load-typesafe'
      form: 'instructions'
      name: string
      requestId: string
    }
  }
}

/** Only the services consumed by this operation. */
export type PreloadServices = Pick<Context, 'skills' | 'credentials' | 'logger'>
/** Identity and history required by skill lookup and injection. */
export type PreloadAgent = Pick<Agent, 'id' | 'session'>

/** Execute one accepted input batch; all external work uses the supplied cancellation signal. */
export async function preload(
  ctx: PreloadServices,
  config: Options,
  audit: WriteAudit,
  agent: PreloadAgent,
  decision: PreStepDecision,
  signal: AbortSignal,
): Promise<PreStepDecision> {
  if (decision.kind === 'reject') return decision
  const preset = agent.session.header.agentPreset
  if (config.presetIds.length && (!preset || !config.presetIds.includes(preset))) return decision
  const users = decision.messages.filter(message => message.source.kind === 'user')
  if (!users.length) return decision
  const userInput = users.flatMap(message => message.content)
    .filter(block => block.type === 'text').map(block => block.text).join('\n\n')
  if (!userInput.trim()) return decision
  signal.throwIfAborted()

  const lookup = { cwd: agent.session.header.cwd, scope: agent, signal }
  const snapshot = await ctx.skills.snapshot(lookup)
  signal.throwIfAborted()
  if (!snapshot.complete) {
    ctx.logger.warn('TypeSafe skill selection skipped: incomplete skill catalog')
    return decision
  }
  // Explicit gestures belong to tool-skill, even if its listener wraps this one.
  const explicit = new Set(Array.from(userInput.matchAll(/(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g), match => match[1]))
  const existingMessages = [...agent.session.deriveMessages(), ...decision.messages]
  const visibleTexts = new Set(existingMessages
    .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text))
  const previouslyLoaded = new Set(existingMessages.flatMap(message => {
    const source = message.source
    return source.kind === 'skill-invocation' || source.kind === 'skill-auto-load-typesafe' ? [source.name] : []
  }))
  const alreadyAdded = new Set(decision.messages.flatMap(message => {
    const source = message.source
    return source.kind === 'skill-invocation' || source.kind === 'skill-auto-load-typesafe' ? [source.name] : []
  }))
  const candidates: Candidate[] = []
  for (const skill of snapshot.skills.filter(isModelInvocable)) {
    if (explicit.has(skill.name) || alreadyAdded.has(skill.name)) continue
    if (previouslyLoaded.has(skill.name)) {
      // Keep the existing reload-on-content-change behavior while avoiding a paid
      // selection request when the current version is already visible in history.
      const current = await (async () => {
        try {
          return await ctx.skills.get(skill.name, lookup)
        } catch {
          // If this optional deduplication lookup fails, retain the candidate and let
          // the normal selection/loading path determine whether the skill is needed.
          signal.throwIfAborted()
          ctx.logger.warn('TypeSafe skill deduplication skipped: skill lookup failed')
          return undefined
        }
      })()
      signal.throwIfAborted()
      if (current && isModelInvocable(current) && visibleTexts.has(renderSkillContent(current))) continue
    }
    candidates.push({ name: skill.name, description: skill.description, whenToUse: skill.whenToUse ?? '' })
  }
  const request = buildRequest(userInput, candidates, config)
  if (!request) return decision

  const credential = await ctx.credentials.resolve(credentialRef(config.apiKeyEnv))
  signal.throwIfAborted()
  if (!credential?.value.trim()) throw new Error('Configure TYPESAFE_API_KEY to enable automatic skill loading')
  const requestId = randomUUID()
  const receipt: AuditRecord = {
    sessionId: agent.session.id,
    messageIds: users.map(message => message.id),
    startedAt: Date.now(),
    endpoint: config.baseURL,
    request: z.json().parse(JSON.parse(JSON.stringify(request))),
    requestBytes: Buffer.byteLength(JSON.stringify(request), 'utf8'),
    catalogSize: candidates.length,
    status: 'started',
  }
  await audit(requestId, receipt)

  let result: ReturnType<typeof parseSelection>
  try {
    signal.throwIfAborted()
    const raw = await requestSelection(request, credential.value, config, signal)
    signal.throwIfAborted()
    result = parseSelection(raw, candidates, config)
  } catch (error) {
    const fatal = error instanceof AuthenticationError || error instanceof PermissionDeniedError
      || error instanceof BadRequestError || error instanceof UnprocessableEntityError
    const failure = fatal ? 'configuration-or-authentication' : signal.aborted ? 'cancelled-or-deadline' : 'selection-failed'
    await audit(requestId, { ...receipt, status: !fatal && signal.aborted ? 'aborted' : 'failed', finishedAt: Date.now(), failure })
    // SDK error messages may contain provider response bodies; report only our classification.
    // A deadline reached during audit writing must not replace an authentication/configuration failure.
    if (fatal) throw new Error(`TypeSafe skill selection: ${failure}`)
    signal.throwIfAborted()
    if (config.onSelectionError === 'fail') throw new Error(`TypeSafe skill selection: ${failure}`)
    ctx.logger.warn(`TypeSafe skill selection skipped: ${failure}`)
    return decision
  }

  const additions: UserMessage[] = []
  const skipped: { name: string; reason: string }[] = []
  let usedBytes = 0
  try {
    for (const selected of result.selected) {
      if (additions.length >= config.maxSkills) break
      const skill = await ctx.skills.get(selected.name, lookup)
      signal.throwIfAborted()
      if (!skill || !isModelInvocable(skill)) {
        skipped.push({ name: selected.name, reason: 'unavailable' })
        continue
      }
      const text = renderSkillContent(skill)
      if (visibleTexts.has(text)) {
        skipped.push({ name: skill.name, reason: 'already-visible' })
        continue
      }
      const bytes = Buffer.byteLength(text, 'utf8')
      if (usedBytes + bytes > config.maxInjectedBytes) {
        skipped.push({ name: skill.name, reason: 'content-budget' })
        continue
      }
      usedBytes += bytes
      additions.push(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'skill-auto-load-typesafe', form: 'instructions', name: skill.name, requestId },
      }))
    }
  } catch (error) {
    await audit(requestId, { ...receipt, status: signal.aborted ? 'aborted' : 'failed', finishedAt: Date.now(),
      response: result.response, failure: 'skill-loading-failed' })
    throw error
  }
  await audit(requestId, {
    ...receipt,
    status: 'completed',
    finishedAt: Date.now(),
    response: result.response,
    selected: result.selected.map(item => item.name),
    loaded: additions.map(message => message.source.kind === 'skill-auto-load-typesafe' ? message.source.name : ''),
    skipped,
  })
  signal.throwIfAborted()
  return additions.length ? { ...decision, messages: [...decision.messages, ...additions] } : decision
}
