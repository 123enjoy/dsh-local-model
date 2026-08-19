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
    localModelRunningTool(cfg),
    localModelDistillTool(cfg),
  ]
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
