// Saved-address comparison is explicit, provider-scoped and fully offline.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createResolver, normalizeConfig } from '../index.js'

const host = 'api.example.test'
const provider = { provider: 'p1', baseURL: `https://${host}:8443/custom/v1`, api: 'openai-completions' }
const pinned = '203.0.113.9'
const ips = ['203.0.113.1', '203.0.113.2', '203.0.113.3']
const candidate = (ip, rtt = 10) => ({ ip, rtt, colo: 'TEST' })
const sample = (ip) => Object.freeze({ ip, status: 200, tps: ip === pinned ? 90 : 120,
  usageReported: true, outputTokens: 100, ttftMs: 100, decodeMs: 1000, totalMs: 1100 })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

function fixture({ selected = pinned, dns = ips.slice(0, 2), entries = ips.slice(0, 2).map((ip) => candidate(ip)),
  records, lookup, inspect, measure, config = {} } = {}) {
  const inspections = [], requests = [], writes = []
  const initial = records ?? [{ hostname: host, provider: 'p1', candidates: entries,
    selected, selectedSource: 'manual', benchmarks: {} }]
  const engine = createResolver(normalizeConfig({ dnsServers: [], scanEdges: false, ...config }), undefined, {
    readState: () => ({ hosts: Object.fromEntries(initial.map((row, index) => [index, structuredClone(row)])) }),
    writeState: (state) => writes.push(structuredClone(state)),
    nativePromiseLookup: lookup ?? (async () => {
      if (dns instanceof Error) throw dns
      return dns.map((address) => ({ address, family: 4 }))
    }),
    inspectAll: async (addresses, hostname, options) => {
      inspections.push({ addresses: [...addresses], hostname, options })
      return inspect ? inspect(addresses, hostname, options) : addresses.map((ip) => candidate(ip, ip === pinned ? 999 : 10))
    },
    measureStream: async (options) => { requests.push(options); return measure ? measure(options) : sample(options.ip) },
  })
  engine.setHosts([host], new Map([[host, ['p1']]]))
  const options = { provider, apiKey: 'fake-key', message: 'offline fixture', model: 'm1', runs: 3, parallelism: 1 }
  return { engine, options, inspections, requests, writes }
}
const count = (h, ip) => h.requests.filter((request) => request.ip === ip).length

test('automatic discovery rechecks the saved address even when DNS and random edge sampling omit it', async () => {
  const h = fixture({ config: { scanEdges: true, maxCandidates: 8 } })
  const result = await h.engine.autoOptimize(host, h.options)
  assert.equal(h.inspections.length, 2)
  assert.equal(h.inspections[0].addresses.filter((ip) => ip === pinned).length, 1)
  assert.equal(h.inspections[1].addresses.includes(pinned), false)
  assert.equal(h.inspections[0].hostname, host)
  assert.equal(h.inspections[0].options.port, 8443)
  assert.equal(h.inspections[0].options.apiPath, '/custom/v1/models')
  assert.equal(h.requests[0].ip, pinned, 'current route is the first real-request baseline')
  assert.equal(count(h, pinned), 3)
  assert.equal(result.candidates.filter((row) => row.ip === pinned).length, 1)
  assert.equal(result.benchmarks[pinned].historical, false)
  assert.equal(result.benchmarks[pinned].confirmed, true)
  assert.deepEqual(result.benchmarks[pinned].samples.map((row) => row.tps), [90, 90, 90])
  assert.equal(result.benchmarks[pinned].scoreContext.scoringVersion, 2)
  assert.equal(result.benchmarks[pinned].scoreContext.peerCount, result.candidates.length)
  assert.equal(result.applied, false)
  assert.equal(h.engine.activeAddressFor(host), pinned)
})

