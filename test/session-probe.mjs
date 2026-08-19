/** 会话探查：打印指定 seq 附近的事件结构，重点看 tool/result 与 user/message 的 id 字段。 */
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
// 找最近的 tool/result 与它前面的 user/message
const lastToolResult = events.findLastIndex((e) => e.type === 'tool/result')
const lastToolCall = events.findLastIndex((e) => e.type === 'tool/call')
const lastUserMsg = events.findLastIndex((e) => e.type === 'user/message')
function show(ev, label) {
  console.log(`\n=== ${label} seq=${ev?.seq} type=${ev?.type} ===`)
  console.log(JSON.stringify(ev, null, 1).slice(0, 1500))
}
show(events[lastToolCall], 'last tool/call')
show(events[lastToolResult], 'last tool/result')
if (lastUserMsg !== -1) show(events[lastUserMsg], 'last user/message')
// 列出最近 5 个 user/message 事件的 id
console.log('\n=== recent user/message ids ===')
let count = 0
for (let i = events.length - 1; i >= 0 && count < 5; i--) {
  if (events[i].type === 'user/message') {
    const d = events[i].data ?? {}
    console.log(`seq=${events[i].seq} id=${d.id} role=${d.role} src=${JSON.stringify(d.source ?? null)} head=${typeof d.content?.[0]?.text === 'string' ? d.content[0].text.slice(0, 50) : ''}`)
    count++
  }
}
