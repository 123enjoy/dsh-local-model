/**
 * Outbound token distiller: wraps the `llm/stream` waterfall so long content
 * in every request to a cloud provider is first compressed by the local
 * model — the cloud pays tokens for the dense summary, not the raw dump.
 *
 * Mechanics:
 * - The waterfall's `next()` re-passes the ORIGINAL options, so a modified
 *   request is re-dispatched through `this.stream(copy)`; a WeakSet marks our
 *   own copies to break the recursion.
 * - Message content is immutable and id-keyed: each message is distilled at
 *   most once, and the compressed copy is reused on every later step.
 * - PERSISTENT CACHE: the id → distilled-content map is written to disk
 *   (~/.dsh/dsh-local-model-distill-cache.json, configurable), so after a
 *   host restart the resumed history is served from cache instead of being
 *   re-distilled (the cause of multi-minute stalls after restart).
 * - FROZEN PRUNE CHAIN: history pruning writes each summary block ONCE and
 *   never rewrites old blocks (newly-pruned messages roll into NEW appended
 *   blocks); only a deep compaction past pruneChainMaxBatches rewrites the
 *   whole chain. This keeps the outbound request byte-stable across turns so
 *   the cloud provider's prompt cache keeps hitting on the summarized history.
 * - PER-REQUEST BUDGET: distillBudgetMs caps how long one request may spend
 *   distilling; on expiry the remaining COLD messages pass through raw, so a
 *   cold cache can never stall a request indefinitely. Cache-hit messages are
 *   never blocked by the budget, so the raw/distilled boundary is deterministic.
 * - Compressed texts are wrapped in ⟦本地蒸馏⟧ markers so the cloud model
 *   knows it is reading a summary and can re-fetch originals via tools.
 * - `distillOnError: 'pass' | 'block'` decides what happens when the local
 *   distiller fails: send the original text, or terminate the stream with an
 *   error finish.
 */

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { renameSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { distillText, estimateTokens, historySummarize } from './compress.js'

/** Bounded FIFO cache: message id → { h: content hash, d: distilled content | null }. */
const DEFAULT_CACHE_LIMIT = 50000
/**
 * Config-resolved cache limit. Large enough that long agentic sessions never
 * evict an old distilled message: eviction would force a RE-distillation, and
 * a non-deterministic re-distill changes the request bytes → cloud cache miss.
 */
const cacheLimitOf = (cfg) => cfg.distillCacheLimit ?? DEFAULT_CACHE_LIMIT
/**
 * Real-token calibration factor. The plugin's estimateTokens is a heuristic
 * that typically UNDERCOUNTS the provider's real tokenizer (≈1.25× for mixed
 * CJK/code). Set tokenEstimateFactor ≈ that ratio so pruneBudgetTokens and the
 * notice numbers are expressed in REAL tokens, matching the cloud bill.
 */
const factorOf = (cfg) => cfg.tokenEstimateFactor ?? 1
/** Token estimate scaled to real tokens for cloud-facing accounting. */
const estFor = (cfg, text) => Math.round(estimateTokens(text) * factorOf(cfg))

/** Thrown when a block fails distillation under the 'block' policy. */
class DistillBlockError extends Error {}

/** Marker pair wrapping a distilled text (announced to the cloud model). */
const MARK_OPEN = '⟦本地蒸馏·原文{0}字符·≈{1}→{2} tokens（-{3}%）⟧'
const MARK_CLOSE = '⟦蒸馏结束⟧'
/** Static prefix (MARK_OPEN before substitutions) used for skip detection. */
export const MARK_OPEN_PREFIX = '⟦本地蒸馏'

/** Parse one marker line back into stats: [chars, tokensBefore, tokensAfter, pct]. */
const MARK_LINE_RE = /^⟦本地蒸馏·原文(\d+)字符·≈(\d+)→(\d+) tokens（([+-]?\d+)%）⟧/

/** History-prune markers: a span of old messages replaced by one local summary. */
const PRUNE_OPEN = '⟦历史剪枝·省略{0}条消息·保留最近{1}条·原文≈{2}→{3} tokens（-{4}%）⟧'
const PRUNE_CLOSE = '⟦剪枝结束⟧'
export const PRUNE_OPEN_PREFIX = '⟦历史剪枝'

/** system + tools fixed overhead tokens (scaled) — part of the sent request. */
function overheadTokens(cfg, options) {
  const f = factorOf(cfg)
  const sys = typeof options.system === 'string' ? Math.round(estimateTokens(options.system) * f) : 0
  const tools = Array.isArray(options.tools) && options.tools.length > 0 ? Math.round(estimateTokens(JSON.stringify(options.tools)) * f) : 0
  return sys + tools
}

/** Token estimate of every BILLED fragment inside a message list (× factor).
 *  Includes reasoning_content (tool-call turns) and tool-call arguments — the
 *  deepseek wire bills them, so the prune budget must see them. */
export function estimateMessagesTokens(messages, factor = 1) {
  let total = 0
  const parts = []
  for (const m of messages ?? []) collectBilledText(m, parts)
  for (const t of parts) total += Math.round(estimateTokens(t) * factor)
  return total
}

/** All text blocks of one message, in order. */
function flattenMessageText(message) {
  const parts = []
  const walk = (blocks) => {
    for (const b of blocks ?? []) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text !== '') parts.push(b.text)
      else if (b?.type === 'tool-result' && Array.isArray(b.content)) walk(b.content)
    }
  }
  walk(message?.content)
  return parts
}

