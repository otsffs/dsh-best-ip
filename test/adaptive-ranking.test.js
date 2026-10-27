// Adaptive ranking exercises the real engine with synthetic streams and memory-only state.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createResolver, normalizeConfig, orderCandidates } from '../index.js'
import { buildScoringContext, optimisticScore, SCORING_VERSION } from '../bench.js'

const host = 'api.example.test'
const provider = { provider: 'p1', baseURL: `https://${host}/v1`, api: 'openai-completions' }
const ips = Array.from({ length: 6 }, (_, index) => `203.0.113.${index + 1}`)
const oldIp = ips[0]
const good = (ip, tps = 100) => ({ ip, status: 200, tps, outputTokens: 100,
  usageReported: true, ttftMs: 100, decodeMs: 1000, totalMs: 1100 })
const bad = (ip) => ({ ip, error: 'timeout' })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

function fixture({ count = 5, measure, lookup, inspect, config = {}, benchmarks = {} } = {}) {
  const calls = [], writes = [], seen = new Map(), snapshots = []
  const candidates = ips.slice(0, count).map((ip, index) => ({ ip, rtt: index + 1, colo: 'TEST' }))
  const engine = createResolver(normalizeConfig({ dnsServers: [], scanEdges: false, ...config }), undefined, {
    readState: () => ({ hosts: { [host]: { hostname: host, provider: 'p1', candidates,
      selected: oldIp, selectedSource: 'manual', benchmarks } } }),
    writeState: (state) => writes.push(structuredClone(state)),
    measureStream: async (options) => {
      const round = seen.get(options.ip) ?? 0
      seen.set(options.ip, round + 1)
      calls.push({ ip: options.ip, round, timeout: options.timeout })
      snapshots.push(structuredClone(engine.progress()))
      return measure ? measure(options, round) : good(options.ip)
    },
    nativePromiseLookup: lookup ?? (async () => { throw new Error('unexpected DNS') }),
    inspectAll: inspect ?? (async () => { throw new Error('unexpected discovery') }),
  })
  engine.setHosts([host], new Map([[host, ['p1']]]))
  const options = { provider, apiKey: 'fixture-key', message: 'fixture', model: 'm1', runs: 3, parallelism: 1 }
  return { engine, options, calls, writes, snapshots, candidates }
}

const routeCalls = (h, ip) => h.calls.filter((entry) => entry.ip === ip)

test('first round starts at the selected RTT leader, later rounds prioritize scores and publish one shared context', async () => {
  const h = fixture({ measure: ({ ip }) => good(ip, 100 + ips.indexOf(ip) * 20) })
  const result = await h.engine.benchmark(host, h.options)
  assert.deepEqual(h.calls.filter((entry) => entry.round === 0).map((entry) => entry.ip), ips.slice(0, 5))
  assert.deepEqual(h.calls.filter((entry) => entry.round === 1).map((entry) => entry.ip), ips.slice(0, 5).reverse())
  assert.deepEqual(h.calls.filter((entry) => entry.round === 2).map((entry) => entry.ip), ips.slice(0, 5).reverse())
  const progress = h.engine.progress()
  assert.equal(progress.round, 3)
  assert.equal(progress.rounds, 3)
  assert.equal(progress.timing, 15)
  assert.equal(progress.skipped, 0)
  assert.equal(progress.leading, ips[4])
  assert.deepEqual(progress.rows.map((row) => row.ip), ips.slice(0, 5).reverse())
  for (const row of progress.rows) {
    assert.equal(row.summary.scoringVersion, SCORING_VERSION)
    assert.equal(row.summary.confirmed, true)
    assert.deepEqual(row.summary.scoreContext, result.scoringContext)
  }
  assert.equal(result.recommended, ips[4])
  assert.equal(h.engine.activeAddressFor(host), oldIp)
})

test('confirmed leader prunes two-failure tails without inventing a third failed sample', async () => {
  const h = fixture({ measure: ({ ip }) => ips.indexOf(ip) < 3 ? good(ip, 180 + ips.indexOf(ip) * 10) : bad(ip) })
  const result = await h.engine.benchmark(host, h.options)
  assert.equal(h.calls.length, 13)
  assert.equal(h.calls[10].ip, ips[2], 'leader is confirmed before tail requests are considered')
  for (const ip of ips.slice(3, 5)) {
    const row = result.benchmarks[ip]
    assert.equal(routeCalls(h, ip).length, 2)
    assert.equal(row.samples.length, 2)
    assert.equal(row.failed, 2)
    assert.equal(row.skippedRuns, 1)
    assert.equal(row.pendingRuns, 0)
    assert.equal(row.plannedRuns, 3)
    assert.equal(row.eliminated, true)
    assert.equal(row.confirmed, false)
    assert.equal(row.skippedReason, 'optimistic-bound')
    assert.ok(row.optimisticBound < result.benchmarks[result.recommended].stabilityScore * 0.95)
  }
  assert.equal(h.engine.progress().timing + h.engine.progress().skipped, 15)
  assert.equal(h.engine.progress().skipped, 2)
  assert.deepEqual(h.engine.progress().rows.slice(-2).map((row) => row.ip), ips.slice(3, 5))
})

