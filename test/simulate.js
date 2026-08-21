/**
 * Integration test: run the outbound distiller against a minimal cordis-like
 * waterfall + fake adapter, backed by the REAL local Ollama.
 * Run: node test/simulate.js
 */

import { installOutboundDistiller } from '../lib/outbound-distill.js'
import { makeResultDistiller } from '../lib/result-distill.js'

const BASE = 'http://127.0.0.1:11434'
const DISTILL_MODEL = process.env.DISTILL_MODEL ?? 'qwen3.5:latest'

/** Minimal cordis waterfall replica (binds thisArg, next re-passes args). */
function makeRuntime(adapterStream) {
  const hooks = []
  const ctx = {
    on(_name, cb, _opts) { hooks.push(cb) },
    waterfall(thisArg, _name, options, inner) {
      const cbs = [...hooks]
      const next = () => (cbs.shift() ?? inner).call(thisArg, options, next)
      return next()
    },
  }
  const runtime = {
    stream(options) {
      return ctx.waterfall(runtime, 'llm/stream', options, () => adapterStream(options))
    },
  }
  return { ctx, runtime }
}

/** Fake adapter: records what it received, yields a stop finish. */
function makeAdapter(received) {
  return async function* (options) {
    received.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

let failures = 0
function assert(cond, label) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label)
  if (!cond) failures++
}

function cfg(over = {}) {
  return {
    baseUrl: BASE,
    distillModel: DISTILL_MODEL,
    distillMinChars: 1500,
    targetRatio: 0.4,
    distillRoles: ['user'],
    distillSystem: false,
    distillChunkChars: 3000,
    distillNumCtx: 8192,
    distillTimeoutMs: 180000,
    distillOnError: 'pass',
    distillBudgetMs: 60000,
    distillCachePath: './.test-distill-cache.json',
    distillNotice: true,
    // history pruning defaults
    pruneEnabled: true,
    pruneBudgetTokens: 40000,
    pruneKeepRecent: 12,
    pruneMaxSourceChars: 12000,
    pruneMaxSummaryTokens: 2048,
    pruneBatchSize: 12,
    pruneChainMaxBatches: 20,
    pruneMaxNewBlocks: 3,
    pruneRollMargin: 1.2,
    pruneTimeoutMs: 120000,
    pruneNotice: true,
    ...over,
  }
}

/** A long, noisy text (~2600 chars) with key facts buried inside. */
function longText() {
  const noise = '  [INFO] worker heartbeat ok, queue empty, waiting for tasks...\n'.repeat(30)
  return '构建系统巡检报告\n\n=== 环境 ===\nNode v22.19.0, pnpm 10.34.4, Windows 11\n\n' +
    '=== 日志（节选） ===\n' + noise + '\n' +
    '=== 关键错误 ===\n' +
    'step 417: BUILD FAILED — error code E5291: native module ssh2 编译失败，缺少 OpenSSL 头文件。\n' +
    '根因：构建机未安装 OpenSSL 开发包。修复：choco install openssl 后重跑 pnpm rebuild ssh2。\n' +
    '=== 结论 ===\n共 3 个 worker 离线（w2、w5、w7），队列积压 1284 个任务，预计恢复时间 40 分钟。\n' +
    '=== 附录：冗长的环境变量清单 ===\n' + ('PATH_ENTRY=C:\\some\\very\\long\\path\\segment\n'.repeat(25))
}

// --- 1. short text passes through untouched, no LLM involved ---
{
  const received = []
  const { ctx, runtime } = makeRuntime(makeAdapter(received))
  installOutboundDistiller(ctx, cfg())
  const msg = { id: 'm-short', role: 'user', content: [{ type: 'text', text: '帮我看看这段代码：const a = 1' }] }
  const t0 = Date.now()
  await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
  const elapsed = Date.now() - t0
  assert(received.length === 1, '1a: adapter received the request')
  assert(received[0].messages[0] === msg, '1b: short message identity preserved (untouched)')
  assert(elapsed < 3000, `1c: no local-LLM latency below the length gate (${elapsed} ms)`)
}

