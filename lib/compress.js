/**
 * Distillation engine: long outbound texts are compressed by the local small
 * model into dense summaries before they cost cloud tokens.
 *
 * Gate is LENGTH, not content: texts below distillMinChars pass through
 * untouched. Every compressed chunk goes through a fidelity check — empty or
 * not-actually-shorter output falls back to the original text, so a bad
 * local-model answer never inflates the request or silently blanks content.
 */

import { chat } from './ollama.js'

/** Thrown when the local compressor's output fails the fidelity check. */
export class CompressError extends Error {}

/**
 * Deterministic seed derived from content, so identical inputs reproduce.
 * Combined with temperature 0 this makes a re-distillation byte-identical —
 * critical for the cloud provider's prompt cache, which keys on exact bytes.
 */
function seedFor(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/**
 * Rough token estimate (chars → tokens), used for the before/after numbers in
 * the distill markers. Consistent on both sides, so the -Z% ratio is honest
 * even though it is not a real tokenizer count: CJK ≈ 1 token/char, other
 * text ≈ 3.6 chars/token.
 */
export function estimateTokens(text) {
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)) cjk++
  }
  const other = text.length - cjk
  return Math.max(1, Math.round(cjk * 1.0 + other * 0.28))
}

/** The system prompt handed to the local distiller model. */
export const DISTILL_SYSTEM =
  '你是文本蒸馏器。把输入文本压缩成高密度摘要，目标是省 token 同时保住关键信息。\n' +
  '必须保留：事实与结论、数字与指标、错误信息/堆栈、文件路径、代码的关键逻辑与关键片段、决策与待办、专有名词。\n' +
  '可以删除：寒暄与客套、重复内容、格式噪音、显而易见的铺垫、与主题无关的细节。\n' +
  '规则：\n' +
  '1. 直接输出蒸馏结果，不加任何解释、前缀或后缀。\n' +
  '2. 保持原文语言；代码与命令保留关键片段，可用省略号跳过重复段落。\n' +
  '3. 结构化内容（表格/JSON/日志）压缩成要点列表。\n' +
  '4. 输出必须明显短于原文。'

/** System prompt for history pruning: turn a span of old conversation into a dense reference. */
export const PRUNE_SYSTEM =
  '你是会话历史摘要器。把一段已完成的旧对话历史压缩成供后续轮次参考的简明摘要。\n' +
  '必须保留：当前目标与正在进行的工作、关键决策与结论、文件路径与命令、错误与修复方案、待办事项、用户的明确要求、数字与指标。\n' +
  '可以省略：寒暄客套、过程细节、重复内容、已完成的临时步骤、与当前目标无关的旧话题。\n' +
  '规则：\n' +
  '1. 直接输出摘要本身，不加任何解释、前缀或后缀；保持原文语言。\n' +
  '2. 用要点列表组织；输出必须明显短于原文（目标 ≤ 原文 30%）。\n' +
  '3. 不确定的细节宁可略去也不要编造。'

