// Synthetic samples only: no HTTPS, DNS, plugins or live providers.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  summarize, buildScoringContext, optimisticScore, sampleError, SCORING_VERSION,
  MIN_RELIABLE_OUTPUT_TOKENS, MIN_RELIABLE_DECODE_MS, MIN_RELIABLE_RUNS,
  OUTLIER_MULTIPLIER, MIN_OUTLIER_RUNS,
} from '../bench.js'

const valid = (tps = 100, overrides = {}) => ({
  status: 200, tps, ttftMs: 10, decodeMs: 1000, totalMs: 1010,
  outputTokens: 100, usageReported: true, ...overrides,
})
const runsAt = (...values) => values.map((value) => valid(value))
const closeTo = (actual, expected, tolerance = 1e-12) => assert.ok(
  Math.abs(actual - expected) <= tolerance * Math.max(Number.MIN_VALUE, Math.abs(expected)), `${actual} != ${expected}`,
)
const jsonSafe = (value) => assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
const harmonic = (values) => values.length / values.reduce((sum, value) => sum + 1 / value, 0)
const calibratedContext = () => buildScoringContext([runsAt(100, 100), runsAt(100, 100), runsAt(100, 100)])
const frozenCopy = (value) => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozenCopy(child)
    Object.freeze(value)
  }
  return value
}

test('subnormal scoring does not round intermediate TPS or reference ratios before weighting', () => {
  const m = Number.MIN_VALUE
  const context = { scoringVersion: 2, calibrated: true, peerCount: 3, sampleCount: 6,
    speedReference: 1.5, speedCap: 2.25 }
  const before = summarize(runsAt(m, 4 * m, 5 * m, 5 * m, 5 * m), { scoringContext: context })
  const faster = summarize(runsAt(m, 5 * m, 5 * m, 5 * m, 5 * m), { scoringContext: context })
  assert.ok(faster.stabilityScore >= before.stabilityScore)
  const constant = summarize(runsAt(m, m), { scoringContext: context }).stabilityScore
  assert.ok(constant >= 66 * m && constant <= 67 * m)
})

test('optimistic bounds remain conservative for subnormal TPS with a normal reference', () => {
  const m = Number.MIN_VALUE
  const context = { scoringVersion: 2, calibrated: true, peerCount: 3, sampleCount: 6,
    speedReference: 1.5, speedCap: 2.25 }
  const prefix = [valid(m), valid(m), valid(2 * m), { error: 'timeout' }]
  const upper = optimisticScore(prefix, { plannedRuns: 5, scoringContext: context })
  for (const last of [m, 2 * m, 4 * m, 1, 2.25, Number.MAX_VALUE]) {
    const final = summarize([...prefix, valid(last)], { plannedRuns: 5, scoringContext: context })
    assert.ok(upper >= final.stabilityScore, `bound ${upper} < actual ${final.stabilityScore}`)
  }
})

test('v2 exports technical thresholds and retains compatibility constants', () => {
  assert.equal(SCORING_VERSION, 2)
  assert.equal(MIN_RELIABLE_OUTPUT_TOKENS, 32)
  assert.equal(MIN_RELIABLE_DECODE_MS, 200)
  assert.equal(MIN_RELIABLE_RUNS, 2)
  assert.equal(OUTLIER_MULTIPLIER, 4)
  assert.equal(MIN_OUTLIER_RUNS, 3)
})

test('independent summaries use fixed reference 100, no cap, and exact v2 weights', () => {
  const result = summarize(runsAt(100, 105, 10000))
  assert.deepEqual(result.scoreContext, {
    scoringVersion: 2, calibrated: false, peerCount: 0, sampleCount: 0, speedReference: 100, speedCap: null,
  })
  assert.equal(result.scoringVersion, 2)
  assert.equal(result.tps, 105)
  assert.equal(result.tpsMin, 100)
  assert.equal(result.tpsMax, 10000)
  assert.equal(result.ttftMs, 10)
  assert.equal(result.ttftMinMs, 10)
  assert.equal(result.ttftMaxMs, 10)
  assert.equal(result.totalMs, 1010)
  assert.equal(result.outputTokens, 100)
  assert.equal(result.usageReported, true)
  assert.equal(result.eligible, true)
  assert.equal(result.reliableRuns, 3)
  assert.equal(result.suspectRuns, 0)
  assert.equal(result.confirmed, true)
  assert.equal(result.successRate, 1)
  assert.equal(result.measurementConfidence, 1)
  closeTo(result.harmonicTps, harmonic([100, 105, 10000]))
  closeTo(result.effectiveTps, result.harmonicTps)
  assert.equal(result.conservativeTps, 100)
  closeTo(result.provisionalScore, 0.8 * harmonic([100, 105, 10000]) + 20)
  assert.equal(result.stabilityScore, result.provisionalScore)
  assert.ok(result.samples.every((sample) => sample.reliable && !sample.flags.includes('high-outlier')))
  assert.deepEqual(result.samples.map((sample) => sample.scoredTps), [100, 105, 10000])
  assert.ok(summarize(runsAt(200, 200)).provisionalScore > summarize(runsAt(100, 100)).provisionalScore)
})

