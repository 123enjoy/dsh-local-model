/**
 * Agent tools exposing the local Ollama runtime. Plain tool-definition
 * objects for ctx.tools.register — no @deepseek-ai imports needed.
 */

import { chat, listModels, listRunning, version } from './ollama.js'
import { distillText, estimateTokens } from './compress.js'
import { readFile } from 'node:fs/promises'

/** One text content block (the only render shape these tools emit). */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** Render the model table shared by list surfaces. */
function renderModels(models) {
  if (models.length === 0) return '本地没有已安装的模型（可用 ollama pull <model> 下载）'
  const rows = models.map(m =>
    [m.name, m.parameterSize ?? '-', m.quantization ?? '-', m.sizeGB != null ? m.sizeGB + ' GB' : '-', m.modifiedAt ?? '-'].join(' | '))
  return ['name | parameters | quant | size | modified', '--- | --- | --- | --- | ---', ...rows].join('\n')
}

/** Per-file cap for content injected into the local model's context. */
const READ_MAX_CHARS = 20000

/** Normalize a `files` param (single string or array) to an array of paths. */
export function normalizeFiles(files) {
  if (Array.isArray(files)) {
    return files.filter(f => typeof f === 'string' && f.trim() !== '').map(f => f.trim())
  }
  if (typeof files === 'string' && files.trim() !== '') return [files.trim()]
  return []
}

/**
 * Read the given local files and build the "===== FILE i/N: <path> ====="
 * context block. File contents never leave the machine — they are passed
 * straight to the local Ollama model. Per-file content is capped so we don't
 * blow the small model's context window.
 */
export async function buildFilesBlock(files) {
  const list = normalizeFiles(files)
  if (list.length === 0) return null
  const blocks = []
  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    let content
    try {
      content = await readFile(p, 'utf8')
    } catch (err) {
      content = `[读取失败: ${err?.message ?? err}]`
    }
    const extra = content.length - READ_MAX_CHARS
    if (extra > 0) {
      content = content.slice(0, READ_MAX_CHARS) + `\n…[内容过长，已截断，尚余 ${extra} 字符]…`
    }
    blocks.push(`===== FILE ${i + 1}/${list.length}: ${p} =====\n${content}`)
  }
  return '以下是你要处理的本地文件内容（数据不出本机）：\n\n' + blocks.join('\n\n')
}

/** local_model_list — installed models + daemon version. */
export function localModelListTool(cfg) {
  return {
    name: 'local_model_list',
    description: 'List models installed in the local Ollama runtime (name, parameter size, quantization, disk size). ' +
      'Triggers: local model, what models are available locally, ollama list, 本地模型, 有哪些模型.',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          version: { type: 'string' },
          models: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                sizeGB: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                parameterSize: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                quantization: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                family: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                modifiedAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
              required: ['name'],
            },
          },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        if (!value.ok) return text('查询失败: ' + (value.error ?? 'unknown'))
        return text(`Ollama ${value.version ?? ''}，共 ${(value.models ?? []).length} 个本地模型：\n` + renderModels(value.models ?? []))
      },
    },
    async execute() {
      try {
        const [ver, models] = await Promise.all([
          version(cfg.baseUrl, 10000),
          listModels(cfg.baseUrl, 10000),
        ])
        return { ok: true, version: ver, models }
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) }
      }
    },
  }
}

/** local_model_running — models currently loaded in (V)RAM. */
export function localModelRunningTool(cfg) {
  return {
    name: 'local_model_running',
    description: 'List local Ollama models currently loaded in memory/VRAM and their expiry. ' +
      'Triggers: which local model is loaded, 显存占用, ollama ps, 已加载模型.',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          models: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                sizeGB: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                vramGB: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                expiresAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
              required: ['name'],
            },
          },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        if (!value.ok) return text('查询失败: ' + (value.error ?? 'unknown'))
        const models = value.models ?? []
        if (models.length === 0) return text('当前没有已加载的本地模型')
        return text(models.map(m =>
          `${m.name} | 显存 ${m.vramGB ?? '?'} GB | 驻留至 ${m.expiresAt ?? '-'}`).join('\n'))
      },
    },
    async execute() {
      try {
        return { ok: true, models: await listRunning(cfg.baseUrl, 10000) }
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) }
      }
    },
  }
}