// --- 2. long text is distilled before reaching the adapter ---
{
  const received = []
  const { ctx, runtime } = makeRuntime(makeAdapter(received))
  installOutboundDistiller(ctx, cfg())
  const original = longText()
  const msg = { id: 'm-long', role: 'user', content: [{ type: 'text', text: original }] }
  await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
  const got = received[0].messages[0].content[0].text
  console.log(`  distilled ${original.length} → ${got.length} chars`)
  console.log('  ---8<---\n' + got.slice(0, 400) + '\n  ---8<---')
  assert(got !== original, '2a: text was replaced')
  assert(got.length < original.length * 0.8, `2b: meaningfully shorter (${got.length} < ${Math.floor(original.length * 0.8)})`)
  assert(got.includes('⟦本地蒸馏'), '2c: distill marker present')
  assert(got.includes('E5291'), '2d: key fact (error code) survived distillation')

  // --- 3. cache: same message id on a later step is not re-distilled ---
  const t0 = Date.now()
  await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
  const elapsed = Date.now() - t0
  assert(received[1].messages[0].content === received[0].messages[0].content, '3a: cached distilled content reused (same array identity)')
  assert(elapsed < 3000, `3b: cache hit skipped the local LLM (${elapsed} ms)`)
}

// --- 4. tool-result nested long content is distilled too ---
{
  const received = []
  const { ctx, runtime } = makeRuntime(makeAdapter(received))
  installOutboundDistiller(ctx, cfg())
  const msg = {
    id: 'm-tool', role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: longText() }] }],
  }
  await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
  const got = received[0].messages[0].content[0].content[0].text
  assert(got.includes('⟦本地蒸馏'), '4a: nested tool-result text distilled')
  assert(got.includes('E5291'), '4b: key fact survived inside tool-result')
}

// --- 5. block policy: distiller failure terminates the stream, adapter never sees it ---
{
  const received = []
  const { ctx, runtime } = makeRuntime(makeAdapter(received))
  installOutboundDistiller(ctx, cfg({ distillOnError: 'block', distillModel: 'nonexistent-model:0' }))
  // 唯一内容：避免命中前面测试已蒸馏的 longText()（内容哈希缓存）
  const msg = { id: 'm-block', role: 'user', content: [{ type: 'text', text: '测试5 阻断策略专用（不命中缓存）：\n' + longText() }] }
  const chunks = await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
  const finish = chunks.at(-1)
  assert(received.length === 0, '5a: adapter never received the request')
  assert(finish?.type === 'finish' && finish.reason?.kind === 'error', '5b: stream ended with error finish')
  assert(finish?.reason?.failure?.code === 'OUTBOUND_DISTILL_BLOCKED', '5c: error code OUTBOUND_DISTILL_BLOCKED')
}

// --- 6. pass policy: distiller failure falls back to the original text ---
{
  const received = []
  const { ctx, runtime } = makeRuntime(makeAdapter(received))
  installOutboundDistiller(ctx, cfg({ distillOnError: 'pass', distillModel: 'nonexistent-model:0' }))
  const original = '测试6 回退策略专用（不命中缓存）：\n' + longText()
  const msg = { id: 'm-pass', role: 'user', content: [{ type: 'text', text: original }] }
  const chunks = await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
  assert(received.length === 1, '6a: adapter received the request despite distiller failure')
  assert(received[0].messages[0].content[0].text === original, '6b: original text passed through verbatim')
  assert(chunks.at(-1)?.reason?.kind === 'stop', '6c: stream completed normally')
}