/**
 * Cache key for one prune block: the batch's CONTENT signature.
 * DSH regenerates message ids on every request, so id-based keys would never
 * cache-hit (and would make the frozen chain invalidate every turn). Content is
 * stable, so content is the right key.
 */
function pruneKeyOf(pruned) {
  return '__prune__' + hashContent(pruned.map((m) => m?.content))
}

/** Content fingerprint of the first `count` messages (id-independent). */
function coveredHashOf(messages, count) {
  return hashContent(messages.slice(0, count).map((m) => m?.content))
}

/**
 * DSH's internal message schema is NOT OpenAI's: tool results are role:'user'
 * messages carrying content [{ type:'tool-result', toolCallId, ... }] blocks,
 * and assistant tool calls are content [{ type:'tool-call', id, ... }] blocks —
 * there is no role:'tool' and no top-level `tool_calls` array. Guards must
 * therefore detect both shapes, or they silently never fire (the original bug:
 * a cut landed on a tool-result user message, whose tool-call assistant was
 * pruned, and the provider rejected the orphaned tool message).
 */
const hasToolResultBlock = (m) =>
  m?.role === 'tool' ||
  (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool-result'))
const hasToolCallBlock = (m) =>
  m?.role === 'assistant' &&
  ((Array.isArray(m?.tool_calls) && m.tool_calls.length > 0) ||
   (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool-call')))

/**
 * Collect the strings the provider ACTUALLY bills for one message's blocks,
 * mirroring dsh-llm-deepseek's serializeAssistant/serializeMessages:
 *   - text        → message content
 *   - reasoning   → `reasoning_content`, but ONLY on tool-call turns — the
 *                   adapter drops it otherwise ("required by thinking-mode
 *                   passback")
 *   - tool-call   → `tool_calls[].function.arguments`
 *   - tool-result → recursed (wire `role:'tool'` message content)
 * The old estimator counted text (+ tool-result) only, so on a real
 * deepseek-v4-flash agentic session (heavy reasoning_content) it read ~20% low
 * and the prune budget fired late — the wire request ran ~16K tokens past the
 * plugin's own estimate. Counting the billed blocks makes budget / prune /
 * diagnostic numbers match the provider meter (DSH's dsh-token-meter prices
 * these same blocks).
 */
function collectBilledText(message, out) {
  const billsReasoning =
    message?.role === 'assistant' &&
    (message.content ?? []).some((b) => b?.type === 'tool-call')
  const walk = (blocks, withReasoning) => {
    for (const b of blocks ?? []) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string') out.push(b.text)
      else if (b.type === 'reasoning' && typeof b.text === 'string' && withReasoning) out.push(b.text)
      else if (b.type === 'tool-call' && typeof b.arguments === 'string') out.push(b.arguments)
      else if (b.type === 'tool-result' && Array.isArray(b.content)) walk(b.content, false)
    }
  }
  walk(message?.content, billsReasoning)
  return out
}

/**
 * Back the next batch's end up so the rolled batch never orphans a tool
 * exchange: the first message after the batch must not be a tool-result whose
 * tool-call assistant is inside the batch, and the last message of the batch
 * must not be an assistant-with-tool-calls whose results are outside it.
 */
function adjustBatchBoundary(messages, start, end) {
  while (end > start && hasToolResultBlock(messages[end])) end--
  while (end > start && hasToolCallBlock(messages[end - 1])) end--
  return end
}

/**
 * Conversation-scoped chain snapshot key. DSH runs multiple threads/agents
 * through the same global hook, so a single shared chain would be corrupted by
 * cross-talk (each thread's first message differs → the shared chain resets
 * every request). Keying by the first message's content isolates them.
 */
function conversationKeyOf(messages) {
  return PRUNE_SNAP_KEY + '__' + hashContent(messages?.[0]?.content ?? '')
}

/** Load the persisted frozen-chain snapshot for one conversation, or null. */
function loadChain(cache, key) {
  try {
    const raw = cache.get(key)
    if (raw !== undefined && typeof raw.d === 'string') {
      const snap = JSON.parse(raw.d)
      if (Array.isArray(snap?.ids) && Array.isArray(snap?.blocks)) return snap
    }
  } catch { /* corrupted snapshot: rebuild below */ }
  return null
}

/**
 * Build the source text for one prune block from its messages. Source is the
 * NEWER side of the batch (the recent-ish old history carries the context
 * worth keeping), truncated to pruneMaxSourceChars.
 */
function pruneSourceFromMessages(cfg, pruned) {
  const parts = []
  let chars = 0
  outer:
  for (let i = pruned.length - 1; i >= 0; i--) {
    for (const t of flattenMessageText(pruned[i])) {
      if (chars >= cfg.pruneMaxSourceChars) break outer
      const take = Math.min(t.length, cfg.pruneMaxSourceChars - chars)
      parts.push(t.slice(t.length - take))
      chars += take
    }
  }
  parts.reverse()
  return parts.join('\n\n')
}

/** Strip the PRUNE_OPEN/PRUNE_CLOSE marker lines from a block text. */
function stripPruneMarkers(text) {
  const lines = text.split('\n')
  const body = []
  for (const line of lines) {
    if (line.startsWith(PRUNE_OPEN_PREFIX) || line === PRUNE_CLOSE) continue
    body.push(line)
  }
  return body.join('\n')
}

/**
 * Build (or fetch from cache) ONE immutable prune block wrapping `source`.
 * `omittedCount`/`keptCount` and the token delta are baked into the marker.
 * Returns null on any failure — the caller then leaves that span untouched.
 * A block is cached by its key and never regenerated once written, which is
 * what keeps the cloud cache hitting on the summarized history.
 */
async function summarizeToPruneBlock(cfg, cache, source, omittedCount, keptCount, key) {
  const hit = cache.get(key)
  if (hit !== undefined && typeof hit.d === 'string') return hit.d
  if (source.trim() === '') return null
  const beforeTokens = estFor(cfg, source)
  let summary
  try {
    summary = await historySummarize(cfg, source)
  } catch (err) {
    cfg.logger?.warn?.(`dsh-local-model: 历史剪枝摘要失败（${err?.message ?? err}），本次按原文发送`)
    return null
  }
  const afterTokens = estFor(cfg, summary)
  const pct = Math.round((1 - afterTokens / beforeTokens) * 100)
  const text = PRUNE_OPEN
    .replace('{0}', String(omittedCount))
    .replace('{1}', String(keptCount))
    .replace('{2}', String(beforeTokens))
    .replace('{3}', String(afterTokens))
    .replace('{4}', String(pct)) + '\n' + summary + '\n' + PRUNE_CLOSE
  cache.set(key, { h: '1', d: text })
  if (cache.size > cacheLimitOf(cfg)) cache.delete(cache.keys().next().value)
  cfg.persist()
  return text
}

/** Build (or fetch from cache) one prune block for a batch of messages. */
function makePruneSummary(cfg, cache, pruned, keptCount, key) {
  return summarizeToPruneBlock(cfg, cache, pruneSourceFromMessages(cfg, pruned), pruned.length, keptCount, key)
}

/**
 * Deep compaction of a frozen chain: merge every block into a single new block.
 * This is the ONE place the whole chain gets rewritten, and therefore the one
 * (rare) event that invalidates the cloud cache for the entire summarized
 * history. Bounded by pruneChainMaxBatches so it fires at most once per
 * `pruneChainMaxBatches` rollovers — the deliberate cost of bounding the
 * chain's token footprint.
 */
async function compactChain(cfg, cache, chain, keptCount) {
  // 合并源截断到 pruneMaxSourceChars（较新端整块优先）——链可能几十块，全量喂
  // 本地模型会超 distillNumCtx 上下文、摘要调用直接失败，导致链永远压不掉、
  // 请求永远超预算、尾部每轮位移缓存全 miss。截断让深度合并总能成功，链回 1 块。
  const parts = []
  let chars = 0
  for (let i = chain.blocks.length - 1; i >= 0; i--) {
    const t = stripPruneMarkers(chain.blocks[i].text)
    if (chars + t.length > cfg.pruneMaxSourceChars && parts.length > 0) break
    parts.unshift(t)
    chars += t.length
  }
  const source = parts.join('\n\n')
  if (source.trim() === '') return null
  const key = '__compact__' + hashContent(chain.blocks.map((b) => b.key))
  const text = await summarizeToPruneBlock(cfg, cache, source, chain.ids.length, keptCount, key)
  if (text === null) return null
  return { ids: chain.ids, blocks: [{ key, text }] }
}

/** Serialize a chain into its summary user messages (fresh ids each request). */
function chainSummaryMessages(chain) {
  return chain.blocks.map((b) => ({
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: b.text }],
    source: { kind: 'plugin', plugin: 'local-model' },
  }))
}