/** local_model_chat — the main entry: send a chat to a local model. */
export function localModelChatTool(cfg) {
  return {
    name: 'local_model_chat',
    description: 'Send a chat request to a locally running Ollama model and return its reply plus latency/throughput stats. ' +
      'Use local_model_list first if unsure which models are installed. ' +
      'Supports an optional `files` array read locally (data never leaves the machine). ' +
      'Triggers: local model, ask the local model, run prompt locally, offline inference, 本地模型, 本地推理, 让本地模型回答, 敏感数据本地处理.',
    parameters: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Ollama model name (e.g. "qwen2.5:7b"). Optional when the plugin config sets defaultModel.',
        },
        prompt: {
          type: 'string',
          description: 'Single-turn user message. Mutually exclusive with messages.',
        },
        messages: {
          type: 'array',
          description: 'Multi-turn chat history, OpenAI-style [{role, content}]. Mutually exclusive with prompt.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
        },
        files: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Optional one or more absolute file paths the local model should read and process. ' +
            'Files are read locally (data never leaves the machine) and injected into the message context.',
        },
        system: { type: 'string', description: 'System prompt prepended when using prompt.' },
        temperature: { type: 'number', description: 'Sampling temperature (Ollama options.temperature).' },
        numPredict: { type: 'integer', description: 'Max tokens to generate (Ollama options.num_predict).' },
        think: { type: 'boolean', description: 'Enable/disable thinking for models that support it (e.g. qwen3).' },
        timeoutMs: { type: 'integer', description: `Timeout in milliseconds (default ${cfg.timeoutMs}; local inference can be slow).` },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          model: { type: 'string' },
          content: { type: 'string' },
          thinking: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          totalDurationMs: { type: 'integer' },
          promptTokens: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          completionTokens: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          tokensPerSecond: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        if (!value.ok) return text('本地模型调用失败: ' + (value.error ?? 'unknown'))
        const stats = `[${value.model} | ${value.totalDurationMs} ms | ${value.completionTokens ?? '?'} tokens | ${value.tokensPerSecond ?? '?'} tok/s]`
        const thinking = value.thinking ? `<thinking>\n${value.thinking}\n</thinking>\n\n` : ''
        return text(thinking + (value.content ?? '') + '\n\n' + stats)
      },
    },
    async execute(args) {
      const model = args.model ?? cfg.defaultModel
      if (!model) {
        return { ok: false, error: '缺少 model 参数，且插件未配置 defaultModel。先用 local_model_list 查看可用模型。' }
      }
      let messages
      if (Array.isArray(args.messages) && args.messages.length > 0) {
        messages = args.messages
      } else if (typeof args.prompt === 'string' && args.prompt !== '') {
        messages = []
        if (typeof args.system === 'string' && args.system !== '') messages.push({ role: 'system', content: args.system })
        messages.push({ role: 'user', content: args.prompt })
      } else {
        return { ok: false, error: '必须提供 prompt 或 messages 之一。' }
      }
      if (args.files) {
        const filesBlock = await buildFilesBlock(args.files)
        if (filesBlock) messages = [{ role: 'system', content: filesBlock }, ...messages]
      }
      const options = {}
      if (typeof args.temperature === 'number') options.temperature = args.temperature
      if (typeof args.numPredict === 'number') options.num_predict = args.numPredict
      try {
        const result = await chat(cfg.baseUrl, {
          model,
          messages,
          options,
          think: typeof args.think === 'boolean' ? args.think : undefined,
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : cfg.timeoutMs,
        })
        // chat() 返回的 role/doneReason 不在输出 schema 内（additionalProperties:false），剔除。
        const { role: _role, doneReason: _doneReason, ...rest } = result
        return { ok: true, ...rest }
      } catch (err) {
        return { ok: false, model, error: err?.message ?? String(err) }
      }
    },
  }
}

