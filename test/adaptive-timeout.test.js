// Entirely offline: real resolver/config/scoring, synthetic streams and in-memory state only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createResolver, normalizeConfig } from '../index.js'
import { summarize } from '../bench.js'

const host = 'api.example.test'
const provider = { provider: 'p1', baseURL: `https://${host}/v1`, api: 'openai-completions' }
const ips = Array.from({ length: 16 }, (_, index) => `203.0.113.${index + 1}`)
const previousIp = ips[0]
const healthy = (ip, overrides = {}) => ({ ip, status: 200, tps: 100, outputTokens: 100,
  usageReported: true, ttftMs: 100, totalMs: 1100, decodeMs: 1000, ...overrides })
const failure = (ip, error = 'timeout') => ({ ip, error })

function fixture({ config = {}, count = 5, selected = previousIp, benchmarks = {}, measure } = {}) {
  const requests = [], outputs = [], writes = [], counts = new Map()
  const entries = ips.slice(0, count).map((ip, index) => ({ ip, rtt: index + 1, colo: 'LAX' }))
  let state = { hosts: { [host]: { hostname: host, provider: 'p1', selected,
    selectedSource: 'manual', candidates: [...entries].reverse(), benchmarks: structuredClone(benchmarks) } } }
  // Isolate deadline adaptation from final-round request elimination.
  const normalized = normalizeConfig({ dnsServers: [], scanEdges: false, adaptiveBenchmarkSampling: false, ...config })
  const engine = createResolver(normalized, undefined, {
    readState: () => structuredClone(state),
    writeState: (value) => { state = structuredClone(value); writes.push(structuredClone(value)) },
    nativePromiseLookup: async () => { throw new Error('unexpected DNS lookup') },
    nativeLookup: () => { throw new Error('unexpected callback DNS lookup') },
    inspectAll: async () => { throw new Error('unexpected discovery') },
    measureStream: async (options) => {
      const round = counts.get(options.ip) ?? 0
      counts.set(options.ip, round + 1)
      requests.push({ ...options, round })
      const value = Object.freeze(measure ? measure(options, round) : healthy(options.ip))
      outputs.push({ ip: options.ip, value, snapshot: structuredClone(value) })
      return value
    },
  })
  engine.setHosts([host], new Map([[host, ['p1']]]))
  const options = { provider, apiKey: 'fake-key', model: 'm1', message: 'offline timeout fixture', runs: 3, parallelism: 64 }
  return { engine, options, normalized, requests, outputs, writes, state: () => state }
}

const timeouts = (h, ip) => h.requests.filter((request) => request.ip === ip).map((request) => request.timeout)
const withoutTimeout = (samples) => samples.map(({ timeoutMs, ...sample }) => sample)
function assertRecorded(h, result, selected = ips.slice(0, 5)) {
  for (const ip of selected) {
    const expected = timeouts(h, ip)
    assert.deepEqual(result.benchmarks[ip].samples.map((sample) => sample.timeoutMs), expected, `saved timeouts for ${ip}`)
    assert.deepEqual(h.engine.progress().rows.find((row) => row.ip === ip).runs.map((run) => run.timeoutMs), expected, `progress timeouts for ${ip}`)
  }
  for (const { value, snapshot } of h.outputs) {
    assert.deepEqual(value, snapshot, 'the injected raw sample must not be changed')
    assert.equal(Object.hasOwn(value, 'timeoutMs'), false, 'timeout metadata belongs on a copy')
  }
}

function healthyMajority({ ip }) {
  return ips.indexOf(ip) < 3 ? healthy(ip, { tps: 100 + ips.indexOf(ip) * 20 }) : failure(ip)
}

