/**
 * Minimal Ollama HTTP client (Node 22+ global fetch, zero deps).
 * Every call carries its own AbortController timeout and maps connection
 * failures to a friendly Chinese error the model can act on.
 */

/** Fetch JSON with a timeout; friendly errors for connection failures. */
async function getJson(baseUrl, path, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(baseUrl + path, { signal: controller.signal })
    if (!res.ok) throw new Error(`Ollama 返回 HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    return await res.json()
  } catch (err) {
    throw mapError(err, baseUrl)
  } finally {
    clearTimeout(timer)
  }
}

/** POST JSON with a timeout; returns parsed JSON. */
async function postJson(baseUrl, path, body, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Ollama 返回 HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    return await res.json()
  } catch (err) {
    throw mapError(err, baseUrl)
  } finally {
    clearTimeout(timer)
  }
}

/** Map fetch failures to actionable messages. */
function mapError(err, baseUrl) {
  if (err?.name === 'AbortError') {
    return new Error(`调用 Ollama 超时（${baseUrl}）。本地模型推理可能较慢，可调大 timeoutMs 重试。`)
  }
  const cause = err?.cause
  if (cause?.code === 'ECONNREFUSED' || cause?.code === 'ENOTFOUND' || cause?.code === 'EHOSTUNREACH') {
    return new Error(`连不上 Ollama（${baseUrl}，${cause.code}）。请确认本机 Ollama 已启动（ollama serve）。`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

/** List installed models (GET /api/tags). */
export async function listModels(baseUrl, timeoutMs) {
  const data = await getJson(baseUrl, '/api/tags', timeoutMs)
  return (data.models ?? []).map(m => ({
    name: m.name,
    sizeGB: typeof m.size === 'number' ? Math.round((m.size / 1e9) * 100) / 100 : null,
    parameterSize: m.details?.parameter_size ?? null,
    quantization: m.details?.quantization_level ?? null,
    family: m.details?.family ?? null,
    modifiedAt: m.modified_at ?? null,
  }))
}

/** List currently loaded models (GET /api/ps). */
export async function listRunning(baseUrl, timeoutMs) {
  const data = await getJson(baseUrl, '/api/ps', timeoutMs)
  return (data.models ?? []).map(m => ({
    name: m.name,
    sizeGB: typeof m.size === 'number' ? Math.round((m.size / 1e9) * 100) / 100 : null,
    vramGB: typeof m.size_vram === 'number' ? Math.round((m.size_vram / 1e9) * 100) / 100 : null,
    expiresAt: m.expires_at ?? null,
  }))
}

/** Ollama version probe (GET /api/version) — cheap health check. */
export async function version(baseUrl, timeoutMs) {
  const data = await getJson(baseUrl, '/api/version', timeoutMs)
  return data.version ?? 'unknown'
}

/**
 * Chat completion (POST /api/chat, stream=false).
 * @param {object} opts { model, messages, options, think, timeoutMs }
 */
export async function chat(baseUrl, opts) {
  const body = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
  }
  if (opts.options && Object.keys(opts.options).length > 0) body.options = opts.options
  if (typeof opts.think === 'boolean') body.think = opts.think
  const data = await postJson(baseUrl, '/api/chat', body, opts.timeoutMs)
  const evalCount = data.eval_count ?? 0
  const evalSeconds = (data.eval_duration ?? 0) / 1e9
  return {
    model: data.model ?? opts.model,
    role: data.message?.role ?? 'assistant',
    content: data.message?.content ?? '',
    thinking: data.message?.thinking || null,
    doneReason: data.done_reason ?? null,
    totalDurationMs: Math.round((data.total_duration ?? 0) / 1e6),
    promptTokens: data.prompt_eval_count ?? null,
    completionTokens: evalCount,
    tokensPerSecond: evalSeconds > 0 ? Math.round((evalCount / evalSeconds) * 10) / 10 : null,
  }
}
