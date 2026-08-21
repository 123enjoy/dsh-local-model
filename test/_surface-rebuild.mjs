// Rebuild the EXACT model-visible surface DSH sent, by folding surfaceOps from
// the session log, then applying prune keep=30 and checking for orphans at the
// wire layer — matching the "省略 1288 条" failing request.
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const LOG = 'D:/dsh/mcp/dsh-local-model/session.jsonl'
const ERR_SEQ = 462075 // failing request finish chunk

// ---- fold the surface over the log prefix ----
const events = []          // seq -> event
const surface = []         // ordered live seqs
const rl = createInterface({ input: createReadStream(LOG) })
for await (const line of rl) {
  if (!line.trim()) continue
  let e; try { e = JSON.parse(line) } catch { continue }
  if (e.seq > ERR_SEQ) break
  if (typeof e.seq !== 'number') continue
  if (!['user/message', 'assistant/message', 'tool/result'].includes(e.type)) continue
  const op = e.surfaceOp
  if (op === undefined) continue // not a surface event
  events[e.seq] = e
  if (op === 'append') {
    surface.push(e.seq)
  } else if (op.op === 'replace') {
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
const msgs = surface.map((seq) => deriveMsg(events[seq])).filter(Boolean)
console.log(`surface nodes: ${surface.length}  derived messages: ${msgs.length}`)

const kinds = (m) => (m.content ?? []).map((b) => b?.type).filter(Boolean)
const hasToolResult = (m) => kinds(m).includes('tool-result')
const hasToolCall = (m) => kinds(m).includes('tool-call')

// ---- prune to keep=30, raw cut (no guard) then wire-check ----
function orphansAt(arr, p) {
  const kept = arr.slice(p)
  const ids = new Set()
  const wire = []
  for (const m of kept) {
    if (m.role === 'user' && hasToolResult(m)) {
      for (const b of m.content) if (b?.type === 'tool-result') wire.push({ role: 'tool', id: b.toolCallId })
    } else if (m.role === 'assistant' && hasToolCall(m)) {
      m.content.filter((b) => b?.type === 'tool-call').forEach((b) => ids.add(b.id))
      wire.push({ role: 'assistant', tool_calls: m.content.filter((b) => b?.type === 'tool-call').length })
    } else wire.push({ role: m.role })
  }
  wire.unshift({ role: 'user' })
  return wire.filter((w) => w.role === 'tool' && !ids.has(w.id))
}

const KEEP = 30
// The request was built from the surface BEFORE the prune/distill notice card
// was appended (that notice lives at the very tail, appended during the request).
const noticeLike = (m) => m?.source?.kind === 'plugin'
console.log(`last message: source=${msgs.at(-1)?.source?.kind} id=${String(msgs.at(-1)?.id).slice(0, 20)} role=${msgs.at(-1)?.role}`)
const msgsNoNotice = noticeLike(msgs.at(-1)) ? msgs.slice(0, -1) : msgs
console.log(`request messages (surface minus trailing notice): ${msgsNoNotice.length}`)

// ---- guards: installed (dead) vs corrected (block-aware) ----
const hasToolResultBlock = (m) => (m?.content ?? []).some((b) => b?.type === 'tool-result')
const hasToolCallBlock = (m) => (m?.content ?? []).some((b) => b?.type === 'tool-call')
function installedGuardEnd(arr) { return arr.length - KEEP } // never fires on real schema
function fixedGuardEnd(arr) {
  let p = arr.length - KEEP
  while (p > 0 && hasToolResultBlock(arr[p])) p--
  while (p > 0 && hasToolCallBlock(arr[p - 1])) p--
  return p
}
const p = installedGuardEnd(msgsNoNotice)
const pFixed = fixedGuardEnd(msgsNoNotice)
console.log(`installed-guard cut p=${p} (pruned=${p}, kept=${msgsNoNotice.length - p})  => orphans=${orphansAt(msgsNoNotice, p).length}`)
console.log(`FIXED-guard cut p=${pFixed} (pruned=${pFixed}, kept=${msgsNoNotice.length - pFixed})  => orphans=${orphansAt(msgsNoNotice, pFixed).length}`)
const o = orphansAt(msgs, p)
console.log(`orphans at raw cut: ${o.length}`)
if (o.length) {
  for (const or of o) console.log(`   ORPHAN tool_call_id=${or.id}`)
  for (let i = Math.max(0, p - 3); i < Math.min(msgs.length, p + 4); i++) {
    const m = msgs[i]
    console.log(`   [${i}] role=${m.role} blocks=[${kinds(m).join(',')}]${i === p ? '  <-- cut' : ''}`)
  }
}
// boundary region regardless
console.log('\nboundary region:')
for (let i = Math.max(0, p - 2); i < Math.min(msgs.length, p + 4); i++) {
  const m = msgs[i]
  const tc = hasToolCall(m) ? m.content.filter((b) => b?.type === 'tool-call').map((b) => b.id).join(',') : ''
  const tr = hasToolResult(m) ? m.content.filter((b) => b?.type === 'tool-result').map((b) => b.toolCallId).join(',') : ''
  console.log(`   [${i}] role=${m.role} blocks=[${kinds(m).join(',')}] tool_call_ids=${tc || tr || '-'}${i === p ? '  <-- cut' : ''}`)
}
