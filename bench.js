// Real-request performance measurement in the harness's terms:
// TTFT: request start -> first non-empty text/reasoning delta (whitespace counts).
// TPS: provider output tokens / (response end - first token), not chunk count.
// This is a client-observed stream rate, not the model's isolated decode speed.

import https from 'node:https'

// Keep caller preflight validation and the wire implementation on one API list.
// Null/undefined retain the historical Chat Completions default.
export const BENCHMARK_APIS = Object.freeze(['openai-completions', 'openai-responses', 'anthropic-messages'])
export const supportsBenchmarkApi = (api) => BENCHMARK_APIS.includes(api ?? 'openai-completions')

function chunkText(payload) {
  const choice = payload?.choices?.[0]
  const delta = choice?.delta ?? choice?.message
  if (typeof delta?.content === 'string') return delta.content
  if (Array.isArray(delta?.content)) {
    return delta.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
  }
  return ''
}

function chunkReasoning(payload) {
  const delta = payload?.choices?.[0]?.delta
  for (const field of ['reasoning_content', 'reasoning', 'thinking']) {
    if (typeof delta?.[field] === 'string' && delta[field] !== '') return delta[field]
  }
  return ''
}

function anthropicPiece(payload) {
  if (payload?.type === 'content_block_start') {
    const block = payload.content_block
    if (block?.type === 'text' && typeof block.text === 'string') return { text: block.text, reasoning: '' }
    if (block?.type === 'thinking' && typeof block.thinking === 'string') return { text: '', reasoning: block.thinking }
  }
  if (payload?.type === 'content_block_delta') {
    const delta = payload.delta
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') return { text: delta.text, reasoning: '' }
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') return { text: '', reasoning: delta.thinking }
  }
  return { text: '', reasoning: '' }
}

function responsesPiece(payload, type) {
  if (typeof payload?.delta !== 'string') return { text: '', reasoning: '' }
  if (type === 'response.output_text.delta') return { text: payload.delta, reasoning: '' }
  if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    return { text: '', reasoning: payload.delta }
  }
  // Done events and the completed response contain snapshots, not new tokens.
  return { text: '', reasoning: '' }
}

const RESPONSES_FAILURE_EVENTS = new Set(['response.failed', 'response.incomplete', 'response.cancelled', 'response.canceled', 'error'])

function responsesError(payload, event) {
  // Never echo Responses error bodies: they can include credentials or prompts.
  const types = [payload?.type, event]
  const failureType = types.find((type) => RESPONSES_FAILURE_EVENTS.has(type))
  if (failureType !== undefined) return `stream error: ${failureType}`
  if (payload?.error != null || payload?.response?.error != null) return 'stream error: Responses error'
  if (types.includes('response.completed') && payload?.response?.status !== 'completed') {
    return 'stream error: response.completed has non-completed status'
  }
  return undefined
}

function readUsage(payload, anthropic) {
  // message_start contains only an initial count. Without the final cumulative
  // message_delta usage it cannot supply the numerator of a completed request.
  if (anthropic) return payload?.type === 'message_delta' ? payload.usage?.output_tokens : undefined
  return payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens
}

function streamError(payload, event) {
  if (payload?.error === undefined && payload?.type !== 'error' && event !== 'error') return undefined
  return 'stream error'
}

/**
 * Send one HTTPS streaming request pinned to ip. No shared agent/TLS session
 * cache: each candidate is measured with the same cold-connection policy.
 * requestImpl/clock permit completely isolated deterministic tests.
 * Failures resolve to { error }; missing usage instead produces null TPS.
 */
