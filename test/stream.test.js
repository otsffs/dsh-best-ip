// Fully isolated: HTTPS is injected, all stream events and clocks are synthetic.
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import test from 'node:test'
import { BENCHMARK_APIS, measureStream, summarize, supportsBenchmarkApi } from '../bench.js'

const provider = { baseURL: 'https://api.example.test/v1', api: 'openai-completions' }
const frame = (value, newline = '\n') => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}${newline}${newline}`
const text = (content) => ({ choices: [{ delta: { content } }] })
const usage = (count) => ({ choices: [], usage: { completion_tokens: count } })

function fixture(steps, { endAt = 300, end = true, status = 200 } = {}) {
  let time = 0
  const captured = {}
  const clock = () => BigInt(Math.round(time * 1e6))
  const requestImpl = (options, callback) => {
    captured.options = options
    const request = new EventEmitter()
    captured.request = request
    request.destroy = () => {
      if (request.destroyed) return
      request.destroyed = true
      request.emit('close')
    }
    request.end = (body) => {
      captured.body = JSON.parse(body)
      queueMicrotask(() => {
        const response = new EventEmitter()
        captured.response = response
        response.statusCode = status
        response.setEncoding = (encoding) => { captured.encoding = encoding }
        response.destroy = () => {
          if (response.destroyed) return
          response.destroyed = true
          response.emit('close')
        }
        callback(response)
        for (const step of steps) {
          if (request.destroyed || response.destroyed) break
          time = step.at ?? time
          if (step.action) {
            step.action({ request, response })
            continue
          }
          const event = step.event ?? 'data'
          if (event === 'requestError') request.emit('error', step.error)
          else response.emit(event, step.error ?? step.data)
        }
        if (end && !response.destroyed) {
          time = endAt
          response.emit('end')
          response.emit('close')
        }
      })
    }
    return request
  }
  return { captured, clock, requestImpl }
}

async function measure(steps, options = {}, overrides = {}) {
  const fake = fixture(steps, options)
  const result = await measureStream({
    provider, apiKey: 'test-key', ip: '192.0.2.7', message: 'Count', model: 'test-model',
    timeout: 1000, clock: fake.clock, requestImpl: fake.requestImpl, ...overrides,
  })
  return { result, ...fake }
}

const completed = [
  { at: 100, data: frame(text('hello')) },
  { at: 150, data: frame(text(' world')) },
  { at: 200, data: frame(usage(100)) },
  { at: 250, data: frame('[DONE]') },
]

test('preserves DSH response-end TPS, IP/SNI/Host, and cold-agent policy', async () => {
  const { result, captured } = await measure(completed, {}, {
    provider: { ...provider, baseURL: 'https://api.example.test:8443/custom/' },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.ttftMs, 100)
  assert.equal(result.decodeMs, 200)
  assert.equal(result.tps, 500)
  assert.equal(result.totalMs, 300)
  assert.equal(result.outputTokens, 100)
  assert.equal(captured.options.host, '192.0.2.7')
  assert.equal(captured.options.servername, 'api.example.test')
  assert.equal(captured.options.headers.host, 'api.example.test:8443')
  assert.equal(captured.options.port, 8443)
  assert.equal(captured.options.path, '/custom/chat/completions')
  assert.equal(captured.options.agent, false)
  assert.equal(captured.options.headers.authorization, 'Bearer test-key')
  assert.deepEqual(captured.body.stream_options, { include_usage: true })
  assert.equal(captured.encoding, 'utf8')
})

test('TPS uses the unrounded response-end decode interval, not displayed milliseconds', async () => {
  const { result } = await measure([
    { at: 100.25, data: frame(text('hello')) },
    { at: 150, data: frame(usage(100)) },
    { at: 200, data: frame('[DONE]') },
  ], { endAt: 300.65 })
  assert.equal(result.error, undefined)
  assert.equal(result.ttftMs, 100)
  assert.equal(result.totalMs, 301)
  assert.equal(result.decodeMs, 200)
  assert.equal(result.tps, 499)
})

for (const newline of ['\n', '\r\n', '\r']) {
  test(`SSE handles ${JSON.stringify(newline)} split at every character boundary`, async () => {
    const wire = frame(text('hello'), newline) + frame(usage(100), newline) + frame('[DONE]', newline)
    const steps = [...wire].map((data) => ({ at: 100, data }))
    const { result } = await measure(steps)
    assert.equal(result.error, undefined)
    assert.equal(result.text, 'hello')
    assert.equal(result.tps, 500)
  })
}

test('SSE strips only an initial UTF-8 BOM', async () => {
  const { result } = await measure([
    { at: 50, data: '\uFEFF' }, ...completed,
  ])
  assert.equal(result.error, undefined)
  assert.equal(result.text, 'hello world')
})

test('SSE joins multi-line data and ignores comments/ping events', async () => {
  const { result } = await measure([
    { at: 50, data: ': comment\r\nevent: ping\r\ndata: keepalive\r\n\r\n' },
    { at: 100, data: 'event: message\ndata: {"choices": [\ndata: {"delta":{"content":"hello"}}]}\n\n' },
    { at: 150, data: frame(usage(100)) },
    { at: 200, data: frame('[DONE]') },
  ])
  assert.equal(result.error, undefined)
  assert.equal(result.ttftMs, 100)
  assert.equal(result.text, 'hello')
})

test('flushes a complete terminal tail without an empty final line', async () => {
  const { result } = await measure([
    ...completed.slice(0, 3), { at: 250, data: 'data: [DONE]' },
  ])
  assert.equal(result.error, undefined)
  assert.equal(result.tps, 500)
})

test('HTTP EOF alone is not successful model completion', async () => {
  const { result } = await measure(completed.slice(0, 3))
  assert.match(result.error, /without completion marker/)
  assert.equal(summarize([result]).eligible, false)
})

test('an incomplete final JSON frame is an error, not a silently valid stream', async () => {
  const { result } = await measure([completed[0], { at: 150, data: 'data: {"usage":' }])
  assert.match(result.error, /invalid JSON/)
})

test('embedded OpenAI and Anthropic errors after content fail the run', async () => {
  for (const payload of [{ error: { message: 'quota exceeded' } }, { type: 'error', error: { message: 'overloaded' } }]) {
    const { result } = await measure([completed[0], { at: 150, data: frame(payload) }])
    assert.equal(result.error, 'stream error')
  }
  const { result } = await measure([completed[0], { at: 150, data: 'event: error\ndata: upstream failed\n\n' }])
  assert.equal(result.error, 'stream error')
})

for (const event of ['aborted', 'close', 'error']) {
  test(`premature response ${event} fails without waiting for deadline`, async () => {
    const { result } = await measure([
      completed[0], { at: 150, event, ...(event === 'error' ? { error: new Error('broken') } : {}) },
    ], { end: false })
    assert.match(result.error, /response/)
    assert.equal(result.totalMs, 150)
  })
}

test('HTTP failures exclude provider bodies and response exception details', async () => {
  const { result } = await measure([{ at: 10, data: 'denied\n now' }], { status: 401 })
  assert.equal(result.error, 'HTTP 401')
  const broken = await measure([{ at: 10, event: 'error', error: new Error('broken') }], { status: 403, end: false })
  assert.equal(broken.result.error, 'response error')
})

for (const api of BENCHMARK_APIS) {
  test(`${api} wire failures never return synthetic secret bodies or exception details`, async () => {
    const secret = 'PRIVATE_WIRE_CANARY'
    for (const [steps, options, extra] of [
      [[{ at: 10, data: secret }], { status: 401 }, {}],
      [[{ at: 10, data: frame({ type: 'error', error: { message: secret } }) }], {}, {}],
      [[{ at: 10, data: `event: error\ndata: ${secret}\n\n` }], {}, {}],
      [[{ at: 10, event: 'error', error: new Error(secret) }], { end: false }, {}],
      [[], {}, { requestImpl: () => { throw Object.assign(new Error(secret), { code: 'ECONNRESET' }) } }],
    ]) {
      const { result } = await measure(steps, options, { provider: { ...provider, api }, ...extra })
      assert.equal(typeof result.error, 'string')
      assert.equal(JSON.stringify(result).includes(secret), false)
    }
  })
}

test('missing or non-finite usage is explicitly unmeasurable', async () => {
  for (const usageFrame of ['', 'data: {"usage":{"completion_tokens":1e309}}\n\n']) {
    const { result } = await measure([
      completed[0], { at: 150, data: usageFrame }, completed[3],
    ])
    assert.equal(result.error, undefined)
    assert.equal(result.usageReported, false)
    assert.equal(result.outputTokens, null)
    assert.equal(result.tps, null)
    const summary = summarize([result])
    assert.equal(summary.measurable, 0)
    assert.equal(summary.unmeasurable, 1)
    assert.equal(summary.eligible, false)
  }
})

test('whitespace and reasoning count as the first token', async () => {
  const { result } = await measure([
    { at: 80, data: frame({ choices: [{ delta: { content: ' ', reasoning_content: '', reasoning: 'thinking' } }] }) },
    { at: 100, data: frame(text('answer')) },
    ...completed.slice(2),
  ])
  assert.equal(result.ttftMs, 80)
  assert.equal(result.reasoningChars, 8)
})

test('Anthropic content starts and final cumulative usage are measured', async () => {
  const { result, captured } = await measure([
    { at: 20, data: frame({ type: 'message_start', message: { usage: { output_tokens: 1 } } }) },
    { at: 100, data: frame({ type: 'content_block_start', content_block: { type: 'thinking', thinking: 'think' } }) },
    { at: 150, data: frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } }) },
    { at: 200, data: frame({ type: 'message_delta', usage: { output_tokens: 100 } }) },
    { at: 250, data: 'event: message_stop\ndata: {"type":"message_stop"}' },
  ], {}, { provider: { ...provider, api: 'anthropic-messages' } })
  assert.equal(result.error, undefined)
  assert.equal(result.tps, 500)
  assert.equal(result.outputTokens, 100)
  assert.equal(result.reasoningChars, 5)
  assert.equal(captured.options.path, '/v1/messages')
  assert.equal(captured.options.headers['x-api-key'], 'test-key')
  assert.equal(captured.options.headers['anthropic-version'], '2023-06-01')
  assert.equal(captured.body.stream_options, undefined)
})

test('Anthropic initial usage cannot substitute for missing final usage', async () => {
  const { result } = await measure([
    { at: 20, data: frame({ type: 'message_start', message: { usage: { output_tokens: 1 } } }) },
    { at: 100, data: frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } }) },
    { at: 250, data: frame({ type: 'message_stop' }) },
  ], {}, { provider: { ...provider, api: 'anthropic-messages' } })
  assert.equal(result.usageReported, false)
  assert.equal(result.tps, null)
})

test('unsupported protocol/API and synchronous request failures resolve errors', async () => {
  for (const invalid of [
    { ...provider, baseURL: 'http://api.example.test/v1' },
    { ...provider, api: 'unsupported-api' },
    { ...provider, baseURL: 'not-a-url' },
  ]) {
    const { result } = await measure([], {}, { provider: invalid, requestImpl: () => { assert.fail('must not send') } })
    assert.equal(typeof result.error, 'string')
  }
  const { result } = await measure([], {}, { requestImpl: () => { throw new Error('setup failed') } })
  assert.equal(result.error, 'request failed')
})

test('API support exports share the wire allow-list and preserve the Chat default', () => {
  assert.deepEqual(BENCHMARK_APIS, ['openai-completions', 'openai-responses', 'anthropic-messages'])
  assert.equal(Object.isFrozen(BENCHMARK_APIS), true)
  for (const api of [...BENCHMARK_APIS, undefined, null]) assert.equal(supportsBenchmarkApi(api), true)
  for (const api of ['', 'openai', 'unsupported-api', 'OpenAI-Responses', {}, []]) {
    assert.equal(supportsBenchmarkApi(api), false)
  }
})

test('canonical provider OAuth marker fails before endpoint parsing or request creation', async () => {
  for (const api of BENCHMARK_APIS) {
    const controller = new AbortController()
    const { result, captured } = await measure([], {}, {
      provider: { baseURL: 'not-a-url', api, authType: 'oauth' },
      apiKey: 'must-not-be-used', signal: controller.signal,
      requestImpl: () => assert.fail('OAuth benchmarks must not create a request'),
    })
    assert.match(result.error, /OAuth.*unsupported/)
    assert.equal(result.status, 0)
    assert.equal(result.ttftMs, null)
    assert.equal(result.totalMs, 0)
    assert.equal(result.tps, null)
    assert.equal(result.usageReported, false)
    assert.equal(captured.request, undefined)
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), [])
    assert.equal(summarize([result]).samples[0].error, result.error)
  }
})

test('direct request and validation errors exclude arbitrary exception details', async () => {
  const huge = 'sensitive detail '.repeat(1000)
  const requestFailure = await measure([], {}, { requestImpl: () => { throw new Error(huge) } })
  assert.equal(requestFailure.result.error, 'request failed')
  const invalidApi = await measure([], {}, { provider: { ...provider, api: huge } })
  assert.equal(invalidApi.result.error, 'unsupported benchmark API')
})

test('pre-aborted signals return a stopped result without parsing or sending', async () => {
  const controller = new AbortController()
  controller.abort()
  const { result, captured } = await measure([], {}, {
    signal: controller.signal, provider: undefined,
    requestImpl: () => assert.fail('a stopped test must not send a request'),
  })
  assert.equal(result.cancelled, true)
  assert.equal(result.error, 'test stopped')
  assert.equal(result.totalMs, 0)
  assert.equal(result.ttftMs, null)
  assert.equal(result.tps, null)
  assert.equal(captured.request, undefined)
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), [])
})

test('aborting an active stream destroys both sides and removes owned listeners', async () => {
  const controller = new AbortController()
  const { result, captured } = await measure([
    completed[0], { at: 140, data: frame(usage(100)) },
    { at: 150, action: () => controller.abort() },
    { at: 160, action: () => assert.fail('must stop reading immediately') },
  ], { end: false }, { signal: controller.signal })
  assert.equal(result.cancelled, true)
  assert.equal(result.error, 'test stopped')
  assert.equal(result.totalMs, 150)
  assert.equal(result.ttftMs, 100)
  assert.equal(result.outputTokens, 100)
  assert.equal(result.tps, null)
  assert.equal(captured.request.destroyed, true)
  assert.equal(captured.response.destroyed, true)
  assert.deepEqual(captured.request.eventNames(), [])
  assert.deepEqual(captured.response.eventNames(), [])
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), [])
})

test('stop after DONE still cancels until HTTP response completion', async () => {
  const controller = new AbortController()
  const { result, captured } = await measure([
    ...completed, { at: 280, action: () => controller.abort() },
  ], { end: false }, { signal: controller.signal })
  assert.equal(result.cancelled, true)
  assert.equal(result.error, 'test stopped')
  assert.equal(result.totalMs, 280)
  assert.equal(result.outputTokens, 100)
  assert.equal(result.tps, null)
  assert.equal(captured.request.destroyed, true)
  assert.equal(captured.response.destroyed, true)
})

test('abort during request creation destroys the returned request without sending', async () => {
  const controller = new AbortController()
  const request = new EventEmitter()
  request.end = () => assert.fail('must not send after abort')
  request.destroy = () => {
    request.destroyed = true
    // A real destroyed request can report ECONNRESET asynchronously.
    queueMicrotask(() => {
      request.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      request.emit('close')
    })
  }
  const { result } = await measure([], {}, {
    signal: controller.signal,
    requestImpl: () => {
      controller.abort()
      return request
    },
  })
  assert.equal(result.error, 'test stopped')
  assert.equal(result.cancelled, true)
  assert.equal(request.destroyed, true)
  assert.deepEqual(request.eventNames(), [])
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), [])
})

test('a response arriving after stop is destroyed without reading it', async () => {
  const controller = new AbortController()
  const request = new EventEmitter()
  const response = new EventEmitter()
  request.destroy = () => { request.destroyed = true; request.emit('close') }
  response.destroy = () => { response.destroyed = true; response.emit('close') }
  response.setEncoding = () => assert.fail('must not read a late response')
  const { result } = await measure([], {}, {
    signal: controller.signal,
    requestImpl: (_, callback) => {
      request.end = () => {
        controller.abort()
        callback(response)
      }
      return request
    },
  })
  assert.equal(result.cancelled, true)
  assert.equal(request.destroyed, true)
  assert.equal(response.destroyed, true)
  assert.deepEqual(request.eventNames(), [])
  assert.deepEqual(response.eventNames(), [])
})

test('normal success and failure detach the signal and stream listeners', async () => {
  for (const steps of [completed, [completed[0], { at: 150, event: 'requestError', error: new Error('broken') }]]) {
    const controller = new AbortController()
    const { result, captured } = await measure(steps, {}, { signal: controller.signal })
    assert.notEqual(result.cancelled, true)
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), [])
    assert.deepEqual(captured.request.eventNames(), [])
    assert.deepEqual(captured.response.eventNames(), [])
    controller.abort()
    assert.notEqual(result.error, 'test stopped')
  }
})

const valid = (tps = 100) => ({ tps, ttftMs: 10, decodeMs: 1000, outputTokens: 100, usageReported: true, totalMs: 1010 })

test('summary counts failed/unmeasurable runs and requires a strict majority', () => {
  const minority = summarize([valid(300), { error: 'timeout' }, { error: 'timeout' }])
  assert.equal(minority.failed, 2)
  assert.equal(minority.measurable, 1)
  assert.equal(minority.unmeasurable, 0)
  assert.equal(minority.tps, 300)
  assert.equal(minority.eligible, false)
  assert.match(minority.error, /strict majority/)
  assert.equal(summarize([valid(), { error: 'timeout' }]).eligible, false)
  const majority = summarize([valid(100), valid(200), { error: 'timeout' }])
  assert.equal(majority.eligible, true)
  assert.equal(majority.error, undefined)
  assert.equal(majority.tps, 150)
  assert.equal(majority.tpsMin, 100)
  assert.equal(majority.tpsMax, 200)
})

test('summary excludes missing, non-finite and invalid TPS/usage/timing', () => {
  const bad = [
    { ...valid(), tps: null }, { ...valid(), tps: NaN }, { ...valid(), tps: Infinity },
    { ...valid(), tps: 0 }, { ...valid(), tps: -1 }, { ...valid(), usageReported: false },
    { ...valid(), outputTokens: Infinity }, { ...valid(), outputTokens: 1.5 }, { ...valid(), ttftMs: NaN },
  ]
  const result = summarize(bad)
  assert.equal(result.failed, 0)
  assert.equal(result.measurable, 0)
  assert.equal(result.unmeasurable, bad.length)
  assert.equal(result.tps, null)
  assert.equal(result.eligible, false)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  const empty = summarize([])
  assert.equal(empty.runs, 0)
  assert.equal(empty.eligible, false)
  assert.equal(typeof empty.error, 'string')
})