/**
 * Break the SENT request's tokens into 系统提示词 / 工具 / 对话消息（历史摘要 +
 * 本次对话）for the notice card. History-summary messages are the frozen-chain
 * prune blocks (text starting with PRUNE_OPEN_PREFIX); every other message
 * (including tool results riding the user role) counts as the current
 * conversation. Tool definitions are estimated from the serialized tools array.
 */
function estimateBreakdown(messages, system, tools, factor = 1) {
  const sys = typeof system === 'string' ? Math.round(estimateTokens(system) * factor) : 0
  const toolsTokens = Array.isArray(tools) && tools.length > 0 ? Math.round(estimateTokens(JSON.stringify(tools)) * factor) : 0
  let history = 0
  let conv = 0
  for (const m of messages ?? []) {
    const isHistory = (m?.content ?? []).some(
      (b) => b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith(PRUNE_OPEN_PREFIX)
    )
    const parts = []
    collectBilledText(m, parts)
    const t = parts.reduce((s, x) => s + Math.round(estimateTokens(x) * factor), 0)
    if (isHistory) history += t
    else conv += t
  }
  return { sys, tools: toolsTokens, history, conv }
}

/**
 * Replace the oldest messages of an over-budget request with a FROZEN CHAIN of
 * local-model history summaries, keeping the most recent `pruneKeepRecent`
 * messages intact. Never touches storage/GUI: only the outbound copy is
 * pruned, so full history stays recoverable. Returns null when pruning is
 * disabled, unnecessary, unsafe, or failed.
 *
 * Cache-friendliness (why this is not a single regenerating summary):
 *   - Every block is written once and never regenerated while the rolled
 *     message set stays a prefix of the request. The chain therefore holds a
 *     byte-stable prefix across turns, so the cloud provider's prompt cache
 *     keeps hitting on the summarized history.
 *   - Newly-pruned messages roll into NEW blocks appended to the chain (up to
 *     pruneMaxNewBlocks per request), never into a rewrite of old blocks.
 *   - Only when the chain exceeds pruneChainMaxBatches blocks is it merged
 *     into one block — the single rare event that invalidates the whole
 *     history cache, the deliberate cost of bounding the chain's size.
 * The snapshot is persisted in the shared cache, so a restart does not force
 * an immediate regeneration either.
 */
