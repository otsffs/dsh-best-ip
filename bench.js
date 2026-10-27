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

// Versioned technical thresholds: throughput alone never makes a sample suspect.
export const SCORING_VERSION = 2
export const MIN_RELIABLE_OUTPUT_TOKENS = 32
export const MIN_RELIABLE_DECODE_MS = 200
export const MIN_RELIABLE_RUNS = 2
// Compatibility exports; only the low-tail diagnostic still uses these values.
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
const successful = (run) => run != null && run.error == null && run.cancelled !== true
const measurable = (run) => successful(run) && run.usageReported === true &&
  Number.isFinite(run.tps) && run.tps > 0 && Number.isSafeInteger(run.outputTokens) && run.outputTokens > 0 &&
  Number.isFinite(run.ttftMs) && run.ttftMs >= 0
const reliable = (run) => measurable(run) && run.outputTokens >= MIN_RELIABLE_OUTPUT_TOKENS &&
  Number.isFinite(run.decodeMs) && run.decodeMs >= MIN_RELIABLE_DECODE_MS
const nonnegativeCount = (value) => Number.isSafeInteger(value) && value >= 0
const quantile = (sorted, fraction) => sorted.length === 0 ? null : sorted[Math.ceil(sorted.length * fraction) - 1]

// Scaling by the minimum avoids overflowing 1 / tinyTPS or summing huge TPS.
// Optional cap copies let optimisticScore handle even safe-integer plans in O(runs).
function harmonicMean(values, cap = null, copies = 0) {
  const count = values.length + copies
  if (count === 0) return null
  let min = copies > 0 ? cap : Number.MAX_VALUE
  let max = copies > 0 ? cap : 0
  for (const value of values) {
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  let scaledSum = 0
  for (const value of values) scaledSum += min / value
  const average = scaledSum / count + (copies > 0 ? (min / cap) * (copies / count) : 0)
  return Math.min(max, min / average)
}

const DEFAULT_SCORING_CONTEXT = Object.freeze({
  scoringVersion: SCORING_VERSION, calibrated: false, peerCount: 0, sampleCount: 0,
  speedReference: 100, speedCap: null,
})

/** Build a fresh, node-balanced context from this cohort's raw samples only. */
export function buildScoringContext(groups) {
  if (!Array.isArray(groups) || groups.some((group) => !Array.isArray(group))) {
    throw new TypeError('Scoring groups must be arrays of raw runs')
  }
  const means = []
  let sampleCount = 0
  for (const group of new Set(groups)) {
    const values = group.filter(reliable).map((run) => run.tps)
    if (values.length === 0) continue
    means.push(harmonicMean(values))
    sampleCount += values.length
    if (!Number.isSafeInteger(sampleCount)) throw new TypeError('Too many scoring samples')
  }
  means.sort((a, b) => a - b)
  const peerCount = means.length
  const speedReference = median(means) ?? 100
  const calibrated = peerCount >= 3 && sampleCount >= 6
  const upper = calibrated ? quantile(means, 0.9) : null
  const speedCap = calibrated
    ? Math.max(speedReference, upper > Number.MAX_VALUE / 1.5 ? Number.MAX_VALUE : upper * 1.5) : null
  return Object.freeze({ scoringVersion: SCORING_VERSION, calibrated, peerCount, sampleCount, speedReference, speedCap })
}

// Fail closed rather than silently comparing scores in different units. Copy only
// the public contract so callers cannot persist credentials through context extras.
function scoringContextOrDefault(context) {
  if (context === undefined) return { ...DEFAULT_SCORING_CONTEXT }
  if (context === null || typeof context !== 'object' || Array.isArray(context)) throw new TypeError('Invalid scoring context')
  const { scoringVersion, calibrated, peerCount, sampleCount, speedReference, speedCap } = context
  const countsValid = nonnegativeCount(peerCount) && nonnegativeCount(sampleCount) && sampleCount >= peerCount &&
    (peerCount > 0 || sampleCount === 0)
  const enoughPeers = countsValid && peerCount >= 3 && sampleCount >= 6
  if (scoringVersion !== SCORING_VERSION || typeof calibrated !== 'boolean' || !countsValid ||
      calibrated !== enoughPeers || !Number.isFinite(speedReference) || speedReference <= 0 ||
      (peerCount === 0 && speedReference !== 100) ||
      (calibrated ? !Number.isFinite(speedCap) || speedCap <= 0 || speedCap < speedReference : speedCap !== null)) {
    throw new TypeError('Invalid scoring context')
  }
  return { scoringVersion, calibrated, peerCount, sampleCount, speedReference, speedCap }
}

function normalizedCounts(runs, plannedRuns, skippedRuns = 0) {
  const skipped = nonnegativeCount(skippedRuns) ? Math.min(skippedRuns, Number.MAX_SAFE_INTEGER - runs.length) : 0
  const actual = runs.length + skipped
  return { planned: nonnegativeCount(plannedRuns) ? Math.max(plannedRuns, actual) : actual, skipped }
}

function scoreMetrics(values, successfulRuns, completedRuns, context, copies = 0) {
  const scored = sortedNumbers(values.map((value) => context.speedCap === null ? value : Math.min(value, context.speedCap)))
  const count = scored.length + copies
  const successRate = completedRuns > 0 ? successfulRuns / completedRuns : 0
  const measurementConfidence = successfulRuns > 0
    ? (count / successfulRuns) * Math.min(1, count / MIN_RELIABLE_RUNS) : 0
  if (count === 0) return { successRate, measurementConfidence, effectiveTps: null, provisionalScore: null }
  const effectiveTps = harmonicMean(scored, context.speedCap, copies)
  const qIndex = Math.ceil(count * 0.25) - 1
  const lower = qIndex < scored.length ? scored[qIndex] : context.speedCap
  // Score with an unrounded dimensionless H/Q25 ratio. The displayed H may be
  // subnormal: rounding it first can make a faster sample lower the score and
  // even invalidate the optimistic pruning bound.
  const scale = lower
  const minimum = Math.min(scored[0] ?? context.speedCap, copies > 0 ? context.speedCap : Number.MAX_VALUE)
  const meanReciprocal = scored.reduce((sum, value) => sum + minimum / value, 0) / count +
    (copies > 0 ? (minimum / context.speedCap) * (copies / count) : 0)
  const harmonicRatio = (minimum / scale) / meanReciprocal
  const blend = 0.8 * harmonicRatio + 0.2
  const penalty = 100 * successRate ** 2 * measurementConfidence
  const ratio = scale / context.speedReference
  let provisionalScore = ratio * (blend * penalty)
  const minNormal = 2 ** -1022
  if (!Number.isFinite(provisionalScore) || ratio < minNormal || provisionalScore < minNormal) {
    // Take only the final rounding when an intermediate ratio is subnormal or
    // overflows. The normal fast path retains exact constant-speed scores.
    const logScore = Math.log(scale) - Math.log(context.speedReference) + Math.log(blend) + Math.log(penalty)
    provisionalScore = logScore >= Math.log(Number.MAX_VALUE) ? Number.MAX_VALUE : Math.exp(logScore)
  }
  return { successRate, measurementConfidence, effectiveTps, provisionalScore }
}

export function sampleError(run) {
  if (run?.cancelled === true) return 'test stopped'
  if (run?.error == null) return run == null ? 'missing run' : null
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
 * Preserve raw transport/median display fields independently of ranking. Only
 * technical rules select scoring samples; caps never lower reliability. The
 * score is 100 * (0.8 * capped H + 0.2 * capped nearest-rank Q25) / reference
 * times successRate squared and measurementConfidence. Spread is diagnostic.
 * Pending, cancelled and deliberately skipped work are distinct from failures.
 */
export function summarize(runs, {
  plannedRuns = runs.length, scoringContext, skippedRuns = 0, skippedReason,
} = {}) {
  const context = scoringContextOrDefault(scoringContext)
  const counts = normalizedCounts(runs, plannedRuns, skippedRuns)
  plannedRuns = counts.planned
  skippedRuns = counts.skipped
  const ok = runs.filter(successful)
  const valid = ok.filter(measurable)
  const samples = Array.from(runs, (run) => {
    const flags = []
    if (run?.cancelled === true) flags.push('cancelled')
    if (run?.error != null && run?.cancelled !== true) flags.push('transport-error')
    if (!measurable(run)) flags.push('unmeasurable')
    if (Number.isSafeInteger(run?.outputTokens) && run.outputTokens > 0 && run.outputTokens < MIN_RELIABLE_OUTPUT_TOKENS) {
      flags.push('insufficient-tokens')
    }
    if (run?.decodeMs == null) flags.push('missing-decode-window')
    else if (!Number.isFinite(run.decodeMs) || run.decodeMs < 0) flags.push('invalid-decode-window')
    else if (run.decodeMs < MIN_RELIABLE_DECODE_MS) flags.push('insufficient-decode-window')
    const trusted = reliable(run)
    const capped = trusted && context.speedCap !== null && run.tps > context.speedCap
    if (capped) flags.push('high-capped')
    return {
      status: finite(run?.status), tps: finite(run?.tps), ttftMs: finite(run?.ttftMs),
      totalMs: finite(run?.totalMs), decodeMs: finite(run?.decodeMs), outputTokens: finite(run?.outputTokens),
      ...(Number.isSafeInteger(run?.timeoutMs) && run.timeoutMs > 0 ? { timeoutMs: run.timeoutMs } : {}),
      usageReported: run?.usageReported === true, error: sampleError(run), cancelled: run?.cancelled === true,
      flags, reliable: trusted, scoredTps: trusted ? (capped ? context.speedCap : run.tps) : null,
    }
  })
  const technical = samples.filter((sample) => sample.reliable)
  if (technical.length >= MIN_OUTLIER_RUNS) {
    const center = median(technical.map((sample) => sample.tps))
    for (const sample of technical) {
      if (sample.tps < center / OUTLIER_MULTIPLIER) sample.flags.push('low-tail')
    }
  }
  const values = sortedNumbers(technical.map((sample) => sample.tps))
  const reliableRuns = values.length
  const rankEligible = reliableRuns >= MIN_RELIABLE_RUNS
  const q25 = quantile(values, 0.25)
  const q75 = quantile(values, 0.75)
  const center = median(values)
  const relativeSpread = center === null ? null : Math.min(Number.MAX_VALUE, (q75 - q25) / center)
  const cancelled = samples.filter((sample) => sample.cancelled).length
  const completedRuns = runs.length - cancelled
  const successfulRuns = ok.length
  const metrics = scoreMetrics(values, successfulRuns, completedRuns, context)
  const pendingRuns = Math.max(0, plannedRuns - runs.length - skippedRuns)
  const confirmed = rankEligible && pendingRuns === 0 && skippedRuns === 0 && cancelled === 0 && runs.length >= plannedRuns
  const scoreReason = reliableRuns === 0 ? 'No technically reliable samples'
    : !rankEligible ? 'Provisional; at least 2 reliable runs required'
      : confirmed ? 'Confirmed; harmonic speed, success and confidence'
        : 'Provisional; pending, cancelled or skipped runs remain'
  const firstFailure = samples.find((sample) => sample.error !== null)
  const eligible = valid.length > runs.length / 2
  const tps = range(valid.map((run) => run.tps))
  const ttft = range(valid.map((run) => run.ttftMs))
  return {
    runs: runs.length, failed: completedRuns - successfulRuns,
    measurable: valid.length, unmeasurable: ok.length - valid.length, eligible,
    ...(!eligible ? { error: valid.length === 0
      ? (firstFailure === undefined ? 'no run produced measurable TPS' : firstFailure.error)
      : `only ${valid.length}/${runs.length} runs produced measurable TPS; a strict majority is required` } : {}),
    ttftMs: median(valid.map((run) => run.ttftMs)), tps: median(valid.map((run) => run.tps)),
    tpsMin: tps.min, tpsMax: tps.max, ttftMinMs: ttft.min, ttftMaxMs: ttft.max,
    totalMs: median(valid.map((run) => run.totalMs)), outputTokens: median(valid.map((run) => run.outputTokens)),
    usageReported: ok.length > 0 && ok.every((run) => run.usageReported === true),
    samples, plannedRuns, completedRuns, successfulRuns, cancelled, skippedRuns, pendingRuns,
    ...(skippedRuns > 0 ? { skippedReason: skippedReason === 'optimistic-bound' ? 'optimistic-bound' : 'not scheduled' } : {}),
    reliableRuns, suspectRuns: samples.length - reliableRuns, rankEligible, confirmed, eliminated: skippedRuns > 0,
    harmonicTps: harmonicMean(values), conservativeTps: q25, relativeSpread,
    ...metrics, stabilityScore: metrics.provisionalScore,
    scoringVersion: SCORING_VERSION, scoreContext: context, scoreReason,
  }
}

/**
 * Best possible final score under a frozen calibrated cap. Real failures and
 * cancellations stay untouched. Unmeasured attempts are successful, technically
 * reliable cap-TPS samples with zero TTFT. Use summarize's exact score primitive
 * without allocating a potentially enormous synthetic-sample array.
 */
export function optimisticScore(runs, { plannedRuns = runs.length, scoringContext } = {}) {
  const context = scoringContextOrDefault(scoringContext)
  if (!context.calibrated || !Number.isFinite(context.speedCap) || context.speedCap <= 0) return null
  const { planned } = normalizedCounts(runs, plannedRuns)
  const remaining = planned - runs.length
  const values = runs.filter(reliable).map((run) => run.tps)
  const successfulRuns = runs.filter(successful).length + remaining
  const completedRuns = runs.filter((run) => run?.cancelled !== true).length + remaining
  return scoreMetrics(values, successfulRuns, completedRuns, context, remaining).provisionalScore
}