test('a slow successful attempt plus failure can be pruned, but healthy slower routes still receive confirmation', async () => {
  const h = fixture({ measure: ({ ip }, round) => {
    if (ip === ips[3]) return round === 0 ? good(ip, 20) : bad(ip)
    if (ip === ips[4]) return good(ip, 30)
    return good(ip, 200)
  } })
  const result = await h.engine.benchmark(host, h.options)
  assert.equal(routeCalls(h, ips[3]).length, 2)
  assert.equal(result.benchmarks[ips[3]].skippedRuns, 1)
  assert.equal(routeCalls(h, ips[4]).length, 3)
  assert.equal(result.benchmarks[ips[4]].confirmed, true)
})

test('all two-failure routes retain their third opportunity; one recovery is provisional and never applied', async () => {
  const h = fixture({ measure: ({ ip }, round) => round < 2 ? bad(ip) : good(ip, 100 + ips.indexOf(ip) * 10) })
  const result = await h.engine.benchmark(host, { ...h.options, testOnly: false })
  assert.equal(h.calls.length, 15)
  assert.equal(h.engine.progress().skipped, 0)
  assert.equal(result.recommended, undefined)
  assert.equal(result.provisionalRecommended, ips[4])
  assert.equal(result.reasonCode, 'INSUFFICIENT_RELIABLE_SAMPLES')
  assert.equal(result.applied, false)
  assert.equal(result.benchmarkFailed, true)
  assert.equal(h.engine.activeAddressFor(host), oldIp)
})

test('missing calibration and disabled adaptive sampling both preserve the complete request budget', async () => {
  for (const settings of [{ count: 2 }, { count: 5, config: { adaptiveBenchmarkSampling: false } }]) {
    const h = fixture({ ...settings, measure: ({ ip }) => ip === ips[0] || ips.indexOf(ip) < 3 ? good(ip) : bad(ip) })
    await h.engine.benchmark(host, h.options)
    assert.equal(h.calls.length, settings.count * 3)
    assert.equal(h.engine.progress().skipped, 0)
  }
})

test('final cohort stays frozen so pruning bounds and confirmed scores never change definitions', async () => {
  const h = fixture({ measure: ({ ip }, round) => ips.indexOf(ip) < 3 ? good(ip, round === 2 ? 10000 : 100) : bad(ip) })
  const result = await h.engine.benchmark(host, h.options)
  const expected = buildScoringContext(ips.slice(0, 5).map((ip) => ips.indexOf(ip) < 3 ? [good(ip), good(ip)] : [bad(ip), bad(ip)]))
  assert.deepEqual(result.scoringContext, expected)
  for (const row of Object.values(result.benchmarks)) assert.deepEqual(row.scoreContext, expected)
  for (const ip of ips.slice(0, 3)) {
    assert.equal(result.benchmarks[ip].samples[2].tps, 10000)
    assert.equal(result.benchmarks[ip].samples[2].reliable, true)
    assert.ok(result.benchmarks[ip].samples[2].flags.includes('high-capped'))
  }
})

test('a failed leader confirmation does not discard routes without a confirmed winner', async () => {
  const h = fixture({ measure: ({ ip }, round) => {
    if (ip === ips[0]) return round === 2 ? bad(ip) : good(ip, 250)
    if (ips.indexOf(ip) < 3) return good(ip, 150)
    return bad(ip)
  } })
  const result = await h.engine.benchmark(host, h.options)
  assert.equal(routeCalls(h, ips[1]).length, 3)
  assert.equal(result.benchmarks[ips[1]].confirmed, true)
  assert.notEqual(result.recommended, ips[0])
})

test('rank display remains stable during out-of-order settlements and only reorders at round boundaries', async () => {
  const gates = ips.slice(0, 3).map(deferred)
  const h = fixture({ count: 3, measure: ({ ip }, round) => round === 0 ? gates[ips.indexOf(ip)].promise : good(ip, 100) })
  const running = h.engine.benchmark(host, { ...h.options, parallelism: 3 })
  await new Promise((resolve) => setImmediate(resolve))
  gates[2].resolve(good(ips[2], 300))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(h.engine.progress().rows.map((row) => row.ip), ips.slice(0, 3))
  assert.equal(h.engine.progress().leading, ips[2])
  gates[0].resolve(good(ips[0], 100)); gates[1].resolve(good(ips[1], 200))
  await running
  const second = h.calls.filter((entry) => entry.round === 1).map((entry) => entry.ip)
  assert.deepEqual(second, [ips[2], ips[1], ips[0]])
})

