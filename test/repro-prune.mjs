/**
 * 真实数据干跑：用当前会话的真实消息重建一个超预算请求，跑一遍剪枝，
 * 输出 before/after token 估算与摘要开头，预估实机效果。
 * 用法：node test/repro-prune.mjs
 */
import { readFileSync, copyFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { installOutboundDistiller } from '../lib/outbound-distill.js'
import { estimateTokens } from '../lib/compress.js'

const CACHE_SRC = `${process.env.USERPROFILE}\\.dsh\\dsh-local-model-distill-cache.json`
const CACHE_TMP = './.repro-prune-cache.json'
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

// 重建全部 surface 消息（user/assistant/tool-result），模拟 agent 每轮重建的消息列表
const messages = []
for (const e of events) {
  if (e.type === 'user/message') {
    messages.push({ id: e.data?.id ?? crypto.randomUUID(), role: 'user', content: e.data?.content ?? [], source: e.data?.source })
  } else if (e.type === 'assistant/message') {
    messages.push({ id: e.data?.id ?? crypto.randomUUID(), role: 'assistant', content: e.data?.content ?? [] })
  } else if (e.type === 'tool/result') {
    const m = e.data?.message
    if (m?.content) messages.push({ id: m.id ?? crypto.randomUUID(), role: m.role ?? 'user', content: m.content })
  }
}
const recent = messages.slice(-400)
const estTokens = (msgs) => {
  let t = 0
  const walk = (b) => { for (const x of b ?? []) { if (x?.type === 'text' && typeof x.text === 'string') t += estimateTokens(x.text); else if (x?.type === 'tool-result' && Array.isArray(x.content)) walk(x.content) } }
  for (const m of msgs) walk(m?.content)
  return t
}
console.log('重建消息数:', recent.length, '估算 tokens:', estTokens(recent))

const hooks = []
const ctx = {
  on(_n, cb, _o) { hooks.push(cb) },
  waterfall(thisArg, _n, o, inner) { const cbs = [...hooks]; const next = () => (cbs.shift() ?? inner).call(thisArg, o, next); return next() },
}
const received = []
const runtime = {
  stream(o) { return ctx.waterfall(runtime, 'llm/stream', o, () => (async function* () { received.push(o); yield { type: 'finish', reason: { kind: 'stop' } } })()) },
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
  distillNotice: false,
  pruneEnabled: true,
  pruneBudgetTokens: 40000,
  pruneKeepRecent: 12,
  pruneMaxSourceChars: 12000,
  pruneMaxSummaryTokens: 2048,
  pruneBatchSize: 12,
  pruneChainMaxBatches: 20,
  pruneMaxNewBlocks: 3,
  pruneTimeoutMs: 120000,
  pruneNotice: false,
}
installOutboundDistiller(ctx, cfg)

const drain = async (s) => { for await (const _ of s) { /* consume */ } }
console.log('--- streaming (prune on) ---')
await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: recent }))
const got = received[0]?.messages ?? []
const afterTokens = estTokens(got)
console.log(`适配器收到消息数: ${got.length} (原 ${recent.length})`)
console.log(`估算 tokens: ${estTokens(recent)} → ${afterTokens}（-${Math.round((1 - afterTokens / estTokens(recent)) * 100)}%）`)
if (got[0]?.content?.[0]?.text?.startsWith('⟦历史剪枝')) {
  const mark = got[0].content[0].text.split('\n')[0]
  console.log('摘要标记行:', mark)
  console.log('摘要正文开头:', got[0].content[0].text.slice(mark.length + 1, mark.length + 201))
} else {
  console.log('⚠ 未发生剪枝，收到第一条消息开头:', JSON.stringify(got[0]?.content?.[0]?.text?.slice(0, 80)))
}