const PRUNE_SNAP_KEY = '__prune__snap'

async function pruneOptions(cfg, cache, options) {
  if (cfg.pruneEnabled === false || cfg.pruneBudgetTokens <= 0) return null
  const messages = options.messages ?? []
  const keep = Math.max(1, cfg.pruneKeepRecent ?? 12)
  if (messages.length <= keep) return null
  // 预算判定必须包含 system + tools：它们是发送请求的一部分，否则请求会超预算 ~20-30K 却仍被判"未超阈值"。
  const messageTokens = estimateMessagesTokens(messages, factorOf(cfg))
  const overhead = overheadTokens(cfg, options)
  const totalTokens = messageTokens + overhead

  const batchSize = Math.max(1, cfg.pruneBatchSize ?? 12)
  const maxBatches = Math.max(1, cfg.pruneChainMaxBatches ?? 20)
  const maxNewBlocks = Math.max(1, cfg.pruneMaxNewBlocks ?? 3)
  // Lazy roll threshold: the un-rolled tail is only compacted once the request
  // materially exceeds the budget. Between rolls the tail is byte-stable, so the
  // cloud prompt cache keeps hitting on it. (The previous design caught the
  // boundary up to messages.length - keep EVERY turn, shifting the tail and
  // dropping the hit rate to roughly chain-only ≈ 60%.)
  const threshold = cfg.pruneBudgetTokens * (cfg.pruneRollMargin ?? 1.5)

  const snapKey = conversationKeyOf(messages)
  let chain = loadChain(cache, snapKey)
  // 用「覆盖前缀的内容指纹」验证链是否仍有效——DSH 每轮重建消息对象、id 不稳定，
  // 用 id 匹配会每轮失效导致链重建、请求反弹。内容稳定，所以按内容指纹匹配。
  const prefixSame = chain !== null && messages.length >= chain.ids.length &&
    chain.coveredHash === coveredHashOf(messages, chain.ids.length)
  if (chain !== null && !prefixSame) chain = null
  // No usable chain yet and the whole request fits the lazy threshold: leave it
  // verbatim — every message is then byte-stable, so the cache hits everything.
  if (chain === null && totalTokens <= threshold) return null

  const prevChainLen = chain?.ids?.length ?? 0
  if (chain === null) chain = { ids: [], blocks: [] }
  // 持久化链快照（含覆盖前缀的内容指纹，用于下次按内容验证；frontHashes 用于失效时定位）。
  const persistChain = () => {
    cache.set(snapKey, { h: 'snap', d: JSON.stringify({
      ids: chain.ids,
      blocks: chain.blocks,
      coveredHash: coveredHashOf(messages, chain.ids.length),
      frontHashes: messages.slice(0, Math.min(chain.ids.length, 3)).map((m) => hashContent(m?.content)),
    }) })
    if (cache.size > cacheLimitOf(cfg)) cache.delete(cache.keys().next().value)
    cfg.persist()
  }
  const chainTokens = () => chain.blocks.reduce((s, b) => s + estFor(cfg, b.text), 0)
  // Messages rolled into the chain THIS request (used by the notice card: it
  // reports the per-request delta, not the ever-growing cumulative total).
  let newlyCompressed = 0

  // Roll the oldest un-rolled messages into frozen blocks until the request
  // fits the lazy threshold; never roll the most recent `keep` messages. The
  // initial build (no chain) is allowed more blocks so it catches up faster.
  // When the request is FAR over the threshold (huge session / chain reset),
  // roll with bigger batches and a higher cap so it recovers fast — mild
  // fidelity loss beats a context overflow.
  const rollCap = prevChainLen === 0 ? Math.max(maxNewBlocks, 8) : maxNewBlocks
  const initialRequest = chainTokens() + estimateMessagesTokens(messages.slice(chain.ids.length), factorOf(cfg)) + overhead
  const overage = threshold > 0 ? initialRequest / threshold : 1
  const effBatch = overage > 2 ? Math.max(batchSize * 3, 48) : batchSize
  // 超阈值时单次滚动上限要足以把请求拉回阈值内——否则链追不上会话，每轮都滚、
  // 尾部字节每轮位移，云端前缀缓存全 miss（实测命中率归零）。上限随超支程度
  // 放大（封顶 48 块，48×effBatch≈2300 条/请求），让链在 1~3 个请求内追平，
  // 之后回到惰性模式（每跨过阈值才滚一次）。块大多命中持久化缓存，装配成本低。
  const effCap = overage > 1
    ? Math.max(rollCap, Math.min(48, Math.max(12, Math.round(overage) * 3)))
    : rollCap
  let boundary = chain.ids.length
  let newBlocks = 0
  while (boundary < messages.length - keep && newBlocks < effCap) {
    const requestTokens = chainTokens() + estimateMessagesTokens(messages.slice(boundary), factorOf(cfg)) + overhead
    if (requestTokens <= threshold) break
    const batchEnd = adjustBatchBoundary(messages, boundary, Math.min(boundary + effBatch, messages.length - keep))
    if (batchEnd <= boundary) break
    const batch = messages.slice(boundary, batchEnd)
    const text = await makePruneSummary(cfg, cache, batch, messages.length - batch.length, pruneKeyOf(batch))
    if (text === null) {
      cfg.logger?.warn?.(`dsh-local-model: 剪枝滚动本地摘要失败（idx ${boundary}..${batchEnd}），停止滚动`)
      break
    }
    chain.blocks.push({ key: pruneKeyOf(batch), text })
    for (const m of batch) chain.ids.push(m?.id ?? '')
    boundary = batchEnd
    newBlocks++
  }
  newlyCompressed = chain.ids.length - prevChainLen
  if (chain.ids.length === 0) return null
  if (newBlocks > 0) persistChain()

  // Deep compaction: the chain grew past its budget — merge into one block.
  if (chain.blocks.length > maxBatches) {
    const merged = await compactChain(cfg, cache, chain, messages.length - chain.ids.length)
    if (merged !== null) {
      chain = merged
      persistChain()
    }
  }

  const summaryMsgs = chainSummaryMessages(chain)
  const visible = messages.slice(chain.ids.length)
  const newOptions = { ...options, messages: [...summaryMsgs, ...visible] }
  const afterTokens = estimateMessagesTokens(newOptions.messages, factorOf(cfg))
  let mark = chain.blocks[0]?.text ?? ''
  mark = mark === '' ? '' : (mark.indexOf('\n') === -1 ? mark : mark.slice(0, mark.indexOf('\n')))
  return {
    options: newOptions,
    prunedCount: chain.ids.length,
    newlyCompressed,
    blockCount: chain.blocks.length,
    keptCount: messages.length - chain.ids.length,
    beforeTokens: messageTokens,
    afterTokens,
    pct: Math.round((1 - afterTokens / messageTokens) * 100),
    mark,
    pruneKey: '__chain__' + hashContent(chain.blocks.map((b) => b.key)),
  }
}

