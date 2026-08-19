/** 找 local_model_chat (callSeq 184226) 结果的 message id 与缓存条目，输出到文件。 */
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
for (let i = 0; i < events.length; i++) {
  const e = events[i]
  if (e.type === 'tool/call' && e.data?.name === 'local_model_chat' && e.seq === 184226) {
    const callId = e.data.callId
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].type === 'tool/result' && events[j].data?.message?.content?.[0]?.toolCallId === callId) {
        out.callSeq = e.seq
        out.callId = callId
        out.resultSeq = events[j].seq
        out.messageId = events[j].data.message.id
        out.role = events[j].data.message.role
        const blocks = events[j].data.message.content
        const inner = blocks?.[0]?.content?.[0]
        out.innerType = inner?.type
        out.innerLen = inner?.text?.length ?? null
        out.innerHead = inner?.text?.slice(0, 60) ?? null
        // 也记下这个 message id 是否已存在于蒸馏缓存（外部再查）
        break
      }
    }
    break
  }
}
writeFileSync('_probe-lmc2.json', JSON.stringify(out, null, 1))
console.log('done -> _probe-lmc2.json')