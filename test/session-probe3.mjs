/** 找 local_model_chat 的 tool/result，输出到文件避免蒸馏。 */
import { writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

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
// 找 name=local_model_chat 的 tool/call 及其后的 tool/result
const out = { hits: [] }
for (let i = 0; i < events.length; i++) {
  const e = events[i]
  if (e.type === 'tool/call' && e.data?.name === 'local_model_chat') {
    const callId = e.data.callId
    let result = null
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].type === 'tool/result' && events[j].data?.message?.content?.[0]?.toolCallId === callId) {
        result = events[j]
        break
      }
    }
    out.hits.push({
      callSeq: e.seq,
      resultSeq: result?.seq ?? null,
      callId,
      storedTextHead: result ? extractTextHead(result.data.message) : null,
      storedTextLen: result ? extractTextLen(result.data.message) : null,
      storedHasMarker: result ? extractTextHead(result.data.message)?.startsWith('\u27F5\u672C') ?? false : null,
    })
  }
}
function extractTextHead(message) {
  const walk = (blocks) => {
    for (const b of blocks ?? []) {
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      if (b.type === 'tool-result' && Array.isArray(b.content)) { const r = walk(b.content); if (r) return r }
    }
    return null
  }
  return walk(message?.content)
}
function extractTextLen(message) {
  const walk = (blocks, n = { v: 0 }) => {
    for (const b of blocks ?? []) {
      if (b.type === 'text' && typeof b.text === 'string') n.v += b.text.length
      if (b.type === 'tool-result' && Array.isArray(b.content)) walk(b.content, n)
    }
    return n.v
  }
  return walk(message?.content)
}
writeFileSync('_probe-lmc.json', JSON.stringify(out.hits, null, 1))
console.log('hits:', out.hits.length, '-> _probe-lmc.json')