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
 * - PER-REQUEST BUDGET: distillBudgetMs caps how long one request may spend
 *   distilling; on expiry the remaining messages pass through raw, so a cold
 *   cache can never stall a request indefinitely.
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
const CACHE_LIMIT = 1000

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

/** Rough token estimate of every text block inside a message list. */
function estimateMessagesTokens(messages) {
  let total = 0
  const walk = (blocks) => {
    for (const b of blocks ?? []) {
      if (b?.type === 'text' && typeof b.text === 'string') total += estimateTokens(b.text)
      else if (b?.type === 'tool-result' && Array.isArray(b.content)) walk(b.content)
    }
  }
  for (const m of messages ?? []) walk(m?.content)
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

/** Cache key for one prune summary: the pruned set's id+content signature. */
function pruneKeyOf(pruned) {
  return '__prune__' + hashContent(pruned.map((m) => [m?.id, m?.content]))
}

/**
 * Build (or fetch from cache) the history summary replacing the pruned span.
 * Source is the NEWER side of the pruned messages (the recent-ish old history
 * carries the context worth keeping), truncated to pruneMaxSourceChars.
 * Returns null on any failure — the caller then leaves history untouched.
 */
async function makePruneSummary(cfg, cache, pruned, keptCount, key) {
  const hit = cache.get(key)
  if (hit !== undefined && typeof hit.d === 'string') return hit.d
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
  const source = parts.join('\n\n')
  if (source.trim() === '') return null
  const beforeTokens = estimateTokens(source)
  let summary
  try {
    summary = await historySummarize(cfg, source)
  } catch (err) {
    cfg.logger?.warn?.(`dsh-local-model: 历史剪枝摘要失败（${err?.message ?? err}），本次按原文发送`)
    return null
  }
  const afterTokens = estimateTokens(summary)
  const pct = Math.round((1 - afterTokens / beforeTokens) * 100)
  const text = PRUNE_OPEN
    .replace('{0}', String(pruned.length))
    .replace('{1}', String(keptCount))
    .replace('{2}', String(beforeTokens))
    .replace('{3}', String(afterTokens))
    .replace('{4}', String(pct)) + '\n' + summary + '\n' + PRUNE_CLOSE
  cache.set(key, { h: '1', d: text })
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  cfg.persist()
  return text
}

/**
 * Replace the oldest messages of an over-budget request with one local-model
 * history summary, keeping the most recent `pruneKeepRecent` messages intact.
 * Never touches storage/GUI: only the outbound copy is pruned, so full history
 * stays recoverable. Returns null when pruning is disabled, unnecessary,
 * unsafe, or failed.
 *
 * Snapshot batching: the pruned set grows by one or two messages every turn,
 * so regenerating the summary per request would add a local call to every
 * response. Instead the summary is reused while the pruned set only grew by
 * fewer than `pruneRegenEvery` messages; the up-to-(B-1) most recently pruned
 * messages are dropped from the model's view (recoverable via tools) until
 * the next regeneration. The snapshot is persisted in the shared cache, so a
 * restart does not force an immediate regeneration either.
 */
const PRUNE_SNAP_KEY = '__prune__snap'

async function pruneOptions(cfg, cache, options) {
  if (cfg.pruneEnabled === false || cfg.pruneBudgetTokens <= 0) return null
  const messages = options.messages ?? []
  const keep = Math.max(1, cfg.pruneKeepRecent ?? 12)
  if (messages.length <= keep) return null
  const totalTokens = estimateMessagesTokens(messages)
  if (totalTokens <= cfg.pruneBudgetTokens) return null
  const pruned = messages.slice(0, messages.length - keep)
  const kept = messages.slice(messages.length - keep)
  const ids = pruned.map((m) => m?.id ?? '')
  // Load the persisted snapshot, if any.
  let snap = null
  try {
    const raw = cache.get(PRUNE_SNAP_KEY)
    if (raw !== undefined && typeof raw.d === 'string') snap = JSON.parse(raw.d)
  } catch { snap = null }
  const prefixSame = snap !== null && snap.ids !== undefined && ids.length >= snap.ids.length &&
    snap.ids.every((id, i) => id === ids[i])
  const grown = prefixSame ? ids.length - snap.ids.length : Infinity
  const regenEvery = Math.max(1, cfg.pruneRegenEvery ?? 6)
  let summaryText = null
  let snapshotId = null
  if (prefixSame && grown < regenEvery && typeof snap.text === 'string') {
    // Stale-batch reuse: the pruned set only grew by a few messages — the
    // summary still covers the overwhelming majority of the pruned history.
    summaryText = snap.text
    snapshotId = typeof snap.snapshotId === 'string' ? snap.snapshotId : null
  } else {
    const pruneKey = pruneKeyOf(pruned)
    summaryText = await makePruneSummary(cfg, cache, pruned, kept.length, pruneKey)
    if (summaryText !== null) {
      snapshotId = pruneKey
      cache.set(PRUNE_SNAP_KEY, { h: 'snap', d: JSON.stringify({ ids, text: summaryText, snapshotId: pruneKey }) })
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
      cfg.persist()
    }
  }
  if (summaryText === null) return null
  const summaryMsg = {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: summaryText }],
    source: { kind: 'plugin', plugin: 'local-model' },
  }
  const afterTokens = estimateMessagesTokens([summaryMsg, ...kept])
  return {
    options: { ...options, messages: [summaryMsg, ...kept] },
    prunedCount: pruned.length,
    keptCount: kept.length,
    beforeTokens: totalTokens,
    afterTokens,
    pct: Math.round((1 - afterTokens / totalTokens) * 100),
    mark: summaryText.slice(0, summaryText.indexOf('\n') === -1 ? summaryText.length : summaryText.indexOf('\n')),
    pruneKey: snapshotId ?? pruneKeyOf(pruned),
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
    const before = estimateTokens(value)
    const after = estimateTokens(distilled)
    const pct = Math.round((1 - after / before) * 100)
    cfg.logger?.info?.(`dsh-local-model: 蒸馏 ≈${before} → ${after} tokens（-${pct}%），原文 ${value.length} 字符`)
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
 * Distill one message (cached by message id, persisted across restarts).
 */
async function distillMessage(cfg, cache, message) {
  if (!cfg.distillRoles.includes(message.role)) return message
  const key = message.id
  const h = hashContent(message.content)
  const hit = cache.get(key)
  if (hit !== undefined && hit.h === h) {
    return hit.d === null ? message : { ...message, content: hit.d }
  }
  const content = await distillBlocks(cfg, message.content)
  const record = { h, d: content === message.content ? null : content }
  cache.set(key, record)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
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
    if (budgetExhausted || Date.now() - started > cfg.distillBudgetMs) {
      if (!budgetExhausted) cfg.logger?.warn?.('dsh-local-model: 蒸馏预算耗尽，剩余消息按原文直传')
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
  const logger = () => { try { return ctx.logger } catch { return undefined } }
  const runtimeCfg = { ...cfg, get logger() { return logger() }, persist }
  /** Message ids already surfaced as a request-level notice (retries and
   *  re-sent history skip; only NEW distillation events get a card). */
  const noticedIds = new Set()
  /** Collect marker lines for the messages that were newly distilled. */
  const freshDistillMarks = (options, distilled, freshIds) => {
    const marks = []
    const beforeMessages = options.messages ?? []
    const afterMessages = distilled.messages ?? []
    for (let i = 0; i < afterMessages.length; i++) {
      if (afterMessages[i] === beforeMessages[i]) continue
      const id = beforeMessages[i]?.id
      if (typeof id !== 'string' || id === '' || noticedIds.has(id)) continue
      freshIds.push(id)
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
    const inputTokens = estimateMessagesTokens(messages)
    const inputK = (inputTokens / 1000).toFixed(1)
    let lines = []
    let summary
    let text
    if (noCompression) {
      // Always-on stats notice: show input token count
      summary = `⟦Input⟧ ≈${inputK}K tokens`
      text = `本次请求 Input ≈${inputK}K tokens（无需压缩）`
      lines.push(summary)
    } else {
      if (pruneInfo !== null) {
        lines.push(`⟦历史剪枝⟧ 省略 ${pruneInfo.prunedCount} 条旧消息，保留最近 ${pruneInfo.keptCount} 条，估算 ${pruneInfo.beforeTokens}→${pruneInfo.afterTokens} tokens（-${pruneInfo.pct}%）`)
      }
      lines.push(...marks)
      // Compute afterTokens for summary
      const afterTokens = pruneInfo !== null ? pruneInfo.afterTokens : estimateMessagesTokens(distilled.messages ?? [])
      const afterK = (afterTokens / 1000).toFixed(1)
      const savedPct = inputTokens > 0 ? Math.round((1 - afterTokens / inputTokens) * 100) : 0
      summary = pruneInfo !== null
        ? `⟦历史剪枝⟧ 省略 ${pruneInfo.prunedCount} 条旧消息，保留最近 ${pruneInfo.keptCount} 条（-${pruneInfo.pct}%）` + (marks.length ? `，另 ${marks.length} 处蒸馏` : '')
        : summarizeMarks(marks)
      text = `本次调用大模型的出站内容已由本地模型压缩处理（会话内原文未改动，仅发送侧被压缩）：\nInput ≈${inputK}K → compress ≈${afterK}K（-${savedPct}%）\n` + lines.join('\n') +
        (pruneInfo !== null ? '\n（省略的旧消息已压成摘要；需要精确细节时请用工具回查原始来源）' : '')
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