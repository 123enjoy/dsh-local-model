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
    pruneRegenEvery: 6,
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
  const msg = { id: 'm-block', role: 'user', content: [{ type: 'text', text: longText() }] }
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
  const original = longText()
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
  const a = { id: 'm-b1', role: 'user', content: [{ type: 'text', text: longText() }] }
  const b = { id: 'm-b2', role: 'user', content: [{ type: 'text', text: longText() }] }
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
    // Fresh long text (unique prefix) so the session-level dedup set marked by
    // 10b doesn't treat this as a re-read and serve the original.
    const upstreamContent = '10g 上游决策蒸馏专用文本（保证不命中 10b 的去重集合）：\n' + longText()
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
    installOutboundDistiller(ctx, cfg({ pruneBudgetTokens: 1000, pruneKeepRecent: 2 }))
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

  // 15g: prune notice card (form:'notice') reports the prune
  {
    const received = []
    const { ctx, runtime } = makeRuntime(makeAdapter(received))
    installOutboundDistiller(ctx, cfg({ pruneBudgetTokens: 1000, pruneKeepRecent: 2 }))
    const agent = makeFakeAgent(['p-keep-2'])
    ctx.agents = { list: () => [agent] }
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages }))
    assert(agent.appended.length >= 1, '15g: notice appended for a pruned request')
    const notice = agent.appended.find((a) => a.type === 'user/message' && a.data?.source?.form === 'notice')
    assert(notice !== undefined, '15g: notice is a user/message with form:notice')
    assert(typeof notice.data.source.summary === 'string' && notice.data.source.summary.startsWith('⟦历史剪枝'), '15g: notice summary reports the prune')
    assert(notice.data.content[0].text.includes('省略 4 条旧消息'), '15g: notice body carries prune details')
  }

  // 15h: snapshot batching — pruned set growing by fewer than pruneRegenEvery
  // messages reuses the summary (no local call) and keeps one notice key.
  {
    const received = []
    const { ctx, runtime } = makeRuntime(makeAdapter(received))
    installOutboundDistiller(ctx, cfg({ pruneBudgetTokens: 1000, pruneKeepRecent: 2, pruneRegenEvery: 6 }))
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages }))
    const firstSummary = received[0].messages[0].content[0].text
    // grow the history by one message: pruned set grows by 1 (< regenEvery)
    const grownMessages = [...messages, { id: 'p-keep-3', role: 'user', content: [{ type: 'text', text: '最新一轮的消息，仍在预算边缘。' }] }]
    const t0 = Date.now()
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: grownMessages }))
    const elapsed = Date.now() - t0
    assert(received.length === 2, '15h: second request was sent')
    assert(received[1].messages.length === 3, '15h: grown request is still pruned to summary + kept')
    assert(received[1].messages[0].content[0].text === firstSummary, '15h: stale-batch reuses the exact summary text')
    assert(elapsed < 3000, `15h: stale-batch reuse skips the local call (${elapsed} ms)`)
  }

  // 15i: pruneRegenEvery reached → the summary is regenerated (new text)
  {
    const received = []
    const { ctx, runtime } = makeRuntime(makeAdapter(received))
    installOutboundDistiller(ctx, cfg({ pruneBudgetTokens: 1000, pruneKeepRecent: 2, pruneRegenEvery: 2 }))
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages }))
    const firstSummary = received[0].messages[0].content[0].text
    const grown = [...messages, { id: 'p-keep-4', role: 'user', content: [{ type: 'text', text: '又一轮新消息。' }] }]
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: grown }))
    // grown by 1 with regenEvery 2 → still < 2 → reuse
    assert(received[1].messages[0].content[0].text === firstSummary, '15i: below regenEvery reuses')
    const grown2 = [...grown, { id: 'p-keep-5', role: 'user', content: [{ type: 'text', text: '再一轮新消息。' }] }]
    await drain(runtime.stream({ provider: 'cloud', model: 'x', messages: grown2 }))
    // grown by 2 since snapshot → regenerate → summary text should differ (marker stats differ)
    assert(received[2].messages[0].content[0].text !== firstSummary, '15i: regenEvery crossed regenerates the summary')
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
// process.exitCode, not process.exit(): let undici's keep-alive sockets
// drain naturally (process.exit trips a libuv assertion on Windows).
process.exitCode = failures === 0 ? 0 : 1
