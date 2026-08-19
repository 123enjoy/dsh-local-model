// Probe: rebuild current session messages, estimate tokens, and report
// whether pruneOptions would trigger, plus what the notice would look like.
import fs from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { estimateTokens } from '../lib/compress.js'

const SESSION = 'C:\\Users\\bigmouse\\.dsh\\sessions\\--D-dsh-mcp--\\session-e0bf4147-4f74-4d69-b2a4-365bdeecdd6c\\session.jsonl.zstd'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const raw = fs.readFileSync(SESSION)
const starts = []
let idx = raw.indexOf(MAGIC)
while (idx !== -1) { starts.push(idx); idx = raw.indexOf(MAGIC, idx + 1) }
console.log(`zstd frames: ${starts.length}, file bytes: ${raw.length}`)

const chunks = []
for (let i = 0; i < starts.length; i++) {
  const end = i + 1 < starts.length ? starts[i + 1] : raw.length
  try { chunks.push(zstdDecompressSync(raw.subarray(starts[i], end)).toString('utf8')) } catch { /* skip */ }
}
const text = chunks.join('')
const lines = text.split('\n').filter((l) => l.trim() !== '')
console.log(`decompressed chars: ${text.length}, events: ${lines.length}`)

const events = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

// Rebuild messages
const messages = []
for (const ev of events) {
  const t = ev.type
  const d = ev.data ?? {}
  if (t === 'user/message' || t === 'assistant/message') {
    messages.push({ id: d.id, role: d.role ?? (t === 'user/message' ? 'user' : 'assistant'), content: d.content })
  } else if (t === 'tool/result') {
    messages.push({ id: d.id, role: 'user', content: d.content })
  }
}
console.log(`rebuilt messages: ${messages.length}`)

const recent = messages.slice(-400)
const est = (m) => estimateTokens((m.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n'))
let total = 0
for (const m of recent) total += est(m)
console.log(`last 400 msgs est tokens: ${total}`)

const last12 = recent.slice(-12)
let t12 = 0
for (const m of last12) t12 += est(m)
console.log(`last 12 msgs est tokens: ${t12}`)

// Also count notice events written so far
let noticeCount = 0
for (const ev of events) {
  const d = ev.data
  if (ev.type === 'user/message' && d?.source?.kind === 'plugin' && d.source.plugin === 'local-model' && d.source.form === 'notice') noticeCount++
}
console.log(`local-model notice events in session: ${noticeCount}`)

console.log(`total > 40000 budget? ${total > 40000}`)
