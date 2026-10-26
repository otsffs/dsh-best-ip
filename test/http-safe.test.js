// Route/tool contract tests without mounting interception or opening sockets.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createResolver, normalizeConfig, registerHttpBridge, registerTools } from '../index.js'

const host = 'api.example.test'
const p1 = { provider: 'p1', baseURL: `https://${host}/v1`, api: 'openai-completions', models: ['m1'] }
const p2 = { provider: 'p2', baseURL: 'https://other.example.test/v1', api: 'openai-completions', models: ['m2'] }
const sample = (ip) => ({ ip, tps: 100, outputTokens: 100, usageReported: true, ttftMs: 100, totalMs: 1100, decodeMs: 1000 })
function fixture({ measure, resolveKey, availability, canApply, lookup, inspect, editError, api = p1.api, config: overrides = {} } = {}) {
  const routes = [], tools = [], calls = [], writes = [], edits = []
  let selection = { provider: 'p1', model: 'default-m1' }
  let config = normalizeConfig({ enabled: true, providers: ['p1', 'p2'], dnsServers: [], scanEdges: false, ...overrides })
  const engine = createResolver(config, undefined, {
    readState: () => ({ hosts: { [host]: { hostname: host, provider: 'p1', selected: '203.0.113.9',
      candidates: [{ ip: '203.0.113.1', rtt: 10 }], benchmarks: {} } } }),
    writeState: (state) => writes.push(structuredClone(state)),
    nativePromiseLookup: lookup ?? (async () => [{ address: '203.0.113.1', family: 4 }]),
    inspectAll: inspect ?? (async (ips) => ips.map((ip) => ({ ip, rtt: 20 }))),
    measureStream: async (options) => { calls.push(options); return measure ? measure(options) : sample(options.ip) },
  })
  engine.setHosts([host], new Map([[host, ['p1']]]))
  const entry = { options: { id: 'dsh-best-ip' } }
  const editor = { entries: () => [entry], async edit(target, update) {
    assert.equal(target, entry)
    if (editError) throw editError
    config = update(config)
    edits.push(structuredClone(config))
  } }
  const ctx = {
    get: (name) => name === 'configEditor' ? editor : undefined,
    inject(services, cb) { cb({ effect: (fn) => fn(),
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      tools: { register: (tool) => { tools.push(tool); return () => {} } } }) },
  }
  const providers = { readProviderProfiles: () => new Map([['p1', { ...p1, api }], ['p2', p2]]),
    resolveApiKey: resolveKey ?? (async () => 'fake-key'),
    readDefaultSelection: () => ({ ...selection }),
    describeBenchmark: availability ?? (async () => ({ supported: true })),
    isCurrentDefault: (profile, model = selection.model) => (canApply?.() ?? true) && profile.provider === selection.provider && model === selection.model,
    subagentParallelism: 2, readOwnConfig: () => config, applyConfig: (value) => { config = value; engine.reconfigure(value) } }
  registerHttpBridge(ctx, engine, () => {}, config, providers)
  registerTools(ctx, engine, () => {}, providers)
  const invoke = async (path, body = {}, headers = {}, raw) => {
    const req = { method: 'POST', headers: { host: '127.0.0.1:12345', ...headers },
      socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(raw ?? JSON.stringify(body)) } }
    let status, value
    await routes.find((route) => route.path.endsWith(`/${path}`)).handler(req, {
      writeHead(code) { status = code }, end(payload) { value = JSON.parse(payload) },
    })
    return { status, ...value }
  }
  return { engine, invoke, calls, tools, writes, edits, setDefault(next) { selection = next } }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('auto defaults to test-only and exposes recommendation rather than claiming applied', async () => {
  const h = fixture()
  const started = await h.invoke('auto')
  assert.equal(started.status, 202)
  assert.ok(started.value.runId)
  await tick()
  const done = (await h.invoke('progress')).value.progress
  assert.equal(done.runId, started.value.runId)
  assert.equal(done.stage, 'done')
  assert.equal(done.applied, false)
  assert.equal(done.recommended, '203.0.113.1')
  assert.equal(h.engine.selectedFor(host, 'p1'), '203.0.113.9')
})

