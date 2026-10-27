// Deterministic run lifecycle tests: no real DNS, sockets, persistence, or timers.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createResolver, normalizeConfig, orderCandidates } from '../index.js'

const host = 'api.example.test'
const provider = { provider: 'p1', baseURL: `https://${host}/v1`, api: 'openai-completions' }
const ips = ['203.0.113.1', '203.0.113.2', '203.0.113.3']
const old = ips[0]
const value = (ip, tps = 100) => ({ ip, tps, usageReported: true, outputTokens: 100, ttftMs: 100, decodeMs: 1000, totalMs: 1100 })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
function fixture({ measure, lookup, inspect } = {}) {
  const calls = [], writes = [], seenSignals = []
  const engine = createResolver(normalizeConfig({ enabled: true, dnsServers: [], scanEdges: false }), undefined, {
    readState: () => ({ hosts: { [host]: { hostname: host, provider: 'p1', selected: old, selectedSource: 'manual',
      candidates: ips.map((ip, index) => ({ ip, rtt: index + 1 })), benchmarks: {} } } }),
    writeState: (state) => writes.push(structuredClone(state)),
    nativePromiseLookup: lookup ?? (async () => ips.map((address) => ({ address, family: 4 }))),
    inspectAll: inspect ?? (async (list) => list.map((ip) => ({ ip, rtt: 20 }))),
    measureStream: async (options) => { calls.push(options.ip); seenSignals.push(options.signal); return measure ? measure(options, calls.length) : value(options.ip) },
  })
  engine.setHosts([host], new Map([[host, ['p1']]]))
  const options = { provider, apiKey: 'fake-key', model: 'm1', message: 'test', runs: 3, parallelism: 1, testOnly: false }
  return { engine, calls, writes, seenSignals, options }
}

test('stop cancels in-flight work, never launches queued IPs, saves completed samples without applying', async () => {
  const entered = deferred(), late = deferred()
  const f = fixture({ measure: ({ ip }, count) => {
    if (count === 1) return value(ip, 100)
    entered.resolve(); return late.promise // deliberately ignores signal
  } })
  const run = f.engine.benchmark(host, f.options)
  await entered.promise
  const runId = f.engine.progress().runId
  assert.equal(f.engine.stop(runId).requested, true)
  assert.equal(f.seenSignals[1].aborted, true)
  const result = await run
  assert.equal(result.stopped, true)
  assert.equal(result.applied, false)
  assert.equal(result.selected, old)
  assert.equal(f.calls.length, 2, 'queued third IP and further rounds must not be launched')
  assert.equal(result.benchmarks[ips[0]].samples[0].tps, 100)
  assert.equal(result.benchmarks[ips[1]].samples[0].cancelled, true)
  assert.equal(result.benchmarks[ips[2]].samples.length, 0)
  assert.equal(result.benchmarks[ips[0]].plannedRuns, 3)
  assert.equal(result.benchmarks[ips[0]].rankEligible, false)
  assert.equal(f.engine.progress().stage, 'stopped')
  assert.equal(f.engine.busy(), false)
  const before = JSON.stringify(f.engine.findings())
  late.resolve(value(ips[1], 9000)); await Promise.resolve(); await Promise.resolve()
  assert.equal(JSON.stringify(f.engine.findings()), before, 'late results must not mutate persisted state')
  assert.equal(f.writes.length, 1)
})

test('stop during auto-test-and-apply preserves prior pin and allows a clean new run', async () => {
  const entered = deferred(), first = deferred()
  let blocked = true
  const f = fixture({ measure: ({ ip }) => { if (blocked) { entered.resolve(); return first.promise } return value(ip) } })
  const run = f.engine.autoOptimize(host, f.options)
  await entered.promise
  f.engine.stop(f.engine.progress().runId)
  const stopped = await run
  assert.equal(stopped.applied, false)
  assert.equal(f.engine.activeAddressFor(host), old)
  blocked = false
  const next = await f.engine.autoOptimize(host, f.options)
  assert.equal(next.stopped, false)
  assert.equal(next.applied, true)
  assert.ok(f.seenSignals.at(-1) !== f.seenSignals[0])
  assert.equal(f.seenSignals.at(-1).aborted, false)
  first.resolve(value(ips[0]))
})

