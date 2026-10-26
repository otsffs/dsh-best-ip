// Synthetic samples only: no HTTPS, DNS, plugins or live providers.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  summarize, SCORING_VERSION, MIN_RELIABLE_OUTPUT_TOKENS, MIN_RELIABLE_DECODE_MS,
  MIN_RELIABLE_RUNS, OUTLIER_MULTIPLIER, MIN_OUTLIER_RUNS,
} from '../bench.js'

const valid = (tps = 100, overrides = {}) => ({
  status: 200, tps, ttftMs: 10, decodeMs: 1000, totalMs: 1010,
  outputTokens: 100, usageReported: true, ...overrides,
})
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)

test('fixed scoring policy exports its reliability and outlier thresholds', () => {
  assert.equal(SCORING_VERSION, 1)
  assert.equal(MIN_RELIABLE_OUTPUT_TOKENS, 32)
  assert.equal(MIN_RELIABLE_DECODE_MS, 200)
  assert.equal(MIN_RELIABLE_RUNS, 2)
  assert.equal(OUTLIER_MULTIPLIER, 4)
  assert.equal(MIN_OUTLIER_RUNS, 3)
})

test('[100,105,10000] retains the raw spike but excludes it from scoring', () => {
  const result = summarize([100, 105, 10000].map((tps) => valid(tps)))
  assert.equal(result.scoringVersion, 1)
  assert.equal(result.eligible, true)
  assert.equal(result.tps, 105)
  assert.equal(result.tpsMax, 10000)
  assert.deepEqual(result.samples.map((sample) => sample.tps), [100, 105, 10000])
  assert.deepEqual(result.samples.map((sample) => sample.reliable), [true, true, false])
  assert.deepEqual(result.samples[2].flags, ['high-outlier'])
  assert.equal(result.reliableRuns, 2)
  assert.equal(result.suspectRuns, 1)
  assert.equal(result.rankEligible, true)
  assert.equal(result.conservativeTps, 100)
  closeTo(result.relativeSpread, 5 / 102.5)
  closeTo(result.stabilityScore, 100 / (1 + 5 / 102.5) * (2 / 3) ** 2)
  assert.equal(result.error, undefined)
  assert.match(result.scoreReason, /ranked using 2\/3/)
})

test('[100,10000,11000] keeps the slow tail and does not reward a high median', () => {
  const result = summarize([100, 10000, 11000].map((tps) => valid(tps)))
  assert.equal(result.tps, 10000)
  assert.equal(result.conservativeTps, 100)
  assert.equal(result.reliableRuns, 3)
  assert.equal(result.rankEligible, true)
  assert.equal(result.samples[0].reliable, true)
  assert.deepEqual(result.samples[0].flags, ['low-tail'])
  assert.ok(result.samples.every((sample) => !sample.flags.includes('high-outlier')))
  closeTo(result.relativeSpread, 10900 / 10000)
  closeTo(result.stabilityScore, 100 / (1 + 10900 / 10000))
  assert.ok(summarize([valid(), valid(), valid()]).stabilityScore > result.stabilityScore)
})

test('stable throughput outranks a volatile route with a higher median', () => {
  const stable = summarize([100, 100, 100].map((tps) => valid(tps)))
  const volatile = summarize([20, 120, 200].map((tps) => valid(tps)))
  assert.ok(volatile.tps > stable.tps)
  assert.equal(stable.relativeSpread, 0)
  assert.equal(stable.stabilityScore, 100)
  assert.ok(stable.stabilityScore > volatile.stabilityScore)
  assert.equal(volatile.reliableRuns, 3)
})

test('quartiles use nearest-rank rather than interpolation', () => {
  const result = summarize([120, 90, 110, 100].map((tps) => valid(tps)))
  assert.equal(result.conservativeTps, 90)
  closeTo(result.relativeSpread, (110 - 90) / 105)
  closeTo(result.stabilityScore, 90 / (1 + 20 / 105))
  assert.deepEqual(result.samples.map((sample) => sample.tps), [120, 90, 110, 100])
})

