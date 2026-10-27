// Paid-IP budgets use synthetic discovery/streams only; no sockets or live state.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createResolver, normalizeConfig } from '../index.js'

const host = 'api.example.test'
const provider = { provider: 'p1', baseURL: `https://${host}/v1`, api: 'openai-completions' }
const candidates = Array.from({ length: 30 }, (_, index) => ({ ip: `203.0.113.${index + 1}`, rtt: 30 - index, colo: 'LAX' }))
const orderedIps = [...candidates].reverse().map((entry) => entry.ip)
const previousIp = orderedIps[0]
const sample = (ip) => ({ ip, status: 200, tps: 100, outputTokens: 100, usageReported: true,
  ttftMs: 100, totalMs: 1100, decodeMs: 1000 })

function fixture({ config = {}, entries = candidates, selected = previousIp, benchmarks = {}, measure, inspect } = {}) {
  const requests = [], inspections = [], lookups = [], writes = []
  const normalized = normalizeConfig({ dnsServers: [], scanEdges: false, ...config })
  const engine = createResolver(normalized, undefined, {
    readState: () => ({ hosts: { [host]: { hostname: host, provider: 'p1', selected,
      selectedSource: 'manual', candidates: structuredClone(entries), benchmarks: structuredClone(benchmarks) } } }),
    writeState: (value) => writes.push(structuredClone(value)),
    nativePromiseLookup: async () => { lookups.push(host); return [{ address: '203.0.113.1', family: 4 }] },
    inspectAll: async (ips) => {
      inspections.push([...ips])
      return inspect ? inspect(ips) : ips.map((ip, index) => ({ ip, rtt: index + 1 }))
    },
    measureStream: async (options) => { requests.push(options); return measure ? measure(options) : sample(options.ip) },
  })
  engine.setHosts([host], new Map([[host, ['p1']]]))
  const options = { provider, apiKey: 'fake-key', model: 'm1', message: 'fixture prompt', runs: 3, parallelism: 64 }
  return { engine, options, requests, inspections, lookups, writes, normalized }
}

const invalidLimits = [-1, 1.5, NaN, Infinity, -Infinity, '5', '', null, true, [], {}, Number.MAX_SAFE_INTEGER + 1]

test('IP limit defaults to all and accepts presets plus arbitrary non-negative safe integers', () => {
  assert.equal(normalizeConfig().maxBenchmarkIps, 0)
  for (const value of [0, 1, 5, 10, 20, 7, 5000, Number.MAX_SAFE_INTEGER]) {
    const config = normalizeConfig({ maxBenchmarkIps: value })
    assert.equal(config.maxBenchmarkIps, value)
    assert.equal(config.maxCandidates, 160, 'the paid-IP budget must not change discovery')
  }
  for (const value of invalidLimits) assert.equal(normalizeConfig({ maxBenchmarkIps: value }).maxBenchmarkIps, 0)
})

for (const limit of [undefined, 0, 1, 5, 10, 20, 7, 100, Number.MAX_SAFE_INTEGER]) {
  test(`limit ${String(limit)} caps unique IPs before concurrent launch, preserving equal rounds and progress`, async () => {
    const h = fixture({ config: { maxBenchmarkIps: limit } })
    const count = !limit ? candidates.length : Math.min(limit, candidates.length)
    const expected = orderedIps.slice(0, count)
    const result = await h.engine.benchmark(host, h.options)
    assert.equal(h.requests.length, count * 3)
    assert.deepEqual(h.requests.slice(0, count).map((entry) => entry.ip), expected, 'first round starts from the selected address, then the lowest ping')
    assert.deepEqual([...new Set(h.requests.map((entry) => entry.ip))], expected)
    for (const ip of expected) assert.equal(h.requests.filter((entry) => entry.ip === ip).length, 3)
    assert.equal(result.candidates.length, candidates.length, 'retain all discovered IPs in the panel')
    assert.equal(Object.keys(result.benchmarks).length, count)
    assert.equal(result.benchmarkContext.maxBenchmarkIps, limit ?? 0)
    assert.equal(h.engine.progress().timingTotal, count * 3)
    assert.equal(h.engine.progress().timing, count * 3)
    assert.deepEqual(h.engine.progress().rows.map((row) => row.ip), expected)
    assert.equal(result.applied, false)
    assert.equal(h.engine.activeAddressFor(host), previousIp)
  })
}

test('per-run override can narrow a saved limit or explicitly restore all without changing config', async () => {
  for (const limit of [2, 0]) {
    const h = fixture({ config: { maxBenchmarkIps: 5 } })
    const result = await h.engine.benchmark(host, { ...h.options, maxBenchmarkIps: limit })
    assert.equal(h.requests.length, (limit || candidates.length) * 3)
    assert.equal(h.engine.state().maxBenchmarkIps, 5)
    assert.equal(result.benchmarkContext.maxBenchmarkIps, limit)
  }
})