test('timeout config accepts only bounded safe integer numbers and literal booleans', () => {
  assert.equal(normalizeConfig().benchmarkTimeoutMs, 60000)
  assert.equal(normalizeConfig().adaptiveBenchmarkTimeout, true)
  for (const value of [1000, 1001, 60000, 300000]) {
    assert.equal(normalizeConfig({ benchmarkTimeoutMs: value }).benchmarkTimeoutMs, value)
  }
  for (const value of [undefined, null, 0, -1, 999, 300001, 1000.5, NaN, Infinity, -Infinity,
    '1000', '60000', true, false, [], {}, Number.MAX_SAFE_INTEGER + 1, 60000n, new Number(60000)]) {
    assert.equal(normalizeConfig({ benchmarkTimeoutMs: value }).benchmarkTimeoutMs, 60000, `invalid timeout ${String(value)}`)
  }
  for (const value of [true, false]) assert.equal(normalizeConfig({ adaptiveBenchmarkTimeout: value }).adaptiveBenchmarkTimeout, value)
  for (const value of [undefined, null, 0, 1, 'true', 'false', [], {}, new Boolean(false)]) {
    assert.equal(normalizeConfig({ adaptiveBenchmarkTimeout: value }).adaptiveBenchmarkTimeout, true)
  }
  const h = fixture()
  assert.equal(h.engine.state().benchmarkTimeoutMs, 60000)
  assert.equal(h.engine.state().adaptiveBenchmarkTimeout, true)
})

test('exactly three healthy peers out of five shorten only timeout retries, never 60->30->15', async () => {
  const h = fixture({ measure: ({ ip }) => ips.indexOf(ip) < 3
    ? healthy(ip, { tps: 100 + ips.indexOf(ip) * 20 })
    : failure(ip, ip === ips[3] ? 'timeout' : 'ETIMEDOUT: synthetic deadline') })
  const result = await h.engine.benchmark(host, h.options)
  for (const ip of ips.slice(0, 3)) assert.deepEqual(timeouts(h, ip), [60000, 60000, 60000])
  for (const ip of ips.slice(3, 5)) assert.deepEqual(timeouts(h, ip), [60000, 30000, 30000])
  assert.equal(h.requests.length, 15)
  for (let round = 0; round < 3; round++) {
    const selected = ips.slice(0, 5)
    assert.deepEqual(h.requests.slice(round * 5, (round + 1) * 5).map((entry) => entry.ip),
      round === 0 ? selected : [selected[2], selected[1], selected[0], selected[3], selected[4]],
      'first explore the selected address and RTT peers, then prioritize the shared v2 score')
  }
  for (const ip of ips.slice(0, 5)) {
    const actual = result.benchmarks[ip]
    const expected = summarize(h.outputs.filter((output) => output.ip === ip).map((output) => output.snapshot),
      { plannedRuns: 3, scoringContext: actual.scoreContext })
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(key === 'samples' ? withoutTimeout(actual[key]) : actual[key],
        key === 'samples' ? withoutTimeout(value) : value, `timeout metadata must not change scoring: ${key}`)
    }
  }
  assertRecorded(h, result)
  assert.equal(result.recommended, ips[2], 'scoring still chooses throughput rather than RTT')
  assert.equal(result.testOnly, true)
  assert.equal(result.applied, false)
  assert.equal(result.selected, previousIp)
  assert.equal(result.selectedSource, 'manual')
  assert.equal(h.engine.activeAddressFor(host), previousIp)
  assert.equal(Object.values(h.state().hosts)[0].selected, previousIp)
})

test('unhealthy rounds, minority successes and fewer than three trusted successes keep base', async () => {
  const cases = [
    { name: 'all time out', count: 5, good: 0 },
    { name: 'three successes are only half the candidates', count: 6, good: 3 },
    { name: 'two of three is a majority but not three peers', count: 3, good: 2 },
    { name: 'short tokens', count: 5, good: 3, overrides: { outputTokens: 31 } },
    { name: 'short decode window', count: 5, good: 3, overrides: { decodeMs: 199 } },
    { name: 'missing usage', count: 5, good: 3, overrides: { usageReported: false } },
  ]
  for (const entry of cases) {
    const h = fixture({ count: entry.count, measure: ({ ip }) => ips.indexOf(ip) < entry.good
      ? healthy(ip, entry.overrides) : failure(ip) })
    const result = await h.engine.benchmark(host, h.options)
    assert.ok(h.requests.every((request) => request.timeout === 60000), entry.name)
    assert.equal(h.requests.length, entry.count * 3, entry.name)
    assertRecorded(h, result, ips.slice(0, entry.count))
  }
})