test('node-balanced context uses raw node harmonic means and nearest-rank Q90', () => {
  const context = buildScoringContext([runsAt(100, 300), runsAt(200, 200), runsAt(400, 400)])
  assert.deepEqual(context, {
    scoringVersion: 2, calibrated: true, peerCount: 3, sampleCount: 6, speedReference: 200, speedCap: 600,
  })
  assert.ok(Object.isFrozen(context))
  jsonSafe(context)
  const result = summarize(runsAt(100, 200, 10000), { scoringContext: context })
  assert.deepEqual(result.scoreContext, context)
  closeTo(result.provisionalScore, 100 * (0.8 * harmonic([100, 200, 600]) + 20) / 200)
})

test('calibration requires three distinct useful groups AND six technical samples', () => {
  const cases = [
    [[], 0, 0, false],
    [[runsAt(100)], 1, 1, false],
    [[runsAt(100, 100, 100), runsAt(100, 100, 100)], 2, 6, false],
    [[runsAt(100, 100), runsAt(100, 100), runsAt(100)], 3, 5, false],
    [[runsAt(100, 100), runsAt(100, 100), runsAt(100, 100)], 3, 6, true],
    [[runsAt(100, 100), runsAt(100, 100), [valid(100, { error: 'timeout' }), valid(100, { cancelled: true })]], 2, 4, false],
  ]
  for (const [groups, peerCount, sampleCount, calibrated] of cases) {
    const context = buildScoringContext(groups)
    assert.equal(context.peerCount, peerCount)
    assert.equal(context.sampleCount, sampleCount)
    assert.equal(context.calibrated, calibrated)
    assert.equal(context.speedReference, 100)
    assert.equal(context.speedCap, calibrated ? 150 : null)
  }
  const group = runsAt(100, 100)
  assert.equal(buildScoringContext([group, group, group]).peerCount, 1)
  for (const groups of [null, {}, [null], [[valid()], 'SECRET']]) {
    assert.throws(() => buildScoringContext(groups), TypeError)
  }
})

test('calibration balances peers rather than samples and reads no historical scores', () => {
  const normal = [runsAt(100, 100), runsAt(200, 200), runsAt(300, 300), runsAt(400, 400)]
  const outlier = Array.from({ length: 1000 }, () => valid(1e8, {
    stabilityScore: 1e12, scoreContext: { speedReference: 1e12 }, text: 'SECRET',
  }))
  const context = buildScoringContext([...normal, outlier])
  assert.equal(context.speedReference, 300)
  assert.equal(context.peerCount, 5)
  assert.equal(context.sampleCount, 1008)
  assert.equal(context.speedCap, 1.5e8)
  assert.equal(buildScoringContext([...normal, runsAt(1e8, 1e8)]).speedReference, context.speedReference)
  const ten = buildScoringContext(Array.from({ length: 10 }, (_, index) => runsAt((index + 1) * 100)))
  assert.equal(ten.speedReference, 550)
  assert.equal(ten.speedCap, 1350)
  assert.doesNotMatch(JSON.stringify(context), /SECRET|text|stabilityScore/)
})

test('calibration excludes only technically untrusted samples and treats null error as absent', () => {
  const context = buildScoringContext([
    [valid(100, { error: null }), valid(100), valid(1e9, { decodeMs: 199 }), valid(1e9, { outputTokens: 31 })],
    [valid(200), valid(200), valid(1e9, { usageReported: false }), valid(1e9, { ttftMs: -1 })],
    [valid(10000), valid(10000), valid(1e9, { error: false }), valid(1e9, { cancelled: true })],
  ])
  assert.equal(context.peerCount, 3)
  assert.equal(context.sampleCount, 6)
  assert.equal(context.speedReference, 200)
  assert.equal(context.speedCap, 15000)
  assert.equal(sampleError(valid(100, { error: null })), null)
})

