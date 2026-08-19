/** 会话探查 v2：把关键事件结构写到 _probe-out.json，避免出站蒸馏影响。 */
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
const out = {}
// 最近的 tool/result（local_model_chat 的）
const tr = events.findLastIndex((e) => e.type === 'tool/result')
out.lastToolResult = events[tr]
// 它之前一个 tool/call
const tc = events.findLastIndex((e) => e.type === 'tool/call' && e.seq < (events[tr]?.seq ?? Infinity))
out.lastToolCall = events[tc]
// 最近 6 个 user/message 的 id/source
out.recentUserMessages = []
let c = 0
for (let i = events.length - 1; i >= 0 && c < 6; i--) {
  if (events[i].type === 'user/message') {
    out.recentUserMessages.push({ seq: events[i].seq, id: events[i].data?.id, role: events[i].data?.role, source: events[i].data?.source ?? null })
    c++
  }
}
// 最近 3 个 assistant/message 的 id
out.recentAssistantMessages = []
c = 0
for (let i = events.length - 1; i >= 0 && c < 3; i--) {
  if (events[i].type === 'assistant/message') {
    out.recentAssistantMessages.push({ seq: events[i].seq, id: events[i].data?.id ?? events[i].data?.message?.id ?? null })
    c++
  }
}
writeFileSync('_probe-out.json', JSON.stringify(out, null, 1))
console.log('written _probe-out.json, keys:', Object.keys(out).join(','))