test('a stale stop ID cannot cancel a subsequent run', async () => {
  const f = fixture()
  await f.engine.benchmark(host, f.options)
  const oldId = f.engine.progress().runId
  const report = f.engine.beginProgress(host)
  assert.throws(() => f.engine.stop(oldId), /no longer matches/)
  assert.equal(f.engine.progress().stage, 'starting')
  report({ stage: 'done' })
})

test('stopping an OS lookup detaches promptly and launches no streaming requests', async () => {
  const entered = deferred(), pending = deferred()
  const f = fixture({ lookup: () => { entered.resolve(); return pending.promise } })
  const run = f.engine.autoOptimize(host, f.options)
  await entered.promise
  f.engine.stop(f.engine.progress().runId)
  const result = await run
  assert.equal(result.stopped, true)
  assert.equal(f.calls.length, 0)
  assert.equal(f.engine.activeAddressFor(host), old)
  pending.resolve(ips.map((address) => ({ address, family: 4 })))
})

test('stopping inspection saves its completed partial candidates without timing or applying', async () => {
  const entered = deferred()
  const f = fixture({ inspect: (list, _host, options) => new Promise((resolve) => {
    entered.resolve()
    options.signal.addEventListener('abort', () => resolve([{ ip: list[0], rtt: 20 }]), { once: true })
  }) })
  const run = f.engine.autoOptimize(host, f.options)
  await entered.promise
  f.engine.stop(f.engine.progress().runId)
  const result = await run
  assert.equal(result.stopped, true)
  assert.equal(result.candidates.length, 1)
  assert.equal(f.calls.length, 0)
  assert.equal(f.engine.activeAddressFor(host), old)
})

test('current-address tests stop between requests and retain completed sample values', async () => {
  const entered = deferred(), pending = deferred()
  const f = fixture({ measure: ({ ip }, count) => {
    if (count === 1) return value(ip, 130)
    entered.resolve(); return pending.promise
  } })
  const run = f.engine.timeSelected(host, f.options)
  await entered.promise
  f.engine.stop(f.engine.progress().runId)
  const result = await run
  assert.equal(result.stopped, true)
  assert.equal(result.summary.samples[0].tps, 130)
  assert.equal(result.summary.cancelled, 1)
  assert.equal(f.calls.length, 2)
  assert.equal(f.writes.length, 0, 'observational current-address test must not overwrite optimization records')
  assert.equal(f.engine.activeAddressFor(host), old)
  pending.resolve(value(old))
})

test('all ordered raw TPS and score components survive a fresh activation', async () => {
  const f = fixture()
  const result = await f.engine.benchmark(host, { ...f.options, testOnly: true })
  const recovered = createResolver(normalizeConfig({ dnsServers: [] }), undefined, {
    readState: () => structuredClone(f.writes.at(-1)),
    writeState: () => { throw new Error('read-only reload must not write') },
  })
  const rows = recovered.findings()[0].benchmarks
  assert.deepEqual(rows[ips[0]].samples.map((sample) => sample.tps), [100, 100, 100])
  assert.equal(rows[ips[0]].stabilityScore, result.benchmarks[ips[0]].stabilityScore)
  assert.equal(rows[ips[0]].scoringVersion, 2)
  assert.equal(recovered.selectedFor(host, 'p1'), old)
})

test('candidate ordering puts v2 scores first, not lucky median or ping', () => {
  const candidates = ips.map((ip, index) => ({ ip, rtt: index }))
  const benchmarks = {
    [ips[0]]: { tps: 9000, stabilityScore: null, rankEligible: false, samples: [{ tps: 9000 }], scoringVersion: 2 },
    [ips[1]]: { tps: 140, stabilityScore: 120, rankEligible: true, samples: [{ tps: 140 }], scoringVersion: 2 },
    [ips[2]]: { tps: 180, stabilityScore: 90, rankEligible: true, samples: [{ tps: 180 }], scoringVersion: 2 },
  }
  assert.deepEqual(orderCandidates(candidates, benchmarks).map((row) => row.ip), [ips[1], ips[2], ips[0]])
  assert.deepEqual(candidates.map((row) => row.ip), ips, 'sorting must not mutate its input')
})