/** Collect the marker (first) line of every distilled text block, recursively. */
function collectMarkLines(blocks, out) {
  for (const block of blocks ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.startsWith(MARK_OPEN_PREFIX)) {
      const nl = block.text.indexOf('\n')
      out.push(nl === -1 ? block.text : block.text.slice(0, nl))
    } else if (block?.type === 'tool-result' && Array.isArray(block.content)) {
      collectMarkLines(block.content, out)
    }
  }
  return out
}

/** Aggregate marker lines into a one-line summary for the collapsed card row. */
function summarizeMarks(marks) {
  if (marks.length === 1) return marks[0]
  let chars = 0, before = 0, after = 0
  for (const mark of marks) {
    const m = MARK_LINE_RE.exec(mark)
    if (m === null) continue
    chars += Number(m[1]); before += Number(m[2]); after += Number(m[3])
  }
  if (before === 0) return marks[0]
  const pct = Math.round((1 - after / before) * 100)
  return `⟦本地蒸馏⟧ 本次请求 ${marks.length} 处压缩，合计 原文${chars}字符·≈${before}→${after} tokens（-${pct}%）`
}

/** All distill marker lines present in a message list — not just this turn's. */
function collectAllDistillMarks(messages) {
  const marks = []
  for (const m of messages ?? []) collectMarkLines(m?.content, marks)
  return marks
}

/**
 * One-line distill comparison for the notice: the single marker verbatim when
 * there's exactly one, else a summed aggregate; null when nothing matches.
 */
function aggregateDistill(marks) {
  let chars = 0, before = 0, after = 0, n = 0
  for (const mark of marks) {
    const m = MARK_LINE_RE.exec(mark)
    if (m === null) continue
    chars += Number(m[1]); before += Number(m[2]); after += Number(m[3]); n++
  }
  if (n === 0) return null
  if (n === 1) return marks[0]
  const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0
  return `合计 ${n} 处：原文${chars}字符 · ≈${before}→${after} tokens（-${pct}%）`
}

/**
 * Locate the agent whose session holds the tail of this request's messages.
 * Tries the plugin context first, then the llm runtime context (the root app
 * context always hosts the agents service), so notices survive any context
 * scoping quirks.
 */
