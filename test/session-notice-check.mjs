/**
 * 会话文件验证工具：按帧解压 session.jsonl.zstd，查找请求级蒸馏 notice 事件
 * （source.plugin === 'local-model' && source.form === 'notice'）。
 * 用法：node test/session-notice-check.mjs [会话目录]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const dir = process.argv[2] ?? 'C:\\Users\\bigmouse\\.dsh\\sessions\\--D-dsh-mcp--\\session-e0bf4147-4f74-4d69-b2a4-365bdeecdd6c'
const file = `${dir}\\session.jsonl.zstd`

const raw = readFileSync(file)
// zstd frame magic: 0x28 B5 2F FD (little-endian)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
let idx = raw.indexOf(MAGIC)
while (idx !== -1) {
  starts.push(idx)
  idx = raw.indexOf(MAGIC, idx + 1)
}
console.log(`zstd frames: ${starts.length}, file bytes: ${raw.length}`)

const chunks = []
for (let i = 0; i < starts.length; i++) {
  const end = i + 1 < starts.length ? starts[i + 1] : raw.length
  const frame = raw.subarray(starts[i], end)
  try {
    chunks.push(zstdDecompressSync(frame).toString('utf8'))
  } catch (err) {
    console.error(`frame ${i} decompress failed: ${err.message}`)
  }
}
const text = chunks.join('')
const lines = text.split('\n').filter((l) => l.trim() !== '')
console.log(`decompressed chars: ${text.length}, events: ${lines.length}`)

let noticeCount = 0
const notices = []
for (const line of lines) {
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  const data = ev.data
  if (ev.type === 'user/message' && data?.source?.kind === 'plugin' && data.source.plugin === 'local-model' && data.source.form === 'notice') {
    noticeCount++
    notices.push({
      seq: ev.seq,
      time: ev.time,
      summary: data.source.summary,
      surfaceOp: ev.surfaceOp ?? data.surfaceOp ?? undefined,
      textHead: typeof data.content?.[0]?.text === 'string' ? data.content[0].text.slice(0, 120) : null,
      id: data.id,
    })
  }
}
console.log(`notice events: ${noticeCount}`)
if (noticeCount > 0) {
  for (const n of notices) {
    console.log(JSON.stringify(n, null, 2))
  }
}
// 最近 8 个事件的类型与 seq，确认 notice 插入位置（应在 assistant 流式输出之前）
const tail = []
for (let i = lines.length - 1; i >= 0 && tail.length < 8; i--) {
  try {
    const ev = JSON.parse(lines[i])
    const src = ev.data?.source ? ' src=' + JSON.stringify(ev.data.source) : ''
    const head = typeof ev.data?.content?.[0]?.text === 'string' ? ` head="${ev.data.content[0].text.slice(0, 60)}"` : ''
    tail.push(`seq=${ev.seq} type=${ev.type}${src}${head}`)
  } catch { /* skip */ }
}
console.log('--- session tail ---')
console.log(tail.reverse().join('\n'))