// --- 7. echo guard: repetitive dump is passed through verbatim (fidelity
//        fallback) and the run aborts early instead of burning a local call
//        per chunk ---
{
  const received = []
  const { ctx, runtime } = makeRuntime(makeAdapter(received))
  installOutboundDistiller(ctx, cfg({ distillChunkChars: 1200 }))
  // 8+ chunks of near-identical config lines: the model reproduces instead of
  // compressing, so the guard must fall back to the original text.
  const dump = Array.from({ length: 600 }, (_, i) => `entry_${i}="key_${i}";type=${i % 3};enabled=${Boolean(i % 2)}`).join('\n')
  assert(dump.length > 1200 * 8, '7a: fixture is long enough to chunk 8+ times')
  const msg = { id: 'm-echo', role: 'user', content: [{ type: 'text', text: dump }] }
  const t0 = Date.now()
  await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
  const elapsed = Date.now() - t0
  const got = received[0].messages[0].content[0].text
  assert(got === dump, '7b: repetitive dump passed through verbatim (fidelity fallback)')
  assert(!got.includes('⟦本地蒸馏'), '7c: no distill markers on a fidelity-failed text')
  // Echo guard aborts after the second echo: 2 attempted chunks × worst-case
  // 30s stays well under 90s — a full 8-chunk run would exceed it.
  assert(elapsed < 90000, `7d: echo guard aborted early (${elapsed} ms, expect ≪ full run)`)
}

// --- 8. persistent cache: a "restarted host" (fresh in-memory maps, same
//        cache file) serves distilled content without a single local call ---
{
  const { rm } = await import('node:fs/promises')
  const cacheFile = './.test-distill-cache.json'
  await rm(cacheFile, { force: true })
  const msg = { id: 'm-persist', role: 'user', content: [{ type: 'text', text: longText() }] }
  // first host: distills and persists
  {
    const received = []
    const { ctx, runtime } = makeRuntime(makeAdapter(received))
    installOutboundDistiller(ctx, cfg())
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
    await new Promise(r => setTimeout(r, 2000)) // let the debounced persist land
    assert(received[0].messages[0].content[0].text.includes('⟦本地蒸馏'), '8a: first host distilled the message')
  }
  // second host (restart): brand-new Maps, same cache file → cache hits
  {
    const received = []
    const { ctx, runtime } = makeRuntime(makeAdapter(received))
    installOutboundDistiller(ctx, cfg())
    const t0 = Date.now()
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
    const elapsed = Date.now() - t0
    assert(received[0].messages[0].content[0].text.includes('⟦本地蒸馏'), '8b: resumed host still serves distilled content')
    assert(elapsed < 3000, `8c: resumed host hit persistent cache, no local call (${elapsed} ms)`)
  }
  await rm(cacheFile, { force: true })
}

// --- 9. per-request budget: with distillBudgetMs=1 the second long message
//        passes through raw (a cold cache can never stall the request) ---
{
  const received = []
  const { ctx, runtime } = makeRuntime(makeAdapter(received))
  installOutboundDistiller(ctx, cfg({ distillBudgetMs: 1 }))
  // 唯一内容：确保两条都是冷消息（不命中前面测试的内容哈希缓存）
  const a = { id: 'm-b1', role: 'user', content: [{ type: 'text', text: '测试9 预算第一条（冷消息）：\n' + longText() }] }
  const b = { id: 'm-b2', role: 'user', content: [{ type: 'text', text: '测试9 预算第二条（冷消息，应原文直传）：\n' + longText() }] }
  await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [a, b] }))
  const bText = received[0].messages[1].content[0].text
  assert(!bText.includes('⟦本地蒸馏'), '9a: budget-exhausted message passed through raw')
  assert(received[0].messages[0].content[0].text.includes('⟦本地蒸馏'), '9b: first message was still distilled')
}