test('outlier cutoffs are strict, require three technical samples, and retain low values', () => {
  const boundary = summarize([100, 100, 400].map((tps) => valid(tps)))
  assert.equal(boundary.reliableRuns, 3)
  assert.deepEqual(boundary.samples[2].flags, [])
  const over = summarize([100, 100, 400.1].map((tps) => valid(tps)))
  assert.equal(over.reliableRuns, 2)
  assert.deepEqual(over.samples[2].flags, ['high-outlier'])
  const pair = summarize([valid(100), valid(10000)])
  assert.equal(pair.reliableRuns, 2)
  assert.deepEqual(pair.samples[1].flags, [])
  const lowBoundary = summarize([25, 100, 100].map((tps) => valid(tps)))
  assert.deepEqual(lowBoundary.samples[0].flags, [])
  const low = summarize([24.9, 100, 100].map((tps) => valid(tps)))
  assert.equal(low.reliableRuns, 3)
  assert.deepEqual(low.samples[0].flags, ['low-tail'])
  assert.equal(low.conservativeTps, 24.9)
})

test('outlier reference median ignores short, failed, and otherwise untrusted samples', () => {
  const result = summarize([
    valid(100), valid(105), valid(10000),
    valid(50000, { decodeMs: 1 }), valid(60000, { outputTokens: 1 }),
    valid(70000, { error: 'timeout' }),
  ])
  assert.deepEqual(result.samples[2].flags, ['high-outlier'])
  assert.equal(result.reliableRuns, 2)
  assert.equal(result.rankEligible, false)
})

test('minimum token/window boundaries are inclusive', () => {
  const result = summarize([valid(160, { outputTokens: 32, decodeMs: 200 }), valid(160, { outputTokens: 32, decodeMs: 200 })])
  assert.equal(result.reliableRuns, 2)
  assert.equal(result.rankEligible, true)
  assert.equal(result.stabilityScore, 160)
})

for (const [overrides, flag] of [
  [{ outputTokens: 31 }, 'insufficient-tokens'],
  [{ decodeMs: 199.999 }, 'insufficient-decode-window'],
  [{ decodeMs: 0 }, 'insufficient-decode-window'],
  [{ decodeMs: undefined }, 'missing-decode-window'],
  [{ decodeMs: null }, 'missing-decode-window'],
  [{ decodeMs: NaN }, 'invalid-decode-window'],
  [{ decodeMs: Infinity }, 'invalid-decode-window'],
  [{ decodeMs: -1 }, 'invalid-decode-window'],
]) {
  test(`transport-measurable samples with ${flag} are not reliable (${String(overrides.decodeMs ?? overrides.outputTokens)})`, () => {
    const result = summarize([valid(100, overrides), valid(100, overrides)])
    assert.equal(result.eligible, true)
    assert.equal(result.measurable, 2)
    assert.equal(result.error, undefined)
    assert.equal(result.reliableRuns, 0)
    assert.equal(result.suspectRuns, 2)
    assert.equal(result.rankEligible, false)
    assert.equal(result.stabilityScore, null)
    assert.equal(result.conservativeTps, null)
    assert.ok(result.samples.every((sample) => sample.flags.includes(flag)))
    assert.match(result.scoreReason, /at least 2.*32 output tokens.*200ms/)
  })
}

