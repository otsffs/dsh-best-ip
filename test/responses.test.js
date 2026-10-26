// Offline only: HTTPS, response chunks, EOF, transport failures and time are mocked.
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import test from 'node:test'
import { measureStream, summarize } from '../bench.js'

const provider = { baseURL: 'https://api.example.test/v1', api: 'openai-responses' }
const frame = (payload, { event = payload?.type, newline = '\n' } = {}) =>
  `${event ? `event: ${event}${newline}` : ''}data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}${newline}${newline}`
const delta = (value, type = 'response.output_text.delta') => ({ type, delta: value })
const complete = (usage = { output_tokens: 100 }, overrides = {}) => ({
  type: 'response.completed', response: { status: 'completed', error: null, incomplete_details: null, usage, ...overrides },
})

function fixture(steps, { end = true, endAt = 300, status = 200 } = {}) {
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
      captured.rawBody = body
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
          if (step.action) step.action({ request, response })
          else if (step.event === 'requestError') request.emit('error', step.error)
          else response.emit(step.event ?? 'data', step.error ?? step.data)
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
    timeout: 1000, requestImpl: fake.requestImpl, clock: fake.clock, ...overrides,
  })
  return { result, ...fake }
}

const completed = [
  { at: 100, data: frame(delta('answer')) },
  { at: 200, data: frame(complete()) },
]
const assertDetached = (captured, signal) => {
  assert.equal(captured.request.destroyed, true)
  assert.equal(captured.response.destroyed, true)
  assert.deepEqual(captured.request.eventNames(), [])
  assert.deepEqual(captured.response.eventNames(), [])
  if (signal) assert.deepEqual(getEventListeners(signal, 'abort'), [])
}

test('Responses POST uses input_text/max_output_tokens, pinned IP, origin Host/SNI and bearer auth', async () => {
  const message = 'Count 多字节 text'
  const { result, captured } = await measure(completed, {}, {
    provider: { ...provider, baseURL: 'https://api.example.test:8443/custom///', authType: 'api-key' },
    model: 'responses-model', message, maxTokens: 123,
  })
  assert.equal(result.error, undefined)
  assert.deepEqual(captured.body, {
    model: 'responses-model', input: [{ role: 'user', content: [{ type: 'input_text', text: message }] }],
    max_output_tokens: 123, stream: true,
  })
  for (const field of ['messages', 'max_tokens', 'stream_options']) assert.equal(field in captured.body, false)
  assert.equal(captured.options.method, 'POST')
  assert.equal(captured.options.path, '/custom/responses')
  assert.equal(captured.options.host, '192.0.2.7')
  assert.equal(captured.options.port, 8443)
  assert.equal(captured.options.servername, 'api.example.test')
  assert.equal(captured.options.headers.host, 'api.example.test:8443')
  assert.equal(captured.options.headers.authorization, 'Bearer test-key')
  assert.equal(captured.options.headers['x-api-key'], undefined)
  assert.equal(captured.options.headers['anthropic-version'], undefined)
  assert.equal(captured.options.headers['content-length'], Buffer.byteLength(captured.rawBody))
  assert.equal(captured.options.headers['content-type'], 'application/json')
  assert.equal(captured.options.headers.accept, 'text/event-stream')
  assert.equal(captured.options.agent, false)
  assert.equal(captured.encoding, 'utf8')
  assertDetached(captured)
})

test('Responses root endpoint and max token default work without a supplied key', async () => {
  const { result, captured } = await measure(completed, {}, {
    provider: { ...provider, baseURL: 'https://api.example.test/' }, apiKey: undefined,
  })
  assert.equal(result.error, undefined)
  assert.equal(captured.options.path, '/responses')
  assert.equal(captured.options.port, 443)
  assert.equal(captured.body.max_output_tokens, 256)
  assert.equal('authorization' in captured.options.headers, false)
})

test('Responses measures first delta to HTTP end, not response.completed or last text', async () => {
  const { result } = await measure([
    { at: 10, data: frame({ type: 'response.created', response: { status: 'in_progress', usage: { output_tokens: 1 } } }) },
    { at: 20, data: frame({ type: 'response.in_progress', response: { usage: { output_tokens: 2 } } }) },
    { at: 30, data: frame(delta('')) },
    { at: 100.25, data: frame(delta('answer')) },
    { at: 150, data: frame(delta('!')) },
    { at: 200, data: frame(complete()) },
  ], { endAt: 300.65 })
  assert.equal(result.error, undefined)
  assert.equal(result.text, 'answer!')
  assert.equal(result.ttftMs, 100)
  assert.equal(result.decodeMs, 200)
  assert.equal(result.totalMs, 301)
  assert.equal(result.outputTokens, 100)
  assert.equal(result.tps, 499)
})

