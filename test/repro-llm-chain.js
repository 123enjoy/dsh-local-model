/**
 * Full-chain reproduction: real LlmRuntime + real invariant + our distiller +
 * a fake adapter, driven through prepareCall -> preparedCall.stream(request),
 * mirroring dsh-agent-loop's step(). Detects "stream yields zero chunks and
 * never finishes" — the observed "Deep diving..." hang signature.
 */
import { Context } from 'file:///C:/Users/bigmouse/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import LlmRuntime from 'file:///C:/Users/bigmouse/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
import { installOutboundDistiller } from '../lib/outbound-distill.js'

const log = (...a) => console.log('[h]', ...a)

// Inline the real invariant validator (source from dsh-llm/lib/invariant.js).
function fail(msg) { const e = new Error(msg); e.code = 'INVARIANT'; throw e }
async function* validateStream(source) {
  const open = new Map()
  let finished = false
  for await (const chunk of source) {
    if (finished) fail(`LLM stream emitted ${chunk.type} after terminal finish`)
    switch (chunk.type) {
      case 'block-start': if (open.has(chunk.index)) fail('dup block-start'); open.set(chunk.index, chunk.blockType); break
      case 'text-delta': if (open.get(chunk.index) !== 'text') fail('text-delta needs open text'); break
      case 'block-end': { if (!open.has(chunk.index)) fail('no open block'); if (open.get(chunk.index) !== chunk.block.type) fail('mismatch'); open.delete(chunk.index); break }
      case 'usage': break
      case 'finish': if (open.size > 0 && chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') fail('finish with open blocks'); finished = true; break
    }
    yield chunk
  }
  if (!finished) fail('stream ended without terminal finish')
}

const ctx = new Context()
const llm = new LlmRuntime(ctx)
ctx.logger = { warn: (...a) => console.log('[llm-warn]', ...a) }
ctx.on('llm/stream', (_options, next) => validateStream(next()), { global: true, prepend: true })

// Fake adapter: valid stream protocol, immediate.
const adapter = {
  providerInfo(p) { return { id: p, name: p } },
  providerRetryPolicy() {},
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) },
  async *stream(options) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, delta: 'fake-cloud-reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fake-cloud-reply' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'success' } }
  },
}
llm.registerAdapter(['test-provider'], adapter)

// Install our distiller (mirrors lib/index.js config from profile patch).
const cfg = {
  baseUrl: 'http://127.0.0.1:11434',
  defaultModel: 'qwen3.5:latest',
  distillEnabled: true,
  distillModel: 'qwen3.5:latest',
  distillMinChars: 2000,
  targetRatio: 0.4,
  distillRoles: ['user'],
  distillSystem: false,
  distillChunkChars: 3000,
  distillNumCtx: 8192,
  distillTimeoutMs: 60000,
  distillOnError: 'pass',
  logger: { info: (...a) => console.log('[distill]', ...a), warn: (...a) => console.log('[distill-warn]', ...a) },
}
installOutboundDistiller(ctx, cfg)

const longText = ('长文本关键信息：错误码 E5291，路径 C:\\src\\app.js，数字 1284。'.repeat(150))

async function runOne(label, request) {
  const preparedCall = await llm.prepareCall({ provider: 'test-provider', model: 'cloud-m', messages: request.messages, signal: request.signal }, request.signal)
  const stream = preparedCall.stream(request)
  let chunks = 0
  let finished = false
  const timeout = setTimeout(() => { console.log(`FAIL[${label}]: TIMEOUT after ${chunks} chunks, finished=${finished}`); process.exit(1) }, 60000)
  const t0 = Date.now()
  for await (const chunk of stream) {
    chunks++
    if (chunk.type === 'finish') { finished = true; break }
  }
  clearTimeout(timeout)
  log(`${label}: chunks=${chunks} finished=${finished} in ${Date.now() - t0}ms`)
  if (chunks === 0 || !finished) { console.log(`FAIL[${label}]: zero-chunks-or-no-finish`); process.exit(1) }
}

// Case A: long user message -> distillation path.
await runOne('A-distill', {
  provider: 'test-provider', model: 'cloud-m',
  signal: new AbortController().signal,
  messages: [
    { id: 'sys', role: 'system', content: '你是助手。' },
    { id: 'u1', role: 'user', content: [{ type: 'text', text: longText }] },
  ],
})

// Case B: short message -> pass-through.
await runOne('B-pass', {
  provider: 'test-provider', model: 'cloud-m',
  signal: new AbortController().signal,
  messages: [
    { id: 'u2', role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ],
})

console.log('ALL OK')
process.exit(0)