test('trusted samples also require finite non-negative totalMs before contributing healthy peers', async () => {
  for (const totalMs of [undefined, null, NaN, Infinity, -Infinity, -1, '1100']) {
    assert.equal(summarize([healthy(ips[0], { totalMs })]).reliableRuns, 1, 'isolate the additional totalMs requirement')
    const h = fixture({ measure: ({ ip }) => ips.indexOf(ip) < 3
      ? healthy(ip, ip === ips[0] ? { totalMs } : {}) : failure(ip) })
    await h.engine.benchmark(host, h.options)
    assert.ok(h.requests.every((request) => request.timeout === 60000), `invalid totalMs ${String(totalMs)}`)
  }
})

test('retry budget uses sorted nearest-rank P90, ceiling and the fixed base half/full bounds', async () => {
  for (const { durations, expected } of [
    { durations: [0, 0, 0], expected: 30000 },
    { durations: [22000, 1100, 2000], expected: 44000 },
    { durations: [40000, 1100, 2000], expected: 60000 },
    { durations: [22000.25, 1100, 2000], expected: 44001 },
    { durations: [40000, 22000, ...Array(9).fill(1100)], expected: 44000 },
  ]) {
    const count = durations.length + 1
    const h = fixture({ count, measure: ({ ip }) => ips.indexOf(ip) < durations.length
      ? healthy(ip, { totalMs: durations[ips.indexOf(ip)] }) : failure(ip) })
    const result = await h.engine.benchmark(host, { ...h.options, runs: 2 })
    assert.deepEqual(timeouts(h, ips[count - 1]), [60000, expected], `P90 durations ${durations}`)
    for (const ip of ips.slice(0, durations.length)) assert.deepEqual(timeouts(h, ip), [60000, 60000])
    assertRecorded(h, result, ips.slice(0, count))
  }
})

test('the immediately preceding round alone controls retries and global degradation restores base', async () => {
  const h = fixture({ measure: ({ ip }, round) => round !== 1 && ips.indexOf(ip) < 3 ? healthy(ip) : failure(ip) })
  const result = await h.engine.benchmark(host, h.options)
  for (const ip of ips.slice(0, 3)) assert.deepEqual(timeouts(h, ip), [60000, 60000, 60000])
  for (const ip of ips.slice(3, 5)) assert.deepEqual(timeouts(h, ip), [60000, 30000, 60000])
  assertRecorded(h, result)
})

test('success or non-timeout errors clear a previous timeout; HTTP 429 and ECONNRESET never qualify', async () => {
  const errors = [
    ['timeout', undefined, 'timeout', 'HTTP 429: synthetic rate limit', 'timeout'],
    ['ETIMEDOUT: synthetic deadline', 'ECONNRESET: synthetic reset', 'HTTP 429', 'timeout', 'ETIMEDOUT'],
  ]
  const h = fixture({ measure: ({ ip }, round) => {
    const index = ips.indexOf(ip)
    if (index < 3 || errors[index - 3][round] === undefined) return healthy(ip)
    return failure(ip, errors[index - 3][round])
  } })
  const result = await h.engine.benchmark(host, { ...h.options, runs: 5 })
  assert.deepEqual(timeouts(h, ips[3]), [60000, 30000, 60000, 30000, 60000])
  assert.deepEqual(timeouts(h, ips[4]), [60000, 30000, 60000, 60000, 30000])
  assertRecorded(h, result)
})

test('disabled adaptation, custom odd base and reconfiguration apply on the next operation', async () => {
  const h = fixture({ config: { benchmarkTimeoutMs: 90001, adaptiveBenchmarkTimeout: false }, measure: healthyMajority })
  assert.equal(h.engine.state().benchmarkTimeoutMs, 90001)
  assert.equal(h.engine.state().adaptiveBenchmarkTimeout, false)
  await h.engine.benchmark(host, h.options)
  assert.ok(h.requests.every((request) => request.timeout === 90001))
  h.engine.reconfigure(normalizeConfig({ ...h.normalized, benchmarkTimeoutMs: 80001, adaptiveBenchmarkTimeout: true }))
  assert.equal(h.engine.state().benchmarkTimeoutMs, 80001)
  assert.equal(h.engine.state().adaptiveBenchmarkTimeout, true)
  const start = h.requests.length
  const result = await h.engine.benchmark(host, h.options)
  for (const ip of ips.slice(0, 5)) {
    const expected = ips.indexOf(ip) < 3 ? [80001, 80001, 80001] : [80001, 40001, 40001]
    assert.deepEqual(h.requests.slice(start).filter((request) => request.ip === ip).map((request) => request.timeout), expected)
    assert.deepEqual(result.benchmarks[ip].samples.map((sample) => sample.timeoutMs), expected)
  }
  assert.equal(h.engine.activeAddressFor(host), previousIp)
})