test('automatic test-and-apply explicitly applies only after successful measurement', async () => {
  const h = fixture()
  const started = await h.invoke('auto', { testOnly: false })
  assert.equal(started.status, 202)
  await tick()
  const done = (await h.invoke('progress')).value.progress
  assert.equal(done.stage, 'done')
  assert.equal(done.testOnly, false)
  assert.equal(done.applied, true)
  assert.equal(h.engine.selectedFor(host, 'p1'), '203.0.113.1')
})

test('failed streams mark auto failed, never done/applied', async () => {
  const h = fixture({ measure: async ({ ip }) => ({ ip, error: 'HTTP 429' }) })
  await h.invoke('auto', { testOnly: false }); await tick()
  const done = (await h.invoke('progress')).value.progress
  assert.equal(done.stage, 'failed')
  assert.equal(done.applied, false)
  assert.equal(h.engine.selectedFor(host, 'p1'), '203.0.113.9')
})

for (const [scenario, dependencies] of [
  ['no DNS answers', { lookup: async () => [] }],
  ['all discovered addresses rejected', { inspect: async () => [] }],
]) {
  test(`${scenario} exposes a durable no-usable-IP failure without changing the pin`, async () => {
    const h = fixture(dependencies)
    const started = await h.invoke('auto', { testOnly: false })
    assert.equal(started.status, 202)
    await tick()
    const done = (await h.invoke('progress')).value.progress
    assert.equal(done.stage, 'failed')
    assert.equal(done.reasonCode, 'NO_USABLE_IP')
    assert.equal(done.applied, false)
    assert.equal(h.calls.length, 0, 'empty discovery must not send paid stream requests')
    assert.equal(h.engine.selectedFor(host, 'p1'), '203.0.113.9')
    h.engine.endProgress()
    const retained = (await h.invoke('progress')).value
    assert.equal(retained.progress, null)
    assert.equal(retained.lastRun.reasonCode, 'NO_USABLE_IP')
    assert.deepEqual((await h.invoke('state')).value.measurements[0].candidates, [])
  })
}

test('credential await race admits only one concurrent auto run', async () => {
  let releaseKey, releaseMeasure
  const keyGate = new Promise((resolve) => { releaseKey = resolve })
  const measureGate = new Promise((resolve) => { releaseMeasure = resolve })
  const h = fixture({ resolveKey: async () => { await keyGate; return 'fake-key' },
    measure: async ({ ip }) => { await measureGate; return sample(ip) } })
  const first = h.invoke('auto'), second = h.invoke('auto')
  releaseKey()
  const statuses = (await Promise.all([first, second])).map((result) => result.status).sort()
  assert.deepEqual(statuses, [202, 409])
  releaseMeasure(); await tick()
})

test('stop route cancels the exact active run and retains a stopped terminal outcome', async () => {
  let entered, release
  const startedMeasuring = new Promise((resolve) => { entered = resolve })
  const pending = new Promise((resolve) => { release = resolve })
  const h = fixture({ measure: async () => { entered(); return pending } })
  const started = await h.invoke('auto', { testOnly: false })
  await startedMeasuring
  const result = await h.invoke('stop', { runId: started.value.runId })
  assert.equal(result.ok, true)
  assert.equal(result.value.requested, true)
  await tick()
  const final = (await h.invoke('progress')).value.progress
  assert.equal(final.stage, 'stopped')
  assert.equal(final.applied, false)
  assert.equal(h.engine.activeAddressFor(host), '203.0.113.9')
  assert.equal(h.calls.length, 1)
  release(sample('203.0.113.1'))
})