/** Build the full tool set from resolved plugin config. */
export function makeTools(cfg) {
  return [
    localModelListTool(cfg),
    localModelChatTool(cfg),
    localModelRunTool(cfg),
    localModelRunningTool(cfg),
    localModelDistillTool(cfg),
  ]
}

/* ------------------------------------------------------------------ *
 * Context-window-aware helpers for local_model_run.  The local small
 * models have small windows (~16K tokens), so oversized file content is
 * shrunken to a budget before being sent.  Strategy is chosen by the
 * instruction wording in 'auto' mode, or forced by the caller.
 * ------------------------------------------------------------------ */

/** Pick the auto context-overflow strategy from the instruction wording. */
function autoStrategy(instruction) {
  if (/摘要|总结|综述|概括|梗概|提炼|overview|summar|condense|digest/i.test(instruction)) return 'distill'
  if (/逐\.|每\.|每个|each|逐条|批量|归类|分类|整理成表|翻译|提取\s*所有|extract all|translate/i.test(instruction)) return 'chunk'
  return 'truncate'
}

/** Split text into chunks each within a token budget, preferring line breaks. */
function splitByTokenBudget(text, budgetTokens) {
  const chunks = []
  const lines = text.split('\n')
  let cur = ''
  let curTokens = 0
  const flush = () => {
    if (cur) chunks.push(cur)
    cur = ''
    curTokens = 0
  }
  for (const line of lines) {
    const lineTokens = estimateTokens(line)
    if (curTokens + lineTokens + 1 > budgetTokens && cur) flush()
    if (lineTokens > budgetTokens) {
      // A single over-long line: hard-split it near the budget boundary.
      let rest = line
      while (estimateTokens(rest) > budgetTokens) {
        let cut = 0
        let acc = ''
        for (const ch of rest) {
          if (estimateTokens(acc + ch) > budgetTokens) break
          acc += ch
          cut += 1
        }
        chunks.push(rest.slice(0, Math.max(1, cut)))
        rest = rest.slice(Math.max(1, cut))
      }
      if (rest) chunks.push(rest)
      flush()
      continue
    }
    curTokens += lineTokens + 1
    cur += (cur ? '\n' : '') + line
  }
  flush()
  return chunks
}

/** head+tail truncation that keeps the start and the end within budget. */
function truncateHeadTail(text, budgetTokens) {
  const originalTokens = estimateTokens(text)
  if (originalTokens <= budgetTokens) return { content: text, truncated: false, originalTokens }
  const headBudget = Math.max(1, Math.floor(budgetTokens * 0.6))
  const tailBudget = budgetTokens - headBudget
  const head = splitByTokenBudget(text, headBudget)[0] ?? ''
  const lines = text.split('\n')
  let tail = ''
  let tailTokens = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = estimateTokens(lines[i])
    if (tailTokens + t + 1 > tailBudget && tail) break
    tail = (tail ? '\n' : '') + lines[i]
    tailTokens += t + 1
  }
  const marker = '\n\n…[内容过长已被截断：预算内保留文档头部与尾部，省略中间内容，结果可能不完整]…\n\n'
  return { content: head + marker + tail, truncated: true, originalTokens }
}

/** One local chat call returning only the text answer. */
async function runOnce(callOpts, messages, numCtx) {
  const options = { num_ctx: numCtx }
  if (callOpts.temperature != null) options.temperature = callOpts.temperature
  if (callOpts.numPredict != null) options.num_predict = callOpts.numPredict
  const res = await chat(callOpts.baseUrl, {
    model: callOpts.model,
    messages,
    options,
    think: callOpts.think,
    timeoutMs: callOpts.timeoutMs,
  })
  return res?.content ?? ''
}

/**
 * Decide how to feed oversized content to the small model and run it.
 * Returns either { systemContent } (fed into one final call) or
 * { finalResult } (chunk/map-reduce already produced the answer).
 */