test('null TPS, missing usage, invalid tokens and invalid TTFT cannot be reliable', () => {
  const runs = [
    valid(null), valid(NaN), valid(Infinity), valid(0), valid(-1),
    valid(100, { usageReported: false }), valid(100, { outputTokens: 0 }),
    valid(100, { outputTokens: 32.5 }), valid(100, { outputTokens: Infinity }),
    valid(100, { ttftMs: NaN }), valid(100, { ttftMs: -1 }),
  ]
  const result = summarize(runs)
  assert.equal(result.measurable, 0)
  assert.equal(result.reliableRuns, 0)
  assert.equal(result.rankEligible, false)
  assert.equal(result.stabilityScore, null)
  assert.equal(result.suspectRuns, runs.length)
  assert.ok(result.samples.every((sample) => sample.flags.includes('unmeasurable')))
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('a single completed sample never ranks, even if display is eligible', () => {
  for (const plannedRuns of [1, 3, 5]) {
    const result = summarize([valid(500)], { plannedRuns })
    assert.equal(result.eligible, true)
    assert.equal(result.error, undefined)
    assert.equal(result.completedRuns, 1)
    assert.equal(result.plannedRuns, plannedRuns)
    assert.equal(result.rankEligible, false)
    assert.equal(result.conservativeTps, 500)
    assert.equal(result.stabilityScore, null)
    assert.match(result.scoreReason, /at least 2/)
  }
})

test('ranking requires a strict majority of planned runs, not just completed runs', () => {
  const half = summarize([valid(), valid()], { plannedRuns: 4 })
  assert.equal(half.eligible, true)
  assert.equal(half.error, undefined)
  assert.equal(half.completedRuns, 2)
  assert.equal(half.rankEligible, false)
  assert.equal(half.stabilityScore, null)
  assert.match(half.scoreReason, /strict majority of planned runs/)
  const majority = summarize([valid(), valid()], { plannedRuns: 3 })
  assert.equal(majority.rankEligible, true)
  closeTo(majority.stabilityScore, 100 * (2 / 3) ** 2)
  assert.equal(majority.plannedRuns, 3)
  assert.equal(majority.completedRuns, 2)
})

test('high outlier exclusion can remove the planned majority without changing transport fields', () => {
  const result = summarize([100, 105, 10000].map((tps) => valid(tps)), { plannedRuns: 4 })
  assert.equal(result.eligible, true)
  assert.equal(result.error, undefined)
  assert.equal(result.reliableRuns, 2)
  assert.equal(result.rankEligible, false)
  assert.equal(result.stabilityScore, null)
  assert.match(result.scoreReason, /strict majority of planned runs/)
})

test('errors, cancellations, and unmeasurable attempts preserve order and completion accounting', () => {
  const result = summarize([
    valid(100), { error: 'timeout' }, valid(105),
    { cancelled: true, error: 'test stopped' }, valid(null, { usageReported: false }),
  ], { plannedRuns: 7 })
  assert.equal(result.runs, 5)
  assert.equal(result.plannedRuns, 7)
  assert.equal(result.completedRuns, 4)
  assert.equal(result.cancelled, 1)
  assert.equal(result.failed, 2)
  assert.equal(result.unmeasurable, 1)
  assert.equal(result.reliableRuns, 2)
  assert.equal(result.suspectRuns, 3)
  assert.equal(result.rankEligible, false)
  assert.deepEqual(result.samples.map((sample) => sample.tps), [100, null, 105, null, null])
  assert.equal(result.samples[1].error, 'timeout')
  assert.equal(result.samples[3].error, 'test stopped')
  assert.ok(result.samples[3].flags.includes('cancelled'))
  assert.equal(result.samples[3].cancelled, true)
})

test('predominantly failed runs and cancelled samples with fabricated usage cannot rank', () => {
  const failures = summarize([valid(), { error: 'timeout' }, { error: 'timeout' }])
  assert.equal(failures.eligible, false)
  assert.equal(failures.rankEligible, false)
  assert.equal(failures.stabilityScore, null)
  const cancelled = summarize([valid(), valid(100, { cancelled: true }), valid(100, { cancelled: true })])
  assert.equal(cancelled.cancelled, 2)
  assert.equal(cancelled.failed, 2)
  assert.equal(cancelled.completedRuns, 1)
  assert.equal(cancelled.reliableRuns, 1)
  assert.equal(cancelled.rankEligible, false)
})

test('samples are an immutable allowlist of finite raw numbers without prompt, text, or credentials', () => {
  const runs = [
    valid(123.456, { ttftMs: 10.125, decodeMs: 812.25, totalMs: 822.375, outputTokens: 100,
      text: 'PRIVATE response', reasoning: 'PRIVATE thinking', message: 'PRIVATE prompt',
      apiKey: 'SECRET bearer', headers: { authorization: 'SECRET auth' }, provider: { apiKey: 'SECRET' } }),
    { tps: Infinity, decodeMs: NaN, outputTokens: 1.5, totalMs: -2.5, ttftMs: undefined,
      error: 'HTTP 401: SECRET token and PRIVATE prompt', text: 'PRIVATE' },
    { error: 'ECONNRESET: SECRET PRIVATE' },
    { error: 'SECRET arbitrary provider text' },
  ]
  const before = structuredClone(runs)
  const result = summarize(runs)
  assert.deepEqual(runs, before)
  assert.deepEqual(Object.keys(result.samples[0]).sort(), [
    'status', 'tps', 'ttftMs', 'totalMs', 'decodeMs', 'outputTokens', 'usageReported',
    'error', 'cancelled', 'flags', 'reliable',
  ].sort())
  assert.equal(result.samples[0].tps, 123.456)
  assert.equal(result.samples[0].ttftMs, 10.125)
  assert.equal(result.samples[0].decodeMs, 812.25)
  assert.equal(result.samples[0].totalMs, 822.375)
  assert.equal(result.samples[1].tps, null)
  assert.equal(result.samples[1].decodeMs, null)
  assert.equal(result.samples[1].outputTokens, 1.5)
  assert.equal(result.samples[1].totalMs, -2.5)
  assert.equal(result.samples[1].error, 'HTTP 401')
  assert.equal(result.samples[2].error, 'ECONNRESET')
  assert.equal(result.samples[3].error, 'request failed')
  assert.doesNotMatch(JSON.stringify(result.samples), /SECRET|PRIVATE|authorization|apiKey/)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('unknown or structured error values never enter persisted sample text', () => {
  const result = summarize([
    { error: { message: 'SECRET' } }, { error: 'stream error: SECRET' },
    { error: 'invalid baseURL: SECRET' }, { error: 'ERR_SECRET: PRIVATE' },
    { error: 'unsupported benchmark API: SECRET' },
  ])
  assert.deepEqual(result.samples.map((sample) => sample.error), [
    'request failed', 'stream error', 'invalid baseURL', 'request failed', 'unsupported benchmark API',
  ])
  assert.doesNotMatch(JSON.stringify(result.samples), /SECRET|PRIVATE/)
})

test('persisted aggregate errors use the same safe classification as samples', () => {
  for (const [error, expected] of [
    ['HTTP 401: SECRET prompt PRIVATE body', 'HTTP 401'],
    ['stream error: SECRET provider body', 'stream error'],
    ['ECONNRESET: SECRET credentials', 'ECONNRESET'],
    ['SECRET arbitrary request failure', 'request failed'],
  ]) {
    const result = summarize([{ error }])
    assert.equal(result.eligible, false)
    assert.equal(result.error, expected)
    assert.equal(result.samples[0].error, expected)
    assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE/)
  }
})

test('empty and missing samples remain serializable and cannot rank', () => {
  const empty = summarize([])
  assert.equal(empty.plannedRuns, 0)
  assert.equal(empty.completedRuns, 0)
  assert.equal(empty.cancelled, 0)
  assert.equal(empty.rankEligible, false)
  assert.equal(empty.conservativeTps, null)
  assert.equal(empty.relativeSpread, null)
  assert.equal(empty.stabilityScore, null)
  assert.deepEqual(empty.samples, [])
  const missing = summarize([undefined, null])
  assert.equal(missing.failed, 2)
  assert.equal(missing.suspectRuns, 2)
  assert.equal(missing.samples.length, 2)
  assert.deepEqual(missing.samples.map((sample) => sample.error), ['missing run', 'missing run'])
  assert.deepEqual(JSON.parse(JSON.stringify(empty)), empty)
  assert.deepEqual(JSON.parse(JSON.stringify(missing)), missing)
})

test('invalid planned counts cannot inflate the score or erase actual attempts', () => {
  for (const plannedRuns of [0, 1, -1, NaN, Infinity, 1.5, '3']) {
    const result = summarize([valid(), valid()], { plannedRuns })
    assert.equal(result.plannedRuns, 2)
    assert.equal(result.stabilityScore, 100)
  }
})

test('finite extreme samples and derived fields remain JSON-safe', () => {
  for (const values of [[Number.MIN_VALUE, Number.MIN_VALUE], [Number.MAX_VALUE, Number.MAX_VALUE],
    [Number.MIN_VALUE, Number.MIN_VALUE, Number.MAX_VALUE]]) {
    const result = summarize(values.map((tps) => valid(tps)))
    assert.deepEqual(result.samples.map((sample) => sample.tps), values)
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  }
})