// --- 10. result-level distiller (tools/post-execute): long pure-text tool
//        results are rewritten BEFORE storage so GUI cards show the distilled
//        content + stats; every guard passes everything else through ---
{
  const distiller = makeResultDistiller(cfg())

  // 10a: short results pass through untouched (decision object returned as-is;
  //      the caller merges result.content when the decision carries none)
  {
    const upstream = { kind: 'accept' }
    const decision = await distiller(
      { name: 'pwsh', parent: void 0 },
      { content: [{ type: 'text', text: 'const a = 1' }] },
      async () => upstream
    )
    assert(decision === upstream, '10a: short tool result untouched')
  }

  // 10b: long pure-text result is distilled with the unified stats marker
  {
    const decision = await distiller(
      { name: 'pwsh', parent: void 0 },
      { content: [{ type: 'text', text: longText() }] },
      async () => ({ kind: 'accept' })
    )
    const text = decision.content[0].text
    assert(text.includes('⟦本地蒸馏·原文') && text.includes('tokens（-') && text.includes('⟦蒸馏结束⟧'),
      '10b: long tool result distilled with stats marker')
    assert(text.includes('E5291'), '10b2: key fact survives distillation')
  }

  // 10c: nested sub-dispatch (run_code SDK path) is skipped
  {
    const upstream = { kind: 'accept' }
    const decision = await distiller(
      { name: 'pwsh', parent: { token: Symbol('p') } },
      { content: [{ type: 'text', text: longText() }] },
      async () => upstream
    )
    assert(decision === upstream, '10c: nested sub-dispatch skipped')
  }

  // 10d: our own tools are never re-distilled
  {
    const upstream = { kind: 'accept' }
    const decision = await distiller(
      { name: 'local_model_chat', parent: void 0 },
      { content: [{ type: 'text', text: longText() }] },
      async () => upstream
    )
    assert(decision === upstream, '10d: local_model_* tools skipped')
  }

  // 10e: block / value-replacement decisions are honored
  {
    const d1 = await distiller(
      { name: 'pwsh' },
      { content: [{ type: 'text', text: longText() }] },
      async () => ({ kind: 'block', feedback: 'no' })
    )
    assert(d1.kind === 'block', '10e1: block decision preserved')

    const d2 = await distiller(
      { name: 'pwsh' },
      { content: [{ type: 'text', text: longText() }] },
      async () => ({ kind: 'accept', value: { ok: true } })
    )
    assert(Object.hasOwn(d2, 'value'), '10e2: value-replaced decision preserved')
  }

  // 10f: results containing non-text blocks (images etc.) pass through raw
  {
    const upstream = { kind: 'accept' }
    const raw = { content: [{ type: 'image', image: 'iVBOR' }, { type: 'text', text: longText() }] }
    const decision = await distiller({ name: 'pwsh' }, raw, async () => upstream)
    assert(decision === upstream, '10f: image blocks are never distilled')
  }

  // 10g: composes with earlier listeners — distills the upstream decision content
  {
    // Fresh long text (unique prefix) so the content-level cache marked by 10b
    // doesn't treat this as a re-read and reuse 10b's distilled bytes.
    const upstreamContent = '10g 上游决策蒸馏专用文本（保证不命中 10b 的内容缓存）：\n' + longText()
    const upstream = { kind: 'accept', content: [{ type: 'text', text: upstreamContent }] }
    const decision = await distiller(
      { name: 'pwsh' },
      { content: [{ type: 'text', text: 'raw' }] },
      async () => upstream
    )
    assert(decision.content[0].text.includes('⟦本地蒸馏'), '10g: distills the upstream decision content')
  }

  // 10h: a distillation failure NEVER breaks a successful tool call
  {
    const badCfg = { ...cfg(), distillMinChars: 1, baseUrl: 'http://127.0.0.1:1', distillTimeoutMs: 800 }
    const badDistiller = makeResultDistiller(badCfg)
    const upstream = { kind: 'accept' }
    // Fresh long text (unique prefix) so the content-level cache from 10b
    // cannot mask the dead-endpoint failure with a cached distillation.
    const uncached = '10h 故障回退专用文本（保证不命中 10b 的内容缓存）：\n' + longText()
    const decision = await badDistiller(
      { name: 'pwsh' },
      { content: [{ type: 'text', text: uncached }] },
      async () => upstream
    )
    assert(decision === upstream, '10h: failure falls back to the raw decision')
  }

  // 10i: a re-read of the SAME text reuses the identical distilled bytes (no
  //      second local call), so the session and the cloud cache stay stable.
  {
    const readText = '10i 重读复用专用文本（不与其他测试共享内容）：\n' + longText()
    const first = await distiller(
      { name: 'pwsh' },
      { content: [{ type: 'text', text: readText }] },
      async () => ({ kind: 'accept' })
    )
    const firstText = first.content[0].text
    assert(firstText.includes('⟦本地蒸馏'), '10i: first read is distilled')
    const t0 = Date.now()
    const second = await distiller(
      { name: 'pwsh' },
      { content: [{ type: 'text', text: readText }] },
      async () => ({ kind: 'accept' })
    )
    const elapsed = Date.now() - t0
    assert(second.content[0].text === firstText, '10i: re-read reuses the identical distilled bytes')
    assert(elapsed < 3000, `10i: re-read skips the local call (${elapsed} ms)`)
  }
}