export function measureStream({
  provider, apiKey, ip, message, model, maxTokens = 256, timeout = 60000, signal,
  requestImpl = https.request, clock = process.hrtime.bigint,
}) {
  if (signal?.aborted) {
    return Promise.resolve({ ip, status: 0, cancelled: true, error: 'test stopped', ttftMs: null, totalMs: 0,
      decodeMs: null, outputTokens: null, tps: null, usageReported: false })
  }
  // The parent resolves identity/auth; refuse its canonical OAuth marker here
  // too, before parsing the endpoint or creating any request with a bearer key.
  if (provider?.authType === 'oauth') {
    return Promise.resolve({ ip, status: 0, error: 'OAuth benchmark authentication is temporarily unsupported',
      ttftMs: null, totalMs: 0, decodeMs: null, outputTokens: null, tps: null, usageReported: false })
  }
  let base
  try {
    base = new URL(provider.baseURL)
  } catch (error) {
    return Promise.resolve({ ip, status: 0, error: 'invalid baseURL', ttftMs: null, totalMs: 0 })
  }
  if (base.protocol !== 'https:') {
    return Promise.resolve({ ip, status: 0, error: 'benchmark requires an https: baseURL', ttftMs: null, totalMs: 0 })
  }
  const api = provider.api ?? 'openai-completions'
  if (!supportsBenchmarkApi(api)) {
    return Promise.resolve({ ip, status: 0, error: 'unsupported benchmark API', ttftMs: null, totalMs: 0 })
  }
  const anthropic = api === 'anthropic-messages'
  const responses = api === 'openai-responses'
  const root = base.pathname.replace(/\/+$/, '')
  const path = `${root}/${anthropic ? 'messages' : responses ? 'responses' : 'chat/completions'}`
  const body = JSON.stringify(responses ? {
    model, input: [{ role: 'user', content: [{ type: 'input_text', text: message }] }],
    max_output_tokens: maxTokens, stream: true,
  } : {
    model, max_tokens: maxTokens, stream: true,
    ...(anthropic ? {} : { stream_options: { include_usage: true } }),
    messages: [{ role: 'user', content: message }],
  })
  const headers = {
    host: base.host,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'content-length': Buffer.byteLength(body),
    'user-agent': 'dsh-best-ip/probe',
  }
  if (anthropic) headers['anthropic-version'] = '2023-06-01'
  if (apiKey !== undefined) {
    if (anthropic) headers['x-api-key'] = apiKey
    else headers.authorization = `Bearer ${apiKey}`
  }

  return new Promise((resolve) => {
    const started = clock()
    const now = () => Number(clock() - started) / 1e6
    let firstTokenAt = null
    let streamEndedAt = null
    let text = ''
    let reasoningChars = 0
    let outputTokens
    let finished = false
    let status = 0
    let sawAnyChunk = false
    let sawTerminal = false
    let buffer = ''
    let firstInput = true
    let event = ''
    let dataLines = []
    let request
    let response
    let deadline
    const listeners = []
    const listen = (target, event, handler, once = false) => {
      target[once ? 'once' : 'on'](event, handler)
      listeners.push([target, event, handler])
    }
    const detach = () => {
      for (const [target, event, handler] of listeners) target.removeListener(event, handler)
      listeners.length = 0
    }
    const watchErrors = (target, handler) => {
      // Destroying a real ClientRequest can emit an asynchronous ECONNRESET.
      // Retain only these fail-closed guards until close, then remove them too.
      const closed = () => {
        target.removeListener('error', handler)
        target.removeListener('close', closed)
      }
      target.on('error', handler)
      target.once('close', closed)
    }
    const stop = () => finish('test stopped', true)

    const finish = (failure, cancelled = false) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      signal?.removeEventListener('abort', stop)
      const totalMs = now()
      const ttftMs = firstTokenAt === null ? null : Math.round(firstTokenAt)
      response?.destroy()
      request?.destroy()
      detach()
      if (failure !== undefined) {
        const validUsage = Number.isSafeInteger(outputTokens) && outputTokens >= 0
        // Only these locally constructed Responses diagnostics may retain detail.
        const safeResponses = ['stream error: response.failed', 'stream error: response.incomplete',
          'stream error: response.cancelled', 'stream error: response.canceled', 'stream error: error',
          'stream error: Responses error', 'stream error: response.completed has non-completed status']
        const safeError = safeResponses.includes(failure) ? failure : sampleError({ error: failure, cancelled })
        resolve({ ip, status, error: safeError, ...(cancelled ? { cancelled: true } : {}), ttftMs,
          totalMs: Math.round(totalMs), decodeMs: null, outputTokens: validUsage ? outputTokens : null,
          tps: null, usageReported: validUsage })
        return
      }
      // Preserve the DSH formula: the decode window ends at response completion,
      // including usage/terminal trailers, rather than at the last text delta.
      const decodeMs = firstTokenAt !== null && streamEndedAt !== null ? streamEndedAt - firstTokenAt : null
      const validUsage = Number.isSafeInteger(outputTokens) && outputTokens >= 0
      const tps = decodeMs !== null && decodeMs > 0 && validUsage && outputTokens > 0
        ? Math.round((outputTokens / decodeMs) * 1000 * 10) / 10
        : null
      resolve({
        ip, status, ttftMs, totalMs: Math.round(totalMs),
        decodeMs: decodeMs === null ? null : Math.round(decodeMs),
        outputTokens: validUsage ? outputTokens : null,
        tps: Number.isFinite(tps) ? tps : null,
        usageReported: validUsage,
        text: text.slice(0, 160), reasoningChars,
      })
    }

    const dispatch = () => {
      const data = dataLines.join('\n')
      const type = event
      dataLines = []
      event = ''
      if (finished || (sawTerminal && !responses)) return
      // Failure event names are authoritative even with an empty, non-JSON or
      // legacy DONE body. Don't let such an event turn into successful EOF.
      if (responses && RESPONSES_FAILURE_EVENTS.has(type)) {
        finish(`stream error: ${type}`)
        return
      }
      if ((data === '' && type !== 'error') || type === 'ping') return
      if (!anthropic && type !== 'error' && data.trim() === '[DONE]') {
        // Responses requires response.completed with an actually completed
        // response; Chat's legacy DONE sentinel is never sufficient evidence.
        if (!responses) sawTerminal = true
        return
      }
      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        finish(type === 'error'
          ? (responses ? 'stream error: error' : 'stream error')
          : 'invalid JSON in stream event')
        return
      }
      const failure = responses ? responsesError(payload, type) : streamError(payload, type)
      if (failure !== undefined) {
        finish(failure)
        return
      }
      // Still check Responses failure/error trailers until HTTP end, but don't
      // count additional deltas, terminal snapshots or duplicate usage twice.
      if (sawTerminal) return
      const responseType = payload?.type ?? type
      if (responses && responseType === 'response.completed') {
        const usage = payload.response.usage?.output_tokens
        outputTokens = Number.isSafeInteger(usage) && usage >= 0 ? usage : undefined
        sawTerminal = true
        return
      }
      if (anthropic && payload?.type === 'message_stop') {
        sawTerminal = true
        return
      }
      if (!responses) {
        const usage = readUsage(payload, anthropic)
        if (usage !== undefined) outputTokens = Number.isSafeInteger(usage) && usage >= 0 ? usage : undefined
      }
      const piece = responses ? responsesPiece(payload, responseType)
        : anthropic ? anthropicPiece(payload) : { text: chunkText(payload), reasoning: chunkReasoning(payload) }
      if (firstTokenAt === null && (piece.text !== '' || piece.reasoning !== '')) firstTokenAt = now()
      reasoningChars += piece.reasoning.length
      text += piece.text
    }

    const line = (value) => {
      if (value === '') {
        dispatch()
        return
      }
      if (value.startsWith(':')) return
      const colon = value.indexOf(':')
      const field = colon === -1 ? value : value.slice(0, colon)
      let content = colon === -1 ? '' : value.slice(colon + 1)
      if (content.startsWith(' ')) content = content.slice(1)
      if (field === 'data') dataLines.push(content)
      else if (field === 'event') event = content
    }

    // SSE permits LF, CRLF and CR. Keep a trailing CR until the next chunk so
    // splitting a CRLF pair never creates a spurious empty line/event boundary.
    const ingest = (chunk, eof = false) => {
      if (firstInput && chunk !== '') {
        if (chunk.startsWith('\uFEFF')) chunk = chunk.slice(1)
        firstInput = false
      }
      buffer += chunk
      let start = 0
      for (let index = 0; index < buffer.length && !finished; index++) {
        const char = buffer[index]
        if (char !== '\r' && char !== '\n') continue
        if (char === '\r' && index === buffer.length - 1 && !eof) break
        line(buffer.slice(start, index))
        if (char === '\r' && buffer[index + 1] === '\n') index++
        start = index + 1
      }
      buffer = buffer.slice(start)
      if (eof && !finished) {
        if (buffer !== '') line(buffer)
        buffer = ''
        // Tolerate a complete final data frame without an empty line, but never
        // treat HTTP EOF alone as successful model completion.
        dispatch()
      }
    }

    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) {
      stop()
      return
    }
    deadline = setTimeout(() => finish('timeout'), timeout)
    deadline.unref?.()
    try {
      request = requestImpl({
        host: ip, port: base.port === '' ? 443 : Number(base.port),
        path, method: 'POST', servername: base.hostname, headers, timeout,
        agent: false,
      }, (incoming) => {
        response = incoming
        watchErrors(response, (error) => finish(`response error: ${error.message}`))
        if (finished) {
          response.destroy()
          return
        }
        status = response.statusCode ?? 0
        let responseEnded = false
        response.setEncoding('utf8')
        listen(response, 'aborted', () => finish('response aborted'), true)
        listen(response, 'close', () => {
          if (!responseEnded) finish('response closed before end')
        }, true)
        if (status !== 200) {
          // Drain errors without retaining provider bodies, which may echo secrets.
          listen(response, 'data', () => {})
          listen(response, 'end', () => {
            responseEnded = true
            finish(`HTTP ${status}`)
          }, true)
          return
        }
        listen(response, 'data', (chunk) => {
          sawAnyChunk = true
          if (!finished) ingest(chunk)
        })
        listen(response, 'end', () => {
          responseEnded = true
          if (finished) return
          ingest('', true)
          if (finished) return
          streamEndedAt = now()
          if (firstTokenAt === null) finish(sawAnyChunk ? 'stream ended before any token' : 'stream ended with no data')
          else if (!sawTerminal) finish('stream ended without completion marker')
          else finish()
        }, true)
      })
      watchErrors(request, (error) => finish(`${error.code ?? 'error'}: ${error.message}`))
      if (finished) request.destroy()
      else {
        listen(request, 'timeout', () => finish('timeout'))
        request.end(body)
      }
    } catch (error) {
      finish(`${error.code ?? 'error'}: ${error.message}`)
    }
  })
}

