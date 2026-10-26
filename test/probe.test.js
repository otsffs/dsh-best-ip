// Unit tests for the candidate-selection logic.
//
// The ranking rules encode the actual finding: on a mainland connection the
// resolver's own anycast address can cross an ocean while a sibling address for
// the same zone lands in Hong Kong. So "near datacenter first, then latency",
// with unmeasured datacenters ranked last.
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'

import { rankAddresses, sampleRange, scanCandidates, inspectAll, NEAR_COLOS } from './../probe.js'

test('near datacenters win over a marginally faster far one', () => {
  const ranked = rankAddresses(
    [
      { ip: '1.1.1.1', colo: 'LAX', rtt: 50 },
      { ip: '2.2.2.2', colo: 'HKG', rtt: 58 },
    ],
    { preferNear: true },
  )
  assert.equal(ranked[0].ip, '2.2.2.2', 'HKG must beat a slightly faster LAX')
})

test('within one datacenter, the fastest address wins', () => {
  const ranked = rankAddresses(
    [
      { ip: '3.3.3.3', colo: 'HKG', rtt: 61 },
      { ip: '4.4.4.4', colo: 'HKG', rtt: 53 },
      { ip: '5.5.5.5', colo: 'HKG', rtt: 57 },
    ],
    { preferNear: true },
  )
  assert.deepEqual(ranked.map((entry) => entry.ip), ['4.4.4.4', '5.5.5.5', '3.3.3.3'])
})

test('an unknown datacenter never outranks a measured near one', () => {
  const ranked = rankAddresses(
    [
      { ip: '6.6.6.6', colo: undefined, rtt: 10 },
      { ip: '7.7.7.7', colo: 'HKG', rtt: 60 },
    ],
    { preferNear: true },
  )
  assert.equal(ranked[0].ip, '7.7.7.7')
})

test('preferNear can be turned off for pure latency ordering', () => {
  const ranked = rankAddresses(
    [
      { ip: '8.8.8.8', colo: 'LAX', rtt: 50 },
      { ip: '9.9.9.9', colo: 'HKG', rtt: 58 },
    ],
    { preferNear: false },
  )
  assert.equal(ranked[0].ip, '8.8.8.8')
})

test('HKG is the most preferred datacenter of all neighbours', () => {
  assert.equal(NEAR_COLOS[0], 'HKG')
})

test('the scan budget is balanced across clipped /16 units, not biased toward HKG', () => {
  const list = scanCandidates(160)
  assert.equal(list.length, 160)
  const counts = new Map()
  for (const ip of list) {
    const range = ip.split('.').slice(0, 2).join('.')
    counts.set(range, (counts.get(range) ?? 0) + 1)
  }
  assert.equal(counts.size, 33)
  assert.deepEqual([...counts.values()].sort((a, b) => a - b), [...Array(5).fill(4), ...Array(28).fill(5)])
  assert.deepEqual(scanCandidates(160), list)
})

test('a smaller budget interleaves units instead of exhausting the first one', () => {
  const list = scanCandidates(33)
  assert.equal(list.length, 33)
  assert.equal(new Set(list.map((ip) => ip.split('.').slice(0, 2).join('.'))).size, 33)
})

test('inspectAll completes an all-rejected scan without firing enough', async () => {
  const seen = []
  const ips = Array.from({ length: 200 }, (_, index) => `candidate-${index}`)
  let inspected = 0
  const found = await inspectAll(ips, 'example.test', {
    concurrency: 4,
    inspect: async () => { inspected++; return null },
    enough: (_entry, list) => list.length >= 5,
    onFound: (entry) => seen.push(entry.ip),
  })
  assert.equal(found.length, 0)
  assert.equal(inspected, ips.length)
  assert.deepEqual(seen, [])
})

