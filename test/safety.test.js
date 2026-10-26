// Fully isolated behavioral tests: never mount the plugin or call real DNS/HTTP/disk.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createResolver, normalizeConfig } from '../index.js'

const host = 'api.example.test'
const provider = { provider: 'p1', baseURL: `https://${host}/custom/v1`, api: 'openai-completions' }
const oldIp = '203.0.113.9'
const a = '203.0.113.1', b = '203.0.113.2', c = '203.0.113.3', d = '203.0.113.4'
const candidate = (ip, rtt = 20, colo = 'HKG') => ({ ip, rtt, colo })
const sample = (ip, tps) => ({ ip, status: 200, ttftMs: 100, totalMs: 1100,
  decodeMs: 1000, outputTokens: tps, usageReported: true, tps })
const record = (extra = {}) => ({ hostname: host, provider: 'p1', candidates: [candidate(a), candidate(b, 200)],
  selected: oldIp, selectedSource: 'manual', benchmarks: {}, probedAt: 1, ...extra })
function harness({ records = [record()], measure, inspect, lookup, config = {} } = {}) {
  let state = { hosts: Object.fromEntries(records.map((entry, index) => [index, structuredClone(entry)])) }
  const writes = [], requests = [], inspections = [], lookups = []
  const engine = createResolver(normalizeConfig({ enabled: true, dnsServers: [], scanEdges: false, ...config }), undefined, {
    readState: () => structuredClone(state),
    writeState: (next) => { state = structuredClone(next); writes.push(structuredClone(next)) },
    nativePromiseLookup: async (hostname, options) => {
      lookups.push({ hostname, options }); return lookup ? lookup(hostname, options) : [{ address: a, family: 4 }, { address: b, family: 4 }]
    },
    nativeLookup: () => { throw new Error('unexpected callback lookup') },
    inspectAll: async (ips, hostname, options) => {
      inspections.push({ ips, hostname, options })
      return inspect ? inspect(ips, hostname, options) : ips.map((ip, index) => candidate(ip, 20 + index))
    },
    measureStream: async (options) => { requests.push(options); return measure ? measure(options, requests.length) : sample(options.ip, options.ip === b ? 200 : 100) },
  })
  engine.setHosts([host], new Map([[host, ['p1']]]))
  const options = { provider, apiKey: 'fake-key', message: 'test prompt', model: 'm1', runs: 3, parallelism: 2 }
  return { engine, options, writes, requests, inspections, lookups, state: () => state }
}

test('test-only is default: recommendation and persistence never replace current pin', async () => {
  const h = harness()
  const result = await h.engine.benchmark(host, h.options)
  assert.equal(result.recommended, b)
  assert.equal(result.selected, oldIp)
  assert.equal(result.selectedSource, 'manual')
  assert.equal(result.applied, false)
  assert.equal(result.testOnly, true)
  assert.equal(h.engine.activeAddressFor(host), oldIp)
  assert.equal(h.requests.length, 6)
  assert.equal(Object.values(h.state().hosts)[0].selected, oldIp)
  assert.equal(Object.values(h.state().hosts)[0].recommended, b)
})

test('explicit apply selects highest median TPS, not lowest ping', async () => {
  const h = harness()
  const result = await h.engine.benchmark(host, { ...h.options, testOnly: false })
  assert.equal(result.selected, b)
  assert.equal(result.applied, true)
  assert.equal(h.engine.activeAddressFor(host), b)
})

test('all candidates get equal counts; a lucky fourth-place single sample cannot win', async () => {
  const seen = new Map()
  const h = harness({ records: [record({ candidates: [a, b, c, d].map((ip, i) => candidate(ip, i + 1)) })],
    measure: ({ ip }) => {
      const n = seen.get(ip) ?? 0; seen.set(ip, n + 1)
      return sample(ip, ({ [a]: [300, 100, 100], [b]: [290, 150, 150], [c]: [280, 170, 170], [d]: [270, 250, 250] })[ip][n])
    } })
  const result = await h.engine.benchmark(host, h.options)
  assert.equal(result.recommended, d)
  assert.deepEqual([...seen.values()], [3, 3, 3, 3])
})