test('contexts are validated, immutable snapshots with an allowlisted public shape', () => {
  const context = calibratedContext()
  for (const overrides of [
    { scoringVersion: 1 }, { calibrated: 1 }, { calibrated: false }, { peerCount: 2 },
    { peerCount: -1 }, { peerCount: 1.5 }, { peerCount: Infinity }, { sampleCount: 5 },
    { sampleCount: '6' }, { sampleCount: Number.MAX_SAFE_INTEGER + 1 },
    { speedReference: 0 }, { speedReference: -1 }, { speedReference: NaN }, { speedReference: Infinity },
    { speedCap: undefined }, { speedCap: null }, { speedCap: 0 }, { speedCap: 99 }, { speedCap: Infinity },
  ]) {
    const broken = { ...context, ...overrides }
    assert.throws(() => summarize(runsAt(100, 100), { scoringContext: broken }), TypeError)
    assert.throws(() => optimisticScore([], { plannedRuns: 3, scoringContext: broken }), TypeError)
  }
  for (const scoringContext of [null, false, 100, {}, [], 'SECRET']) {
    assert.throws(() => summarize([], { scoringContext }), TypeError)
  }
  assert.throws(() => summarize([], { scoringContext: { ...buildScoringContext([]), peerCount: 0, sampleCount: 1 } }), TypeError)
  assert.throws(() => summarize([], { scoringContext: { ...buildScoringContext([]), speedReference: 200 } }), TypeError)
  const input = { ...context, prompt: 'PRIVATE', apiKey: 'SECRET' }
  const before = structuredClone(input)
  const result = summarize(runsAt(100, 100), { scoringContext: input })
  assert.deepEqual(input, before)
  assert.deepEqual(result.scoreContext, context)
  input.speedReference = 1000
  assert.equal(result.scoreContext.speedReference, 100)
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|apiKey|prompt/)
})

test('coordinatewise faster throughput never lowers scores in one shared context', () => {
  const groups = [runsAt(120, 132, 157), runsAt(158, 221, 326), runsAt(100, 180, 260)]
  const context = buildScoringContext(groups)
  const summarizeShared = (runs) => summarize(runs, { scoringContext: context })
  assert.ok(summarizeShared(groups[1]).provisionalScore > summarizeShared(groups[0]).provisionalScore)
  for (const values of [[1, 100, 10000], [100, 100, 100], [20, 120, 200], [158, 221, 326]]) {
    const base = summarizeShared(runsAt(...values))
    for (let index = 0; index < values.length; index++) {
      for (const multiplier of [1.01, 2, 10, 1000]) {
        const raised = values.map((value, i) => i === index ? value * multiplier : value)
        const next = summarizeShared(runsAt(...raised))
        assert.ok(next.provisionalScore >= base.provisionalScore - 1e-10)
        assert.equal(next.reliableRuns, base.reliableRuns)
      }
    }
  }
})

test('harmonic speed penalizes the slow tail while spread remains diagnostic only', () => {
  const stable = summarize(runsAt(100, 100, 100))
  const volatile = summarize(runsAt(20, 120, 200))
  assert.equal(stable.provisionalScore, 100)
  assert.ok(volatile.tps > stable.tps)
  closeTo(volatile.harmonicTps, harmonic([20, 120, 200]))
  closeTo(volatile.provisionalScore, 0.8 * harmonic([20, 120, 200]) + 0.2 * 20)
  assert.ok(volatile.provisionalScore < stable.provisionalScore)
  const slowTail = summarize(runsAt(1, 10000, 11000))
  assert.equal(slowTail.reliableRuns, 3)
  assert.deepEqual(slowTail.samples[0].flags, ['low-tail'])
  closeTo(slowTail.relativeSpread, 10999 / 10000)
  closeTo(slowTail.provisionalScore, 0.8 * harmonic([1, 10000, 11000]) + 0.2)
  assert.equal(slowTail.samples[0].scoredTps, 1)
})