async function planRun({ filesBlock, strategy, budgetTokens, availForContent, instruction, callOpts, cfg }) {
  const contentTokens = estimateTokens(filesBlock)
  const decided = strategy === 'auto' ? autoStrategy(instruction) : strategy
  if (contentTokens <= availForContent) {
    return { systemContent: filesBlock, context: { strategy: 'full', contentTokens, budgetTokens, truncated: false } }
  }
  if (decided === 'truncate') {
    const { content, truncated, originalTokens } = truncateHeadTail(filesBlock, availForContent)
    return { systemContent: content, context: { strategy: 'truncate', contentTokens, originalTokens, budgetTokens, truncated } }
  }
  if (decided === 'distill') {
    const distilled = await distillText(cfg, filesBlock)
    return {
      systemContent: distilled,
      context: { strategy: 'distill', contentTokens, distilledTokens: estimateTokens(distilled), budgetTokens },
    }
  }
  // chunk: map the instruction over each block, then merge into the final answer.
  const chunkBudget = Math.max(500, Math.floor(availForContent * 0.8))
  const chunks = splitByTokenBudget(filesBlock, chunkBudget)
  const parts = []
  for (let i = 0; i < chunks.length; i++) {
    const m = [
      { role: 'system', content: `第 ${i + 1}/${chunks.length} 块待处理内容：\n${chunks[i]}` },
      { role: 'user', content: instruction },
    ]
    parts.push(await runOnce(callOpts, m, budgetTokens))
  }
  let finalResult = parts.join('\n\n---\n\n')
  if (parts.length > 1) {
    finalResult = await runOnce(callOpts, [
      { role: 'system', content: '以下是同一指令对各块文件内容的处理结果，请在不遗漏信息的前提下合并成一份连贯的最终输出。' },
      { role: 'user', content: finalResult },
    ], budgetTokens)
  }
  return { finalResult, context: { strategy: 'chunk', chunks: chunks.length, contentTokens, budgetTokens } }
}

/**
 * local_model_run — instruct the local small model to process one or more local
 * files and return a concise result. Purpose: "remote command, local execution".
 * The cloud model delegates concrete file work (extraction, filtering, summary,
 * translation, formatting, pattern/error search) to the local model instead of
 * reading the file itself (which would be distilled / cost upload tokens).
 * File contents are read locally and never leave the machine.
 */
