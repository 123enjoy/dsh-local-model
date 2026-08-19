/**
 * 复现 v2：从真实会话提取 lmc 结果消息原文，命中真实缓存，复现 notice 路径。
 */
import { readFileSync, copyFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { installOutboundDistiller } from '../lib/outbound-distill.js'

const CACHE_SRC = `${process.env.USERPROFILE}\\.dsh\\dsh-local-model-distill-cache.json`
const CACHE_TMP = './.repro-cache.json'
copyFileSync(CACHE_SRC, CACHE_TMP)

const file = 'C:\\Users\\bigmouse\\.dsh\\sessions\\--D-dsh-mcp--\\session-e0bf4147-4f74-4d69-b2a4-365bdeecdd6c\\session.jsonl.zstd'
const raw = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
let idx = raw.indexOf(MAGIC)
while (idx !== -1) { starts.push(idx); idx = raw.indexOf(MAGIC, idx + 1) }
const chunks = []
for (let i = 0; i < starts.length; i++) {
  const end = i + 1 < starts.length ? starts[i + 1] : raw.length
  try { chunks.push(zstdDecompressSync(raw.subarray(starts[i], end)).toString('utf8')) } catch { /* skip */ }
}
const events = []
for (const line of chunks.join('').split('\n')) {
  if (line.trim() === '') continue
  try { events.push(JSON.parse(line)) } catch { /* skip */ }
}

// 提取 lmc 结果消息（用真实存储对象）
let realMessage = null
for (let i = 0; i < events.length; i++) {
  const e = events[i]
  if (e.type === 'tool/result' && e.data?.message?.id === '1f7876b5-d088-42b3-9006-ec4c2cca0398') {
    realMessage = e.data.message
    break
  }
}
if (!realMessage) { console.error('real message not found'); process.exit(2) }
const innerText = realMessage.content[0].content[0].text
console.log('real inner text len:', innerText.length)

const options = { provider: 'cloud', model: 'x', messages: [realMessage] }

const appended = []
const agent = {
  session: {
    events,
    append(type, data, opts) { appended.push({ type, data, opts }) },
  },
}
const hooks = []
const ctx = {
  on(_name, cb, _opts) { hooks.push(cb) },
  waterfall(thisArg, _name, o, inner) {
    const cbs = [...hooks]
    const next = () => (cbs.shift() ?? inner).call(thisArg, o, next)
    return next()
  },
  agents: { list: () => [agent] },
}
const runtime = {
  stream(o) { return ctx.waterfall(runtime, 'llm/stream', o, () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()) },
}

const cfg = {
  baseUrl: 'http://127.0.0.1:11434',
  distillModel: process.env.DISTILL_MODEL ?? 'qwen3.5:latest',
  distillMinChars: 2000,
  targetRatio: 0.4,
  distillRoles: ['user'],
  distillSystem: false,
  distillChunkChars: 3000,
  distillNumCtx: 8192,
  distillTimeoutMs: 180000,
  distillOnError: 'pass',
  distillBudgetMs: 60000,
  distillCachePath: CACHE_TMP,
  distillNotice: true,
}
installOutboundDistiller(ctx, cfg)

const drain = async (s) => { for await (const _ of s) { /* consume */ } }
console.log('--- streaming request 1 ---')
await drain(runtime.stream(options))
console.log('appended notices after req1:', appended.length)
for (const a of appended) {
  console.log('type:', a.type, 'opts:', JSON.stringify(a.opts ?? null))
  console.log('source:', JSON.stringify(a.data.source ?? null))
  console.log('content head:', JSON.stringify(a.data.content?.[0]?.text?.slice(0, 150) ?? null))
}
console.log('--- streaming request 2 (same message re-sent, cache hit) ---')
await drain(runtime.stream(options))
console.log('appended notices after req2:', appended.length, '(expect still 1 — no spam)')