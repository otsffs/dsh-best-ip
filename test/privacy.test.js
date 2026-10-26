// Synthetic canaries only. No live credentials, profiles, sockets or provider APIs.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, createResolver, normalizeConfig } from '../index.js'
import { sampleError } from '../bench.js'

const secret = 'PRIVATE_CANARY_DO_NOT_PERSIST'
const host = 'api.example.test', ip = '203.0.113.7'
const provider = { provider: 'p1', baseURL: `https://user:${secret}@${host}/${secret}?token=${secret}#${secret}`, api: 'openai-completions' }
const sample = { ip, tps: 100, outputTokens: 100, usageReported: true, ttftMs: 10, totalMs: 1010, decodeMs: 1000 }
function fixture({ context, measure, saveError = false } = {}) {
  const writes = [], warnings = []
  const engine = createResolver(normalizeConfig({ dnsServers: [], scanEdges: false }), { warn: (value) => warnings.push(value) }, {
    readState: () => ({ hosts: { [host]: { hostname: host, provider: 'p1', selected: ip,
      candidates: [{ ip, rtt: 10 }], benchmarks: {}, benchmarkContext: context } } }),
    writeState: (value) => { if (saveError) throw new Error(secret); writes.push(structuredClone(value)) },
    nativePromiseLookup: async () => [{ address: ip, family: 4 }],
    measureStream: measure ?? (async () => sample),
    inspectAll: async () => [{ ip, rtt: 10 }],
  })
  engine.setHosts([host], new Map([[host, ['p1']]]))
  const options = { provider, apiKey: secret, model: 'm1', message: secret, runs: 3 }
  return { engine, options, writes, warnings }
}
const safe = (value) => assert.equal(JSON.stringify(value).includes(secret), false)

test('test preloader prevents requiring schema modules from a live DSH profile', () => {
  assert.equal(process.env.DSH_BEST_IP_ISOLATED_TESTS, '1')
  assert.equal(Config, undefined)
})

test('fresh benchmark context stores only origin and non-secret numeric/model metadata', async () => {
  const h = fixture()
  const result = await h.engine.benchmark(host, h.options)
  assert.deepEqual(result.benchmarkContext, { provider: 'p1', model: 'm1', endpointOrigin: `https://${host}`,
    maxTokens: 256, runs: 3, maxBenchmarkIps: 0 })
  safe([result, h.engine.findings(), h.engine.progress(), h.engine.lastRun(), h.writes])
})

test('legacy context is allowlisted on load, display and the next explicit write', () => {
  for (const urlField of ['baseURL', 'endpointOrigin']) {
    const h = fixture({ context: { provider: 'p1', model: 'm1', [urlField]: provider.baseURL,
      message: secret, apiKey: secret, unknown: { password: secret }, runs: 3, maxTokens: 256 } })
    assert.deepEqual(h.engine.findings()[0].benchmarkContext, { provider: 'p1', model: 'm1', runs: 3, maxTokens: 256, endpointOrigin: `https://${host}` })
    assert.equal(h.writes.length, 0, 'privacy cleanup must not eagerly write live state')
    h.engine.select(host, ip, { provider, testOnly: false })
    safe([h.engine.findings(), h.writes])
  }
  for (const context of [null, [], secret, { baseURL: secret, message: secret, unknown: secret }]) {
    const h = fixture({ context })
    safe(h.engine.findings())
  }
})

for (const [failure, category] of [
  [`HTTP 401: ${secret}`, 'HTTP 401'], [`stream error: ${secret}`, 'stream error'],
  [`ECONNRESET: ${secret}`, 'ECONNRESET'], [secret, 'request failed'],
]) {
  test(`progress and retained outcomes classify ${category} without provider error text`, async () => {
    const h = fixture({ measure: async () => ({ ip, error: failure }) })
    const result = await h.engine.benchmark(host, h.options)
    assert.equal(h.engine.progress().rows[0].runs[0].error, category)
    safe([result, h.engine.progress(), h.engine.lastRun(), h.engine.findings(), h.writes])
    await h.engine.timeSelected(host, h.options)
    assert.equal(h.engine.progress().rows[0].runs[0].error, category)
    safe([h.engine.progress(), h.engine.lastRun()])
    assert.equal(sampleError({ error: category }), category, 'safe classification is idempotent')
  })
}

test('stream exceptions and storage exceptions cannot place secrets in progress, results or logs', async () => {
  const h = fixture({ measure: async () => { throw new Error(secret) }, saveError: true })
  const result = await h.engine.benchmark(host, h.options)
  assert.ok(result.saveError)
  assert.ok(h.warnings.length > 0)
  safe([result, h.engine.progress(), h.engine.lastRun(), h.warnings])
})