test('stop route rejects missing/stale IDs and cross-site requests', async () => {
  const h = fixture()
  assert.equal((await h.invoke('stop')).status, 400)
  assert.equal((await h.invoke('stop', { runId: 'stale' })).status, 409)
  assert.equal((await h.invoke('stop', { runId: 'x' }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal(h.writes.length, 0)
})

test('agent stop tool uses the same run ID and cancellation semantics as the stop route', async () => {
  let entered, release
  const gate = new Promise((resolve) => { entered = resolve })
  const pending = new Promise((resolve) => { release = resolve })
  const h = fixture({ measure: async () => { entered(); return pending } })
  const started = await h.invoke('auto')
  await gate
  const status = await h.tools.find((tool) => tool.name === 'best_ip_status').execute({})
  assert.equal(status.run.runId, started.value.runId)
  const tool = h.tools.find((tool) => tool.name === 'best_ip_stop')
  assert.ok(tool)
  const stopped = await tool.execute({ runId: status.run.runId })
  validate(tool.output.schema, stopped)
  assert.equal(stopped.requested, true)
  await tick()
  assert.equal((await h.invoke('progress')).value.progress.stage, 'stopped')
  const statusTool = h.tools.find((tool) => tool.name === 'best_ip_status')
  const saved = await statusTool.execute({})
  validate(statusTool.output.schema, saved)
  assert.deepEqual(saved.measurements[0].candidates[0].runTps, [null])
  assert.equal((await tool.execute({ runId: status.run.runId })).requested, false)
  await assert.rejects(tool.execute({ runId: 'stale' }), /no longer matches/)
  release(sample('203.0.113.1'))
})

test('malformed/empty forget never erases stored choices', async () => {
  const h = fixture()
  for (const body of [{}, { host: '' }, { host: 123 }]) assert.equal((await h.invoke('forget', body)).status, 400)
  assert.equal((await h.invoke('forget', {}, {}, '{bad')).status, 400)
  assert.equal(h.engine.selectedFor(host, 'p1'), '203.0.113.9')
  assert.equal(h.writes.length, 0)
})

test('malformed action bodies never start a paid measurement', async () => {
  const h = fixture()
  for (const raw of ['{bad', 'null', '[]']) {
    assert.equal((await h.invoke('auto', {}, {}, raw)).status, 400)
    assert.equal((await h.invoke('time', {}, {}, raw)).status, 400)
  }
  assert.equal(h.calls.length, 0)
  assert.equal(h.writes.length, 0)
})

test('select and forget both require explicit non-test mode', async () => {
  const h = fixture()
  assert.equal((await h.invoke('select', { host, provider: 'p1', ip: '203.0.113.1' })).ok, false)
  assert.equal((await h.invoke('forget', { host, provider: 'p1' })).status, 400)
  assert.equal(h.engine.selectedFor(host, 'p1'), '203.0.113.9')
})

test('benchmark rejects a provider/host mismatch before sending requests', async () => {
  const h = fixture()
  const result = await h.invoke('benchmark', { host, provider: 'p2', message: 'test', model: 'm2' })
  assert.equal(result.ok, false)
  assert.equal(h.calls.length, 0)
})

test('stale provider requests are rejected, then a new DSH default uses its exact model', async () => {
  const h = fixture()
  const stale = await h.invoke('auto', { provider: 'p2' })
  assert.equal(stale.status, 409)
  assert.equal(h.calls.length, 0)
  assert.equal(h.writes.length, 0)
  h.setDefault({ provider: 'p2', model: 'm2' })
  assert.equal((await h.invoke('auto')).status, 202)
  await tick()
  assert.ok(h.calls.length > 0)
  assert.ok(h.calls.every((call) => call.provider.provider === 'p2' && call.model === 'm2'))
})

test('OpenAI Responses passes both automatic and current-address engine preflight', async () => {
  const h = fixture({ api: 'openai-responses' })
  assert.equal((await h.invoke('auto')).status, 202)
  await tick()
  assert.equal((await h.invoke('progress')).value.progress.stage, 'done')
  assert.equal((await h.invoke('time')).status, 202)
  await tick()
  assert.equal((await h.invoke('progress')).value.progress.stage, 'done')
  assert.ok(h.calls.length > 0)
  assert.ok(h.calls.every((call) => call.provider.api === 'openai-responses'))
})

test('OAuth refusals happen before key resolution, probing or paid streams on every surface', async () => {
  let keys = 0
  const h = fixture({ availability: async () => ({ supported: false, authType: 'oauth', reasonCode: 'OAUTH_UNSUPPORTED' }),
    resolveKey: async () => { keys++; throw new Error('must not resolve OAuth') } })
  const body = { host, provider: 'p1', model: 'default-m1', message: 'fixture prompt', testOnly: false }
  for (const route of ['auto', 'time', 'benchmark', 'probe']) {
    const result = await h.invoke(route, body)
    assert.equal(result.ok, false, route)
    assert.match(result.message, /OAuth/, route)
  }
  const manual = await h.invoke('select', { ...body, ip: '203.0.113.1' })
  assert.equal(manual.ok, false)
  assert.match(manual.message, /OAuth/)
  const tool = h.tools.find((tool) => tool.name === 'best_ip_resolve')
  const result = await tool.execute({ host, probe: true, benchmark: true, message: 'fixture prompt', testOnly: false })
  assert.match(result.error, /OAuth/)
  assert.equal(keys, 0)
  assert.equal(h.calls.length, 0)
  assert.equal(h.writes.length, 0)
  assert.equal(h.engine.selectedFor(host, 'p1'), '203.0.113.9')
  assert.equal((await h.invoke('state')).value.benchmarkAvailability.reasonCode, 'OAUTH_UNSUPPORTED')
})

test('a default switch during credential resolution starts no obsolete paid run', async () => {
  for (const route of ['auto', 'time', 'benchmark']) {
    let release, entered
    const waiting = new Promise((resolve) => { entered = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    const h = fixture({ resolveKey: async () => { entered(); await gate; return 'fake-key' } })
    const pending = h.invoke(route, { host, provider: 'p1', model: 'default-m1', message: 'fixture prompt', testOnly: false })
    await waiting
    h.setDefault({ provider: 'p2', model: 'm2' }); release()
    const result = await pending
    assert.equal(result.status, 409, route)
    assert.equal(h.calls.length, 0, route)
    assert.equal(h.writes.length, 0, route)
    assert.equal(h.engine.busy(), false, route)
  }
})

test('manual apply rechecks the default after asynchronous auth metadata', async () => {
  let entered, release
  const waiting = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const h = fixture({ availability: async () => { entered(); await gate; return { supported: true } } })
  const pending = h.invoke('select', { host, provider: 'p1', ip: '203.0.113.1', testOnly: false })
  await waiting
  h.setDefault({ provider: 'p2', model: 'm2' }); release()
  assert.equal((await pending).status, 409)
  assert.equal(h.engine.selectedFor(host, 'p1'), '203.0.113.9')
  assert.equal(h.writes.length, 0)
})

test('a default change observed only at final commit saves samples without applying', async () => {
  let same = true
  const h = fixture({ canApply: () => same, measure: async ({ ip }) => { same = false; return sample(ip) } })
  assert.equal((await h.invoke('auto', { testOnly: false })).status, 202)
  await tick()
  const done = (await h.invoke('progress')).value.progress
  assert.equal(done.stage, 'done')
  assert.equal(done.applied, false)
  assert.equal(done.defaultChanged, true)
  assert.match(done.message, /changed/)
  assert.equal(h.engine.selectedFor(host, 'p1'), '203.0.113.9')
  assert.ok(h.writes.length > 0)
})

test('rejects deceptive loopback-looking hostnames', async () => {
  const h = fixture()
  assert.equal((await h.invoke('state', {}, { host: '127.attacker.example:12345' })).status, 403)
})

function validate(schema, value, at = 'value') {
  if (schema.oneOf) {
    assert.equal(schema.oneOf.filter((branch) => { try { validate(branch, value, at); return true } catch { return false } }).length, 1, at)
    return
  }
  if (schema.type === 'null') { assert.equal(value, null, at); return }
  if (schema.type === 'object') {
    assert.equal(typeof value, 'object', at)
    assert.notEqual(value, null, at)
    for (const [key, item] of Object.entries(value)) {
      assert.ok(schema.properties?.[key] || schema.additionalProperties !== false, `${at}.${key} undeclared`)
      if (schema.properties?.[key]) validate(schema.properties[key], item, `${at}.${key}`)
    }
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value), at)
    value.forEach((item, i) => validate(schema.items, item, `${at}[${i}]`))
  } else {
    assert.equal(typeof value, schema.type, at)
    if (schema.type === 'number') assert.ok(Number.isFinite(value), at)
  }
}

test('tool defaults are safe, use default model, and produce lossless closed-schema output', async () => {
  const h = fixture()
  const resolver = h.tools.find((tool) => tool.name === 'best_ip_resolve')
  assert.ok(resolver.parameters.properties.testOnly)
  const result = await resolver.execute({ host, benchmark: true, message: 'test prompt' })
  assert.equal(result.applied, false)
  assert.equal(result.recommended, '203.0.113.1')
  assert.equal(h.engine.selectedFor(host, 'p1'), '203.0.113.9')
  assert.ok(h.calls.every((call) => call.model === 'default-m1'))
  validate(resolver.output.schema, result)
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)))
  const status = h.tools.find((tool) => tool.name === 'best_ip_status')
  const state = await status.execute({})
  validate(status.output.schema, state)
  assert.deepEqual(state, JSON.parse(JSON.stringify(state)))
})