test('missing usage/TPS, NaN and Infinity never participate in selection', async () => {
  for (const tps of [null, undefined, NaN, Infinity, 0]) {
    const h = harness({ measure: ({ ip }) => ({ ...sample(ip, 100), tps, usageReported: false }) })
    const result = await h.engine.benchmark(host, { ...h.options, testOnly: false })
    assert.equal(result.benchmarkFailed, true)
    assert.equal(result.selected, oldIp)
    assert.equal(result.applied, false)
    assert.ok(h.writes.length > 0, 'failure diagnostics must persist')
  }
})

test('a mostly failing fast address cannot beat a reliable candidate', async () => {
  const counts = new Map()
  const h = harness({ measure: ({ ip }) => {
    const n = counts.get(ip) ?? 0; counts.set(ip, n + 1)
    return ip === a && n > 0 ? { ip, error: 'timeout' } : sample(ip, ip === a ? 1000 : 100)
  } })
  assert.equal((await h.engine.benchmark(host, h.options)).recommended, b)
})

test('stale results and excluded subset entries cannot win a new run', async () => {
  const h = harness({ records: [record({ benchmarks: { [b]: { ...sample(b, 9000), runs: 3, eligible: true } } })] })
  const result = await h.engine.benchmark(host, { ...h.options, only: [a] })
  assert.equal(result.recommended, a)
  assert.equal(h.requests.length, 3)
  assert.equal(result.benchmarkContext.model, 'm1')
})

test('exceptions become per-address failures and do not abort other candidates', async () => {
  const h = harness({ measure: ({ ip }) => { if (ip === a) throw new Error('fixture error'); return sample(ip, 200) } })
  const result = await h.engine.benchmark(host, h.options)
  assert.equal(result.recommended, b)
  assert.equal(result.benchmarks[a].failed, 3)
})

test('one-click discovery never installs an intermediate RTT winner', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const h = harness({ measure: async ({ ip }) => { await gate; return sample(ip, 100) } })
  const run = h.engine.autoOptimize(host, { ...h.options, testOnly: false })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.engine.activeAddressFor(host), oldIp)
  assert.equal(h.writes.length, 0, 'discovery must be job-local')
  assert.throws(() => h.engine.select(host, a, { provider, testOnly: false }), /running/)
  await assert.rejects(h.engine.benchmark(host, h.options), /already running/)
  assert.throws(() => h.engine.forget(host), /running/)
  release(); await run
})

test('failed optimization preserves old address even if it vanished from fresh candidates', async () => {
  const h = harness({ measure: ({ ip }) => ({ ip, error: 'HTTP 429' }) })
  const result = await h.engine.autoOptimize(host, { ...h.options, testOnly: false })
  assert.equal(result.selected, oldIp)
  assert.equal(result.benchmarkFailed, true)
  assert.equal(h.engine.activeAddressFor(host), oldIp)
  assert.equal(Object.values(h.state().hosts)[0].benchmarks[a].failed, 3)
})

test('missing credentials fail before discovery and do not mutate state', async () => {
  const h = harness()
  await assert.rejects(h.engine.autoOptimize(host, { ...h.options, apiKey: undefined }), /credential/)
  assert.equal(h.lookups.length, 0)
  assert.equal(h.writes.length, 0)
})

test('near DNS answers do not suppress scan, and no near-enough early stop exists', async () => {
  const h = harness({ config: { scanEdges: true, maxCandidates: 16 } })
  await h.engine.autoOptimize(host, h.options)
  assert.equal(h.inspections.length, 2)
  assert.equal(h.inspections[1].ips.length, 16)
  assert.equal(h.inspections[1].options.enough, undefined)
  assert.equal(h.inspections[0].options.apiPath, '/custom/v1/models')
  assert.equal(h.inspections[0].options.port, 443)
  assert.equal(h.requests.length, 18 * 3)
})