/** Fake agent with a session recording appended events. */
function makeFakeAgent(matchIds) {
  const appended = []
  return {
    appended,
    session: {
      events: matchIds.map((id) => ({ type: 'user/message', data: { id } })),
      append(type, data, opts) { appended.push({ type, data, opts }) },
    },
  }
}

// --- 11. distilled request leaves a GUI notice card (form:'notice') ---
{
  const received = []
  const { ctx, runtime } = makeRuntime(makeAdapter(received))
  installOutboundDistiller(ctx, cfg())
  const msg = { id: 'm-notice', role: 'user', content: [{ type: 'text', text: longText() }] }
  const agent = makeFakeAgent(['m-notice'])
  ctx.agents = { list: () => [agent] }
  await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
  assert(received.length === 1, '11a: adapter received the request')
  assert(agent.appended.length === 1, '11b: notice appended exactly once')
  const notice = agent.appended[0]
  assert(notice.type === 'user/message', '11c: notice is a user/message event')
  assert(notice.opts?.surfaceOp === 'append', '11d: notice uses append surface op')
  assert(notice.data?.source?.kind === 'plugin' && notice.data.source.plugin === 'local-model' && notice.data.source.form === 'notice', '11e: notice source declares plugin/form')
  assert(typeof notice.data.source.summary === 'string' && notice.data.source.summary.startsWith('⟦本地蒸馏'), '11f: collapsed-row summary carries the distill marker')
  assert(notice.data.content[0].text.includes('⟦本地蒸馏'), '11g: notice body lists the marker lines')
  assert(typeof notice.data.id === 'string' && notice.data.id !== '', '11h: notice message has an id')
  // retry: fresh options object, same message id (cache hit → distilled again)
  await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
  assert(agent.appended.length === 1, '11i: retried request does not duplicate the notice')
}

// --- 12. distillNotice:false suppresses the card, distillation still applies ---
{
  const received = []
  const { ctx, runtime } = makeRuntime(makeAdapter(received))
  installOutboundDistiller(ctx, cfg({ distillNotice: false }))
  const msg = { id: 'm-no-notice', role: 'user', content: [{ type: 'text', text: longText() }] }
  const agent = makeFakeAgent(['m-no-notice'])
  ctx.agents = { list: () => [agent] }
  await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
  assert(received.length === 1, '12a: adapter received the request')
  assert(agent.appended.length === 0, '12b: distillNotice:false suppresses the notice')
}

// --- 13. no agents service: notice skipped, stream unaffected ---
{
  const received = []
  const { ctx, runtime } = makeRuntime(makeAdapter(received))
  installOutboundDistiller(ctx, cfg())
  const msg = { id: 'm-no-agents', role: 'user', content: [{ type: 'text', text: longText() }] }
  await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
  assert(received.length === 1, '13a: request still streams without an agents service')
}

// --- 14. undistilled (short) request gets no notice ---
{
  const received = []
  const { ctx, runtime } = makeRuntime(makeAdapter(received))
  installOutboundDistiller(ctx, cfg())
  const msg = { id: 'm-notice-short', role: 'user', content: [{ type: 'text', text: '短消息，不触发蒸馏' }] }
  const agent = makeFakeAgent(['m-notice-short'])
  ctx.agents = { list: () => [agent] }
  await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [msg] }))
  assert(agent.appended.length === 0, '14a: undistilled request gets no notice')
}

