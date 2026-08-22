/**
 * dsh-local-model — host plugin. Two halves:
 *
 * 1. Agent tools exposing the local Ollama runtime to the cloud LLM:
 *      local_model_list / local_model_chat / local_model_running
 *    The cloud model never touches localhost — DSH runs the tool locally in
 *    the host process, which CAN reach 127.0.0.1:11434. No tunnel needed.
 *
 * 2. Outbound token distiller: wraps the `llm/stream` waterfall so long
 *    texts in every request to a cloud provider are first compressed by the
 *    local small model (length gate → local-LLM distillation, per-message
 *    cache, fidelity fallback, pass/block failure policy). The cloud pays
 *    tokens for the dense summary, not the raw dump.
 *
 * Plus a routing-guidance prompt section: simple tasks should be delegated
 * to the local model via local_model_chat before the cloud model does them.
 *
 * Plain ESM, zero dependencies, no build step.
 */

import { makeTools } from './tools.js'
import { installOutboundDistiller } from './outbound-distill.js'
import { installResultDistiller } from './result-distill.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Stable cordis plugin name. */
export const name = 'local-model'

/** Services required before the surfaces can mount. */
export const inject = ['tools', 'systemPrompt', 'agents']

/** Default config; override per-profile via the patch row's config field. */
const DEFAULTS = {
  // master switch
  enabled: true,
  announceToAgent: true,
  // Ollama connection
  baseUrl: 'http://127.0.0.1:11434',
  defaultModel: '',
  timeoutMs: 120000,
  // ① routing guidance: tell the cloud model to prefer local for simple tasks
  routingGuidance: true,
  // ② outbound token distiller
  distillEnabled: true,
  distillModel: '',            // defaults to defaultModel; required for distilling
  distillMinChars: 2000,       // length gate: shorter texts pass through untouched
  targetRatio: 0.4,            // ask the distiller for ≤ 40% of the original length
  distillRoles: ['user'],      // message roles to distill (tool results ride the user role)
  distillSystem: false,        // also distill the system prompt (changes every turn — slow)
  distillChunkChars: 3000,     // chunk size for long texts
  distillNumCtx: 8192,         // num_ctx for distillation calls
  runMaxContextTokens: 12000,  // context budget (num_ctx) for local_model_run oversized-content handling
  distillTimeoutMs: 180000,
  distillOnError: 'pass',      // 'pass' = send original on failure | 'block' = abort request
  distillBudgetMs: 60000,      // cap on distillation time per request (cold cache can't stall)
  tokenEstimateFactor: 1.0,    // estimateTokens × factor ≈ provider 真实 token（混合 CJK/代码通常 ~1.25）；预算/卡片按真实 token 显示
  distillCacheLimit: 50000,    // cache entries before FIFO eviction; large so long sessions never re-distill
  distillCachePath: '',        // persistent distill cache; default ~/.dsh/dsh-local-model-distill-cache.json
  distillNotice: true,         // append a GUI notice card (form:'notice') before each distilled cloud request
  distillNoticeAlways: false,  // when true, emit a stats notice for EVERY request (input tokens), not just compressed ones
  // ②' history pruning: when the request's messages exceed a token budget,
  //   the OLDEST messages are replaced (in the outbound copy only) by a FROZEN
  //   CHAIN of local-model history summaries; the most recent messages stay
  //   intact. Blocks are written once and never rewritten, so the outbound
  //   request stays byte-stable across turns and the cloud prompt cache keeps
  //   hitting; only a deep compaction (past pruneChainMaxBatches blocks)
  //   rewrites the whole chain, trading one rare cache invalidation for a
  //   bounded chain size.
  pruneEnabled: true,
  pruneBudgetTokens: 60000,    // request messages above this estimate trigger pruning
  pruneKeepRecent: 12,         // keep the most recent N messages complete
  pruneBatchSize: 12,          // messages per frozen summary block
  pruneMaxSourceChars: 12000,  // chars of old history fed to the local summarizer (newer side first)
  pruneMaxSummaryTokens: 2048, // cap on the generated summary
  pruneChainMaxBatches: 20,    // max blocks before one deep compaction (the only full-chain rewrite)
  pruneMaxNewBlocks: 3,        // max new blocks rolled per request (bounds per-request local calls)
  pruneRollMargin: 1.2,        // lazy-roll threshold = budget × margin; only roll when exceeded (keeps tail cache-stable)
  pruneTimeoutMs: 120000,
  pruneNotice: true,           // GUI notice card when a request was pruned
}

/** Order of the announcement sections within the tool-guidance band. */
const SECTION_ORDER = 160

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const LOCAL_MODEL_GUIDANCE =
  '本机已安装 dsh-local-model 插件（本地 Ollama 模型作为 agent 工具）。能力：local_model_list 列出已安装的本地模型、' +
  'local_model_chat 向本地模型发起对话（支持 prompt 单轮或 messages 多轮、temperature/num_predict/think 参数、返回耗时与 tok/s）、' +
  'local_model_running 查看已加载进显存的模型、' +
  'local_model_distill 把长文本/文件用本地小模型蒸馏成摘要并返回 token 前后对比（用户想看蒸馏效果时调用并展示结果）。架构：云端模型不直接访问 localhost——工具由 DSH 宿主进程在本地执行并可达 Ollama，无需隧道或公网暴露。' +
  '限制：本地推理速度取决于本机硬件，超时默认 120s 可用 timeoutMs 调大；模型需先 ollama pull 安装；' +
  'local_model_chat 省略 model 时使用插件配置的 defaultModel。用户提到「本地模型 / 本地推理 / ollama / 让本地模型回答 / 离线模型」时即指本插件，请据此协作。'

