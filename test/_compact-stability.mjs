/**
 * Cache-stability around DEEP COMPACTION.
 *
 * Drives the REAL outbound-distiller through a growing session that forces the
 * frozen prune chain past pruneChainMaxBatches (deep compaction) repeatedly.
 * The local model is STUBBED by a deterministic in-process fake Ollama server
 * (same input → same output, like temperature:0 + content seed), so the run is
 * fast and repeatable while still exercising the plugin's real chain/roll/
 * compact logic end to end.
 *
 * For every consecutive request pair we measure the byte-identical wire prefix
 * (role + all billed fragments, ids stripped — ids never hit the wire), which
 * is exactly what a cloud prompt cache keys on. We record the hit ratio and
 * flag the turns where compaction fired (block count dropped).
 *
 * The user reports: when the chain fills up and compaction fires, cache hit
 * rate drops to ~1% and STAYS there. System prompt + tools are unchanged, so
 * the prefix cache should still hit on them. This test tells us (a) whether
 * steady-state turns are byte-stable, (b) what the compaction turn does, and
 * (c) whether it recovers or oscillates.
 *
 * Run: node test/_compact-stability.mjs [maxBatches] [scenario A|B]
 */

import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { installOutboundDistiller } from '../lib/outbound-distill.js'

const CACHE = './.test-compact-stability.json'
rmSync(CACHE, { force: true })

/* ---------- deterministic fake Ollama ---------- */

function fakeSummarize(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  const facts = [...text.matchAll(/事实[^\s。，、]*/g)].map((m) => m[0]).slice(-8).join('、')
  // pad deterministically so the body clears historySummarize's fidelity floor
  // (out.length >= min(80, source*0.02)); ~150 chars is safely above 80.
  const tail = text.replace(/\s+/g, ' ').slice(-70)
  const body = `摘要[${h.toString(36)}] 关键：${facts || tail}`.padEnd(150, '·')
  if (body.length >= text.length) return text.slice(0, Math.max(90, Math.floor(text.length * 0.5)))
  return body.slice(0, Math.max(90, Math.min(body.length, Math.floor(text.length * 0.6))))
}

async function startFakeOllama(port) {
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    if (req.url === '/api/chat') {
      const parsed = JSON.parse(body)
      const user = [...(parsed.messages ?? [])].reverse().find((m) => m?.role === 'user')?.content ?? ''
      const content = fakeSummarize(user)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: parsed.model,
        message: { role: 'assistant', content },
        done_reason: 'stop', eval_count: content.length, total_duration: 1,
      }))
    } else {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    }
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return server
}

/* ---------- minimal waterfall harness ---------- */

function makeRuntime(adapterStream) {
  const hooks = []
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    agents: { list: () => [{ session: { events: [], append() {} } }] },
    on(_n, cb) { hooks.push(cb) },
    waterfall(thisArg, _n, options, inner) {
      const cbs = [...hooks]
      const next = () => (cbs.shift() ?? inner).call(thisArg, options, next)
      return next()
    },
  }
  const runtime = { stream(options) { return ctx.waterfall(runtime, 'llm/stream', options, () => adapterStream(options)) } }
  return { ctx, runtime }
}

async function drain(stream) {
  for await (const _ of stream) { /* drain */ }
}

function cfg(baseUrl, over = {}) {
  return {
    baseUrl,
    distillModel: 'stub',
    distillMinChars: 1500,
    targetRatio: 0.4,
    distillRoles: ['user'],
    distillSystem: false,
    distillChunkChars: 3000,
    distillNumCtx: 8192,
    distillTimeoutMs: 5000,
    distillOnError: 'pass',
    distillBudgetMs: 60000,
    distillCachePath: CACHE,
    distillNotice: false,
    pruneEnabled: true,
    pruneBudgetTokens: 2000,
    pruneKeepRecent: 2,
    pruneMaxSourceChars: 12000,
    pruneMaxSummaryTokens: 2048,
    pruneBatchSize: 12,
    pruneChainMaxBatches: 4,
    pruneMaxNewBlocks: 3,
    pruneRollMargin: 1.2,
    pruneTimeoutMs: 5000,
    pruneNotice: false,
    ...over,
  }
}

function histLine(tag, fact) {
  return `[步骤 ${tag}] 上下文说明段落，包含关键事实：${fact}。` +
    '这里是一些占位叙述，用于撑起长度，确保消息进入剪枝范围。'.repeat(10) + '\n'
}

/** Deterministic wire projection: role + billed fragments, ids stripped.
 *  The cloud provider caches the FULL request prefix — system + tool defs are
 *  the fixed head, then the conversation. So they must be in the wire too. */