/** A moderately long CJK text (~350 chars) with a unique key fact. */
function histLine(tag, fact) {
  return `[步骤 ${tag}] 上下文说明段落，包含关键事实：${fact}。` +
    '这里是一些占位叙述，用于撑起长度，确保消息进入剪枝范围。'.repeat(12) +
    '\n'
}

// --- 15. history pruning: over-budget requests get their oldest messages
//         replaced by one local-model summary, recent ones stay intact ---
{
  const kept = [
    { id: 'p-keep-1', role: 'user', content: [{ type: 'text', text: '最近的助手消息之一，关于当前任务。' }] },
    { id: 'p-keep-2', role: 'user', content: [{ type: 'text', text: '最近的助手消息之二，正在做的东西。' }] },
  ]
  const pruned = [
    { id: 'p-old-1', role: 'user', content: [{ type: 'text', text: histLine('1', '甲方案已废弃') }] },
    { id: 'p-old-2', role: 'user', content: [{ type: 'text', text: histLine('2', '乙方案已选定，端口 8848') }] },
    { id: 'p-old-3', role: 'user', content: [{ type: 'text', text: histLine('3', '缓存键为 cache:user:42') }] },
    { id: 'p-old-4', role: 'user', content: [{ type: 'text', text: histLine('4', '部署目标为 10.0.0.8') }] },
  ]
  const messages = [...pruned, ...kept]

  // 15a: under budget → untouched
  {
    const received = []
    const { ctx, runtime } = makeRuntime(makeAdapter(received))
    installOutboundDistiller(ctx, cfg({ pruneBudgetTokens: 100000 }))
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages }))
    assert(received.length === 1, '15a: adapter received the request')
    assert(received[0].messages === messages, '15a: under-budget request keeps message identity')
  }

  // 15b+15c: over budget → oldest replaced by a prune-summary message, recent
  // kept; a repeated request reuses the cached summary without a local call.
  {
    const received = []
    const { ctx, runtime } = makeRuntime(makeAdapter(received))
    installOutboundDistiller(ctx, cfg({ pruneBudgetTokens: 100, pruneKeepRecent: 2 }))
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages }))
    const got = received[0].messages
    assert(got.length === 3, `15b: pruned request has summary + kept messages (got ${got.length})`)
    assert(typeof got[0].content?.[0]?.text === 'string' && got[0].content[0].text.startsWith('⟦历史剪枝'), '15b: first message is the local history summary')
    assert(got[0].content[0].text.includes('省略4条消息'), '15b: summary marker reports the pruned count')
    assert(got[1] === kept[0] && got[2] === kept[1], '15b: the recent messages are kept intact (same objects)')
    assert(got[0].source?.kind === 'plugin' && got[0].source?.plugin === 'local-model', '15b: summary message declares its producer')
    const firstSummary = got[0].content[0].text
    const t0 = Date.now()
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages }))
    const elapsed = Date.now() - t0
    assert(received.length === 2, '15c: second request was sent')
    assert(received[1].messages[0].content[0].text === firstSummary, '15c: cached prune summary is identical')
    assert(elapsed < 3000, `15c: cached prune summary skips the local call (${elapsed} ms)`)
  }

  // 15d: not enough messages to prune
  {
    const received = []
    const { ctx, runtime } = makeRuntime(makeAdapter(received))
    installOutboundDistiller(ctx, cfg({ pruneBudgetTokens: 1, pruneKeepRecent: 3 }))
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: [kept[0], kept[1]] }))
    assert(received[0].messages.length === 2 && received[0].messages[0] === kept[0], '15d: messages at/below keepRecent are never pruned')
  }

  // 15e: prune summary failure → full history falls through untouched
  {
    const received = []
    const bad = { ...cfg({ pruneBudgetTokens: 1, pruneKeepRecent: 2 }), baseUrl: 'http://127.0.0.1:1', distillTimeoutMs: 800 }
    const { ctx, runtime } = makeRuntime(makeAdapter(received))
    installOutboundDistiller(ctx, bad)
    const fresh = [
      { id: 'p-fail-1', role: 'user', content: [{ type: 'text', text: histLine('x', '未缓存的全新长消息A') }] },
      { id: 'p-fail-2', role: 'user', content: [{ type: 'text', text: histLine('y', '未缓存的全新长消息B') }] },
      { id: 'p-fail-3', role: 'user', content: [{ type: 'text', text: '保留尾部' }] },
    ]
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: fresh }))
    assert(received.length === 1, '15e: request still streams after prune failure')
    assert(received[0].messages === fresh, '15e: failed prune falls back to the full original messages')
  }

  // 15f: pruneEnabled:false → never prunes
  {
    const received = []
    const { ctx, runtime } = makeRuntime(makeAdapter(received))
    installOutboundDistiller(ctx, cfg({ pruneEnabled: false, pruneBudgetTokens: 1, pruneKeepRecent: 2 }))
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages }))
    assert(received[0].messages === messages, '15f: pruneEnabled:false keeps the request untouched')
  }

  // 15g: prune notice card (form:'notice') reports the per-request delta
  {
    const received = []
    const { ctx, runtime } = makeRuntime(makeAdapter(received))
    installOutboundDistiller(ctx, cfg({ pruneBudgetTokens: 100, pruneKeepRecent: 2, distillCachePath: './.test-prune-notice.json' }))
    const agent = makeFakeAgent(['p-keep-2'])
    ctx.agents = { list: () => [agent] }
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages }))
    assert(agent.appended.length >= 1, '15g: notice appended for a pruned request')
    const notice = agent.appended.find((a) => a.type === 'user/message' && a.data?.source?.form === 'notice')
    assert(notice !== undefined, '15g: notice is a user/message with form:notice')
    assert(typeof notice.data.source.summary === 'string' && notice.data.source.summary.startsWith('⟦历史剪枝'), '15g: notice summary reports the prune')
    assert(notice.data.source.summary.includes('本轮压缩 4 条'), '15g: notice row reports the per-request delta (not cumulative)')
    assert(notice.data.content[0].text.includes('覆盖 4 条'), '15g: notice body shows the history chain coverage')
  }

  // 15h: frozen chain — growing the pruned set APPENDS a new block and never
  // rewrites earlier blocks, so the outbound request keeps a byte-stable prefix
  // that the cloud provider's prompt cache keeps hitting on.
  {
    const received = []
    const { ctx, runtime } = makeRuntime(makeAdapter(received))
    installOutboundDistiller(ctx, cfg({ pruneBudgetTokens: 100, pruneKeepRecent: 2, distillCachePath: './.test-prune-chain.json' }))
    const longMsg = (id, tag) => ({ id, role: 'user', content: [{ type: 'text', text: histLine(tag, `链测试事实 ${tag}`) }] })
    const m = [longMsg('c-o1', '1'), longMsg('c-o2', '2'), longMsg('c-o3', '3'), longMsg('c-o4', '4'), longMsg('c-k1', '5'), longMsg('c-k2', '6')]
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: m }))
    assert(received[0].messages.length === 3, `15h: rebuild → 1 block + kept (got ${received[0].messages.length})`)
    const b0 = received[0].messages[0].content[0].text
    assert(b0.startsWith('⟦历史剪枝'), '15h: first message is the initial prune block')
    // grow by one long message → c-k1 rolls off into a NEW appended block
    const grown = [...m, longMsg('c-k3', '7')]
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: grown }))
    assert(received[1].messages.length === 4, `15h: roll appends a 2nd block (got ${received[1].messages.length})`)
    assert(received[1].messages[0].content[0].text === b0, '15h: earlier block stays byte-identical (cached prefix)')
    assert(received[1].messages[1].content[0].text.startsWith('⟦历史剪枝'), '15h: 2nd message is the newly-rolled block')
    assert(received[1].messages[1].content[0].text !== b0, '15h: new block differs from the first')
    assert(received[1].messages[2].id === 'c-k2' && received[1].messages[3].id === 'c-k3', '15h: recent messages stay intact')
  }

  // 15i: deep compaction — a chain past pruneChainMaxBatches merges into one
  // block (the one rare full-chain rewrite that bounds the chain's size).
  {
    const received = []
    const { ctx, runtime } = makeRuntime(makeAdapter(received))
    installOutboundDistiller(ctx, cfg({ pruneBudgetTokens: 100, pruneKeepRecent: 2, pruneBatchSize: 1, pruneChainMaxBatches: 2, distillCachePath: './.test-prune-compact.json' }))
    const longMsg = (id, tag) => ({ id, role: 'user', content: [{ type: 'text', text: histLine(tag, `压缩测试事实 ${tag}`) }] })
    const m = [longMsg('co1', '1'), longMsg('co2', '2'), longMsg('co3', '3'), longMsg('co4', '4'), longMsg('ck1', '5'), longMsg('ck2', '6')]
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: m }))
    assert(received[0].messages.length === 3, '15i: rebuild → 1 block + kept')
    const g1 = [...m, longMsg('ck3', '7')]
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: g1 }))
    assert(received[1].messages.length === 4, `15i: roll 1 → 2 blocks (got ${received[1].messages.length})`)
    const g2 = [...g1, longMsg('ck4', '8')]
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: g2 }))
    assert(received[2].messages.length === 3, `15i: chain past maxBatches → deep compaction to 1 block (got ${received[2].messages.length})`)
    assert(received[2].messages[0].content[0].text.startsWith('⟦历史剪枝'), '15i: compacted first message is still a prune block')
    assert(received[2].messages[0].content[0].text !== received[1].messages[0].content[0].text, '15i: compacted block differs from the pre-roll first block')
    assert(received[2].messages[1].id === 'ck3' && received[2].messages[2].id === 'ck4', '15i: recent messages stay intact after compaction')
  }
}