// Fixed, versioned scoring policy: short streams amplify timing/buffering noise.
// High spikes can be artifacts, but slow tails are genuine stability evidence.
export const SCORING_VERSION = 1
export const MIN_RELIABLE_OUTPUT_TOKENS = 32
export const MIN_RELIABLE_DECODE_MS = 200
export const MIN_RELIABLE_RUNS = 2
export const OUTLIER_MULTIPLIER = 4
export const MIN_OUTLIER_RUNS = 3

const finite = (value) => Number.isFinite(value) ? value : null
const sortedNumbers = (values) => values.filter(Number.isFinite).sort((a, b) => a - b)
const median = (values) => {
  const sorted = sortedNumbers(values)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 !== 0) return sorted[mid]
  const sum = sorted[mid - 1] + sorted[mid]
  return Number.isFinite(sum) ? sum / 2 : sorted[mid - 1] / 2 + sorted[mid] / 2
}
const range = (values) => {
  const sorted = sortedNumbers(values)
  return { min: sorted[0] ?? null, max: sorted[sorted.length - 1] ?? null }
}
const measurable = (run) => run !== undefined && run !== null && run.error === undefined &&
  run.cancelled !== true && run.usageReported === true && Number.isFinite(run.tps) && run.tps > 0 &&
  Number.isSafeInteger(run.outputTokens) && run.outputTokens > 0 &&
  Number.isFinite(run.ttftMs) && run.ttftMs >= 0