/** Split long text into chunks on line boundaries (≤ maxChars each). */
export function chunkText(value, maxChars) {
  if (value.length <= maxChars) return [value]
  const chunks = []
  let current = ''
  for (const line of value.split('\n')) {
    const piece = current === '' ? line : current + '\n' + line
    if (piece.length > maxChars && current !== '') {
      chunks.push(current)
      current = line
    } else {
      current = piece
    }
    // A single line longer than maxChars is hard-split.
    while (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars))
      current = current.slice(maxChars)
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/**
 * Distill one chunk with the local model. Returns the original chunk when
 * compression produced nothing shorter (fidelity fallback); throws
 * CompressError only when the call itself failed.
 */
export async function distillChunk(cfg, value) {
  const result = await chat(cfg.baseUrl, {
    model: cfg.distillModel,
    messages: [
      { role: 'system', content: DISTILL_SYSTEM },
      { role: 'user', content: `把以下文本压缩到原文的 ${Math.round(cfg.targetRatio * 100)}% 以内：\n\n${value}` },
    ],
    options: {
      temperature: 0,
      seed: seedFor(value),
      num_predict: Math.max(256, Math.ceil(value.length * cfg.targetRatio)),
      num_ctx: cfg.distillNumCtx,
    },
    think: false,
    timeoutMs: cfg.distillTimeoutMs,
  })
  const out = (result.content ?? '').trim()
  if (out === '') throw new CompressError('本地蒸馏模型返回空内容')
  // Fidelity: never inflate, never near-blank.
  if (out.length >= value.length) return value
  if (out.length < value.length * 0.05) throw new CompressError(`蒸馏输出过短（${out.length}/${value.length} 字符），疑似内容丢失`)
  return out
}

/**
 * Summarize one span of conversation history for pruning. Unlike distillChunk,
 * an inflated (not-shorter) output is an ERROR, not a pass-through: embedding
 * the source verbatim as the "summary" would grow the request instead of
 * shrinking it, so the caller falls back to leaving history untouched.
 */
export async function historySummarize(cfg, source) {
  const result = await chat(cfg.baseUrl, {
    model: cfg.distillModel,
    messages: [
      { role: 'system', content: PRUNE_SYSTEM },
      { role: 'user', content: `把下面的对话历史压缩成简明摘要：\n\n${source}` },
    ],
    options: {
      temperature: 0,
      seed: seedFor(source),
      num_predict: cfg.pruneMaxSummaryTokens ?? 2048,
      num_ctx: cfg.distillNumCtx,
    },
    think: false,
    timeoutMs: cfg.pruneTimeoutMs ?? cfg.distillTimeoutMs,
  })
  const out = (result.content ?? '').trim()
  if (out === '') throw new CompressError('本地历史摘要模型返回空内容')
  if (out.length >= source.length) throw new CompressError(`历史摘要未缩短（${out.length}/${source.length} 字符），放弃剪枝`)
  if (out.length < Math.min(80, source.length * 0.02)) throw new CompressError(`历史摘要过短（${out.length} 字符），疑似内容丢失`)
  return out
}

/**
 * Distill a full text (chunked, then joined). Returns the original text when
 * every chunk failed to shrink.
 *
 * Echo guard: a chunk whose distilled output came back NOT shorter than the
 * input means the model is reproducing instead of compressing (typical for
 * repetitive/config dumps). Two consecutive echoes abort the remaining
 * chunks — no point burning local calls on content the model refuses to
 * compress.
 *
 * Dedup: when the source repeats itself across chunks (e.g. an article
 * pasted 5×), each chunk yields a near-identical summary. Outputs that are
 * ~80% similar to the previous kept summary are dropped.
 */
export async function distillText(cfg, value) {
  const chunks = chunkText(value, cfg.distillChunkChars)
  const out = []
  let echoes = 0
  let lastKept = ''
  for (let i = 0; i < chunks.length; i++) {
    if (echoes >= 2) {
      cfg.logger?.warn?.(`dsh-local-model: 检测到 ${echoes} 个分块回显（模型在复读而非压缩），${chunks.length - i} 个剩余分块按原文直传`)
      while (i < chunks.length) out.push(chunks[i++])
      break
    }
    const distilled = await distillChunk(cfg, chunks[i])
    if (distilled === chunks[i]) {
      echoes++
      cfg.logger?.info?.(`dsh-local-model: 分块 ${i + 1}/${chunks.length} 未压缩（回显/保真兜底），回退原文`)
    } else {
      echoes = 0
    }
    if (lastKept !== '' && similarity(distilled, lastKept) >= 0.8) {
      cfg.logger?.info?.(`dsh-local-model: 分块 ${i + 1}/${chunks.length} 摘要与上一块高度相似，去重跳过`)
      continue
    }
    if (distilled !== chunks[i]) lastKept = distilled
    out.push(distilled)
  }
  return out.join('\n\n')
}

/**
 * Char-trigram Jaccard similarity over the first ~1500 chars of each text.
 * Cheap, good enough to catch near-duplicate chunk summaries.
 */
function similarity(a, b) {
  const nearA = a.slice(0, 1500)
  const nearB = b.slice(0, 1500)
  const setA = new Set()
  const setB = new Set()
  for (let i = 0; i + 2 < nearA.length; i++) setA.add(nearA.slice(i, i + 3))
  for (let i = 0; i + 2 < nearB.length; i++) setB.add(nearB.slice(i, i + 3))
  if (setA.size === 0 && setB.size === 0) return 1
  let inter = 0
  for (const t of setA) if (setB.has(t)) inter++
  const union = setA.size + setB.size - inter
  return union === 0 ? 1 : inter / union
}