for (const type of ['response.output_text.delta', 'response.reasoning_summary_text.delta', 'response.reasoning_text.delta']) {
  test(`${type} non-empty deltas (including whitespace) establish first-token time`, async () => {
    const { result } = await measure([
      { at: 40, data: frame(delta('', type)) },
      { at: 80, data: frame(delta(' ', type)) },
      { at: 100, data: frame(delta('answer')) },
      completed[1],
    ])
    assert.equal(result.error, undefined)
    assert.equal(result.ttftMs, 80)
    assert.equal(result.decodeMs, 220)
    assert.equal(result.tps, 454.5)
    assert.equal(result.text, type === 'response.output_text.delta' ? ' answer' : 'answer')
    assert.equal(result.reasoningChars, type === 'response.output_text.delta' ? 0 : 1)
  })
}

test('Responses reasoning-only streams remain measurable without visible output text', async () => {
  const { result } = await measure([
    { at: 100, data: frame(delta('think', 'response.reasoning_text.delta')) }, completed[1],
  ])
  assert.equal(result.error, undefined)
  assert.equal(result.text, '')
  assert.equal(result.reasoningChars, 5)
  assert.equal(result.ttftMs, 100)
  assert.equal(result.tps, 500)
})

test('Responses final snapshots and done events never add duplicate text or reasoning', async () => {
  const { result } = await measure([
    { at: 10, data: frame({ type: 'response.output_text.done', text: 'not a first delta' }) },
    { at: 20, data: frame({ type: 'response.reasoning_summary_text.done', text: 'not a first delta' }) },
    { at: 80, data: frame(delta('think', 'response.reasoning_summary_text.delta')) },
    completed[0],
    { at: 140, data: frame({ type: 'response.output_text.done', text: 'answer', delta: 'answer' }) },
    { at: 150, data: frame({ type: 'response.reasoning_text.done', text: 'think', delta: 'think' }) },
    { at: 180, data: frame({ type: 'response.output_item.done', item: { content: [{ type: 'output_text', text: 'answer' }] } }) },
    { at: 200, data: frame(complete({ output_tokens: 100 }, {
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }],
    })) },
    { at: 220, data: frame(delta('must not be added after completion')) },
    { at: 250, data: frame(complete({ output_tokens: 900 })) },
  ])
  assert.equal(result.error, undefined)
  assert.equal(result.ttftMs, 80)
  assert.equal(result.text, 'answer')
  assert.equal(result.reasoningChars, 5)
  assert.equal(result.outputTokens, 100)
})

test('Responses accepts only completed response output_tokens, not initial or top-level usage', async () => {
  const { result } = await measure([
    { at: 10, data: frame({ type: 'response.created', response: { usage: { output_tokens: 1 } } }) },
    completed[0],
    { at: 150, data: frame({ type: 'response.output_text.done', usage: { output_tokens: 999 }, text: 'answer' }) },
    { at: 200, data: frame({ ...complete(), usage: { output_tokens: 999, completion_tokens: 999 } }) },
    { at: 250, data: frame('[DONE]') },
  ])
  assert.equal(result.error, undefined)
  assert.equal(result.usageReported, true)
  assert.equal(result.outputTokens, 100)
  assert.equal(result.tps, 500)
})

for (const [label, finalUsage] of [
  ['missing', undefined], ['empty', {}], ['null', { output_tokens: null }],
  ['negative', { output_tokens: -1 }], ['fractional', { output_tokens: 1.5 }],
  ['string', { output_tokens: '100' }], ['unsafe integer', { output_tokens: 2 ** 53 }],
  ['wrong field', { completion_tokens: 100 }],
]) {
  test(`Responses ${label} completed usage is unmeasurable; initial usage never substitutes`, async () => {
    const { result } = await measure([
      { at: 20, data: frame({ type: 'response.created', response: { usage: { output_tokens: 100 } } }) },
      completed[0],
      { at: 200, data: frame({ ...complete({}, { usage: finalUsage }), usage: { output_tokens: 100 } }) },
    ])
    assert.equal(result.error, undefined)
    assert.equal(result.usageReported, false)
    assert.equal(result.outputTokens, null)
    assert.equal(result.tps, null)
    const summary = summarize([result])
    assert.equal(summary.measurable, 0)
    assert.equal(summary.unmeasurable, 1)
    assert.equal(summary.eligible, false)
  })
}

