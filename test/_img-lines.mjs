import { readFileSync } from 'node:fs'
const lines = readFileSync(process.argv[2], 'utf8').split('\n')
for (const ln of [3269, 3513]) {
  const e = JSON.parse(lines[ln - 1])
  const msg = e.data?.message
  console.log('=== line', ln, 'type', e.type, 'turn', e.data?.turn, 'step', e.data?.step, '===')
  const blocks = msg?.content ?? []
  for (const b of blocks) {
    if (b?.type === 'tool-result') {
      console.log('  tool-result toolCallId=', b.toolCallId)
      for (const c of b.content ?? []) {
        console.log('    block type=', c.type, 'text=', String(c.text ?? '').slice(0, 200), 'attachment=', c.attachment ? JSON.stringify(Object.keys(c.attachment)) : null)
      }
    } else {
      console.log('  block type=', b?.type, JSON.stringify(b).slice(0, 200))
    }
  }
}