export function sampleError(run) {
  if (run?.cancelled === true) return 'test stopped'
  if (run?.error === undefined) return run == null ? 'missing run' : null
  // Provider bodies and exception messages can echo prompts, URLs or secrets.
  // Persist a bounded error category, never their arbitrary trailing text.
  if (typeof run.error !== 'string') return 'request failed'
  const error = run.error
  const http = /^HTTP (\d{3})(?::|$)/.exec(error)
  if (http) return `HTTP ${http[1]}`
  for (const category of ['test stopped', 'timeout', 'response aborted', 'response closed before end',
    'stream ended before any token', 'stream ended with no data', 'stream ended without completion marker',
    'invalid JSON in stream event', 'stream error', 'response error', 'invalid baseURL',
    'benchmark requires an https: baseURL', 'unsupported benchmark API',
    'OAuth benchmark authentication is temporarily unsupported']) {
    if (error === category || error.startsWith(`${category}:`)) return category
  }
  const code = /^([A-Z][A-Z0-9_]{1,39})(?::|$)/.exec(error)?.[1]
  const safeCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
    'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'EPROTO', 'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']
  return safeCodes.includes(code) ? code : 'request failed'
}

/**
 * Preserve transport/median display fields independently of ranking. Samples are
 * a fixed-size allowlist per attempted run: finite raw numbers are unchanged,
 * non-finite/missing values become null, and text/credentials are never copied.
 * plannedRuns includes unstarted work, so stopping early cannot inflate a score.
 * conservativeTps is nearest-rank Q25(v); relativeSpread is (Q75-Q25)/median(v).
 * stabilityScore = Q25/(1+relativeSpread) * (reliableRuns/plannedRuns)^2.
 * rankEligible is authoritative; rejected scores are null, not transport errors.
 */