test('reconfiguration applies the new limit on the next benchmark', async () => {
  const h = fixture()
  h.engine.reconfigure(normalizeConfig({ ...h.normalized, maxBenchmarkIps: 7 }))
  await h.engine.benchmark(host, h.options)
  assert.equal(h.engine.state().maxBenchmarkIps, 7)
  assert.equal(h.requests.length, 7 * 3)
})

test('invalid per-run limits are rejected before discovery or a paid request', async () => {
  for (const limit of invalidLimits) {
    const h = fixture()
    const options = { ...h.options, maxBenchmarkIps: limit }
    await assert.rejects(h.engine.benchmark(host, options), /maxBenchmarkIps/)
    await assert.rejects(h.engine.autoOptimize(host, options), /maxBenchmarkIps/)
    assert.equal(h.requests.length, 0)
    assert.equal(h.lookups.length, 0)
    assert.equal(h.inspections.length, 0)
    assert.equal(h.writes.length, 0)
  }
})

test('limit is applied after an explicit subset and sorts missing/invalid RTTs last', async () => {
  const entries = [
    { ip: 'unknown' }, { ip: 'null', rtt: null }, { ip: 'nan', rtt: NaN },
    { ip: 'negative', rtt: -1 }, { ip: 'slow', rtt: 50 }, { ip: 'fast', rtt: 0 },
    { ip: 'excluded', rtt: 0 }, { ip: 'tied', rtt: 50 },
  ]
  const h = fixture({ config: { maxBenchmarkIps: 3 }, entries })
  await h.engine.benchmark(host, { ...h.options, only: entries.filter((entry) => entry.ip !== 'excluded').map((entry) => entry.ip) })
  assert.deepEqual(h.requests.slice(0, 3).map((entry) => entry.ip), ['fast', 'slow', 'tied'])
  assert.equal(h.requests.length, 9)
  assert.equal(entries[0].ip, 'unknown', 'sorting must not mutate caller input')
})

test('failed IPs consume slots and never backfill from slower candidates', async () => {
  const selected = candidates[0].ip
  const h = fixture({ config: { maxBenchmarkIps: 5 }, selected, measure: ({ ip }) => ({ ip, error: 'timeout' }) })
  const result = await h.engine.autoOptimize(host, { ...h.options, testOnly: false })
  // This fixture discovers only the selected IP: the cap is not a target to fill.
  assert.equal(h.requests.length, 3)
  assert.equal(result.benchmarkFailed, true)
  assert.equal(h.engine.activeAddressFor(host), selected)

  const full = fixture({ config: { maxBenchmarkIps: 5 }, measure: ({ ip }) => ({ ip, error: 'timeout' }) })
  await full.engine.benchmark(host, { ...full.options, testOnly: false })
  assert.equal(full.requests.length, 15)
  assert.deepEqual([...new Set(full.requests.map((entry) => entry.ip))], orderedIps.slice(0, 5))
  assert.equal(full.engine.activeAddressFor(host), previousIp)
})

test('a stale winner outside the budget is retained for display but cannot be recommended or applied', async () => {
  const oldWinner = candidates[0].ip
  const previous = { ip: oldWinner, scoringVersion: 1, rankEligible: true, stabilityScore: 99999, conservativeTps: 99999, samples: [{}] }
  const h = fixture({ config: { maxBenchmarkIps: 1 }, benchmarks: { [oldWinner]: previous } })
  const result = await h.engine.benchmark(host, { ...h.options, testOnly: false })
  assert.deepEqual(result.benchmarks[oldWinner], { ...previous, historical: true })
  assert.equal(result.recommended, orderedIps[0])
  assert.equal(result.selected, orderedIps[0])
  assert.equal(result.applied, true)
  assert.equal(h.requests.length, 3)
})

test('full discovery precedes the paid cap, ignores rejected IPs and near-colo preference', async () => {
  const h = fixture({ selected: candidates[0].ip, config: { maxBenchmarkIps: 7, scanEdges: true, preferNearEdges: true },
    inspect: (ips) => ips.length === 1
      ? [{ ip: ips[0], rtt: 1, colo: 'HKG' }]
      : ips.flatMap((ip, index) => index % 3 === 0 ? [] : [{ ip, rtt: index + 10, colo: index % 2 ? 'LAX' : 'HKG' }]),
  })
  const result = await h.engine.autoOptimize(host, h.options)
  assert.equal(h.inspections.length, 2)
  assert.equal(h.inspections[1].length, 160, 'do not truncate free discovery to the paid budget')
  assert.ok(result.candidates.length > 7)
  const expected = [...result.candidates].sort((a, b) => a.rtt - b.rtt).slice(0, 7).map((entry) => entry.ip)
  assert.deepEqual(h.requests.slice(0, 7).map((entry) => entry.ip), expected)
  assert.equal(h.requests.length, 21)
  assert.equal(Object.keys(result.benchmarks).length, 7)
  assert.equal(h.engine.progress().timingTotal, 21)
})