test('the baseline reserves a paid slot inside limits including one, without exceeding the request budget', async () => {
  for (const limit of [0, 1, 2]) {
    const h = fixture({ entries: ips.map((ip, index) => candidate(ip, index + 1)), config: { maxBenchmarkIps: limit } })
    const result = await h.engine.benchmark(host, h.options)
    const expected = limit === 0 ? [pinned, ...ips] : [pinned, ...ips.slice(0, limit - 1)]
    assert.deepEqual([...new Set(h.requests.map((request) => request.ip))], expected)
    assert.equal(h.requests.length, expected.length * 3)
    assert.equal(h.engine.progress().timingTotal, expected.length * 3)
    assert.equal(result.candidates.length, 4)
    assert.equal(result.benchmarkContext.maxBenchmarkIps, limit)
    for (const ip of expected) assert.equal(count(h, ip), 3)
    assert.equal(h.engine.activeAddressFor(host), pinned)
  }
})

test('an already discovered saved IP is probed and benchmarked once per round, never duplicated', async () => {
  const h = fixture({ dns: [pinned, ips[0], pinned], entries: [candidate(pinned, 999), candidate(pinned, 100), candidate(ips[0])] })
  const result = await h.engine.autoOptimize(host, h.options)
  assert.equal(h.inspections.flatMap((entry) => entry.addresses).filter((ip) => ip === pinned).length, 1)
  assert.equal(result.candidates.filter((row) => row.ip === pinned).length, 1)
  assert.equal(h.requests.length, 6)
  assert.equal(count(h, pinned), 3)
  const bare = fixture({ entries: [candidate(pinned, 999), candidate(pinned, 100), candidate(ips[0])] })
  const timed = await bare.engine.benchmark(host, bare.options)
  assert.equal(timed.candidates.filter((row) => row.ip === pinned).length, 1)
  assert.equal(count(bare, pinned), 3)
  assert.equal(bare.requests.length, 6)
})

test('DNS failure does not prevent testing an explicitly saved baseline, but no baseline still means no guessing', async () => {
  const h = fixture({ dns: new Error('synthetic DNS failure') })
  const result = await h.engine.autoOptimize(host, h.options)
  assert.deepEqual(h.inspections[0].addresses, [pinned])
  assert.deepEqual([...new Set(h.requests.map((request) => request.ip))], [pinned])
  assert.equal(result.recommended, pinned)
  assert.equal(result.benchmarkFailed, false)
  assert.equal(h.engine.activeAddressFor(host), pinned)
  const empty = fixture({ selected: undefined, records: [{ hostname: host, provider: 'p1', candidates: [], benchmarks: {} }], dns: [] })
  const missing = await empty.engine.autoOptimize(host, empty.options)
  assert.equal(empty.requests.length, 0)
  assert.equal(empty.inspections.length, 0)
  assert.equal(missing.reasonCode, 'NO_USABLE_IP')
})

test('a rejected free probe preserves only the saved baseline for a genuine API diagnostic', async () => {
  const h = fixture({ inspect: (addresses) => addresses.filter((ip) => ip !== pinned && ip !== ips[1]).map((ip) => candidate(ip)) })
  const result = await h.engine.autoOptimize(host, h.options)
  assert.equal(count(h, pinned), 3)
  assert.equal(count(h, ips[1]), 0, 'a rejected unselected DNS address is not promoted')
  const baseline = result.candidates.find((row) => row.ip === pinned)
  assert.equal(baseline.rtt, undefined, 'never invent a successful probe or RTT')
  assert.equal(baseline.colo, 'unknown')
  assert.equal(result.benchmarks[pinned].confirmed, true)
  const failed = fixture({ dns: [], inspect: () => [], measure: ({ ip }) => ({ ip, error: 'timeout' }) })
  const failure = await failed.engine.autoOptimize(host, { ...failed.options, testOnly: false })
  assert.equal(count(failed, pinned), 3)
  assert.equal(failure.benchmarks[pinned].failed, 3)
  assert.equal(failure.applied, false)
  assert.equal(failed.engine.activeAddressFor(host), pinned)
})

test('explicit only scopes remain authoritative, including when explicitly requesting the missing saved IP', async () => {
  const excluded = fixture()
  const result = await excluded.engine.benchmark(host, { ...excluded.options, only: [ips[0]], maxBenchmarkIps: 1 })
  assert.equal(count(excluded, pinned), 0)
  assert.equal(excluded.requests.length, 3)
  assert.equal(result.recommended, ips[0])
  assert.equal(excluded.engine.activeAddressFor(host), pinned)
  const included = fixture()
  const current = await included.engine.benchmark(host, { ...included.options, only: [pinned], maxBenchmarkIps: 1 })
  assert.equal(included.requests.length, 3)
  assert.equal(current.recommended, pinned)
  assert.equal(current.candidates.some((row) => row.ip === pinned), true)
  const empty = fixture()
  await empty.engine.benchmark(host, { ...empty.options, only: [] })
  assert.equal(empty.requests.length, 0)
})