const discoveredIps = Array.from({ length: 30 }, (_, index) => `203.0.113.${index + 1}`)
const multiIpDiscovery = {
  lookup: async () => discoveredIps.map((address) => ({ address, family: 4 })),
  inspect: async (ips) => ips.map((ip) => ({ ip, rtt: 31 - Number(ip.split('.').at(-1)) })),
}

for (const limit of [undefined, 10, 7, 0]) {
  for (const testOnly of [true, false]) {
    test(`auto route honors IP limit ${String(limit)} and preserves mode ${testOnly}`, async () => {
      const h = fixture({ ...multiIpDiscovery, config: { maxBenchmarkIps: 10 } })
      const started = await h.invoke('auto', { ...(limit === undefined ? {} : { maxBenchmarkIps: limit }), testOnly })
      assert.equal(started.status, 202)
      await tick()
      const count = limit === 0 ? 30 : limit ?? 10
      assert.equal(h.calls.length, count * 3)
      assert.deepEqual([...new Set(h.calls.map((call) => call.ip))], [...discoveredIps].reverse().slice(0, count))
      const done = (await h.invoke('progress')).value.progress
      assert.equal(done.timingTotal, count * 3)
      assert.equal(done.applied, !testOnly)
      assert.equal((await h.invoke('state')).value.maxBenchmarkIps, 10, 'per-run override is not a config write')
    })
  }
}