test('provider records survive independently when providers share a hostname', async () => {
  const h = harness({ records: [record(), record({ provider: 'p2', selected: c })] })
  h.engine.setHosts([host], new Map([[host, ['p1', 'p2']]]))
  await h.engine.benchmark(host, h.options)
  const records = h.engine.findings()
  assert.equal(records.length, 2)
  assert.equal(records.find((entry) => entry.provider === 'p2').selected, c)
  assert.equal(records.find((entry) => entry.provider === 'p1').selected, oldIp)
  assert.equal(Object.keys(h.state().hosts).length, 2)
  assert.equal(h.engine.activeAddressFor(host), undefined, 'conflicting pins must use system DNS')
})

test('adding a preview-only provider record cannot unset an existing extra-host pin', async () => {
  const h = harness()
  h.engine.setHosts([host]) // extraHosts has no provider bindings
  assert.equal(h.engine.activeAddressFor(host), oldIp)
  const result = await h.engine.autoOptimize(host, { ...h.options, provider: { ...provider, provider: 'p2' } })
  assert.equal(result.testOnly, true)
  assert.equal(result.selected, undefined)
  assert.equal(h.engine.activeAddressFor(host), oldIp)
})

test('a first-ever test cannot create an active pin, including after persistence', async () => {
  const h = harness({ records: [] })
  assert.equal(h.engine.activeAddressFor(host), undefined)
  await h.engine.autoOptimize(host, h.options)
  assert.equal(h.engine.activeAddressFor(host), undefined)
  assert.equal(Object.values(h.state().hosts)[0].selected, undefined)
})

test('test current address with plugin disabled uses system baseline, not dormant pin', async () => {
  const h = harness({ config: { enabled: false } })
  const result = await h.engine.timeSelected(host, h.options)
  assert.equal(result.ip, a)
  assert.ok(h.requests.every((request) => request.ip === a))
  assert.equal(h.writes.length, 0)
  assert.equal(h.engine.selectedFor(host, provider), oldIp)
})

test('manual apply requires explicit testOnly:false', () => {
  const h = harness()
  assert.throws(() => h.engine.select(host, a, { provider }), /test-only/)
  assert.equal(h.engine.select(host, a, { provider, testOnly: false }).selected, a)
})

test('forget requires explicit host and only removes the requested provider', () => {
  const h = harness({ records: [record(), record({ provider: 'p2' })] })
  assert.throws(() => h.engine.forget(), /explicit host/)
  h.engine.forget(host, 'p1')
  assert.deepEqual(h.engine.findings().map((entry) => entry.provider), ['p2'])
})

test('resolver completion progress is accumulated rather than stuck at one', () => {
  const h = harness()
  const report = h.engine.beginProgress(host)
  report({ resolvers: 3, resolversDone: 0 })
  report({ resolversDone: 1 }); report({ resolversDone: 1 }); report({ resolversDone: 1 })
  assert.equal(h.engine.progress().resolversDone, 3)
})

test('old progress reporters cannot alter a new run', () => {
  const h = harness()
  const first = h.engine.beginProgress(host)
  first({ stage: 'done', message: 'first' })
  const id = h.engine.progress().runId
  const second = h.engine.beginProgress(host)
  assert.notEqual(h.engine.progress().runId, id)
  first({ stage: 'failed', message: 'stale' })
  assert.equal(h.engine.progress().stage, 'starting')
  second({ stage: 'done' })
  assert.equal(h.engine.busy(), false)
  h.engine.endProgress()
  assert.equal(h.engine.lastRun().stage, 'done')
})

test('disposal during an operation forbids late commits', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const h = harness({ measure: async ({ ip }) => { await gate; return sample(ip, 100) } })
  const run = h.engine.benchmark(host, { ...h.options, testOnly: false })
  h.engine.dispose(); release()
  const result = await run
  assert.equal(result.applied, false)
  assert.equal(h.writes.length, 0)
  assert.equal(h.engine.selectedFor(host, provider), oldIp)
})