test('stopping during prioritized final confirmation cancels queued tails without changing the active IP', async () => {
  const entered = deferred(), pending = deferred()
  const h = fixture({ measure: ({ ip }, round) => {
    if (round === 2) { entered.resolve(); return pending.promise }
    return ips.indexOf(ip) < 3 ? good(ip, 100 + ips.indexOf(ip) * 20) : bad(ip)
  } })
  const running = h.engine.benchmark(host, { ...h.options, testOnly: false })
  await entered.promise
  h.engine.stop(h.engine.progress().runId)
  const result = await running
  assert.equal(h.calls.length, 11)
  assert.equal(result.stopped, true)
  assert.equal(result.applied, false)
  assert.equal(h.engine.activeAddressFor(host), oldIp)
  assert.equal(h.engine.progress().stage, 'stopped')
  assert.equal(h.engine.progress().skipped, 0, 'user cancellation is not algorithmic elimination')
  pending.resolve(good(ips[2], 10000))
})

test('a later subset keeps old v2 samples but never mixes their cohort scores into the new ranking', async () => {
  const h = fixture({ measure: ({ ip }) => good(ip, ip === ips[0] ? 100 : 200) })
  const first = await h.engine.benchmark(host, h.options)
  const old = first.benchmarks[ips[4]]
  const second = await h.engine.benchmark(host, { ...h.options, only: [ips[0]] })
  assert.notEqual(second.benchmarkId, first.benchmarkId)
  assert.equal(second.recommended, ips[0])
  assert.equal(second.benchmarks[ips[0]].historical, false)
  assert.equal(second.benchmarks[ips[4]].historical, true)
  assert.equal(second.benchmarks[ips[4]].stabilityScore, old.stabilityScore)
  assert.deepEqual(second.benchmarks[ips[4]].samples, old.samples)
  assert.equal(h.engine.findings()[0].candidates[0].ip, ips[0])
  const reloaded = createResolver(normalizeConfig({ dnsServers: [] }), undefined, {
    readState: () => structuredClone(h.writes.at(-1)),
    writeState: () => { throw new Error('read-only reload') },
  })
  assert.equal(reloaded.findings()[0].recommended, ips[0])
  assert.equal(reloaded.findings()[0].candidates[0].ip, ips[0])
  assert.equal(reloaded.findings()[0].benchmarks[ips[4]].historical, true)
})

test('discovery-only retains raw measurements as history consistently before and after reload', async () => {
  const h = fixture({ count: 3,
    lookup: async () => ips.slice(0, 3).map((address) => ({ address, family: 4 })),
    inspect: async (addresses) => addresses.map((ip, index) => ({ ip, rtt: index + 1 })),
  })
  const first = await h.engine.benchmark(host, h.options)
  const requests = h.calls.length
  const probed = await h.engine.probeNow(host, provider)
  assert.equal(h.calls.length, requests, 'discovery must not launch paid streaming requests')
  for (const ip of ips.slice(0, 3)) {
    assert.equal(probed.benchmarks[ip].historical, true)
    assert.equal(probed.benchmarks[ip].stabilityScore, first.benchmarks[ip].stabilityScore)
    assert.deepEqual(probed.benchmarks[ip].samples, first.benchmarks[ip].samples)
  }
  const current = h.engine.findings()[0]
  assert.equal(current.recommended, undefined)
  const reloaded = createResolver(normalizeConfig({ dnsServers: [] }), undefined, {
    readState: () => structuredClone(h.writes.at(-1)),
    writeState: () => { throw new Error('read-only reload') },
  })
  const restored = reloaded.findings()[0]
  assert.deepEqual(restored.benchmarks, current.benchmarks)
  assert.equal(restored.recommended, undefined)
  assert.equal(h.engine.activeAddressFor(host), oldIp)
  assert.equal(reloaded.selectedFor(host, 'p1'), oldIp)
})

test('legacy winners remain visible but cannot compete or become a v2 recommendation on load', () => {
  const legacy = { ip: ips[0], scoringVersion: 1, stabilityScore: 99999, rankEligible: true, samples: [{ tps: 99999 }] }
  const h = fixture({ benchmarks: { [ips[0]]: legacy } })
  const current = { [ips[0]]: legacy,
    [ips[1]]: { scoringVersion: 2, stabilityScore: 10, reliableRuns: 2, rankEligible: true, samples: [{}] } }
  assert.deepEqual(orderCandidates(h.candidates.slice(0, 2), current).map((entry) => entry.ip), [ips[1], ips[0]])
  assert.equal(h.engine.findings()[0].benchmarks[ips[0]].scoringVersion, 1)
  assert.equal(h.writes.length, 0)
  assert.equal(h.engine.activeAddressFor(host), oldIp)
  assert.equal(optimisticScore([], { plannedRuns: 3, scoringContext: buildScoringContext([]) }), null)
})