test('inspectAll returns when satisfied, without awaiting or publishing slow siblings', async () => {
  const pending = []
  const seen = []
  const progress = []
  const found = await inspectAll(['fast', 'slow-1', 'slow-2'], 'example.test', {
    concurrency: 3,
    waveSize: 3,
    inspect: async (ip) => ip === 'fast' ? { ip } : new Promise((resolve) => pending.push(() => resolve({ ip }))),
    enough: () => true,
    onFound: (entry) => seen.push(entry.ip),
    onProgress: (value) => progress.push(value),
  })
  assert.deepEqual(found, [{ ip: 'fast' }])
  assert.equal(pending.length, 2, 'siblings are still unresolved at return')
  for (const resolve of pending) resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(found, [{ ip: 'fast' }], 'returned results must not grow in the background')
  assert.deepEqual(seen, ['fast'])
  assert.equal(progress.length, 1)
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function promptly(promise) {
  const pending = Symbol('pending')
  const result = await Promise.race([promise, nextTurn().then(() => pending)])
  assert.notEqual(result, pending, 'cancellation must not await a signal-ignoring inspector')
  return result
}

test('inspectAll pre-abort dispatches/publishes nothing and does not register an abort listener', async () => {
  const controller = new AbortController()
  controller.abort()
  const forbidden = () => assert.fail('pre-aborted scan must do nothing')
  const found = await inspectAll(['a', 'b'], 'example.test', {
    signal: controller.signal, inspect: forbidden, onFound: forbidden, onProgress: forbidden, enough: forbidden,
  })
  assert.deepEqual(found, [])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

for (const withEnough of [false, true]) {
  test(`inspectAll abort returns partial results and ignores late settlements ${withEnough ? 'with' : 'without'} enough`, async () => {
    const controller = new AbortController()
    const started = []
    const pending = new Map()
    const seen = []
    const progress = []
    let enoughCalls = 0
    const scan = inspectAll(['a', 'b', 'c', 'd', 'e'], 'example.test', {
      concurrency: 3, waveSize: 4, signal: controller.signal,
      inspect: (ip, hostname, options) => {
        assert.equal(hostname, 'example.test')
        assert.equal(options.signal, controller.signal)
        started.push(ip)
        const task = deferred()
        pending.set(ip, task)
        return task.promise // Deliberately ignores options.signal.
      },
      onFound: (entry) => seen.push(entry.ip),
      onProgress: (value) => { progress.push(value); controller.abort() },
      ...(withEnough ? { enough: () => { enoughCalls++; return false } } : {}),
    })
    assert.deepEqual(started, ['a', 'b', 'c'])
    pending.get('a').resolve({ ip: 'a', rtt: 10 })
    const found = await promptly(scan)
    assert.deepEqual(found, [{ ip: 'a', rtt: 10 }])
    assert.deepEqual(started, ['a', 'b', 'c'], 'neither queued addresses nor the next wave are dispatched')
    assert.deepEqual(seen, ['a'])
    assert.deepEqual(progress, [{ attempted: 1, usable: 1, total: 5 }])
    assert.equal(enoughCalls, 0, 'abort during progress also suppresses enough')
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    pending.get('b').resolve({ ip: 'late-success', rtt: 1 })
    pending.get('c').reject(new Error('late ignored inspector rejection'))
    await nextTurn() // Node's runner also detects any unhandled rejection.
    assert.deepEqual(found, [{ ip: 'a', rtt: 10 }], 'returned results cannot grow later')
    assert.deepEqual(seen, ['a'])
    assert.equal(progress.length, 1)
    assert.deepEqual(started, ['a', 'b', 'c'])
  })
}

test('inspectAll external abort releases hung inspectors even before the first result', async () => {
  const controller = new AbortController()
  const started = []
  const scan = inspectAll(['a', 'b', 'c'], 'example.test', {
    concurrency: 2, waveSize: 3, signal: controller.signal,
    inspect: (ip) => { started.push(ip); return new Promise(() => {}) },
    onFound: () => assert.fail('no result completed'),
    onProgress: () => assert.fail('aborted work is not progress'),
  })
  assert.deepEqual(started, ['a', 'b'])
  controller.abort()
  assert.deepEqual(await promptly(scan), [])
  assert.deepEqual(started, ['a', 'b'])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('inspectAll synchronous inspector abort prevents the rest of the initial dispatch', async () => {
  const controller = new AbortController()
  const started = []
  const scan = inspectAll(['a', 'b', 'c'], 'example.test', {
    concurrency: 3, waveSize: 3, signal: controller.signal,
    inspect: (ip) => {
      started.push(ip)
      controller.abort()
      return new Promise(() => {})
    },
  })
  assert.deepEqual(await promptly(scan), [])
  assert.deepEqual(started, ['a'])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('inspectAll abort inside onFound suppresses progress/enough and further dispatch', async () => {
  const controller = new AbortController()
  const started = []
  const found = await inspectAll(['a', 'b'], 'example.test', {
    concurrency: 1, waveSize: 2, signal: controller.signal,
    inspect: async (ip) => { started.push(ip); return { ip } },
    onFound: () => controller.abort(),
    onProgress: () => assert.fail('progress after abort'),
    enough: () => assert.fail('enough after abort'),
  })
  assert.deepEqual(found, [{ ip: 'a' }])
  assert.deepEqual(started, ['a'])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('inspectAll abort on rejected-address progress prevents the next wave', async () => {
  const controller = new AbortController()
  const started = []
  const progress = []
  const found = await inspectAll(['a', 'b'], 'example.test', {
    concurrency: 1, waveSize: 1, signal: controller.signal,
    inspect: async (ip) => { started.push(ip); return null },
    onProgress: (value) => { progress.push(value); controller.abort() },
  })
  assert.deepEqual(found, [])
  assert.deepEqual(started, ['a'])
  assert.deepEqual(progress, [{ attempted: 1, usable: 0, total: 2 }])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('inspectAll enough still returns early with a signal and consumes late rejections', async () => {
  const controller = new AbortController()
  const late = deferred()
  const progress = []
  const found = await promptly(inspectAll(['fast', 'slow', 'not-started'], 'example.test', {
    concurrency: 2, waveSize: 3, signal: controller.signal,
    inspect: async (ip) => ip === 'fast' ? { ip } : late.promise,
    enough: () => true,
    onProgress: (value) => progress.push(value),
  }))
  assert.deepEqual(found, [{ ip: 'fast' }])
  assert.equal(controller.signal.aborted, false, 'enough must not abort the caller controller')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  late.reject(new Error('late rejection after enough'))
  controller.abort()
  await nextTurn()
  assert.deepEqual(found, [{ ip: 'fast' }])
  assert.deepEqual(progress, [{ attempted: 1, usable: 1, total: 3 }])
})

test('inspectAll ordinary inspector failures still reject and remove the abort listener', async () => {
  const controller = new AbortController()
  const late = deferred()
  const seen = []
  const error = new Error('ordinary inspector failure')
  await assert.rejects(inspectAll(['bad', 'slow'], 'example.test', {
    concurrency: 2, waveSize: 2, signal: controller.signal,
    inspect: async (ip) => {
      if (ip === 'bad') throw error
      return late.promise
    },
    onFound: (entry) => seen.push(entry),
  }), error)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  late.resolve({ ip: 'slow' })
  await nextTurn()
  assert.deepEqual(seen, [], 'a failed invocation cannot publish in the background')
})

test('range sampling stays inside its CIDR and skips network-shaped addresses', () => {
  const ips = sampleRange('104.21.0.0/16', 64)
  assert.ok(ips.length > 0)
  for (const ip of ips) {
    assert.match(ip, /^104\.21\.\d{1,3}\.\d{1,3}$/)
    assert.ok(!ip.endsWith('.0'), `${ip} should not be a network address`)
    assert.ok(!ip.endsWith('.255'), `${ip} should not be a broadcast address`)
  }
  // Deterministic: the same range and stride produce the same list.
  assert.deepEqual(sampleRange('104.21.0.0/16', 64), ips)
})