test('recommendations and selected addresses belonging to another provider or host cannot become this baseline', async () => {
  const records = [
    { hostname: host, provider: 'p1', candidates: [candidate(ips[0])], recommended: pinned, benchmarks: {} },
    { hostname: host, provider: 'p2', candidates: [], selected: '203.0.113.8', benchmarks: {} },
    { hostname: 'other.example.test', provider: 'p1', candidates: [], selected: '203.0.113.7', benchmarks: {} },
  ]
  const h = fixture({ records, dns: [ips[0]] })
  const result = await h.engine.autoOptimize(host, h.options)
  assert.deepEqual([...new Set(h.requests.map((request) => request.ip))], [ips[0]])
  assert.equal(result.selected, undefined)
  assert.deepEqual(h.inspections[0].addresses, [ips[0]])
  assert.equal(h.engine.findings().find((row) => row.provider === 'p2').selected, '203.0.113.8')
})

test('stopping while the saved address is being measured never launches queued alternatives or applies a result', async () => {
  const entered = deferred(), late = deferred()
  const h = fixture({ measure: () => { entered.resolve(); return late.promise } })
  const running = h.engine.autoOptimize(host, { ...h.options, testOnly: false })
  await entered.promise
  assert.equal(h.requests[0].ip, pinned)
  h.engine.stop(h.engine.progress().runId)
  const result = await running
  assert.equal(h.requests.length, 1)
  assert.equal(result.stopped, true)
  assert.equal(result.applied, false)
  assert.equal(h.engine.activeAddressFor(host), pinned)
  assert.equal(result.benchmarks[pinned].samples[0].cancelled, true)
  assert.equal(result.benchmarks[pinned].failed, 0)
  const before = JSON.stringify(h.engine.findings())
  late.resolve(sample(pinned))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(JSON.stringify(h.engine.findings()), before)
})

test('cancelling DNS preserves the previous candidates and measurements instead of clearing the saved baseline snapshot', async () => {
  const entered = deferred(), pending = deferred()
  const candidates = ips.slice(0, 2).map((ip) => candidate(ip))
  const oldMeasurement = { ip: ips[0], tps: 120, runs: 3, samples: [{ tps: 120 }] }
  const benchmarks = { [ips[0]]: oldMeasurement }
  const records = [{ hostname: host, provider: 'p1', selected: pinned, selectedSource: 'manual',
    candidates, benchmarks, probedAt: 123 }]
  const h = fixture({ records, lookup: () => { entered.resolve(); return pending.promise } })
  const running = h.engine.autoOptimize(host, { ...h.options, testOnly: false })
  await entered.promise
  h.engine.stop(h.engine.progress().runId)
  const result = await running
  assert.equal(result.stopped, true)
  assert.equal(result.applied, false)
  assert.equal(h.requests.length, 0)
  assert.equal(h.inspections.length, 0)
  assert.deepEqual(result.candidates, candidates)
  assert.deepEqual(result.benchmarks, benchmarks)
  assert.equal(result.probedAt, 123)
  assert.equal(h.engine.activeAddressFor(host), pinned)
  const saved = Object.values(h.writes.at(-1).hosts)[0]
  assert.deepEqual(saved.candidates, candidates)
  assert.deepEqual(saved.benchmarks, benchmarks)
  const before = JSON.stringify(h.engine.findings())
  pending.resolve([])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(JSON.stringify(h.engine.findings()), before)
})

test('only an explicit successful apply may replace the saved address after comparing it', async () => {
  const h = fixture()
  const result = await h.engine.autoOptimize(host, { ...h.options, testOnly: false })
  assert.equal(count(h, pinned), 3)
  assert.equal(result.applied, true)
  assert.notEqual(result.selected, pinned)
  assert.equal(h.engine.activeAddressFor(host), result.recommended)
})
