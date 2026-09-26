/** Opt-in single paid request for checking a user-supplied TypeSafe credential. */
import { resolveConfig } from '../dist/config.js'
import { buildRequest, parseSelection, requestSelection } from '../dist/selector.js'

const key = process.env.TYPESAFE_API_KEY
if (!key?.trim()) throw new Error('Set TYPESAFE_API_KEY before running test:live')
const config = resolveConfig({})
const candidates = [
  { name: 'code-review', description: 'Review source changes for bugs and missing tests.', whenToUse: 'Reviewing a code change' },
  { name: 'slide-author', description: 'Create presentation slides and speaker notes.', whenToUse: 'Creating a presentation' },
]
const request = buildRequest(process.argv[2] ?? 'Review this code change for bugs and missing tests.', candidates, config)
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), config.timeoutMs)
try {
  const raw = await requestSelection(request, key, config, controller.signal)
  const result = parseSelection(raw, candidates, config)
  console.log(JSON.stringify({ model: result.response.model, scores: result.scores, selected: result.selected, usage: result.response.usage }, null, 2))
} catch {
  // Provider error bodies can contain sensitive data; the smoke reports no raw errors.
  throw new Error('TypeSafe smoke failed; check your credential, connectivity and model access')
} finally {
  clearTimeout(timer)
}