function findAgentForMessages(ctx, runtime, messages) {
  const listFrom = (c) => c?.agents?.list?.()
  const agents = listFrom(ctx) ?? listFrom(runtime?.ctx) ?? []
  if (!Array.isArray(agents) || agents.length === 0) return null
  if (agents.length === 1) return agents[0]
  const tailIds = []
  for (let i = messages.length - 1; i >= 0 && tailIds.length < 8; i--) {
    const id = messages[i]?.id
    if (typeof id === 'string' && id !== '') tailIds.push(id)
  }
  if (tailIds.length === 0) return null
  for (const agent of agents) {
    const events = agent.session?.events
    if (!Array.isArray(events)) continue
    const stop = Math.max(0, events.length - 500)
    for (let j = events.length - 1; j >= stop; j--) {
      const data = events[j]?.data
      const id = data?.id ?? data?.message?.id
      if (typeof id === 'string' && tailIds.includes(id)) return agent
    }
  }
  return null
}

/** FNV-1a of the serialized content — stable cheap fingerprint. */
function hashContent(content) {
  let h = 0x811c9dc5
  const s = JSON.stringify(content)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/**
 * Distill one text value when it exceeds the length gate.
 * 'pass' policy: distillation failure returns the original text.
 */
export async function maybeDistill(cfg, value) {
  if (value.length < cfg.distillMinChars) return value
  // Already a distill marker (e.g. a local_model_distill result, or a cached
  // distilled message) or a prune summary: skip re-distillation.
  if (value.startsWith(MARK_OPEN_PREFIX) || value.startsWith(PRUNE_OPEN_PREFIX)) return value
  try {
    const distilled = await distillText(cfg, value)
    if (distilled === value) return value
    const before = estFor(cfg, value)
    const after = estFor(cfg, distilled)
    const pct = Math.round((1 - after / before) * 100)
    return MARK_OPEN
      .replace('{0}', String(value.length))
      .replace('{1}', String(before))
      .replace('{2}', String(after))
      .replace('{3}', String(pct)) + '\n' + distilled + '\n' + MARK_CLOSE
  } catch (err) {
    if (cfg.distillOnError === 'block') throw new DistillBlockError(err?.message ?? String(err))
    cfg.logger?.warn?.(`dsh-local-model: 本地蒸馏失败，按 distillOnError=pass 发送原文（${err?.message ?? err}）`)
    return value
  }
}

/** Distill a content-block array; returns the same array when nothing changed. */
async function distillBlocks(cfg, blocks) {
  let changed = false
  const out = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      const distilled = await maybeDistill(cfg, block.text)
      if (distilled !== block.text) {
        changed = true
        out.push({ ...block, text: distilled })
        continue
      }
    } else if (block?.type === 'tool-result' && Array.isArray(block.content)) {
      const inner = await distillBlocks(cfg, block.content)
      if (inner !== block.content) {
        changed = true
        out.push({ ...block, content: inner })
        continue
      }
    }
    out.push(block)
  }
  return changed ? out : blocks
}

/**
 * Distill one message. Cached by CONTENT hash (not message id — DSH regenerates
 * ids every request, so id keys would never hit), persisted across restarts.
 */
async function distillMessage(cfg, cache, message) {
  if (!cfg.distillRoles.includes(message.role)) return message
  const key = hashContent(message.content)
  const hit = cache.get(key)
  if (hit !== undefined) {
    return hit.d === null ? message : { ...message, content: hit.d }
  }
  const content = await distillBlocks(cfg, message.content)
  const record = { h: key, d: content === message.content ? null : content }
  cache.set(key, record)
  if (cache.size > cacheLimitOf(cfg)) cache.delete(cache.keys().next().value)
  cfg.persist()
  return record.d === null ? message : { ...message, content: record.d }
}

/** Build the distilled GenerateOptions (identity-preserved when nothing shrank). */
async function distillOptions(cfg, cache, options) {
  const started = Date.now()
  const messages = []
  let changed = false
  let budgetExhausted = false
  for (const message of options.messages ?? []) {
    if (budgetExhausted) {
      messages.push(message)
      continue
    }
    // Cache hits distill for free (no local call), so they must not consume the
    // wall-clock budget — otherwise the raw/distilled boundary would flicker
    // with local-model latency and change the request bytes turn to turn. Only
    // genuinely cold messages are budget-gated, and once distilled they join
    // the hit path forever.
    const h = hashContent(message.content)
    const hit = cache.get(h)
    if (hit !== undefined) {
      if (hit.d === null) {
        messages.push(message)
        continue
      }
      changed = true
      messages.push({ ...message, content: hit.d })
      continue
    }
    if (Date.now() - started > cfg.distillBudgetMs) {
      if (!budgetExhausted) cfg.logger?.warn?.('dsh-local-model: 蒸馏预算耗尽，剩余冷消息按原文直传')
      budgetExhausted = true
      messages.push(message)
      continue
    }
    const distilled = await distillMessage(cfg, cache, message)
    if (distilled !== message) changed = true
    messages.push(distilled)
  }
  let system = options.system
  if (cfg.distillSystem && typeof system === 'string' && system !== '') {
    const distilledSystem = await maybeDistill(cfg, system)
    if (distilledSystem !== system) {
      changed = true
      system = distilledSystem
    }
  }
  if (!changed) return options
  return { ...options, messages, system }
}

