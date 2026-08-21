// End-to-end: rebuild the EXACT failing request (1318 messages) from the real
// session log, run it through the REAL installOutboundDistiller/pruneOptions,
// and check the adapter-received messages for wire-format orphans.
import { readFileSync, copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { installOutboundDistiller } from '../lib/outbound-distill.js'

const LOG = 'D:/dsh/mcp/dsh-local-model/session.jsonl'
const ERR_SEQ = 462075

// ---- rebuild the exact surface DSH used for the failing request ----
const events = []
const surface = []
const rl = createInterface({ input: createReadStream(LOG) })
for await (const line of rl) {
  if (!line.trim()) continue
  let e; try { e = JSON.parse(line) } catch { continue }
  if (e.seq > ERR_SEQ) break
  if (typeof e.seq !== 'number') continue
  if (!['user/message', 'assistant/message', 'tool/result'].includes(e.type)) continue
  const op = e.surfaceOp
  if (op === undefined) continue
  events[e.seq] = e
  if (op === 'append') surface.push(e.seq)
  else if (op.op === 'replace') {
    const start = surface.findIndex((s) => s === op.start)
    if (start !== -1) {
      const end = surface.indexOf(op.end, start)
      const removeTo = end === -1 ? start + 1 : end + 1
      surface.splice(start, removeTo - start, e.seq)
    } else surface.push(e.seq)
  }
}
function deriveMsg(e) {
  if (e.type === 'user/message') return e.data
  if (e.type === 'assistant/message') return e.data.message?.content?.length ? e.data.message : null
  if (e.type === 'tool/result') return e.data.message
  return null
}
let msgs = surface.map((seq) => deriveMsg(events[seq])).filter(Boolean)
// drop trailing plugin notice appended during the request
if (msgs.at(-1)?.source?.kind === 'plugin') msgs = msgs.slice(0, -1)
console.log(`failing request messages rebuilt: ${msgs.length}`)

const hasTR = (m) => (m?.content ?? []).some((b) => b?.type === 'tool-result')
const hasTC = (m) => (m?.content ?? []).some((b) => b?.type === 'tool-call')

// ---- mock ctx/runtime, mirroring repro-prune.mjs ----
const hooks = []
const ctx = {
  on(_n, cb, _o) { hooks.push(cb) },
  waterfall(thisArg, _n, o, inner) { const cbs = [...hooks]; const next = () => (cbs.shift() ?? inner).call(thisArg, o, next); return next() },
}
const received = []
const runtime = {
  stream(o) { return ctx.waterfall(runtime, 'llm/stream', o, () => (async function* () { received.push(o); yield { type: 'finish', reason: { kind: 'stop' } } })()) },
}
// fresh cache file with the persisted prune summaries so makePruneSummary hits cache
const CACHE_SRC = `${process.env.USERPROFILE}\\.dsh\\dsh-local-model-distill-cache.json`
const tmp = mkdtempSync(join(tmpdir(), 'dsh-prune-'))
const cachePath = join(tmp, 'cache.json')
copyFileSync(CACHE_SRC, cachePath)

const cfg = {
  baseUrl: 'http://127.0.0.1:11434',
  distillModel: 'qwen3.5:latest',
  distillMinChars: 2000,
  targetRatio: 0.4,
  distillRoles: ['user'],
  distillSystem: false,
  distillChunkChars: 3000,
  distillNumCtx: 8192,
  distillTimeoutMs: 180000,
  distillOnError: 'pass',
  distillBudgetMs: 60000,
  distillCachePath: cachePath,
  distillNotice: false,
  pruneEnabled: true,
  pruneBudgetTokens: 40000,
  pruneKeepRecent: 30,
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
await drain(runtime.stream({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: msgs }))
const got = received[0]?.messages ?? []
console.log(`adapter received messages: ${got.length} (input ${msgs.length})`)

// ---- wire-convert and check orphans ----
const wire = []
const ids = new Set()
for (const m of got) {
  if (m.role === 'user' && hasTR(m)) {
    for (const b of m.content) if (b?.type === 'tool-result') wire.push({ role: 'tool', tool_call_id: b.toolCallId })
  } else if (m.role === 'assistant' && hasTC(m)) {
    m.content.filter((b) => b?.type === 'tool-call').forEach((b) => ids.add(b.id))
    wire.push({ role: 'assistant', tool_calls: m.content.filter((b) => b?.type === 'tool-call').map((b) => b.id) })
  } else wire.push({ role: m.role, content: '' })
}
const orphans = wire.filter((w) => w.role === 'tool' && !ids.has(w.tool_call_id))
console.log(`wire messages: ${wire.length}`)
if (got[0]?.content?.[0]?.text?.startsWith('⟦历史剪枝')) {
  console.log('pruned; summary marker:', got[0].content[0].text.split('\n')[0])
} else {
  console.log('NOT pruned (fallback path) — first msg text:', JSON.stringify(String(got[0]?.content?.[0]?.text ?? '').slice(0, 80)))
}
console.log(`\nORPHAN tool messages at wire: ${orphans.length}`)
if (orphans.length) {
  console.log('FAIL — orphans present:', orphans.map((o) => o.tool_call_id))
  process.exit(1)
}
console.log('PASS — no orphaned tool messages')