test('quartiles use nearest rank, and cap never drops reliability, success or raw fields', () => {
  const context = calibratedContext()
  const result = summarize(runsAt(120, 90, 10000, 100), { scoringContext: context })
  assert.equal(result.conservativeTps, 90)
  closeTo(result.relativeSpread, (120 - 90) / 110)
  closeTo(result.harmonicTps, harmonic([120, 90, 10000, 100]))
  closeTo(result.effectiveTps, harmonic([120, 90, 150, 100]))
  closeTo(result.provisionalScore, 0.8 * harmonic([120, 90, 150, 100]) + 0.2 * 90)
  assert.equal(result.samples[2].tps, 10000)
  assert.equal(result.samples[2].scoredTps, 150)
  assert.deepEqual(result.samples[2].flags, ['high-capped'])
  assert.equal(result.samples[2].reliable, true)
  assert.equal(result.reliableRuns, 4)
  assert.equal(result.successfulRuns, 4)
  assert.equal(result.successRate, 1)
  assert.equal(result.measurementConfidence, 1)
  assert.equal(result.samples[2].decodeMs, 1000)
  const atCap = summarize(runsAt(150, 150), { scoringContext: context })
  const overCap = summarize(runsAt(10000, 11000), { scoringContext: context })
  assert.equal(atCap.provisionalScore, overCap.provisionalScore)
  assert.equal(overCap.conservativeTps, 10000)
  assert.equal(overCap.effectiveTps, 150)
  assert.ok(atCap.samples.every((sample) => !sample.flags.includes('high-capped')))
})

test('same successful measurements receive a separate squared real-failure penalty', () => {
  const good = summarize(runsAt(100, 100))
  const failed = summarize([...runsAt(100, 100), { error: 'timeout' }, { error: 'HTTP 503' }])
  assert.equal(failed.harmonicTps, good.harmonicTps)
  assert.equal(failed.measurementConfidence, good.measurementConfidence)
  assert.equal(failed.successRate, 0.5)
  closeTo(failed.provisionalScore, good.provisionalScore * 0.5 ** 2)
  assert.equal(failed.failed, 2)
  assert.equal(failed.successfulRuns, 2)
  assert.equal(failed.rankEligible, true)
  assert.equal(failed.confirmed, true)
})

test('measurement confidence distinguishes unmeasurable successes from transport failures', () => {
  const result = summarize([valid(), valid(), valid(null, { usageReported: false }), valid(100, { decodeMs: 1 })])
  assert.equal(result.successfulRuns, 4)
  assert.equal(result.failed, 0)
  assert.equal(result.successRate, 1)
  assert.equal(result.measurementConfidence, 0.5)
  assert.equal(result.measurable, 3)
  assert.equal(result.unmeasurable, 1)
  assert.equal(result.provisionalScore, 50)
  assert.equal(summarize([valid(), valid(null)]).measurementConfidence, 0.25)
})

test('unmeasured, cancelled and skipped requests have separate completion accounting', () => {
  const result = summarize([
    valid(100), { error: 'timeout' }, valid(105, { error: null }),
    valid(500, { cancelled: true, error: 'test stopped' }), valid(null, { usageReported: false }),
  ], { plannedRuns: 8, skippedRuns: 2, skippedReason: 'optimistic-bound' })
  assert.equal(result.runs, 5)
  assert.equal(result.plannedRuns, 8)
  assert.equal(result.completedRuns, 4)
  assert.equal(result.successfulRuns, 3)
  assert.equal(result.failed, 1)
  assert.equal(result.cancelled, 1)
  assert.equal(result.skippedRuns, 2)
  assert.equal(result.skippedReason, 'optimistic-bound')
  assert.equal(result.pendingRuns, 1)
  assert.equal(result.eliminated, true)
  assert.equal(result.confirmed, false)
  assert.equal(result.reliableRuns, 2)
  assert.equal(result.rankEligible, true)
  assert.equal(result.samples.length, 5)
  assert.equal(result.successRate, 3 / 4)
  assert.equal(result.measurementConfidence, 2 / 3)
  assert.equal(result.samples[2].error, null)
  assert.equal(result.samples[3].reliable, false)
  assert.ok(result.samples[3].flags.includes('cancelled'))
  assert.ok(!result.samples[3].flags.includes('transport-error'))
  const base = summarize(runsAt(100, 100), { plannedRuns: 100 })
  const cancelled = summarize([...runsAt(100, 100), { cancelled: true }], { plannedRuns: 100 })
  const skipped = summarize(runsAt(100, 100), { plannedRuns: 100, skippedRuns: 98 })
  assert.equal(base.pendingRuns, 98)
  assert.equal(cancelled.pendingRuns, 97)
  assert.equal(skipped.pendingRuns, 0)
  assert.equal(cancelled.failed, 0)
  assert.equal(skipped.failed, 0)
  assert.equal(base.provisionalScore, cancelled.provisionalScore)
  assert.equal(base.provisionalScore, skipped.provisionalScore)
  assert.equal(base.rankEligible, true)
  assert.equal(base.confirmed, false)
  assert.equal(skipped.confirmed, false)
  assert.equal(skipped.samples.length, 2)
})