test('saved IP limits round-trip through the editor, state, automatic actions and agent status', async () => {
  const h = fixture({ ...multiIpDiscovery })
  assert.equal((await h.invoke('state')).value.maxBenchmarkIps, 0)
  for (const limit of [10, 7, 0]) {
    const saved = await h.invoke('save', { maxBenchmarkIps: limit })
    assert.equal(saved.ok, true)
    assert.equal(saved.value.maxBenchmarkIps, limit)
    assert.equal(h.edits.at(-1).maxBenchmarkIps, limit)
    assert.equal((await h.invoke('state')).value.maxBenchmarkIps, limit)
    h.calls.length = 0
    assert.equal((await h.invoke('auto')).status, 202)
    await tick()
    assert.equal(h.calls.length, (limit || 30) * 3, 'omitted request limit uses the saved configuration')
    const tool = h.tools.find((tool) => tool.name === 'best_ip_status')
    const value = await tool.execute({})
    assert.equal(value.maxBenchmarkIps, limit)
    validate(tool.output.schema, value)
  }
})

test('benchmark route and agent resolve tool also obey the global IP limit', async () => {
  const h = fixture({ ...multiIpDiscovery, config: { maxBenchmarkIps: 7 } })
  await h.invoke('auto'); await tick()
  h.calls.length = 0
  const result = await h.invoke('benchmark', { host, message: 'fixture prompt' })
  assert.equal(result.ok, true)
  assert.equal(h.calls.length, 21)
  h.calls.length = 0
  const resolver = h.tools.find((tool) => tool.name === 'best_ip_resolve')
  const value = await resolver.execute({ host, benchmark: true, message: 'fixture prompt' })
  assert.equal(h.calls.length, 21)
  validate(resolver.output.schema, value)
})