export function summarize(runs, { plannedRuns = runs.length } = {}) {
  plannedRuns = Number.isSafeInteger(plannedRuns) && plannedRuns >= 0
    ? Math.max(plannedRuns, runs.length) : runs.length
  const ok = runs.filter((run) => run !== undefined && run !== null && run.error === undefined && run.cancelled !== true)
  const valid = ok.filter(measurable)
  const samples = Array.from(runs, (run) => {
    const flags = []
    if (run?.cancelled === true) flags.push('cancelled')
    if (run?.error !== undefined && run?.cancelled !== true) flags.push('transport-error')
    const valid = measurable(run)
    if (!valid) flags.push('unmeasurable')
    if (Number.isSafeInteger(run?.outputTokens) && run.outputTokens > 0 && run.outputTokens < MIN_RELIABLE_OUTPUT_TOKENS) {
      flags.push('insufficient-tokens')
    }
    if (run?.decodeMs == null) flags.push('missing-decode-window')
    else if (!Number.isFinite(run.decodeMs) || run.decodeMs < 0) flags.push('invalid-decode-window')
    else if (run.decodeMs < MIN_RELIABLE_DECODE_MS) flags.push('insufficient-decode-window')
    return {
      status: finite(run?.status), tps: finite(run?.tps), ttftMs: finite(run?.ttftMs),
      totalMs: finite(run?.totalMs), decodeMs: finite(run?.decodeMs), outputTokens: finite(run?.outputTokens),
      usageReported: run?.usageReported === true, error: sampleError(run), cancelled: run?.cancelled === true,
      flags, reliable: valid && run.outputTokens >= MIN_RELIABLE_OUTPUT_TOKENS &&
        Number.isFinite(run.decodeMs) && run.decodeMs >= MIN_RELIABLE_DECODE_MS,
    }
  })
  const technical = samples.filter((sample) => sample.reliable)
  if (technical.length >= MIN_OUTLIER_RUNS) {
    const center = median(technical.map((sample) => sample.tps))
    for (const sample of technical) {
      if (sample.tps / center > OUTLIER_MULTIPLIER) {
        sample.flags.push('high-outlier')
        sample.reliable = false
      } else if (sample.tps < center / OUTLIER_MULTIPLIER) {
        // Keep the low tail in v: discarding it would reward unstable routes.
        sample.flags.push('low-tail')
      }
    }
  }
  const values = sortedNumbers(samples.filter((sample) => sample.reliable).map((sample) => sample.tps))
  const reliableRuns = values.length
  const rankEligible = reliableRuns >= MIN_RELIABLE_RUNS && reliableRuns > plannedRuns / 2
  const q25 = values.length > 0 ? values[Math.ceil(values.length * 0.25) - 1] : null
  const q75 = values.length > 0 ? values[Math.ceil(values.length * 0.75) - 1] : null
  const center = median(values)
  const relativeSpread = center === null ? null : Math.min(Number.MAX_VALUE, (q75 - q25) / center)
  const stabilityScore = rankEligible
    ? q25 / (1 + relativeSpread) * (reliableRuns / plannedRuns) ** 2 : null
  const scoreReason = rankEligible
    ? `ranked using ${reliableRuns}/${plannedRuns} reliable runs; lower-quartile TPS, spread and completion penalties`
    : reliableRuns < MIN_RELIABLE_RUNS
      ? `only ${reliableRuns}/${plannedRuns} reliable runs; at least ${MIN_RELIABLE_RUNS} are required (>=${MIN_RELIABLE_OUTPUT_TOKENS} output tokens and >=${MIN_RELIABLE_DECODE_MS}ms decode window)`
      : `only ${reliableRuns}/${plannedRuns} reliable runs; a strict majority of planned runs is required`
  const cancelled = samples.filter((sample) => sample.cancelled).length
  const firstFailure = runs.find((run) => run?.error !== undefined)
  const eligible = valid.length > runs.length / 2
  const tps = range(valid.map((run) => run.tps))
  const ttft = range(valid.map((run) => run.ttftMs))
  return {
    runs: runs.length,
    failed: runs.length - ok.length,
    measurable: valid.length,
    unmeasurable: ok.length - valid.length,
    eligible,
    ...(!eligible ? { error: valid.length === 0
      ? (firstFailure === undefined ? 'no run produced measurable TPS' : sampleError(firstFailure))
      : `only ${valid.length}/${runs.length} runs produced measurable TPS; a strict majority is required` } : {}),
    ttftMs: median(valid.map((run) => run.ttftMs)),
    tps: median(valid.map((run) => run.tps)),
    tpsMin: tps.min, tpsMax: tps.max,
    ttftMinMs: ttft.min, ttftMaxMs: ttft.max,
    totalMs: median(valid.map((run) => run.totalMs)),
    outputTokens: median(valid.map((run) => run.outputTokens)),
    usageReported: ok.length > 0 && ok.every((run) => run.usageReported === true),
    samples, plannedRuns, completedRuns: runs.length - cancelled, cancelled,
    reliableRuns, suspectRuns: samples.length - reliableRuns, rankEligible,
    conservativeTps: q25, relativeSpread, stabilityScore, scoringVersion: SCORING_VERSION, scoreReason,
  }
}