test('two reliable runs rank without a planned majority; confirmation requires all work, no skip/cancel', () => {
  for (const plannedRuns of [2, 3, 5, 100]) {
    const result = summarize(runsAt(100, 100), { plannedRuns })
    assert.equal(result.rankEligible, true)
    assert.equal(result.provisionalScore, 100)
    assert.equal(result.confirmed, plannedRuns === 2)
  }
  const cancelled = summarize([...runsAt(100, 100), valid(100, { cancelled: true })])
  assert.equal(cancelled.rankEligible, true)
  assert.equal(cancelled.confirmed, false)
  assert.equal(cancelled.failed, 0)
  const onlyCancelled = summarize([valid(100, { cancelled: true }), { cancelled: true }])
  assert.equal(onlyCancelled.completedRuns, 0)
  assert.equal(onlyCancelled.successfulRuns, 0)
  assert.equal(onlyCancelled.failed, 0)
  assert.equal(onlyCancelled.successRate, 0)
  assert.equal(onlyCancelled.measurementConfidence, 0)
  assert.equal(onlyCancelled.rankEligible, false)
  assert.equal(onlyCancelled.provisionalScore, null)
})

test('one reliable run has a provisional score, but never a formal recommendation', () => {
  for (const plannedRuns of [1, 3, 5]) {
    const result = summarize([valid(500)], { plannedRuns })
    assert.equal(result.eligible, true)
    assert.equal(result.rankEligible, false)
    assert.equal(result.confirmed, false)
    assert.equal(result.reliableRuns, 1)
    assert.equal(result.measurementConfidence, 0.5)
    assert.equal(result.provisionalScore, 250)
    assert.equal(result.stabilityScore, 250)
    assert.match(result.scoreReason, /at least 2/)
  }
  const failed = summarize([valid(500), { error: 'timeout' }, { error: 'timeout' }])
  assert.equal(failed.eligible, false)
  assert.equal(failed.rankEligible, false)
  closeTo(failed.provisionalScore, 250 / 9)
})

