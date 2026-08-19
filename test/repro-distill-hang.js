/**
 * Reproduction harness for the "Deep diving..." hang.
 *
 * Boots a real cordis Context, installs the plugin's outbound distiller
 * exactly as lib/index.js does, and simulates the dsh-llm `llm/stream`
 * waterfall with a mock adapter. Feeds it a long message so distillation
 * actually runs against real Ollama, then checks the returned stream
 * terminates with a `finish` chunk in bounded time.
 */
import { Context } from 'file:///C:/Users/bigmouse/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import { installOutboundDistiller } from '../lib/outbound-distill.js'

const log = (...a) => console.log('[h]', ...a)

// Mock adapter: a valid LLM stream protocol stream.
async function* adapterStream(options) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, delta: 'mock reply to model ' + (options.model ?? '?') }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'mock reply' } }
  yield { type: 'finish', reason: { kind: 'success', failure: undefined } }
}

// Mock LlmRuntime: mirrors dsh-llm stream() -> ctx.waterfall(this, 'llm/stream', ...)
const runtime = {
  stream(options) {
    return runtime.ctx.waterfall(this, 'llm/stream', options, () => adapterStream(options))
  },
}

async function run() {
  const ctx = new Context()
  runtime.ctx = ctx

  // Install the distiller exactly as the plugin does.
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

  const longText = ('这是一个需要被压缩的长文本，包含关键信息：错误码 E5291，路径 C:\\src\\app.js，数字 1284。'.repeat(120))
  log('longText length =', longText.length)

  // Case 1: long user message -> distillation path -> must still finish.
  const options1 = {
    sessionId: 's1',
    model: 'cloud-model',
    messages: [
      { id: 'm-sys', role: 'system', content: '你是助手。' },
      { id: 'm-user', role: 'user', content: [{ type: 'text', text: longText }] },
    ],
  }

  const timer = setTimeout(() => { console.log('TIMEOUT: stream did not finish in 90s'); process.exit(1) }, 90000)

  const stream = runtime.stream(options1)
  let blocks = 0
  let finished = false
  const t0 = Date.now()
  for await (const chunk of stream) {
    if (chunk.type === 'finish') { finished = true; break }
    if (chunk.type === 'block-start') blocks++
  }
  const ms = Date.now() - t0
  clearTimeout(timer)
  log(`case1 finished=${finished} blocks=${blocks} in ${ms}ms`)
  if (!finished) { console.log('FAIL: no finish chunk'); process.exit(1) }

  // Case 2: short message -> pass-through path.
  const options2 = {
    sessionId: 's2',
    model: 'cloud-model',
    messages: [
      { id: 'm2', role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ],
  }
  const stream2 = runtime.stream(options2)
  let f2 = false
  for await (const c of stream2) { if (c.type === 'finish') { f2 = true; break } }
  log('case2 pass-through finished =', f2)
  if (!f2) { console.log('FAIL: pass-through did not finish'); process.exit(1) }

  console.log('ALL OK')
  process.exit(0)
}

run().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1) })
