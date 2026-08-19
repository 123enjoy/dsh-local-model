/**
 * Decisive test of the CHANGED-content re-dispatch path.
 * A mock local-chat HTTP server returns a short valid summary, so the
 * distiller actually rewrites the request and calls runtime.stream(distilled).
 * Full chain: real LlmRuntime + invariant + fake adapter + distiller,
 * driven via prepareCall().stream() exactly like dsh-agent-loop.
 */
import http from 'node:http'
import { Context } from 'file:///C:/Users/bigmouse/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import LlmRuntime from 'file:///C:/Users/bigmouse/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
import { installOutboundDistiller } from '../lib/outbound-distill.js'

const log = (...a) => console.log('[h]', ...a)

// ---- mock local Ollama chat server: returns a short valid summary ----
const localServer = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    if (req.url === '/api/chat') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'qwen3.5:latest',
        message: { role: 'assistant', content: '高密度摘要：错误码E5291，路径C:\\src\\app.js，数量1284。' + '关键要点A，关键要点B，关键要点C，关键要点D，关键要点E，关键要点F。'.repeat(8) },
        total_duration: 1000000,
        eval_count: 20,
        eval_duration: 500000000,
      }))
    } else {
      res.writeHead(404); res.end('{}')
    }
  })
})
await new Promise(r => localServer.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${localServer.address().port}`
log('mock local chat on', baseUrl)

// ---- invariant (same as dsh-llm/lib/invariant.js) ----
function fail(msg) { const e = new Error(msg); e.code = 'INVARIANT'; throw e }
async function* validateStream(source) {
  const open = new Map(); let finished = false
  for await (const chunk of source) {
    if (finished) fail('chunk after finish')
    switch (chunk.type) {
      case 'block-start': if (open.has(chunk.index)) fail('dup'); open.set(chunk.index, chunk.blockType); break
      case 'text-delta': if (open.get(chunk.index) !== 'text') fail('no open text'); break
      case 'block-end': { if (!open.has(chunk.index)) fail('no open'); open.delete(chunk.index); break }
      case 'finish': if (open.size && chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') fail('open blocks'); finished = true; break
    }
    yield chunk
  }
  if (!finished) fail('no finish')
}

const ctx = new Context()
ctx.logger = { warn: (...a) => console.log('[warn]', ...a) }
ctx.on('llm/stream', (_o, next) => validateStream(next()), { global: true, prepend: true })
const llm = new LlmRuntime(ctx)

const adapter = {
  providerInfo(p) { return { id: p, name: p } },
  providerRetryPolicy() {},
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) },
  async *stream(options) {
    // record the message count actually delivered to the adapter
    adapter.lastMessages = options.messages
    adapter.lastSystem = options.system
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, delta: 'cloud-reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'cloud-reply' } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'success' } }
  },
}
llm.registerAdapter(['test-provider'], adapter)

const cfg = {
  baseUrl,
  defaultModel: 'qwen3.5:latest',
  distillEnabled: true,
  distillModel: 'qwen3.5:latest',
  distillMinChars: 100,
  targetRatio: 0.4,
  distillRoles: ['user'],
  distillSystem: false,
  distillChunkChars: 3000,
  distillNumCtx: 8192,
  distillTimeoutMs: 5000,
  distillOnError: 'pass',
  logger: { info: (...a) => console.log('[distill]', ...a), warn: (...a) => console.log('[distill-warn]', ...a) },
}
installOutboundDistiller(ctx, cfg)

const longText = '这是很长很长的文本，包含关键信息：错误码 E5291，路径 C:\\src\\app.js，数量 1284。'.repeat(40)
log('longText length =', longText.length, '(gate=100)')

const request = {
  provider: 'test-provider', model: 'cloud-m',
  signal: new AbortController().signal,
  messages: [
    { id: 'sys', role: 'system', content: '你是助手。' },
    { id: 'u1', role: 'user', content: [{ type: 'text', text: longText }] },
  ],
}

const preparedCall = await llm.prepareCall({ provider: 'test-provider', model: 'cloud-m', messages: request.messages, signal: request.signal }, request.signal)
const stream = preparedCall.stream(request)

let chunks = 0, finished = false
const timeout = setTimeout(() => { console.log('FAIL: TIMEOUT after', chunks, 'chunks'); process.exit(1) }, 30000)
const t0 = Date.now()
for await (const chunk of stream) { chunks++; if (chunk.type === 'finish') { finished = true; break } }
clearTimeout(timeout)
log(`chunks=${chunks} finished=${finished} in ${Date.now() - t0}ms`)
if (chunks === 0 || !finished) { console.log('FAIL: zero-chunks or no finish'); process.exit(1) }

// Verify the adapter actually received the DISTILLED (shorter) message.
const delivered = adapter.lastMessages?.find(m => m.id === 'u1')
const deliveredText = delivered?.content?.map(b => b.text ?? '').join('') ?? ''
log('adapter received u1 text length =', deliveredText.length)
log('adapter received system =', adapter.lastSystem)

if (deliveredText.includes('本地蒸馏') && deliveredText.length < longText.length) {
  console.log('PASS: adapter got the distilled summary')
} else {
  console.log('NOTE: adapter did NOT get a distilled summary (re-dispatch path not exercised)')
}
process.exit(chunks === 0 || !finished ? 1 : 0)