test('invalid IP limits are refused before credentials/paid work or any config write', async () => {
  let keys = 0
  const h = fixture({ ...multiIpDiscovery, resolveKey: async () => { keys++; return 'fake-key' } })
  for (const limit of [-1, 1.5, '10', 'all', null, true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
    const body = { maxBenchmarkIps: limit }
    assert.equal((await h.invoke('auto', body)).status, 400, String(limit))
    assert.equal((await h.invoke('save', { ...body, enabled: false })).status, 400, String(limit))
  }
  assert.equal(h.calls.length, 0)
  assert.equal(h.writes.length, 0)
  assert.equal(h.edits.length, 0, 'a mixed body must not partially save other fields')
  assert.equal(keys, 0)
  assert.equal(h.engine.state().maxBenchmarkIps, 0)
})

test('token-estimate metadata agrees with the real automatic request budget', async () => {
  const h = fixture({ config: { maxCandidates: 33, benchmarkRuns: 4 } })
  const state = (await h.invoke('state')).value
  assert.equal(state.maxCandidates, 33)
  assert.equal(state.benchmarkRuns, 4)
  assert.equal(state.benchmarkMaxTokens, 256)
  await h.invoke('auto'); await tick()
  assert.equal(h.calls.length, state.benchmarkRuns)
  assert.ok(h.calls.every((call) => call.maxTokens === state.benchmarkMaxTokens))
})

test('credential backend exceptions are not echoed through HTTP or agent-tool errors', async () => {
  const secret = 'PRIVATE_CREDENTIAL_CANARY'
  const h = fixture({ resolveKey: async () => { throw new Error(secret) } })
  for (const route of ['auto', 'time', 'benchmark']) {
    const result = await h.invoke(route, { host, message: 'fixture prompt' })
    assert.equal(result.ok, false)
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.match(result.message, /credentials/)
  }
  const result = await h.tools.find((tool) => tool.name === 'best_ip_resolve').execute({ host, benchmark: true, message: 'fixture prompt' })
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.match(result.error, /credentials/)
  assert.equal(h.calls.length, 0)
})

test('configuration editor exceptions do not expose backend details or partially save', async () => {
  const secret = 'PRIVATE_EDITOR_CANARY'
  const h = fixture({ editError: new Error(secret) })
  const result = await h.invoke('save', { maxBenchmarkIps: 10 })
  assert.equal(result.ok, false)
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(h.edits.length, 0)
  assert.equal(h.engine.state().maxBenchmarkIps, 0)
})

test('HTTP progress and state never return error-body or benchmark-prompt canaries', async () => {
  const secret = 'PRIVATE_HTTP_CANARY'
  for (const route of ['auto', 'time', 'benchmark']) {
    const h = fixture({ measure: async ({ ip }) => ({ ip, error: `HTTP 401: ${secret}` }) })
    const result = await h.invoke(route, { host, message: secret })
    await tick()
    const progress = await h.invoke('progress')
    const state = await h.invoke('state')
    assert.equal(JSON.stringify([result, progress, state, h.writes]).includes(secret), false)
    assert.equal(progress.value.progress.rows[0].runs[0].error, 'HTTP 401')
  }
})
