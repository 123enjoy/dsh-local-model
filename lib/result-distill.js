/**
 * result-distill.js — tool-result outbound distiller
 *
 * Distills long plain-text tool results before they enter the session,
 * so the cloud model pays fewer tokens.
 *
 * Key behavior:
 *   - First read of a file: distill (save tokens)
 *   - Re-read of the same file: reuse the SAME distilled bytes, so the session
 *     (and the cloud provider's prompt cache) sees identical content for that
 *     text every time — alternating between distilled and original would
 *     guarantee a cache miss on every re-read.
 *
 * Hook contract mirrors the official `dsh-spill-policy` plugin:
 *   ctx.on('tools/post-execute', async (exec, result, next) => ...)
 * Execution order: runs next() first to accumulate decisions, then
 * possibly overrides them (spill-policy "last word" pattern). The content
 * to transform is the upstream decision's projection, falling back to the
 * raw result (`decision.content ?? result.content`).
 *
 * Priority rules:
 *   - Big results → spill-policy preview first (this module is a noop).
 *   - Medium results (distillMinChars .. maxInlineBytes) → this module first.
 *   - Only accepts decisions without a value replacement and plain-text blocks
 *     (a result carrying any non-text block passes through untouched).
 *   - Skips nested sub-dispatches (exec.parent) and own tools.
 *
 * Safety: never turns success into failure; on error falls back to the
 * original decision (distillOnError: 'block' only applies at request level).
 */

import { maybeDistill, MARK_OPEN_PREFIX } from './outbound-distill.js'
import crypto from 'node:crypto'

const SKIP_TOOL_NAMES = new Set([
  'local_model_list',
  'local_model_chat',
  'local_model_run',
  'local_model_running',
  'local_model_distill'
])

// ── Session-level dedup: reuse the FIRST distilled bytes for repeated content ──
// If the same content appears again (model re-reading), reuse the identical
// distilled text instead of the original. Keeping these bytes stable is what
// lets the cloud provider's prompt cache hit on that message; alternating
// between distilled and original would guarantee a miss on every re-read.
// A Map (not a WeakSet) because it must hold the string keys AND values.
const distilledByHash = new Map()
const DEDUP_HASH_LIMIT = 2000

function contentHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function cachedDistilled(text) {
  return distilledByHash.get(contentHash(text))
}

function rememberDistilled(text, distilled) {
  const h = contentHash(text)
  if (distilledByHash.size >= DEDUP_HASH_LIMIT) {
    // LRU-lite: clear half when full
    const entries = [...distilledByHash.keys()]
    for (let i = 0; i < DEDUP_HASH_LIMIT / 2; i++) distilledByHash.delete(entries[i])
  }
  distilledByHash.set(h, distilled)
}

// ── Core distiller factory ────────────────────────────────────────────

function makeResultDistiller(cfg) {
  return async function resultDistiller(exec, result, next) {
    const decision = await next()

    if (!cfg || cfg.distillEnabled === false) return decision
    if (decision?.kind !== 'accept') return decision
    if (Object.hasOwn(decision, 'value')) return decision
    if (exec?.parent !== void 0) return decision
    if (exec?.name !== void 0 && SKIP_TOOL_NAMES.has(exec.name)) return decision

    // The content to transform: the upstream decision's projection, or the raw
    // result payload when the decision carries none.
    const src = decision.content ?? result?.content
    const isArray = Array.isArray(src)
    const blocks = isArray
      ? src
      : typeof src === 'string'
        ? [{ type: 'text', text: src }]
        : []

    if (!blocks.length) return decision
    // Pure-text only: any non-text block (image etc.) passes through untouched.
    if (isArray && blocks.some(b => !b || b.type !== 'text' || typeof b.text !== 'string')) return decision

    const totalChars = blocks.reduce((s, b) => s + b.text.length, 0)
    if (totalChars < cfg.distillMinChars) return decision

    let changed = false
    const newBlocks = []

    for (const block of blocks) {
      const text = block.text
      // Skip short blocks or already-distilled blocks
      if (text.length < cfg.distillMinChars || text.startsWith(MARK_OPEN_PREFIX)) {
        newBlocks.push(block)
        continue
      }

      // ── Re-read: reuse the FIRST distilled bytes so the session (and the
      //    cloud cache) sees identical content for this text every time.
      //    (The model's "deliberately re-reading needs full details" intent is
      //    served by the distill marker + tool re-fetch guidance instead of
      //    byte alternation.)
      const cached = cachedDistilled(text)
      if (cached !== undefined) {
        newBlocks.push({ ...block, text: cached })
        changed = true
        continue
      }

      // Distill via local model
      try {
        const distilled = await maybeDistill(cfg, text)
        // Remember regardless of whether it shrank: a re-read of a text that
        // ended up too short still gets the same bytes.
        rememberDistilled(text, distilled)
        if (distilled !== text) {
          newBlocks.push({ ...block, text: distilled })
          changed = true
        } else {
          newBlocks.push(block)
        }
      } catch {
        // On error: keep original text, never turn success into failure
        newBlocks.push(block)
      }
    }

    if (!changed) return decision
    return {
      kind: 'accept',
      content: newBlocks,
      ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
    }
  }
}

function installResultDistiller(ctx, cfg) {
  const distiller = makeResultDistiller(cfg)
  ctx.on('tools/post-execute', distiller, { prepend: true })
}

export { installResultDistiller, makeResultDistiller }