export function localModelRunTool(cfg) {
  return {
    name: 'local_model_run',
    description: 'Instruct the local small model to process one or more local files and return a concise result. ' +
      'Reads the files locally (data never leaves the machine) and sends your instruction + the file contents to the local model. ' +
      'Use when you (the cloud model) want to delegate concrete file work — extraction, filtering, summary, translation, ' +
      'formatting, searching for patterns/errors — to the local model instead of reading the file yourself. ' +
      'Triggers: 让本地模型处理文件 / 本地读取并提取 / 把文件里的 X 挑出来 / 在本地文件里找出 / run local on these files. ' +
      'Note: the local model never touches the filesystem itself — the DSH host (this process) reads every file, ' +
      'passes the content as plain text to the local Ollama model for pure text transformation, and returns the text back. ' +
      'The local model cannot read/write/enumerate/execute anything on its own; all file I/O (including any write-back, ' +
      'batching or directory traversal you want) must be orchestrated by this host, never assumed on the model side.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        files: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'One or more absolute file paths for the local model to read and process.',
        },
        instruction: { type: 'string', description: 'What the local model should do with the file(s). Concise and concrete.' },
        outputFormat: { type: 'string', description: 'Optional: ask for json/csv/list/纯文本 etc. Appended to the instruction.' },
        model: { type: 'string', description: 'Local model name; defaults to the plugin defaultModel.' },
        temperature: { type: 'number', description: 'Sampling temperature.' },
        numPredict: { type: 'integer', description: 'Max tokens to generate.' },
        think: { type: 'boolean', description: 'Enable/disable thinking for models that support it.' },
        timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default cfg.timeoutMs).' },
        strategy: {
          type: 'string',
          enum: ['auto', 'truncate', 'distill', 'chunk'],
          description: 'How to handle file content that exceeds the small model context budget: ' +
            'truncate (keep head+tail), distill (compress locally first), chunk (map-reduce per block). ' +
            'Defaults to auto, which picks by the instruction wording.',
        },
      },
      required: ['files', 'instruction'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' } },
          model: { type: 'string' },
          content: { type: 'string' },
          thinking: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          totalDurationMs: { type: 'integer' },
          promptTokens: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          completionTokens: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          tokensPerSecond: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          context: { oneOf: [{ type: 'object' }, { type: 'null' }] },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        if (!value.ok) return text('本地处理失败: ' + (value.error ?? 'unknown'))
        const files = Array.isArray(value.files) && value.files.length ? '文件: ' + value.files.join(', ') + '\n\n' : ''
        const stats = value.totalDurationMs
          ? `[${value.model} | ${value.totalDurationMs} ms | ${value.completionTokens ?? '?'} tokens | ${value.tokensPerSecond ?? '?'} tok/s]`
          : ''
        const thinking = value.thinking ? `<thinking>\n${value.thinking}\n</thinking>\n\n` : ''
        const ctx = value.context
          ? `\n[context: ${value.context.strategy}${value.context.truncated ? '·已截断' : ''}${value.context.contentTokens != null ? `·${value.context.contentTokens} tokens` : ''}${value.context.distilledTokens != null ? `→${value.context.distilledTokens}` : ''}${value.context.chunks != null ? `·${value.context.chunks} 块` : ''}]`
          : ''
        return text(files + thinking + (value.content ?? '') + '\n\n' + stats + ctx)
      },
    },
    async execute(args) {
      const model = args.model ?? cfg.defaultModel
      if (!model) {
        return { ok: false, error: '缺少 model 参数，且插件未配置 defaultModel。先用 local_model_list 查看可用模型。' }
      }
      const filesList = normalizeFiles(args.files)
      if (filesList.length === 0) return { ok: false, error: 'local_model_run 需要 files 参数（一个或多个文件路径）。' }
      if (typeof args.instruction !== 'string' || args.instruction.trim() === '') {
        return { ok: false, error: 'local_model_run 需要 instruction 参数（告诉本地模型对文件做什么）。' }
      }
      let filesBlock
      try {
        filesBlock = await buildFilesBlock(filesList)
      } catch (err) {
        filesBlock = null
      }
      if (!filesBlock) return { ok: false, error: '无法读取指定的文件。' }

      let instruction = args.instruction.trim()
      if (typeof args.outputFormat === 'string' && args.outputFormat.trim() !== '') {
        instruction += `\n\n请以 ${args.outputFormat.trim()} 的格式输出结果。`
      }

      // ---- context-window-aware handling (small local model window) ----
      const budgetTokens = (typeof cfg.runMaxContextTokens === 'number' && cfg.runMaxContextTokens > 0)
        ? cfg.runMaxContextTokens
        : 12000
      const strategy = typeof args.strategy === 'string' ? args.strategy : 'auto'
      const instructionTokens = estimateTokens(instruction)
      const availForContent = Math.max(1, budgetTokens - instructionTokens - 180)

      const callOpts = {
        baseUrl: cfg.baseUrl,
        model,
        think: typeof args.think === 'boolean' ? args.think : undefined,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : cfg.timeoutMs,
        temperature: typeof args.temperature === 'number' ? args.temperature : undefined,
        numPredict: typeof args.numPredict === 'number' ? args.numPredict : undefined,
      }

      const plan = await planRun({
        filesBlock, strategy, budgetTokens, availForContent, instruction, callOpts, cfg,
      })

      let resultContent
      let resultRest = {}
      if (plan.finalResult != null) {
        // chunk/map-reduce already produced the final answer; skip the single final call.
        resultContent = plan.finalResult
      } else {
        const messages = [
          { role: 'system', content: plan.systemContent + '\n\n请只按用户接下来的指令处理上述文件并输出结果。' },
          { role: 'user', content: instruction },
        ]
        const options = {}
        if (callOpts.temperature != null) options.temperature = callOpts.temperature
        if (callOpts.numPredict != null) options.num_predict = callOpts.numPredict
        options.num_ctx = budgetTokens
        try {
          const result = await chat(callOpts.baseUrl, {
            model,
            messages,
            options,
            think: callOpts.think,
            timeoutMs: callOpts.timeoutMs,
          })
          const { role: _role, doneReason: _doneReason, ...rest } = result
          resultContent = rest.content
          resultRest = rest
        } catch (err) {
          return { ok: false, model, files: filesList, error: err?.message ?? String(err) }
        }
      }
      return { ok: true, model, files: filesList, content: resultContent, context: plan.context, ...resultRest }
    },
  }
}