function wireString(messages, system = '', tools = []) {
  const parts = ['SYS:' + system]
  if (Array.isArray(tools) && tools.length > 0) parts.push('TOOLS:' + JSON.stringify(tools))
  for (const m of messages ?? []) {
    const blocks = m?.content ?? []
    const billsReasoning = m?.role === 'assistant' && blocks.some((b) => b?.type === 'tool-call')
    const frags = []
    const walk = (bs, withReasoning) => {
      for (const b of bs ?? []) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string') frags.push('t:' + b.text)
        else if (b.type === 'reasoning' && typeof b.text === 'string' && withReasoning) frags.push('r:' + b.text)
        else if (b.type === 'tool-call' && typeof b.arguments === 'string') frags.push('a:' + b.arguments)
        else if (b.type === 'tool-result' && Array.isArray(b.content)) walk(b.content, false)
      }
    }
    walk(blocks, billsReasoning)
    parts.push((m?.role ?? '?') + '{' + frags.join('|') + '}')
  }
  return parts.join('\x00')
}

function commonPrefixLen(a, b) {
  let i = 0
  const n = Math.min(a.length, b.length)
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/* ---------- run one scenario ---------- */

async function runScenario(baseUrl, name, c, histCount, turns, growEvery, builder = histLine, system = 'SYS', tools = [], perTurn = 1) {
  rmSync(CACHE, { force: true })
  const received = []
  const adapter = async function* (options) { received.push(options); yield { type: 'finish', reason: { kind: 'stop' } } }
  const { ctx, runtime } = makeRuntime(adapter)
  installOutboundDistiller(ctx, c)

  const base = Array.from({ length: histCount }, (_, i) => ({
    id: 'h' + i, role: 'user', content: [{ type: 'text', text: builder('h' + i, '历史事实 ' + i + ' 号') }],
  }))

  let prevWire = null, prevMsgWire = null, prevBlocks = 0, compactions = 0
  const rows = []
  for (let t = 0; t < turns; t++) {
    // A REAL growing session: the messages already seen are RETAINED verbatim
    // (same content); `perTurn` new messages are appended each turn (agentic
    // turns add assistant + tool-call + tool-result + user in one go).
    const messages = [...base]
    for (let k = 0; k < (t + 1) * perTurn; k++) {
      messages.push({ id: 'n' + k, role: 'user', content: [{ type: 'text', text: builder('n' + k, '新增事实 ' + k) }] })
    }
    await drain(runtime.stream({ provider: 'cloud', model: 'x', system, tools, messages }))
    const opts = received[received.length - 1]
    const wire = wireString(opts.messages, opts.system ?? system, opts.tools ?? tools)
    const msgWire = wireString(opts.messages)
    const nMsgs = opts.messages.length
    const blocks = opts.messages.filter((m) => (m.content?.[0]?.text ?? '').startsWith('⟦历史剪枝')).length
    const first = opts.messages[0]?.content?.[0]?.text ?? ''
    const pruned = first.startsWith('⟦历史剪枝') ? (Number(/省略(\d+)条/.exec(first)?.[1]) || 0) : 0
    const prefix = prevWire === null ? 0 : commonPrefixLen(prevWire, wire)
    const hitPct = prevWire === null ? 0 : Math.round((prefix / Math.max(1, wire.length)) * 100)
    // message-portion hit: the unstable part the user watches (system/tools are
    // fixed and dominate the full-wire number, hiding the message churn)
    const msgPrefix = prevMsgWire === null ? 0 : commonPrefixLen(prevMsgWire, msgWire)
    const msgHit = prevMsgWire === null ? 0 : Math.round((msgPrefix / Math.max(1, msgWire.length)) * 100)
    const compacted = prevWire !== null && blocks < prevBlocks
    const rolled = prevWire !== null && blocks > prevBlocks
    if (compacted) compactions++
    rows.push({ t, nMsgs, blocks, pruned, len: wire.length, hitPct, msgHit, compacted, rolled })
    prevWire = wire
    prevMsgWire = msgWire
    prevBlocks = blocks
  }
  return { name, rows, compactions }
}

/** Avg turns between roll events (excluding the initial build, t=0). */
function rollInterval(rows) {
  const rollTurns = rows.filter((r) => r.rolled).map((r) => r.t)
  if (rollTurns.length === 0) return Infinity
  const gaps = []
  for (let i = 1; i < rollTurns.length; i++) gaps.push(rollTurns[i] - rollTurns[i - 1])
  const firstGap = rollTurns[0] // gap since t=0 build
  gaps.push(firstGap)
  return Math.round(gaps.reduce((s, x) => s + x, 0) / gaps.length)
}

function report(name, rows, compactions) {
  const hits = rows.slice(1).map((r) => r.hitPct)
  const mhits = rows.slice(1).map((r) => r.msgHit)
  const avg = hits.reduce((s, x) => s + x, 0) / hits.length
  const mAvg = mhits.reduce((s, x) => s + x, 0) / mhits.length
  const min = Math.min(...hits)
  const mMin = Math.min(...mhits)
  const stable = hits.filter((h) => h >= 90).length
  const mStable = mhits.filter((h) => h >= 90).length
  const interval = rollInterval(rows)
  const intervalTxt = interval === Infinity ? 'inf' : `${interval} turns`
  console.log(`\n===== ${name} =====`)
  console.log(`full-wire: avg=${avg.toFixed(1)}%  min=${min}%  >=90%: ${stable}/${hits.length}   message-only: avg=${mAvg.toFixed(1)}%  min=${mMin}%  >=90%: ${mStable}/${mhits.length}  compactions=${compactions}  roll-interval=${intervalTxt}`)
  console.log('turn  msgs  blk  pruned  hit% mHit%    len')
  for (const r of rows) {
    const flag = r.compacted ? '  <== COMPACT' : r.rolled ? '  <== ROLL' : ''
    if (r.t === 0 || r.hitPct < 100 || r.compacted || r.rolled || r.msgHit < 90) {
      console.log(`${String(r.t).padStart(4)} ${String(r.nMsgs).padStart(5)} ${String(r.blocks).padStart(3)} ${String(r.pruned).padStart(7)} ${String(r.hitPct).padStart(4)}% ${String(r.msgHit).padStart(4)}% ${String(r.len).padStart(7)}${flag}`)
    }
  }
}

function bigHistLine(tag, fact, scale = 14) {
  const unit = histLine(tag, fact)
  return unit + (fact + ' 补充细节 ' + tag + '。').repeat(scale) + '\n'
}

const server = await startFakeOllama(18444)
const baseUrl = 'http://127.0.0.1:18444'
const maxBatches = Number(process.argv[2] ?? 4)

// Scenario A: tail fits under the lazy threshold after compaction → recovery expected.
{
  const { name, rows, compactions } = await runScenario(baseUrl, `A maxBatches=${maxBatches} (tail fits)`,
    cfg(baseUrl, { pruneChainMaxBatches: maxBatches }), 34, 60, 1)
  report(name, rows, compactions)
}

// Scenario B: keep-zone alone exceeds the threshold → can never fit; check for
// roll/compact oscillation (every turn shifts the tail = persistent miss).
{
  const { name, rows, compactions } = await runScenario(baseUrl, `B maxBatches=${maxBatches} (tail NEVER fits)`,
    cfg(baseUrl, { pruneChainMaxBatches: maxBatches, pruneKeepRecent: 16, pruneBudgetTokens: 400 }),
    50, 60, 1)
  report(name, rows, compactions)
}

// Scenario C: USER's default config (maxBatches=20, keep=12, budget 40000 → lazy
// threshold 48000) with messages big enough that the 12-message tail alone
// exceeds the threshold (~55K). This is the config/session shape the user
// reported "块满了 → 压缩 → 缓存命中率 1%" from.
{
  const { name, rows, compactions } = await runScenario(baseUrl,
    `C user-defaults (maxBatches=${maxBatches}, keep=12, budget 40000, big tail)`,
    cfg(baseUrl, {
      pruneChainMaxBatches: maxBatches,
      pruneKeepRecent: 12,
      pruneBudgetTokens: 40000,
      pruneBatchSize: 12,
    }), 30, 45, 1, bigHistLine)
  report(name, rows, compactions)
}

// Scenario E: FAITHFUL reproduction of the user's real setup — the config is the
// plugin default (budget 40000 → lazy threshold 48000, keep 12, batchSize 12,
// maxBatches 20), the overhead matches their earlier logs (system ≈3.5K +
// tools ≈15.8K ≈ 19K), and each message ≈2.5K tokens so the 12-message tail
// alone (~30K) plus overhead pushes the request marginally over the threshold
// (~49K > 48K). This is the "块满了 → 压缩 → 缓存命中率 1%" shape.
{
  const system = '系'.repeat(3569)
  const tools = [{ type: 'function', function: { name: 'f', description: '工'.repeat(15826) } }]
  const { name, rows, compactions } = await runScenario(
    baseUrl,
    `E user-real overhead, marginal tail (maxBatches=${maxBatches}, keep=12, budget 40000)`,
    cfg(baseUrl, { pruneChainMaxBatches: maxBatches, pruneKeepRecent: 12, pruneBudgetTokens: 40000, pruneBatchSize: 12 }),
    40, 70, 1, (tag, fact) => bigHistLine(tag, fact, 180), system, tools)
  report(name, rows, compactions)
}

// Scenario F: USER's session shape with their budget change (60000) — real
// overhead (~19K), ~330-token messages, 3 messages per turn. A 12-msg roll
// batch (~4K) barely drops a ~72K-threshold request, so without hysteresis the
// request crosses the threshold again after a turn or two → "两次滚动间隔短".
{
  const system = '系'.repeat(3569)
  const tools = [{ type: 'function', function: { name: 'f', description: '工'.repeat(15826) } }]
  const { name, rows, compactions } = await runScenario(
    baseUrl,
    `F user budget 60000, real overhead, 3 msgs/turn`,
    cfg(baseUrl, { pruneChainMaxBatches: maxBatches, pruneKeepRecent: 12, pruneBudgetTokens: 60000, pruneBatchSize: 12 }),
    165, 20, 1, histLine, system, tools, 3)
  report(name, rows, compactions)
}

server.close()