// --- 16. billed-content accounting: the estimator counts reasoning_content
//         (on tool-call turns ONLY — the deepseek adapter drops it otherwise)
//         and tool-call arguments, matching what dsh-llm-deepseek actually puts
//         on the wire and what DSH's own dsh-token-meter bills. Regression: the
//         old text-only walk read ~20% low on real agentic sessions (deepseek
//         thinking + tool calls are invisible to it), so the prune budget fired
//         late and the real request ran past the plugin's estimate. ---
{
  const { estimateMessagesTokens } = await import('../lib/outbound-distill.js')
  const text = 'x'.repeat(4000)              // ~1120 est tokens as non-CJK text
  const reasoning = 'y'.repeat(4000)         // chain-of-thought, same length
  const args = '{"path":"' + 'z'.repeat(2000) + '"}'
  const toolCallMsg = {
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'reasoning', text: reasoning },
      { type: 'tool-call', id: 'c1', name: 'fs_read', arguments: args },
    ],
  }
  const finalAnswerMsg = { role: 'assistant', content: [{ type: 'text', text }, { type: 'reasoning', text: reasoning }] }
  const plainMsg = { role: 'assistant', content: [{ type: 'text', text }] }
  const toolResultMsg = { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text }] }] }
  const toolCallTok = estimateMessagesTokens([toolCallMsg], 1)
  const finalTok = estimateMessagesTokens([finalAnswerMsg], 1)
  const plainTok = estimateMessagesTokens([plainMsg], 1)
  const toolResultTok = estimateMessagesTokens([toolResultMsg], 1)
  assert(toolCallTok > plainTok * 2, `16a: tool-call turn bills reasoning + arguments (${toolCallTok} > ${plainTok * 2})`)
  assert(finalTok < plainTok * 1.5, `16b: final-answer reasoning is NOT billed (adapter strips it; ${finalTok} vs ${plainTok})`)
  assert(toolResultTok >= plainTok, `16c: tool-result content still counted (${toolResultTok})`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
// process.exitCode, not process.exit(): let undici's keep-alive sockets
// drain naturally (process.exit trips a libuv assertion on Windows).
process.exitCode = failures === 0 ? 0 : 1