/**
 * local_model_distill — distill text (or a file) on demand and return the
 * compressed result plus token stats. Purpose: make distillation visible to
 * the user: this tool's result renders as a generic text block containing the
 * ⟦本地蒸馏⟧ summary and the ≈A→B tokens（-C%） numbers, right in the chat.
 */
export function localModelDistillTool(cfg) {
  return {
    name: 'local_model_distill',
    description: 'Distill long text (or the content of a file path) with the local small model on demand, ' +
      'returning the compressed summary plus before/after token stats. ' +
      'Use when the user wants to SEE what the outbound distiller did, or wants a dense summary of a long file/content. ' +
      'Triggers: 把这段内容蒸馏一下 / 这个文件上传前会省多少 token / 我要看蒸馏结果 / distill this.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to distill. Mutually exclusive with path.' },
        path: { type: 'string', description: 'Absolute file path whose content gets distilled. Mutually exclusive with text.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          originalChars: { type: 'integer' },
          beforeTokens: { type: 'integer' },
          afterTokens: { type: 'integer' },
          savingsPct: { type: 'integer' },
          skipped: { type: 'boolean', description: 'true when the text was below the length gate or the model refused to compress' },
          content: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        if (!value.ok) return text('蒸馏失败: ' + (value.error ?? 'unknown'))
        if (value.skipped) return text(`未蒸馏（原文 ${value.originalChars} 字符，低于门槛或模型拒绝压缩），原样展示无标记。`)
        // Same marker format as the outbound distiller so already-distilled
        // results are never distilled twice downstream.
        const marker = `⟦本地蒸馏·原文${value.originalChars}字符·≈${value.beforeTokens}→${value.afterTokens} tokens（-${value.savingsPct}%）⟧`
        return text(marker + '\n' + value.content + '\n⟦蒸馏结束⟧')
      },
    },
    async execute(args) {
      let source
      if (typeof args.text === 'string' && args.text !== '') {
        source = args.text
      } else if (typeof args.path === 'string' && args.path !== '') {
        try {
          source = await readFile(args.path, 'utf8')
        } catch (err) {
          return { ok: false, error: `读取文件失败: ${err?.message ?? err}` }
        }
      } else {
        return { ok: false, error: '必须提供 text 或 path 之一。' }
      }
      if (source.length < cfg.distillMinChars) {
        return { ok: true, originalChars: source.length, skipped: true, beforeTokens: estimateTokens(source), afterTokens: estimateTokens(source), savingsPct: 0, content: source }
      }
      try {
        const distilled = await distillText(cfg, source)
        if (distilled === source) {
          return { ok: true, originalChars: source.length, skipped: true, beforeTokens: estimateTokens(source), afterTokens: estimateTokens(source), savingsPct: 0, content: source }
        }
        const before = estimateTokens(source)
        const after = estimateTokens(distilled)
        return {
          ok: true,
          originalChars: source.length,
          beforeTokens: before,
          afterTokens: after,
          savingsPct: Math.round((1 - after / before) * 100),
          skipped: false,
          content: distilled,
        }
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) }
      }
    },
  }
}