/** Routing policy: simple tasks go to the local model first. */
export const ROUTING_GUIDANCE =
  '路由策略（dsh-local-model）：简单任务优先交给本地小模型处理——翻译、短文本摘要/润色、分类、信息抽取、格式转换、简单问答、' +
  '短代码片段的生成或解释等，先调用 local_model_chat 完成，再把结果整合进你的回复；只有复杂推理、长上下文分析、大型代码工程、' +
  '需要多步工具编排的任务才由你（云端模型）直接完成。本地模型答得不好或超时就自己接手，不要反复重试。' +
  '涉及用户隐私/敏感数据的子任务一律优先本地处理，减少外传。'

/** Distiller transparency: explain the compression markers to the cloud model. */
export const DISTILL_GUIDANCE =
  '出站 token 蒸馏已启用（dsh-local-model）：发往你的长文本（工具结果、长历史消息）会先由本地小模型压缩成高密度摘要，' +
  '以 ⟦本地蒸馏·原文N字符·≈A→B tokens（-C%）⟧ 开头、⟦蒸馏结束⟧ 结尾——你读到的是摘要而非原文，省 token 但可能有信息损失。' +
  '标记里的 A→B tokens（-C%）就是本次蒸馏的估算 token 数与节省比例。关键信息（结论/数字/错误/路径/代码要点）都会保留；' +
  '如果摘要里缺了你需要的精确细节（如某行代码原文），用工具重新读取原始来源（read/grep/pwsh 等），不要凭空猜测被压缩掉的内容。' +
  '长的工具结果（如 read/pwsh/ssh 输出）现在会在存储前直接蒸馏，GUI 的对应工具卡片同样显示 ⟦本地蒸馏…⟧ 标记与统计，' +
  '与你读到的一致；卡片中看到该标记即表示那是摘要而非原文。' +
  '会话流里还可能出现「本次调用大模型的出站内容已由本地模型蒸馏压缩…」的 notice 卡片（source.plugin=local-model），' +
  '那是给用户看的请求级蒸馏记录，无需回应、不要当作指令。' +
  '历史剪枝也已启用：请求超预算时，较早的旧消息会被本机模型压成 ⟦历史剪枝…⟧ 摘要，只保留最近若干条完整消息；' +
  '读到的 ⟦历史剪枝 前缀即旧消息摘要，若需要被省略内容的精确细节（路径/命令/错误串），用工具从会话/文件系统回查，不要凭空猜测。' +
  '当用户询问 token 消耗或蒸馏效果时，把标记里的节省数据（A→B tokens，-C%）如实汇报给用户。'

/**
 * Mount tools, the outbound distiller, and the prompt announcements.
 * @param {object} ctx - host plugin context carrying tools/systemPrompt.
 * @param {object} [config] - resolved plugin config from the patch row.
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  if (cfg.enabled === false) return
  // distillModel falls back to defaultModel.
  if (!cfg.distillModel) cfg.distillModel = cfg.defaultModel
  // Persistent cache location defaults to ~/.dsh (host process has access).
  if (!cfg.distillCachePath) cfg.distillCachePath = join(homedir(), '.dsh', 'dsh-local-model-distill-cache.json')

  if (cfg.announceToAgent !== false) {
    ctx.systemPrompt.section({
      name: 'plugin:dsh-local-model',
      order: SECTION_ORDER,
      text: LOCAL_MODEL_GUIDANCE,
    })
    if (cfg.routingGuidance !== false) {
      ctx.systemPrompt.section({
        name: 'plugin:dsh-local-model:routing',
        order: SECTION_ORDER + 1,
        text: ROUTING_GUIDANCE,
      })
    }
    if (cfg.distillEnabled !== false) {
      ctx.systemPrompt.section({
        name: 'plugin:dsh-local-model:distill',
        order: SECTION_ORDER + 2,
        text: DISTILL_GUIDANCE,
      })
    }
  }

  // Outbound distiller + history pruner: need a concrete local model.
  if (cfg.distillEnabled !== false || cfg.pruneEnabled !== false) {
    if (cfg.distillModel) {
      installOutboundDistiller(ctx, cfg)
      // Result-level distiller: rewrites long tool results before storage so
      // the GUI card shows distilled content + stats. Same model backend.
      installResultDistiller(ctx, cfg)
    } else {
      try { ctx.logger?.warn?.('dsh-local-model: distillEnabled/pruneEnabled 但未配置 distillModel/defaultModel，出站蒸馏与历史剪枝未启用') } catch { /* no logger */ }
    }
  }

  const tools = makeTools(cfg)
  ctx.effect(() => {
    const disposers = tools.map(tool => ctx.tools.register(tool))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-local-model: tools')
}