test('only the current selected set counts: excluded/capped IPs and stale records cannot contaminate health', async () => {
  const benchmarks = Object.fromEntries(ips.slice(0, 8).map((ip) => [ip,
    { ...summarize([healthy(ip), healthy(ip), healthy(ip)]), ip }]))
  for (const { good, only, limit, selected, expected } of [
    { good: 3, only: ips.slice(0, 5), limit: 0, selected: 5, expected: 30000 },
    { good: 0, only: ips.slice(0, 5), limit: 0, selected: 5, expected: 60000 },
    { good: 2, only: undefined, limit: 3, selected: 3, expected: 60000 },
  ]) {
    const h = fixture({ count: 8, benchmarks, config: { maxBenchmarkIps: limit }, measure: ({ ip }) =>
      ips.indexOf(ip) < good ? healthy(ip) : failure(ip) })
    const result = await h.engine.benchmark(host, { ...h.options, only, runs: 2 })
    assert.equal(h.requests.length, selected * 2)
    assert.deepEqual([...new Set(h.requests.map((request) => request.ip))], ips.slice(0, selected))
    assert.deepEqual(timeouts(h, ips[selected - 1]), [60000, expected])
    assert.deepEqual(result.benchmarks[ips[7]], { ...benchmarks[ips[7]], historical: true }, 'unselected history remains display-only')
    assertRecorded(h, result, ips.slice(0, selected))
  }
  const h = fixture({ measure: (options, round) => round < 2 ? healthyMajority(options) : failure(options.ip) })
  await h.engine.benchmark(host, { ...h.options, runs: 2 })
  assert.deepEqual(timeouts(h, ips[4]), [60000, 30000])
  const result = await h.engine.benchmark(host, { ...h.options, runs: 2 })
  assert.deepEqual(timeouts(h, ips[4]), [60000, 30000, 60000, 60000], 'no adaptive state leaks between benchmarks')
  assert.deepEqual(result.benchmarks[ips[4]].samples.map((sample) => sample.timeoutMs), [60000, 60000])
})

test('timeSelected has no peers and always uses the configured base, recording every timeout without writes', async () => {
  const timedIp = '203.0.113.250'
  const h = fixture({ selected: timedIp, config: { benchmarkTimeoutMs: 90001 }, measure: (options, round) => {
    if (options.ip !== timedIp) return healthyMajority(options)
    return round === 1 ? healthy(options.ip) : failure(options.ip, round === 2 ? 'ETIMEDOUT' : 'timeout')
  } })
  await h.engine.benchmark(host, { ...h.options, only: ips.slice(0, 5) })
  assert.deepEqual(timeouts(h, ips[4]), [90001, 45001, 45001])
  assert.deepEqual(timeouts(h, timedIp), [], 'the peer benchmark explicitly excludes the current address')
  const writesBefore = h.writes.length
  const result = await h.engine.timeSelected(host, { ...h.options, runs: 5 })
  assert.equal(result.ip, timedIp)
  assert.equal(result.applied, false)
  assert.deepEqual(timeouts(h, timedIp), Array(5).fill(90001))
  assert.deepEqual(result.summary.samples.map((sample) => sample.timeoutMs), Array(5).fill(90001))
  assert.deepEqual(h.engine.progress().rows[0].runs.map((run) => run.timeoutMs), Array(5).fill(90001))
  assert.equal(h.writes.length, writesBefore)
  assert.equal(h.engine.activeAddressFor(host), timedIp)
  for (const { value, snapshot } of h.outputs) assert.deepEqual(value, snapshot)
})
