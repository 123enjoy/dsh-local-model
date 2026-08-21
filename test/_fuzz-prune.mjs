// Adversarial fuzzer for the prune cut-point guard, over DSH's REAL message
// schema — NOT OpenAI's. In DSH, tool results are role:'user' messages carrying
// content [{ type:'tool-result', toolCallId, ... }] blocks, and assistant tool
// calls are content [{ type:'tool-call', id, ... }] blocks. The old fuzzer
// generated OpenAI-format (role:'tool' / assistant.tool_calls) messages, which
// never occur in the plugin's input, so it validated nothing.
//
// Generates VALID copies of an underlying conversation (deep clone, unique
// tool_call_ids), applies the exact corrected cut-point guard from
// outbound-distill.js, converts the outbound [summary(user), ...kept] to wire
// format, and checks for orphaned role:'tool' messages INTRODUCED by the cut.

let seed = 424242
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const pick = (a) => a[Math.floor(rnd() * a.length)]

const textBlock = (t) => [{ type: 'text', text: t }]

// Build a valid DSH-schema message array. Each assistant-with-tool-call is
// directly followed by EXACTLY its number of tool-result messages.
function buildValid() {
  const msgs = []
  let callSeq = 0
  const len = 6 + Math.floor(rnd() * 60)
  for (let i = 0; i < len; i++) {
    const kind = pick(['u', 'a', 'T', 'u', 'a'])
    if (kind === 'u') { msgs.push({ role: 'user', content: textBlock('x'.repeat(60)) }); continue }
    if (kind === 'a') { msgs.push({ role: 'assistant', content: textBlock('z'.repeat(30)) }); continue }
    // T: parallel tool calls, DSH-style: one assistant message with N
    // tool-call blocks, then N user messages each with one tool-result block.
    const n = 1 + Math.floor(rnd() * 3)
    const blocks = [{ type: 'text', text: 'z'.repeat(10) }]
    const ids = []
    for (let k = 0; k < n; k++) {
      const id = 'c' + (++callSeq)
      ids.push(id)
      blocks.push({ type: 'tool-call', id, name: 'f', arguments: '{}' })
    }
    msgs.push({ role: 'assistant', content: blocks })
    for (const id of ids) {
      msgs.push({
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: id, isError: false, content: textBlock('y'.repeat(60)) }],
      })
    }
  }
  // ensure starts with user so keep bites a real boundary
  if (msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: textBlock('x'.repeat(60)) })
  return msgs
}

const cloneMsgs = (msgs) => JSON.parse(JSON.stringify(msgs))

// DSH-surface wire projection: user w/ tool-result block -> role:'tool';
// assistant w/ tool-call block -> role:'assistant' + tool_calls.
function toWire(arr) {
  const wire = []
  const ids = new Set()
  for (const m of arr) {
    const content = m.content ?? []
    const hasTR = content.some((b) => b?.type === 'tool-result')
    const hasTC = content.some((b) => b?.type === 'tool-call')
    if (m.role === 'user' && hasTR) {
      for (const b of content) if (b?.type === 'tool-result') wire.push({ role: 'tool', tool_call_id: b.toolCallId })
    } else if (m.role === 'assistant' && hasTC) {
      const calls = content.filter((b) => b?.type === 'tool-call').map((b) => b.id)
      calls.forEach((id) => ids.add(id))
      wire.push({ role: 'assistant', tool_calls: calls })
    } else {
      wire.push({ role: m.role, content: '' })
    }
  }
  return { wire, ids }
}

// True iff every tool message's id is satisfied by a preceding assistant
// tool_calls with no intervening plain user/assistant.
function isValidOrder(arr) {
  const { wire, ids } = toWire(arr)
  for (const w of wire) {
    if (w.role !== 'tool') continue
    let ok = false
    for (let j = wire.indexOf(w) - 1; j >= 0; j--) {
      const p = wire[j]
      if (p.role === 'user') break
      if (p.role === 'assistant') {
        if (Array.isArray(p.tool_calls) && p.tool_calls.includes(w.tool_call_id)) { ok = true; break }
        break
      }
    }
    if (!ok) return false
  }
  return true
}

// Corrected guard, verbatim logic from outbound-distill.js.
function adjust(msgs, keep) {
  const messages = cloneMsgs(msgs)
  const hasToolResultBlock = (m) => m?.role === 'tool' || (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool-result'))
  const hasToolCallBlock = (m) => m?.role === 'assistant' && ((Array.isArray(m?.tool_calls) && m.tool_calls.length > 0) || (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool-call')))
  let pruneEnd = Math.max(0, messages.length - keep)
  while (pruneEnd > 0 && hasToolResultBlock(messages[pruneEnd])) pruneEnd--
  while (pruneEnd > 0 && hasToolCallBlock(messages[pruneEnd - 1])) pruneEnd--
  return messages.slice(pruneEnd)
}

let found = 0, checked = 0
for (let iter = 0; iter < 400000 && found < 15; iter++) {
  const src = buildValid()
  if (!isValidOrder(src)) continue // defensive: generator must stay valid
  checked++
  const keep = 1 + Math.floor(rnd() * 15)
  const kept = adjust(src, keep)
  const out = [{ role: 'user', content: [] }, ...kept]
  if (!isValidOrder(out)) {
    found++
    console.log(`ITER ${iter} keep=${keep} n=${src.length} keptN=${kept.length}`)
    console.log(`  roles=${src.map((m) => (m.content ?? []).some((b) => b?.type === 'tool-call') ? 'T' : (m.content ?? []).some((b) => b?.type === 'tool-result') ? 't' : m.role[0]).join('')}`)
    console.log(`  kept =${kept.map((m) => (m.content ?? []).some((b) => b?.type === 'tool-call') ? 'T' : (m.content ?? []).some((b) => b?.type === 'tool-result') ? 't' : m.role[0]).join('')}`)
  }
}
console.log(found ? `\nORPHANS INTRODUCED BY PRUNE: ${found}` : `\nNo new orphans in ${checked} valid DSH-schema conversations (400k).`)