/** Disk cache load/save with a debounced atomic write. */
function makePersister(cfg) {
  const path = cfg.distillCachePath
  const cache = new Map()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry && typeof entry.id === 'string' && typeof entry.h === 'string') {
          cache.set(entry.id, { h: entry.h, d: entry.d })
        }
      }
    }
  } catch { /* first run: no cache yet */ }
  let timer = null
  const persist = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      try {
        mkdirSync(dirname(path), { recursive: true })
        const tmp = path + '.tmp'
        writeFileSync(tmp, JSON.stringify([...cache.entries()].map(([id, v]) => ({ id, h: v.h, d: v.d }))))
        renameSync(tmp, path)
      } catch {
        // Never let cache I/O break model calls.
      }
    }, 1500)
  }
  return { cache, persist }
}

/**
 * Install the llm/stream wrapper. Runs outermost (prepend) so everything
 * downstream — other wrappers, loggers, the adapter — only ever sees the
 * distilled request.
 */
export function installOutboundDistiller(ctx, cfg) {
  const owned = new WeakSet()
  const { cache, persist } = makePersister(cfg)
  // ctx.logger is a cordis built-in in the web profile, but resolve it
  // lazily and tolerate absence so the distiller never breaks model calls.
  // Resolve the host logger, MIRRORING to console so diagnostics always surface
  // in the terminal (DSH routes ctx.logger elsewhere). `.info`/`.warn`/`.debug`
  // exist on both. Never throws into the stream path.
  const logger = () => {
    try {
      if (ctx.logger?.info && ctx.logger?.warn) {
        return {
          info: (...a) => { try { ctx.logger.info(...a) } catch { /* ignore */ } console.log(...a) },
          warn: (...a) => { try { ctx.logger.warn(...a) } catch { /* ignore */ } console.warn(...a) },
          debug: (...a) => { try { ctx.logger.debug?.(...a) } catch { /* ignore */ } console.log(...a) },
        }
      }
    } catch { /* fall through to console */ }
    return console
  }
  const runtimeCfg = { ...cfg, get logger() { return logger() }, persist }
  /** Content fingerprints already surfaced as a request-level notice (retries
   *  and re-sent history skip; only NEW distillation events get a card). DSH
   *  regenerates message ids every request, so dedup is by content, not id. */
  const noticedIds = new Set()
  /** Collect marker lines for the messages that were newly distilled. */
  const freshDistillMarks = (options, distilled, freshIds) => {
    const marks = []
    const beforeMessages = options.messages ?? []
    const afterMessages = distilled.messages ?? []
    for (let i = 0; i < afterMessages.length; i++) {
      if (afterMessages[i] === beforeMessages[i]) continue
      const ck = hashContent(beforeMessages[i]?.content ?? '')
      if (noticedIds.has(ck)) continue
      freshIds.push(ck)
      collectMarkLines(afterMessages[i]?.content, marks)
    }
    if (distilled.system !== options.system && typeof distilled.system === 'string' && distilled.system.startsWith(MARK_OPEN_PREFIX)) {
      const nl = distilled.system.indexOf('\n')
      marks.push(nl === -1 ? distilled.system : distilled.system.slice(0, nl))
    }
    return marks
  }
  /**
   * Append a GUI-visible notice (context card, form:'notice') recording one
   * processed request (history-pruned and/or distilled), right before the
   * stream starts. The session keeps the originals; the notice is the only
   * durable trace that the cloud call itself was transformed. Only fires for
   * work not yet noticed, so cached re-processing does not spam cards.
   * Never throws into the stream path.
   */
  const appendProcessNotice = (options, distilled, runtime, pruneInfo) => {
    const alwaysNotice = runtimeCfg.distillNoticeAlways === true
    if (runtimeCfg.distillNotice === false && !alwaysNotice && pruneInfo === null) return
    const freshIds = []
    const marks = freshDistillMarks(options, distilled, freshIds)
    // When distillNoticeAlways is on and nothing was compressed, still emit
    // a one-line stats notice so the user sees input token count every turn.
    const noCompression = marks.length === 0 && pruneInfo === null
    if (noCompression && !alwaysNotice) return
    const pruneKeyPart = pruneInfo === null ? '' : 'p|' + pruneInfo.pruneKey
    let key
    if (noCompression) {
      // For always-on stats, use the last user message ID to ensure uniqueness per request
      const lastUserMsg = [...(options.messages ?? [])].reverse().find((m) => m?.role === 'user')
      key = 'stats|' + (lastUserMsg?.id ?? Date.now().toString(36))
    } else {
      key = pruneKeyPart + (marks.length ? '|m|' + [...freshIds].sort().join(',') + '|' + marks.join('|') : '')
    }
    if (noticedIds.has(key)) return
    const messages = options.messages ?? []
    const agent = findAgentForMessages(ctx, runtime, messages)
    if (agent === null) {
      runtimeCfg.logger?.warn?.('dsh-local-model: 请求已被压缩处理，但未能定位所属会话，跳过处理通知卡片')
      return
    }
    noticedIds.add(key)
    for (const id of freshIds) noticedIds.add(id)
    if (noticedIds.size > 400) {
      for (const id of [...noticedIds].slice(0, 200)) noticedIds.delete(id)
    }
    // Input total uses the ORIGINAL (pre-prune) size so the savings number is
    // honest when history pruning replaced the oldest messages; with no pruning
    // the passed messages already are the originals. System prompt and tool
    // definitions are fixed overhead — counted in both before and after, so the
    // reported savings stays honest.
    const { sys, tools, history, conv } = estimateBreakdown(distilled.messages ?? [], distilled.system, distilled.tools, factorOf(runtimeCfg))
    const afterTotal = sys + tools + history + conv
    const origMessages = pruneInfo !== null ? pruneInfo.beforeTokens : estimateMessagesTokens(messages, factorOf(runtimeCfg))
    const origTotal = origMessages + sys + tools
    const inputK = (origTotal / 1000).toFixed(1)
    const savedPct = origTotal > 0 ? Math.round((1 - afterTotal / origTotal) * 100) : 0
    const fmtK = (t) => (t / 1000).toFixed(1) + 'K'
    const allMarks = collectAllDistillMarks(distilled.messages ?? [])
    const distillTotal = aggregateDistill(allMarks)
    const freshNote = marks.length > 0 ? `，本轮蒸馏 ${marks.length} 处` : `（含 ${allMarks.length} 处已蒸馏内容）`
    const blocks = pruneInfo?.blockCount ?? 0
    const covered = pruneInfo?.prunedCount ?? 0
    // Composition bullets: 系统提示词 / 工具 / 对话消息（历史摘要 · 本次对话）+ 合计.
    const compose = []
    if (sys > 0) compose.push(`• 系统提示词  ≈ ${fmtK(sys)} tokens`)
    if (tools > 0) compose.push(`• 工具       ≈ ${fmtK(tools)} tokens`)
    if (history > 0) {
      compose.push(`• 对话消息    ≈ ${fmtK(history + conv)} tokens`)
      compose.push(`    历史摘要   ≈ ${fmtK(history)} tokens（${blocks} 块 · 覆盖 ${covered} 条）`)
      compose.push(`    本次对话   ≈ ${fmtK(conv)} tokens${distillTotal !== null ? freshNote : ''}`)
      if (distillTotal !== null) compose.push(`       └ ${distillTotal}`)
    } else {
      compose.push(`• 对话消息    ≈ ${fmtK(conv)} tokens${distillTotal !== null ? freshNote : ''}`)
      if (distillTotal !== null) compose.push(`     └ ${distillTotal}`)
    }
    compose.push(`合计 ≈ ${fmtK(afterTotal)} tokens`)
    let summary
    let text
    if (noCompression) {
      // Always-on stats notice: input total + composition.
      summary = `⟦Input⟧ ≈${inputK}K tokens`
      text = [
        `本次请求 Input ≈${inputK}K tokens（无需压缩）`,
        '',
        '组成：',
        ...compose,
      ].join('\n')
    } else {
      // The collapsed row keeps the per-turn action (本轮压缩 N 条) separate from
      // the cumulative savings (相对完整会话 -Z%) so they can't be misread as one
      // number.
      summary = pruneInfo !== null
        ? (pruneInfo.newlyCompressed > 0
            ? `⟦历史剪枝⟧ 本轮压缩 ${pruneInfo.newlyCompressed} 条 · 相对完整会话 -${savedPct}%`
            : `⟦历史剪枝⟧ 历史链覆盖 ${pruneInfo.prunedCount} 条 · 相对完整会话 -${savedPct}%`)
          + (marks.length ? `，另 ${marks.length} 处蒸馏` : '')
        : summarizeMarks(marks)
      text = [
        `出站内容已由本地模型压缩 · 相对完整会话 -${savedPct}%`,
        '',
        '压缩后组成：',
        ...compose,
        '',
        `原始 Input ≈${inputK}K（未压缩）· 原文未改动，仅发送侧被压缩`,
        '需要精确细节时，用工具回查原始来源。',
      ].join('\n')
    }
    agent.session.append('user/message', {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'local-model', form: 'notice', summary },
    }, { surfaceOp: 'append' })
  }

  ctx.on('llm/stream', function (options, next) {
    // Our own re-dispatched copy: continue the chain untouched.
    if (owned.has(options)) return next()
    const runtime = this // LlmRuntime
    return (async function* () {
      let distilled
      let pruneInfo = null
      let work = options
      try {
        pruneInfo = await pruneOptions(runtimeCfg, cache, options)
        if (pruneInfo !== null) work = pruneInfo.options
        distilled = await distillOptions(runtimeCfg, cache, work)
      } catch (err) {
        if (err instanceof DistillBlockError) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                code: 'OUTBOUND_DISTILL_BLOCKED',
                message: `出站内容蒸馏失败且 distillOnError=block，请求未发出：${err.message}`,
              },
            },
          }
          return
        }
        runtimeCfg.logger?.warn?.(`dsh-local-model: 蒸馏器异常，发送原始请求（${err?.message ?? err}）`)
        distilled = work
      }
      // Always try to emit a stats notice (distillNoticeAlways)
      try {
        appendProcessNotice(work, distilled, runtime, pruneInfo)
      } catch (err) {
        runtimeCfg.logger?.warn?.(`dsh-local-model: 请求级处理通知追加失败（${err?.message ?? err}）`)
      }
      if (distilled === options && pruneInfo === null) {
        yield* next()
        return
      }
      owned.add(distilled)
      yield* runtime.stream(distilled)
    })()
  }, { global: true, prepend: true })
}