test('minimum token/window boundaries are inclusive; zero TTFT is technically valid', () => {
  const result = summarize([valid(160, { outputTokens: 32, decodeMs: 200, ttftMs: 0 }), valid(160, { outputTokens: 32, decodeMs: 200 })])
  assert.equal(result.reliableRuns, 2)
  assert.equal(result.rankEligible, true)
  assert.equal(result.provisionalScore, 160)
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
  test(`technical boundary ${flag}: ${String(overrides.decodeMs ?? overrides.outputTokens)}`, () => {
    const runs = [valid(100, overrides), valid(100, overrides)]
    const result = summarize(runs)
    assert.equal(result.eligible, true)
    assert.equal(result.measurable, 2)
    assert.equal(result.error, undefined)
    assert.equal(result.successfulRuns, 2)
    assert.equal(result.successRate, 1)
    assert.equal(result.reliableRuns, 0)
    assert.equal(result.suspectRuns, 2)
    assert.equal(result.rankEligible, false)
    assert.equal(result.provisionalScore, null)
    assert.equal(result.stabilityScore, null)
    assert.equal(result.harmonicTps, null)
    assert.equal(result.effectiveTps, null)
    assert.equal(result.conservativeTps, null)
    assert.ok(result.samples.every((sample) => sample.flags.includes(flag)))
    assert.equal(buildScoringContext([runs]).sampleCount, 0)
  })
}

test('invalid TPS, usage, token counts and TTFT cannot become reliable', () => {
  const runs = [
    ...[null, undefined, NaN, Infinity, -Infinity, 0, -1, '100'].map((tps) => valid(100, { tps })),
    valid(100, { usageReported: false }), valid(100, { usageReported: 1 }),
    ...[0, -1, 32.5, Infinity, Number.MAX_SAFE_INTEGER + 1].map((outputTokens) => valid(100, { outputTokens })),
    ...[NaN, Infinity, -1, null, undefined].map((ttftMs) => valid(100, { ttftMs })),
    valid(100, { error: false }), valid(100, { error: 0 }), valid(100, { error: '' }),
  ]
  const result = summarize(runs)
  assert.equal(result.measurable, 0)
  assert.equal(result.reliableRuns, 0)
  assert.equal(result.rankEligible, false)
  assert.equal(result.provisionalScore, null)
  assert.equal(result.suspectRuns, runs.length)
  assert.ok(result.samples.every((sample) => sample.flags.includes('unmeasurable')))
  assert.equal(buildScoringContext([runs]).sampleCount, 0)
  jsonSafe(result)
})

test('invalid counts normalize safely without erasing actual attempts or skipped work', () => {
  for (const plannedRuns of [0, 1, -1, NaN, Infinity, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
    const result = summarize(runsAt(100, 100), { plannedRuns, skippedRuns: 2 })
    assert.equal(result.plannedRuns, 4)
    assert.equal(result.skippedRuns, 2)
    assert.equal(result.pendingRuns, 0)
    assert.equal(result.provisionalScore, 100)
    assert.equal(result.confirmed, false)
  }
  for (const skippedRuns of [-1, NaN, Infinity, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
    const result = summarize(runsAt(100, 100), { skippedRuns })
    assert.equal(result.plannedRuns, 2)
    assert.equal(result.skippedRuns, 0)
    assert.equal(result.confirmed, true)
  }
  const huge = summarize(runsAt(100, 100), { skippedRuns: Number.MAX_SAFE_INTEGER })
  assert.equal(huge.plannedRuns, Number.MAX_SAFE_INTEGER)
  assert.equal(huge.skippedRuns, Number.MAX_SAFE_INTEGER - 2)
  assert.equal(huge.pendingRuns, 0)
  jsonSafe(huge)
})

test('optimistic score needs calibrated finite cap and matches an explicit cap completion', () => {
  const runs = [valid(90), { error: 'timeout' }, valid(null)]
  assert.equal(optimisticScore(runs, { plannedRuns: 5 }), null)
  assert.equal(optimisticScore(runs, { plannedRuns: 5, scoringContext: buildScoringContext([runsAt(100, 100)]) }), null)
  const context = calibratedContext()
  const optimistic = optimisticScore(runs, { plannedRuns: 5, scoringContext: context })
  const explicit = summarize([...runs, valid(context.speedCap, { ttftMs: 0 }), valid(context.speedCap, { ttftMs: 0 })], {
    plannedRuns: 5, scoringContext: context,
  })
  closeTo(optimistic, explicit.provisionalScore)
  assert.equal(optimisticScore(runs, { plannedRuns: runs.length, scoringContext: context }),
    summarize(runs, { scoringContext: context }).provisionalScore)
  assert.equal(optimisticScore([], { plannedRuns: 0, scoringContext: context }), null)
  assert.equal(optimisticScore([{ error: 'timeout' }], { plannedRuns: 1, scoringContext: context }), null)
})

test('optimistic bound is conservative for slower/faster, failed, untrusted and cancelled completions', () => {
  const context = calibratedContext()
  const outcomes = [
    valid(1), valid(80), valid(150), valid(10000), { error: 'timeout' },
    valid(100, { decodeMs: 1 }), valid(null), valid(100, { cancelled: true }),
  ]
  for (const prefix of [[], [valid(100)], [{ error: 'timeout' }], [valid(90), { error: 'timeout' }],
    [valid(50), valid(null), valid(100, { cancelled: true })]]) {
    const plannedRuns = prefix.length + 2
    const bound = optimisticScore(prefix, { plannedRuns, scoringContext: context })
    assert.ok(Number.isFinite(bound))
    for (const first of outcomes) {
      for (const second of outcomes) {
        const final = summarize([...prefix, first, second], { plannedRuns, scoringContext: context })
        assert.ok(final.provisionalScore === null || final.provisionalScore <= bound + 1e-10,
          `${final.provisionalScore} > ${bound}`)
      }
    }
  }
  assert.equal(optimisticScore([], { plannedRuns: Number.MAX_SAFE_INTEGER, scoringContext: context }), 150)
  const hugePlan = optimisticScore([valid(1), { error: 'timeout' }], {
    plannedRuns: Number.MAX_SAFE_INTEGER, scoringContext: context,
  })
  assert.ok(Number.isFinite(hugePlan) && hugePlan > 149 && hugePlan <= 150)
})

test('samples remain an immutable raw allowlist and never retain responses or credentials', () => {
  const runs = [
    valid(123.456, { ttftMs: 10.125, decodeMs: 812.25, totalMs: 822.375, outputTokens: 100,
      text: 'PRIVATE response', reasoning: 'PRIVATE thinking', message: 'PRIVATE prompt', prompt: 'PRIVATE',
      key: 'SECRET', apiKey: 'SECRET bearer', headers: { authorization: 'SECRET auth' }, provider: { apiKey: 'SECRET' } }),
    { tps: Infinity, decodeMs: NaN, outputTokens: 1.5, totalMs: -2.5, ttftMs: undefined,
      error: 'HTTP 401: SECRET token and PRIVATE prompt', text: 'PRIVATE' },
    { error: 'ECONNRESET: SECRET PRIVATE' }, { error: 'SECRET arbitrary provider text' },
  ]
  const before = structuredClone(runs)
  frozenCopy(runs)
  const context = calibratedContext()
  const result = summarize(runs, { scoringContext: context, skippedRuns: 1, skippedReason: 'SECRET PRIVATE' })
  optimisticScore(runs, { plannedRuns: 10, scoringContext: context })
  buildScoringContext([runs, runsAt(100, 100), runsAt(200, 200)])
  assert.deepEqual(runs, before)
  assert.deepEqual(Object.keys(result.samples[0]).sort(), [
    'status', 'tps', 'ttftMs', 'totalMs', 'decodeMs', 'outputTokens', 'usageReported',
    'error', 'cancelled', 'flags', 'reliable', 'scoredTps',
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
  assert.equal(result.skippedReason, 'not scheduled')
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|authorization|apiKey|prompt/)
  assert.match(result.scoreReason, /^[A-Za-z0-9 ,;.-]+$/)
  jsonSafe(result)
})

test('timeoutMs metadata accepts only optional positive safe integers', () => {
  const result = summarize([
    valid(100, { timeoutMs: 60000 }), valid(100, { timeoutMs: 30000 }),
    valid(100, { timeoutMs: Number.MAX_SAFE_INTEGER }),
    ...[undefined, null, 'SECRET', NaN, Infinity, -1, 0, 1.5, {}, Number.MAX_SAFE_INTEGER + 1]
      .map((timeoutMs) => valid(100, { timeoutMs })),
  ])
  assert.equal(result.samples[0].timeoutMs, 60000)
  assert.equal(result.samples[1].timeoutMs, 30000)
  assert.equal(result.samples[2].timeoutMs, Number.MAX_SAFE_INTEGER)
  assert.ok(result.samples.slice(3).every((sample) => !Object.hasOwn(sample, 'timeoutMs')))
  assert.doesNotMatch(JSON.stringify(result), /SECRET/)
})

test('error categories remain bounded and aggregate errors use identical safe classification', () => {
  for (const [error, expected] of [
    [{ message: 'SECRET' }, 'request failed'], [false, 'request failed'], [0, 'request failed'], ['', 'request failed'],
    ['HTTP 401: SECRET prompt PRIVATE body', 'HTTP 401'], ['stream error: SECRET', 'stream error'],
    ['invalid baseURL: SECRET', 'invalid baseURL'], ['ERR_SECRET: PRIVATE', 'request failed'],
    ['unsupported benchmark API: SECRET', 'unsupported benchmark API'],
    ['ECONNRESET: SECRET credentials', 'ECONNRESET'], ['ETIMEDOUT: SECRET', 'ETIMEDOUT'],
    ['OAuth benchmark authentication is temporarily unsupported: SECRET', 'OAuth benchmark authentication is temporarily unsupported'],
    ['invalid JSON in stream event: SECRET', 'invalid JSON in stream event'],
    ['stream ended without completion marker: SECRET', 'stream ended without completion marker'],
    ['response closed before end: SECRET', 'response closed before end'],
    ['SECRET arbitrary request failure', 'request failed'],
  ]) {
    const result = summarize([{ error }])
    assert.equal(sampleError({ error }), expected)
    assert.equal(result.eligible, false)
    assert.equal(result.error, expected)
    assert.equal(result.samples[0].error, expected)
    assert.equal(result.failed, 1)
    assert.equal(result.successRate, 0)
    assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE/)
  }
  for (const error of [undefined, null]) {
    const result = summarize([valid(100, { error }), valid(100, { error })])
    assert.equal(result.failed, 0)
    assert.equal(result.reliableRuns, 2)
    assert.equal(result.provisionalScore, 100)
    assert.ok(result.samples.every((sample) => sample.error === null && !sample.flags.includes('transport-error')))
  }
  assert.equal(sampleError({ cancelled: true, error: 'SECRET' }), 'test stopped')
})

test('empty and missing samples stay JSON-safe, but missing attempts count as failures', () => {
  const empty = summarize([])
  assert.equal(empty.plannedRuns, 0)
  assert.equal(empty.completedRuns, 0)
  assert.equal(empty.successfulRuns, 0)
  assert.equal(empty.cancelled, 0)
  assert.equal(empty.skippedRuns, 0)
  assert.equal(empty.pendingRuns, 0)
  assert.equal(empty.rankEligible, false)
  assert.equal(empty.confirmed, false)
  assert.equal(empty.conservativeTps, null)
  assert.equal(empty.relativeSpread, null)
  assert.equal(empty.provisionalScore, null)
  assert.equal(empty.stabilityScore, null)
  assert.deepEqual(empty.samples, [])
  const missing = summarize([undefined, null])
  assert.equal(missing.failed, 2)
  assert.equal(missing.suspectRuns, 2)
  assert.equal(missing.successfulRuns, 0)
  assert.deepEqual(missing.samples.map((sample) => sample.error), ['missing run', 'missing run'])
  jsonSafe(empty)
  jsonSafe(missing)
})

test('finite extremes keep raw values, positive harmonic means and JSON-safe scores', () => {
  for (const values of [
    [Number.MIN_VALUE, Number.MIN_VALUE], [Number.MAX_VALUE, Number.MAX_VALUE],
    [Number.MIN_VALUE, Number.MIN_VALUE, Number.MAX_VALUE], [Number.MIN_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    [1e-300, 1e300, 1e300], [1e300, 1e300, 1e300],
  ]) {
    const runs = runsAt(...values)
    const context = buildScoringContext([runs, [...runs], [...runs]])
    assert.ok(Number.isFinite(context.speedReference) && context.speedReference > 0)
    assert.ok(Number.isFinite(context.speedCap) && context.speedCap > 0)
    for (const scoringContext of [undefined, context]) {
      const result = summarize(runs, { scoringContext })
      assert.deepEqual(result.samples.map((sample) => sample.tps), values)
      assert.equal(result.reliableRuns, values.length)
      assert.ok(Number.isFinite(result.harmonicTps) && result.harmonicTps > 0)
      assert.ok(Number.isFinite(result.effectiveTps) && result.effectiveTps > 0)
      assert.ok(Number.isFinite(result.provisionalScore) && result.provisionalScore >= 0)
      jsonSafe(result)
    }
    jsonSafe(context)
    assert.ok(Number.isFinite(optimisticScore(runs, { plannedRuns: 5, scoringContext: context })))
  }
  const hugeContext = buildScoringContext([runsAt(Number.MAX_VALUE, Number.MAX_VALUE),
    runsAt(Number.MAX_VALUE, Number.MAX_VALUE), runsAt(Number.MAX_VALUE, Number.MAX_VALUE)])
  assert.equal(hugeContext.speedReference, Number.MAX_VALUE)
  assert.equal(hugeContext.speedCap, Number.MAX_VALUE)
  assert.equal(summarize(runsAt(Number.MAX_VALUE, Number.MAX_VALUE), { scoringContext: hugeContext }).provisionalScore, 100)
  const tinyContext = buildScoringContext([runsAt(Number.MIN_VALUE, Number.MIN_VALUE),
    runsAt(Number.MIN_VALUE, Number.MIN_VALUE), runsAt(Number.MIN_VALUE, Number.MIN_VALUE)])
  assert.equal(tinyContext.speedReference, Number.MIN_VALUE)
  assert.equal(summarize(runsAt(Number.MIN_VALUE, Number.MIN_VALUE), { scoringContext: tinyContext }).provisionalScore, 100)
  assert.equal(summarize(runsAt(Number.MAX_VALUE, Number.MAX_VALUE), { scoringContext: tinyContext }).provisionalScore, 200)
  const uncappedTiny = buildScoringContext([runsAt(Number.MIN_VALUE, Number.MIN_VALUE)])
  assert.equal(summarize(runsAt(Number.MAX_VALUE, Number.MAX_VALUE), { scoringContext: uncappedTiny }).provisionalScore, Number.MAX_VALUE)
  const subnormalRuns = runsAt(Number.MIN_VALUE, Number.MAX_VALUE)
  const subnormalContext = buildScoringContext([subnormalRuns])
  assert.equal(summarize(subnormalRuns, { scoringContext: subnormalContext }).provisionalScore, 90)
  assert.ok(summarize(runsAt(Number.MIN_VALUE, Number.MIN_VALUE)).provisionalScore > 0)
  // A ratio can overflow before failure penalties even though the answer is finite.
  const smallContext = { ...calibratedContext(), speedReference: 1, speedCap: Number.MAX_VALUE }
  const penalized = summarize([...runsAt(Number.MAX_VALUE, Number.MAX_VALUE),
    ...Array.from({ length: 18 }, () => ({ error: 'timeout' }))], { scoringContext: smallContext })
  assert.ok(Number.isFinite(penalized.provisionalScore))
  closeTo(penalized.provisionalScore, Number.MAX_VALUE, 1e-12)
})