test('Responses non-finite wire usage is unmeasurable and zero is reported without TPS', async () => {
  const nonfinite = await measure([
    completed[0], { at: 200, data: 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":1e309}}}\n\n' },
  ])
  assert.equal(nonfinite.result.error, undefined)
  assert.equal(nonfinite.result.usageReported, false)
  assert.equal(nonfinite.result.tps, null)
  const zero = await measure([completed[0], { at: 200, data: frame(complete({ output_tokens: 0 })) }])
  assert.equal(zero.result.error, undefined)
  assert.equal(zero.result.usageReported, true)
  assert.equal(zero.result.outputTokens, 0)
  assert.equal(zero.result.tps, null)
})

for (const status of [undefined, 'failed', 'incomplete', 'error', 'cancelled', 'canceled', 'in_progress', 'queued']) {
  test(`Responses response.completed rejects actual status ${String(status)}`, async () => {
    const { result } = await measure([
      completed[0], { at: 200, data: frame(complete({ output_tokens: 100 }, { status })) },
    ])
    assert.match(result.error, /stream error:.*non-completed status/)
    assert.equal(result.outputTokens, null)
    assert.equal(result.tps, null)
    assert.equal(summarize([result]).eligible, false)
  })
}

const sensitive = 'prompt=private API_KEY=must-not-echo https://private.invalid/?secret=hidden '.repeat(1000)
for (const type of ['response.failed', 'response.incomplete', 'response.cancelled', 'response.canceled', 'error']) {
  for (const eventOnly of [false, true]) {
    test(`Responses ${type} ${eventOnly ? 'event name' : 'payload type'} fails safely after content`, async () => {
      const controller = new AbortController()
      const payload = { ...(eventOnly ? {} : { type }), message: sensitive,
        response: { status: 'incomplete', error: { message: sensitive }, usage: { output_tokens: 100 } } }
      const { result, captured } = await measure([
        completed[0], { at: 200, data: frame(payload, { event: eventOnly ? type : '' }) },
      ], {}, { signal: controller.signal })
      assert.equal(result.error, `stream error: ${type}`)
      assert.ok(result.error.length <= 240)
      assert.equal(result.error.includes('private'), false)
      assert.equal(result.outputTokens, null)
      assert.equal(result.tps, null)
      assert.equal(result.totalMs, 200)
      assertDetached(captured, controller.signal)
    })
  }
}

test('Responses failure event names fail even with empty, DONE or non-JSON bodies', async () => {
  for (const event of ['response.failed', 'response.incomplete', 'response.cancelled', 'error']) {
    for (const body of ['', '[DONE]', sensitive]) {
      const { result } = await measure([
        ...completed, { at: 250, data: frame(body, { event }) },
      ])
      assert.equal(result.error, `stream error: ${event}`)
      assert.equal(result.tps, null)
    }
  }
})

test('Responses generic embedded and non-JSON error events never echo provider bodies', async () => {
  for (const wire of [
    frame({ error: { message: sensitive } }, { event: undefined }),
    frame(complete({ output_tokens: 100 }, { error: { message: sensitive } })),
    frame(sensitive, { event: 'error' }),
    frame('[DONE]', { event: 'error' }),
    'event: error\n\n',
  ]) {
    const { result } = await measure([completed[0], { at: 200, data: wire }])
    assert.match(result.error, /^stream error:/)
    assert.ok(result.error.length <= 240)
    assert.equal(result.error.includes('private'), false)
    assert.equal(result.tps, null)
  }
})

test('Responses error or failed/incomplete trailers still fail after response.completed', async () => {
  for (const type of ['error', 'response.failed', 'response.incomplete']) {
    const { result } = await measure([...completed, { at: 250, data: frame({ type, message: sensitive }) }])
    assert.equal(result.error, `stream error: ${type}`)
    assert.equal(result.outputTokens, 100)
    assert.equal(result.tps, null)
  }
})

for (const [label, tail] of [
  ['plain HTTP EOF', ''],
  ['Chat DONE marker', frame('[DONE]')],
  ['in-progress usage', frame({ type: 'response.in_progress', response: { usage: { output_tokens: 100 } } })],
]) {
  test(`Responses ${label} is not successful completion`, async () => {
    const { result } = await measure([completed[0], { at: 200, data: tail }])
    assert.match(result.error, /without completion marker/)
    assert.equal(result.usageReported, false)
    assert.equal(result.tps, null)
  })
}

test('Responses DONE-only and terminal snapshots without delta evidence cannot succeed', async () => {
  for (const steps of [
    [{ at: 200, data: frame('[DONE]') }],
    [{ at: 100, data: frame(delta('')) }, completed[1]],
    [{ at: 100, data: frame({ type: 'response.output_text.done', text: 'answer' }) }, completed[1]],
    [{ at: 200, data: frame(complete({ output_tokens: 100 }, { output: [{ content: [{ text: 'answer' }] }] })) }],
  ]) {
    const { result } = await measure(steps)
    assert.match(result.error, /before any token/)
    assert.equal(result.ttftMs, null)
    assert.equal(result.tps, null)
  }
})

test('Responses incomplete JSON and a truncated completed frame fail rather than succeeding at EOF', async () => {
  for (const tail of ['data: {', 'event: response.completed\ndata: {"type":"response.completed","response":']) {
    const { result } = await measure([completed[0], { at: 200, data: tail }])
    assert.equal(result.error, 'invalid JSON in stream event')
    assert.equal(result.tps, null)
  }
})

test('Responses flushes a complete final response.completed frame without a blank line', async () => {
  const { result } = await measure([
    completed[0], { at: 200, data: `event: response.completed\ndata: ${JSON.stringify(complete())}` },
  ])
  assert.equal(result.error, undefined)
  assert.equal(result.tps, 500)
})

for (const newline of ['\n', '\r\n', '\r']) {
  test(`Responses SSE handles ${JSON.stringify(newline)} split at every character boundary`, async () => {
    const wire = `\uFEFF: comment${newline}${newline}` +
      frame(delta('answer'), { newline }) + frame(complete(), { newline })
    const { result } = await measure([...wire].map((data) => ({ at: 100, data })))
    assert.equal(result.error, undefined)
    assert.equal(result.text, 'answer')
    assert.equal(result.ttftMs, 100)
    assert.equal(result.outputTokens, 100)
    assert.equal(result.tps, 500)
  })
}

test('Responses SSE joins multiline data, ignores pings, and can read event-only delta types', async () => {
  const { result } = await measure([
    { at: 10, data: 'event: ping\ndata: not JSON\n\n: keepalive\n\n' },
    { at: 100, data: 'event: response.output_text.delta\ndata: {\ndata: "delta":"answer"}\n\n' },
    { at: 200, data: frame({ response: { status: 'completed', usage: { output_tokens: 100 } } }, { event: 'response.completed' }) },
  ])
  assert.equal(result.error, undefined)
  assert.equal(result.text, 'answer')
  assert.equal(result.tps, 500)
})

for (const event of ['aborted', 'close', 'error', 'requestError']) {
  test(`Responses premature ${event} fails even after the completed event`, async () => {
    const { result, captured } = await measure([
      ...completed, { at: 250, event, error: new Error('transport broken') },
    ], { end: false })
    assert.equal(typeof result.error, 'string')
    assert.equal(result.totalMs, 250)
    assert.equal(result.tps, null)
    assertDetached(captured)
  })
}

for (const afterCompletion of [false, true]) {
  test(`Responses cancellation ${afterCompletion ? 'after response.completed' : 'during content'} destroys both sides and listeners`, async () => {
    const controller = new AbortController()
    const { result, captured } = await measure([
      ...(afterCompletion ? completed : [completed[0]]),
      { at: 250, action: () => controller.abort() },
      { at: 260, action: () => assert.fail('must stop immediately on cancellation') },
    ], { end: false }, { signal: controller.signal })
    assert.equal(result.cancelled, true)
    assert.equal(result.error, 'test stopped')
    assert.equal(result.ttftMs, 100)
    assert.equal(result.totalMs, 250)
    assert.equal(result.outputTokens, afterCompletion ? 100 : null)
    assert.equal(result.tps, null)
    assertDetached(captured, controller.signal)
  })
}

test('Responses normal completion detaches the signal before later aborts', async () => {
  const controller = new AbortController()
  const { result, captured } = await measure(completed, {}, { signal: controller.signal })
  assert.equal(result.error, undefined)
  assertDetached(captured, controller.signal)
  controller.abort()
  assert.equal(result.cancelled, undefined)
  assert.equal(result.tps, 500)
})
