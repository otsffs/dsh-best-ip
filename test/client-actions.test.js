// Test real actions and render the panel with lightweight injected React hooks.
// No browser, network request or installed plugin is involved.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { buildScoringContext, summarize } from '../bench.js'

const serverSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function action(name, dependencies) {
  const start = source.indexOf(`      const ${name} = async `)
  assert.notEqual(start, -1, `${name} must exist`)
  const end = source.indexOf('\n      }\n', start) + '\n      }'.length
  assert.ok(end > start)
  return new Function(...Object.keys(dependencies), `${source.slice(start, end)}; return ${name}`)(...Object.values(dependencies))
}
function fixture() {
  const requests = [], running = [], notes = [], errors = [], stops = []
  const dependencies = {
    selection: { provider: 'p1', model: 'm1' },
    measurement: { hostname: 'api.example.test' },
    message: 'measure this',
    draft: { maxBenchmarkIps: 0 }, benchmarkIpLimitInvalid: false,
    call: async (path, payload) => { requests.push({ path, payload }); return { runId: 'test-run' } },
    pollUntilDone: async () => ({ stage: 'done', recommended: '203.0.113.1', applied: requests.at(-1).payload.testOnly === false }),
    describeRunError: (...args) => helper('describeRunError')(...args),
    load: async () => {}, t: (key) => key,
    setRunning: (value) => running.push(value), setProgress: () => {},
    setError: (value) => errors.push(value), setNote: (value) => notes.push(value),
    setTiming: () => {}, setTimeResult: () => {}, setStickySummary: () => {},
    setTimeProgress: () => {}, setTimeRuns: () => {},
    setStopping: (value) => stops.push(value), setActiveRunId: () => {}, activeRunId: 'test-run', stopping: false,
  }
  return { dependencies, requests, running, notes, errors, stops }
}

function helper(name, dependencies = {}, text = source) {
  const declaration = new RegExp(`(^|\\n)( *)function ${name}\\(`).exec(text)
  assert.ok(declaration, `${name} must exist`)
  const start = declaration.index + declaration[1].length
  const ending = `\n${declaration[2]}}`
  const end = text.indexOf(`${ending}\n`, start) + ending.length
  assert.ok(end > start)
  // Keep isolated helper tests compatible with the real display-only slot dependency.
  const injected = { ...(['sampleValues', 'sampleDetails'].includes(name) ? { sampleSlots: helper('sampleSlots') } : {}), ...dependencies }
  return new Function(...Object.keys(injected), `${text.slice(start, end)}; return ${name}`)(...Object.values(injected))
}

test('stopping sends only the exact active run ID and waits for terminal progress', async () => {
  const f = fixture()
  await action('stopTest', f.dependencies)()
  assert.deepEqual(f.requests, [{ path: '/stop', payload: { runId: 'test-run' } }])
  assert.deepEqual(f.stops, [true])
  assert.deepEqual(f.running, [], 'the stop request must not claim the run has drained')
  assert.deepEqual(f.notes, ['stoppingHint'])
})

test('a quick terminal update cannot be overwritten by a late stop response', async () => {
  const f = fixture()
  f.dependencies.call = async () => { f.dependencies.setNote('terminal-stopped'); return {} }
  await action('stopTest', f.dependencies)()
  assert.equal(f.notes.at(-1), 'terminal-stopped')
})

test('stopping without an active ID or while already stopping sends no request', async () => {
  for (const change of [{ activeRunId: null }, { stopping: true }]) {
    const f = fixture()
    await action('stopTest', { ...f.dependencies, ...change })()
    assert.equal(f.requests.length, 0)
  }
})

test('stop errors re-enable the stop action rather than falsely declaring stopped', async () => {
  const f = fixture()
  f.dependencies.call = async () => { throw new Error('stale run') }
  await action('stopTest', f.dependencies)()
  assert.deepEqual(f.stops, [true, false])
  assert.equal(f.errors.at(-1), 'stale run')
})

function resultStyles() {
  const start = source.indexOf('    const S = {')
  const end = source.indexOf('    const RESULTS_LAYOUT =', start)
  assert.ok(start >= 0 && end > start)
  return new Function(`${source.slice(start, end)}; return S`)()
}

test('apply and identity columns stay pinned above an opaque surface', () => {
  const styles = resultStyles()
  assert.equal(styles.resultAction.position, 'sticky')
  assert.equal(styles.resultAction.right, 0)
  assert.ok(styles.resultAction.zIndex > 0)
  assert.equal(styles.resultAction.background, 'var(--dsw-alias-bg-layer-1)')
  assert.equal(styles.resultIdentity.position, 'sticky')
  assert.equal(styles.resultIdentity.left, 0)
  assert.equal(styles.th.position, 'sticky')
  assert.equal(styles.th.top, 0)
  assert.equal(styles.table.tableLayout, 'fixed')
  assert.equal(styles.table.borderCollapse, 'separate')
  assert.match(source, /\.\.\.S\.td, \.\.\.S\.resultAction/)
})

test('live round table shares width across rounds instead of reserving a fixed offscreen column', () => {
  const styles = resultStyles()
  assert.equal(styles.runsTable.tableLayout, 'fixed')
  assert.equal(styles.runsTable.minWidth, 0)
  assert.equal(Object.hasOwn(styles.runsTable, 'minWidth') && styles.runsTable.minWidth > 0, false)
  // Three default rounds plus identity and score must fit the 780px settings card.
  const table = renderComponent('RunsTable', { progress: { rounds: 3, rows: [{
    ip: '203.0.113.1', rank: 1, runs: [{ tps: 100 }, { tps: 101 }, { tps: 102 }],
  }] } })
  const columns = nodes(table).find((node) => node.type === 'colgroup').children
  assert.deepEqual(columns.map((column) => column.props.style.width), ['38%', '22%', '13.333333333333334%', '13.333333333333334%', '13.333333333333334%'])
  const header = nodes(table).find((node) => node.type === 'tr')
  assert.equal(header.children.at(-1).children[0].children[0], 'run3')
  for (const cell of nodes(table).filter((node) => node.type === 'td').slice(2)) assert.equal(cell.props.style.textAlign, 'right')
})

test('live round cells keep the third sample readable without a fixed 104px column', () => {
  const table = renderComponent('RunsTable', { progress: { rounds: 3, rows: [{
    ip: '203.0.113.1', rank: 1, runs: [{ tps: 158.4 }, { tps: 221.1 }, { tps: 326.8 }],
  }] } })
  const cells = nodes(table).filter((node) => node.type === 'td')
  assert.deepEqual(cells.slice(2).map((cell) => cell.children[0]), ['158.4', '221.1', '326.8'])
  assert.ok(cells.slice(2).every((cell) => ['7px 4px', '7px 0 7px 4px'].includes(cell.props.style.padding)))
  assert.ok(cells.slice(2).every((cell) => cell.props.style.width === undefined))
})

test('large result sets scroll in a bounded viewport with wrapping samples', () => {
  const styles = resultStyles()
  assert.equal(styles.page.minWidth, 0)
  assert.equal(styles.card.minWidth, 0)
  assert.equal(styles.resultViewport.minWidth, 0)
  assert.equal(styles.resultViewport.overflow, 'auto')
  assert.ok(styles.resultViewport.maxHeight.includes('vh'))
  assert.equal(styles.td.whiteSpace, 'normal')
  assert.equal(styles.sampleBadges.flexWrap, 'wrap')
  assert.equal(styles.sampleBadge.overflowWrap, 'anywhere')
  assert.equal(styles.resultApply.whiteSpace, 'normal')
})

test('narrow settings panes use cards rather than offscreen table actions', () => {
  const styles = resultStyles()
  assert.equal(styles.resultsSurface.containerType, 'inline-size')
  assert.equal(styles.resultsSurface.containerName, 'dsh-best-ip-results')
  assert.match(source, /@container dsh-best-ip-results \(max-width: 620px\)/)
  assert.match(source, /\.dsh-best-ip-results-wide \{ display: none; \}/)
  assert.match(source, /\.dsh-best-ip-results-cards \{ display: flex; \}/)
  assert.equal(styles.resultCards.display, undefined, 'inline display must not override the responsive stylesheet')
  assert.equal(styles.resultCards.overflowX, 'hidden')
  assert.equal(styles.resultCardHeader.display, 'flex')
  assert.equal(styles.resultCardHeader.justifyContent, 'space-between')
})

test('table, cards and recommendation shortcut share the same explicit apply action', () => {
  assert.equal((source.match(/h\(ResultApply,/g) ?? []).length, 3)
  assert.match(source, /onClick: \(\) => onChoose\(ip\)/)
  assert.match(source, /'aria-label': `\$\{label \?\? t\('use'\)\}: \$\{ip\}`/)
  assert.match(source, /label: t\('applyRecommended'\)/)
  assert.match(source, /h\(ResultTiming, \{ row, bench, t \}\)/)
  assert.match(source, /h\(SampleBadges, \{ bench, t \}\)/)
})

test('stored per-run TPS remain visible with outliers, cancellations and unstarted slots', () => {
  const sampleValues = helper('sampleValues')
  const t = (key) => key
  assert.equal(sampleValues({ plannedRuns: 3, samples: [{ tps: 100 }, { tps: 105 }, { tps: 10000, flags: ['high-outlier'] }] }, t), '(100.0, 105.0, 10000.0⚠)')
  assert.equal(sampleValues({ plannedRuns: 3, samples: [{ tps: 100 }, { cancelled: true }] }, t), '(100.0, sampleStopped, sampleMissing)')
  assert.equal(sampleValues({ tps: 100 }, t), 'sampleLegacy', 'legacy median must never be copied into invented runs')
  assert.match(source, /sampleValues\(bench, t\)/)
  assert.match(source, /sampleDetails\(bench, t\)/)
})

test('v2 ordering separates scored, attempted, eliminated, legacy and untested tiers without mutating inputs', () => {
  const ordered = helper('orderedCandidates')
  const candidates = ['untested', 'legacy', 'eliminated', 'attempted', 'provisional', 'confirmed'].map((ip, index) => ({ ip, rtt: index }))
  const rows = {
    legacy: { scoringVersion: 1, rankEligible: true, stabilityScore: 1e6, tps: 10000 },
    eliminated: { scoringVersion: 2, stabilityScore: 1000, eliminated: true, samples: [{}] },
    attempted: { scoringVersion: 2, stabilityScore: null, samples: [{ error: 'timeout' }] },
    provisional: { scoringVersion: 2, stabilityScore: 110, reliableRuns: 1, rankEligible: false, samples: [{}] },
    confirmed: { scoringVersion: 2, stabilityScore: 100, reliableRuns: 3, rankEligible: true, confirmed: true, samples: [{}, {}, {}] },
  }
  const before = structuredClone({ candidates, rows })
  assert.deepEqual(ordered(candidates, rows).map((row) => row.ip), ['provisional', 'confirmed', 'attempted', 'eliminated', 'legacy', 'untested'])
  assert.deepEqual({ candidates, rows }, before)
  assert.deepEqual(ordered(undefined, undefined), [])
})

test('plugin inventory, settings entry and page title use the same speed-test name', () => {
  for (const [locale, name, description] of [
    ['zh', '模型节点优选', '为当前默认模型实测 API 速度，自动选出最快且最稳定的解析 IP 节点，并按需应用。'],
    ['en', 'Model Node Optimizer', 'Benchmark the current default model API and pick the fastest, most stable resolved IP node, optionally applying it.'],
  ]) {
    const resource = JSON.parse(fs.readFileSync(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8'))
    // `locale/*.json` exists only so `dsh-app-boot` can title the plugin in the
    // inventory; it reads `meta.title`/`meta.description` and nothing else. UI
    // strings live in the client dictionaries below, so duplicating them here
    // only ever created a second copy that could drift out of date.
    assert.deepEqual(Object.keys(resource), ['meta'], `${locale}.json must carry only display metadata`)
    assert.deepEqual(Object.keys(resource.meta).sort(), ['description', 'title'])
    assert.equal(resource.meta.title, name)
    assert.equal(resource.meta.description, description)
    assert.equal(source.split(`title: '${name}'`).length - 1, 2, 'client metadata and page title must match')
    assert.ok(source.includes(`section: '${name}'`))
    assert.ok(source.includes(`subtitle: '${description}'`))
  }
  assert.doesNotMatch(source, /提供商 DNS|Provider DNS Pin|section: 'Provider DNS'|API IP Speed Test|API IP 测速/)
})

test('both automatic actions are explicit and the global mode switch is removed', () => {
  assert.match(source, /autoTest: '自动测速'/)
  assert.match(source, /autoTestAndApply: '自动测速并应用'/)
  assert.match(source, /onClick: \(\) => runAutoTest\(true\)/)
  assert.match(source, /onClick: \(\) => runAutoTest\(false\)/)
  assert.doesNotMatch(source, /setTestOnly|一键优选|t\('testOnly'\)/)
})

for (const [mode, flag, state] of [['test', true, 'test'], ['apply', false, 'apply']]) {
  test(`${mode} action sends its own explicit flag and cleans up running state`, async () => {
    const f = fixture()
    await action('runAutoTest', f.dependencies)(flag)
    assert.equal(f.requests[0].path, '/auto')
    assert.equal(f.requests[0].payload.testOnly, flag)
    assert.equal(f.requests[0].payload.provider, 'p1')
    assert.equal(f.requests[0].payload.model, 'm1')
    assert.deepEqual(f.running, [state, null])
    assert.equal(f.notes.at(-1), flag ? 'previewDone' : 'applies')
  })
}

test('a default change is reported as saved-but-not-applied, not success on the new model', async () => {
  const f = fixture()
  f.dependencies.pollUntilDone = async () => ({ stage: 'done', applied: false, defaultChanged: true })
  await action('runAutoTest', f.dependencies)(false)
  assert.equal(f.notes.at(-1), 'defaultChangedHint')
})

test('OAuth eligibility disables both paid actions without disabling cancellation', () => {
  assert.match(source, /benchmarkBlocked = state\?\.benchmarkAvailability\?\.supported === false/)
  assert.match(source, /selection === undefined \|\| benchmarkBlocked/)
  assert.match(source, /benchmarkReasons\.\$\{state\.benchmarkAvailability\.reasonCode\}/)
  assert.match(source, /disabled: !activeRunId \|\| stopping/)
})

test('an apply click cannot make the next test click apply', async () => {
  const f = fixture()
  const run = action('runAutoTest', f.dependencies)
  await run(false); await run(true); await run()
  assert.deepEqual(f.requests.map((entry) => entry.payload.testOnly), [false, true, true])
})

test('an accidental event/object argument cannot opt in to application', async () => {
  const f = fixture()
  await action('runAutoTest', f.dependencies)({ type: 'click' })
  assert.equal(f.requests[0].payload.testOnly, true)
})

test('a failed automatic action reports failure and never claims application', async () => {
  const f = fixture()
  f.dependencies.call = async () => { throw new Error('fixture failure') }
  await action('runAutoTest', f.dependencies)(false)
  assert.deepEqual(f.errors, [null, 'fixture failure'])
  assert.deepEqual(f.notes, [null])
  assert.deepEqual(f.running, ['apply', null])
})

for (const testOnly of [true, false]) {
  test(`empty discovery keeps its localized failure after state refresh (testOnly=${testOnly})`, async () => {
    const f = fixture()
    f.dependencies.pollUntilDone = async () => ({ stage: 'failed', reasonCode: 'NO_USABLE_IP', message: 'no usable candidate; previous selection kept' })
    // The real load() clears old errors. A terminal error must be set AFTER it.
    f.dependencies.load = async () => f.dependencies.setError(null)
    await action('runAutoTest', f.dependencies)(testOnly)
    assert.equal(f.errors.at(-1), 'noValidIp')
    assert.deepEqual(f.notes, [null], 'empty discovery must not claim a recommendation or application')
    assert.equal(f.running.at(-1), null)
  })
}

for (const name of ['runAutoTest', 'runTimeCurrent']) {
  test(`${name} retains other terminal failures and save errors after refresh`, async () => {
    const f = fixture()
    f.dependencies.pollUntilDone = async () => ({ stage: 'failed', message: 'stream failed', saveError: 'save failed' })
    f.dependencies.load = async () => f.dependencies.setError(null)
    await action(name, f.dependencies)()
    assert.equal(f.errors.at(-1), 'stream failed\nsave failed')
    assert.deepEqual(f.notes, [null])
  })
}

function poller(dependencies) {
  const start = source.indexOf('      const pollUntilDone = useCallback(')
  const end = source.indexOf('\n      }, [])', start) + '\n      }, [])'.length
  assert.ok(start >= 0 && end > start)
  return new Function('useCallback', ...Object.keys(dependencies), `${source.slice(start, end)}; return pollUntilDone`)(
    (callback) => callback, ...Object.values(dependencies),
  )
}

test('live and retained no-IP outcomes both survive polling', async () => {
  const final = { runId: 'test-run', stage: 'failed', reasonCode: 'NO_USABLE_IP' }
  for (const value of [{ progress: final }, { progress: null, lastRun: final }]) {
    const errors = []
    const poll = poller({ call: async () => value, setError: (value) => errors.push(value) })
    assert.deepEqual(await poll(() => {}, final.runId), final)
  }
})

test('poll failures propagate to the action instead of being cleared by load', async () => {
  const poll = poller({ call: async () => { throw new Error('poll failed') }, setError: () => {} })
  await assert.rejects(poll(() => {}, 'test-run'), /poll failed/)
})

async function renderPanel(state, language = 'zh', { interactive = false, call } = {}) {
  let panel, dictionaries, hookIndex = 0
  const values = [], effects = []
  const react = {
    createElement: (type, props, ...children) => typeof type === 'function'
      ? type({ ...props, children: children.flat(Infinity) })
      : { type, props: props ?? {}, children: children.flat(Infinity) },
    useState(initial) {
      const index = hookIndex++
      if (!(index in values)) values[index] = initial
      return [values[index], (value) => { values[index] = value }]
    },
    useEffect: (callback) => effects.push(callback),
    useCallback: (callback) => callback,
  }
  const locale = {
    register: (_namespace, dicts) => { dictionaries = dicts },
    bind: () => (key) => key.split('.').reduce((value, part) => value?.[part], dictionaries[language]),
  }
  const ctx = {
    get: () => locale,
    inject: (_services, callback) => callback({ locale, effect: (callback) => callback() }),
    slots: { inject: (_name, callback) => callback(), register: (_options, component) => { panel = component } },
  }
  new Function('window', 'fetch', 'setTimeout', source)(
    { __ModuleLoader__: { load: ({ factory }) => factory(() => react).apply(ctx) } },
    async (url, options) => ({ ok: true, json: async () => ({ ok: true, value: call ? await call(url.replace('/api/dsh-best-ip', ''), JSON.parse(options.body)) : state }) }),
    (callback) => queueMicrotask(callback),
  )
  const t = locale.bind()
  panel({ t })
  effects[0]()
  await new Promise((resolve) => setImmediate(resolve))
  const render = () => { hookIndex = 0; return panel({ t }) }
  return interactive ? { render } : render()
}

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...tree.children.flatMap(nodes)]
}

test('reopened empty results show no valid IP, not the initial invitation or a blank table', async () => {
  const state = { enabled: true, servers: [], defaultSelection: { provider: 'p1', model: 'm1' } }
  for (const [language, label] of [['zh', '无有效IP地址'], ['en', 'No valid IP address.']]) {
    const tree = await renderPanel({ ...state, measurements: [{ provider: 'p1', hostname: 'api.example.test', candidates: [], probedAt: 1 }] }, language)
    assert.ok(nodes(tree).some((node) => node.props.role === 'status' && node.children.includes(label)))
    assert.ok(!nodes(tree).some((node) => node.type === 'table'), 'empty results must not leave a blank table')
  }
  for (const measurements of [[], [{ provider: 'p1', hostname: 'api.example.test', candidates: [{ ip: '203.0.113.1' }] }]]) {
    const tree = await renderPanel({ ...state, measurements })
    assert.ok(!nodes(tree).some((node) => node.children.includes('无有效IP地址')))
  }
})

test('cancelled empty discovery remains stopped rather than claiming no valid IP', async () => {
  const f = fixture()
  f.dependencies.pollUntilDone = async () => ({ stage: 'stopped' })
  f.dependencies.load = async () => f.dependencies.setError(null)
  await action('runAutoTest', f.dependencies)(false)
  assert.equal(f.errors.at(-1), null)
  assert.equal(f.notes.at(-1), 'stoppedHint')
  const tree = await renderPanel({
    enabled: true, servers: [], defaultSelection: { provider: 'p1' },
    measurements: [{ provider: 'p1', hostname: 'api.example.test', candidates: [], stopped: true }],
  })
  assert.ok(!nodes(tree).some((node) => node.children.includes('无有效IP地址')))
  assert.ok(nodes(tree).some((node) => node.props.role === 'status' && node.children.includes('已停止，已完成的样本已保留；当前地址未改变。')))
})

test('current-address testing is always non-applying', async () => {
  const f = fixture()
  await action('runTimeCurrent', f.dependencies)()
  assert.equal(f.requests[0].path, '/time')
  assert.equal(f.requests[0].payload.testOnly, true)
})

test('manual apply and clear remain explicit actions without a mode switch', async () => {
  const f = fixture()
  await action('choose', f.dependencies)('203.0.113.1')
  await action('forget', f.dependencies)()
  assert.deepEqual(f.requests.map((entry) => [entry.path, entry.payload.testOnly]), [['/select', false], ['/forget', false]])
})

for (const limit of [0, 10, 7]) {
  for (const testOnly of [true, false]) {
    test(`automatic action uses the current IP limit ${limit}, independently of apply mode ${testOnly}`, async () => {
      const f = fixture()
      f.dependencies.draft.maxBenchmarkIps = limit
      await action('runAutoTest', f.dependencies)(testOnly)
      assert.equal(f.requests[0].payload.maxBenchmarkIps, limit)
      assert.equal(f.requests[0].payload.testOnly, testOnly)
    })
  }
}

test('invalid custom IP limit cannot start an automatic action', async () => {
  const f = fixture()
  f.dependencies.benchmarkIpLimitInvalid = true
  await action('runAutoTest', f.dependencies)(false)
  assert.equal(f.requests.length, 0)
  assert.deepEqual(f.running, [])
})

const panelState = { enabled: true, servers: [], measurements: [], defaultSelection: { provider: 'p1', model: 'm1' } }
const limitSelect = (tree) => nodes(tree).find((node) => node.type === 'select')
const customLimitInput = (tree) => nodes(tree).find((node) => node.type === 'input' && node.props.type === 'number')
const buttonWithText = (tree, text) => nodes(tree).find((node) => node.type === 'button' && node.children.includes(text))

test('the IP limit beside automatic actions offers only 10, custom and all, defaulting to all', async () => {
  for (const [language, labels] of [['zh', ['10 个', '任意（自定义）', '全部']], ['en', ['10 IPs', 'Custom', 'All']]]) {
    const tree = await renderPanel(panelState, language)
    const select = limitSelect(tree)
    assert.equal(select.props.value, '0')
    assert.deepEqual(select.children.map((node) => node.props.value), ['10', 'custom', '0'])
    assert.deepEqual(select.children.map((node) => node.children[0]), labels)
    assert.ok(select.props['aria-label'])
    const label = nodes(tree).find((node) => node.children.includes(select))
    assert.ok(nodes(tree).some((node) => node.children.includes(label) && node.children.some((child) => child?.type === 'button' && child.children.includes(language === 'zh' ? '自动测速' : 'Auto speed test'))), 'the selector belongs beside the automatic buttons')
  }
})

test('saved arbitrary limits reopen as custom, with positive-integer input constraints', async () => {
  for (const limit of [5, 7, 20, 161]) {
    const tree = await renderPanel({ ...panelState, maxBenchmarkIps: limit })
    assert.equal(limitSelect(tree).props.value, 'custom')
    const input = customLimitInput(tree)
    assert.equal(input.props.value, limit)
    assert.equal(input.props.min, 1)
    assert.equal(input.props.step, 1)
    assert.equal(input.props['aria-invalid'], false)
  }
  const tree = await renderPanel({ ...panelState, maxBenchmarkIps: 10 })
  assert.equal(limitSelect(tree).props.value, '10')
  assert.equal(customLimitInput(tree), undefined)
})

test('custom editing keeps the custom field visible for 10 and refuses blank/zero/fractional/negative input', async () => {
  const ui = await renderPanel(panelState, 'zh', { interactive: true })
  limitSelect(ui.render()).props.onChange({ target: { value: 'custom' } })
  for (const value of ['', '0', '-1', '1.5', '1e20']) {
    customLimitInput(ui.render()).props.onChange({ target: { value } })
    const tree = ui.render()
    assert.equal(limitSelect(tree).props.value, 'custom')
    assert.equal(customLimitInput(tree).props['aria-invalid'], true)
    for (const label of ['自动测速', '自动测速并应用']) assert.equal(buttonWithText(tree, label).props.disabled, true)
    const save = buttonWithText(tree, '保存')
    if (save) assert.equal(save.props.disabled, true)
    assert.ok(nodes(tree).some((node) => node.props.role === 'alert' && node.children.includes('请输入正整数 IP 数量。')))
  }
  customLimitInput(ui.render()).props.onChange({ target: { value: '10' } })
  assert.equal(limitSelect(ui.render()).props.value, 'custom', 'typing a preset number must not hide the input mid-edit')
  assert.equal(customLimitInput(ui.render()).props['aria-invalid'], false)
  limitSelect(ui.render()).props.onChange({ target: { value: '0' } })
  assert.equal(customLimitInput(ui.render()), undefined)
  assert.equal(buttonWithText(ui.render(), '自动测速').props.disabled, false)
})

test('selecting a limit takes effect on a click even before saving, and controls lock during the run', async () => {
  const requests = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ui = await renderPanel(panelState, 'zh', { interactive: true, call: async (path, payload) => {
    requests.push({ path, payload })
    if (path === '/auto') { await gate; return { runId: 'test-run' } }
    if (path === '/progress') return { progress: { runId: 'test-run', stage: 'done', applied: false, recommended: '203.0.113.1' } }
    return panelState
  } })
  limitSelect(ui.render()).props.onChange({ target: { value: '10' } })
  const run = buttonWithText(ui.render(), '自动测速').props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  try {
    assert.equal(requests.find((entry) => entry.path === '/auto').payload.maxBenchmarkIps, 10)
    assert.equal(requests.some((entry) => entry.path === '/save'), false)
    assert.equal(limitSelect(ui.render()).props.disabled, true)
  } finally {
    release()
    await run
  }
  assert.equal(limitSelect(ui.render()).props.disabled, false)
})

test('save includes the chosen custom IP limit and reopens the confirmed value', async () => {
  let saved = { ...panelState, maxBenchmarkIps: 0 }
  const requests = []
  const ui = await renderPanel(saved, 'zh', { interactive: true, call: async (path, payload) => {
    requests.push({ path, payload })
    if (path === '/save') saved = { ...saved, maxBenchmarkIps: payload.maxBenchmarkIps }
    return saved
  } })
  limitSelect(ui.render()).props.onChange({ target: { value: 'custom' } })
  customLimitInput(ui.render()).props.onChange({ target: { value: '7' } })
  await buttonWithText(ui.render(), '保存').props.onClick()
  assert.equal(requests.find((entry) => entry.path === '/save').payload.maxBenchmarkIps, 7)
  assert.equal(limitSelect(ui.render()).props.value, 'custom')
  assert.equal(customLimitInput(ui.render()).props.value, 7)
})

const costDetailsIcon = (tree) => nodes(tree).find((node) => node.type === 'button' && node.children.includes('!'))
const renderedText = (tree) => nodes(tree).flatMap((node) => node.children.filter((child) => typeof child === 'string')).join(' ')

test('compact token hints retain configured calculations only in the hover details', async () => {
  for (const [config, total, summaries] of [
    [{}, '122,880', { zh: '全部最多约12w token', en: 'All: up to about 120k tokens' }],
    [{ maxBenchmarkIps: 10 }, '7,680', { zh: '10 个最多约7,680 token', en: '10 IPs: up to about 7,680 tokens' }],
    [{ maxBenchmarkIps: 7 }, '5,376', { zh: '7 个最多约5,376 token', en: '7 IPs: up to about 5,376 tokens' }],
    [{ maxCandidates: 32, benchmarkRuns: 2, benchmarkMaxTokens: 128 }, '8,192', { zh: '全部最多约8,192 token', en: 'All: up to about 8,192 tokens' }],
  ]) {
    for (const language of ['zh', 'en']) {
      const tree = await renderPanel({ ...panelState, ...config }, language)
      const icon = costDetailsIcon(tree)
      assert.ok(icon)
      assert.equal(icon.props.type, 'button')
      assert.ok(icon.props['aria-label'])
      assert.equal(icon.props['aria-description'], icon.props.title)
      assert.equal(icon.props.style.borderRadius, '50%')
      assert.ok(icon.props.title.includes(total), `missing ${total} in hover details for ${language}`)
      assert.match(icon.props.title, /输入 token|input tokens/)
      if (!config.maxBenchmarkIps) assert.match(icon.props.title, /DNS/)
      const summary = nodes(tree).find((node) => node.children.includes(summaries[language]))
      assert.ok(summary, `missing compact summary for ${language}`)
      assert.ok(nodes(tree).some((node) => node.children.includes(summary) && node.children.includes(icon)), 'details icon stays next to the summary')
      assert.ok(!renderedText(tree).includes(icon.props.title), 'long calculation must not appear inline')
      assert.equal(icon.props.onClick, undefined, 'details icon must not trigger a test or save')
    }
  }
})

test('default hover text preserves the complete requested estimate and caveats', async () => {
  const tree = await renderPanel(panelState)
  assert.equal(costDetailsIcon(tree).props.title,
    '按 160 个有效 IP × 每 IP 3 次 × 每次最多 256 输出 token 估算：约 122,880 输出 token 预算，另计输入 token。实际消耗取决于有效 IP 数和输出长度。 “全部”以额外扫描上限 160 个 IP 为例；DNS 返回地址和上次已选 IP 不计入扫描上限，实际 IP 数可能更多。')
  assert.ok(renderedText(tree).includes('全部最多约12w token'))
  assert.ok(!renderedText(tree).includes('按 160 个有效 IP'))
})

test('editing the limit updates both compact and hover text, and invalid input hides the estimate', async () => {
  const ui = await renderPanel(panelState, 'zh', { interactive: true })
  limitSelect(ui.render()).props.onChange({ target: { value: '10' } })
  assert.ok(renderedText(ui.render()).includes('10 个最多约7,680 token'))
  assert.match(costDetailsIcon(ui.render()).props.title, /按 10 个有效 IP/)
  assert.doesNotMatch(costDetailsIcon(ui.render()).props.title, /DNS/)
  limitSelect(ui.render()).props.onChange({ target: { value: 'custom' } })
  customLimitInput(ui.render()).props.onChange({ target: { value: '7' } })
  assert.ok(renderedText(ui.render()).includes('7 个最多约5,376 token'))
  assert.match(costDetailsIcon(ui.render()).props.title, /按 7 个有效 IP/)
  customLimitInput(ui.render()).props.onChange({ target: { value: '' } })
  assert.equal(costDetailsIcon(ui.render()), undefined)
  limitSelect(ui.render()).props.onChange({ target: { value: '0' } })
  assert.ok(renderedText(ui.render()).includes('全部最多约12w token'))
  assert.match(costDetailsIcon(ui.render()).props.title, /DNS/)
})

function translator(language = 'en') {
  const start = source.indexOf(`    const ${language} = {`)
  const end = source.indexOf('\n    }\n', start) + '\n    }'.length
  const dict = new Function(`${source.slice(start, end)}; return ${language}`)()
  return (key) => key.split('.').reduce((value, part) => value?.[part], dict)
}

function renderComponent(name, props, language = 'en') {
  const h = (type, attributes, ...children) => typeof type === 'function'
    ? type({ ...attributes, children: children.flat(Infinity) })
    : { type, props: attributes ?? {}, children: children.flat(Infinity) }
  const dependencies = { h, S: resultStyles(), sampleSlots: helper('sampleSlots'), sampleValues: helper('sampleValues'), sampleDetails: helper('sampleDetails') }
  dependencies.ResultScore = helper('ResultScore', dependencies)
  dependencies.SampleBadges = helper('SampleBadges', dependencies)
  return helper(name, dependencies)({ ...props, t: translator(language) })
}

const rawRun = (tps = 100, extra = {}) => ({ tps, ttftMs: 50, totalMs: 1050, decodeMs: 1000, outputTokens: 100, usageReported: true, ...extra })
const reliableSummary = (count = 3, options = {}) => summarize(Array.from({ length: count }, () => rawRun()), { plannedRuns: 3, ...options })
const measuredState = (benchmarks, extra = {}) => ({ ...panelState, measurements: [{
  provider: 'p1', hostname: 'api.example.test', candidates: Object.keys(benchmarks).map((ip, index) => ({ ip, rtt: index + 10, colo: 'TEST' })),
  benchmarks, ...extra,
}] })
const applyButtons = (tree) => nodes(tree).filter((node) => node.type === 'button' && node.props.className === 'dsh-best-ip-result-apply')

// Execute only the server's pure comparator declaration, never its module/profile/bootstrap.
test('the complete client ordering tuple matches the current server across versions and non-finite values', () => {
  const ordered = helper('orderedCandidates')
  const serverOrdered = helper('orderCandidates', { SCORING_VERSION: 2 }, serverSource)
  const versions = [undefined, 1, 2, 3, '2']
  const numbers = [undefined, null, 0, 10, 100, NaN, Infinity, -Infinity]
  const candidates = [], benchmarks = {}
  for (let index = 0; index < 120; index++) {
    const ip = `node-${String(index).padStart(3, '0')}`
    candidates.push({ ip, rtt: numbers[(index * 3) % numbers.length] })
    benchmarks[ip] = {
      scoringVersion: versions[index % versions.length], historical: index % 7 === 0,
      samples: index % 3 ? [{}] : [], eliminated: index % 11 === 0,
      stabilityScore: numbers[index % numbers.length], tps: index % 2 ? 500 : null,
      reliableRuns: numbers[(index + 1) % numbers.length], effectiveTps: numbers[(index + 2) % numbers.length],
      conservativeTps: numbers[(index + 3) % numbers.length], ttftMs: numbers[(index + 4) % numbers.length],
    }
  }
  const before = structuredClone({ candidates, benchmarks })
  for (const input of [candidates, [...candidates].reverse(), [...candidates.slice(37), ...candidates.slice(0, 37)]]) {
    assert.deepEqual(ordered(input, benchmarks), serverOrdered(input, benchmarks))
  }
  assert.deepEqual({ candidates, benchmarks }, before)
})

for (const [field, better] of [['stabilityScore', 101], ['reliableRuns', 4], ['effectiveTps', 101], ['conservativeTps', 91], ['ttftMs', 49]]) {
  test(`v2 sorting honors ${field} before later tuple fields and RTT`, () => {
    const base = { scoringVersion: 2, stabilityScore: 100, reliableRuns: 3, effectiveTps: 100, conservativeTps: 90, ttftMs: 50 }
    const candidates = [{ ip: 'b', rtt: 1 }, { ip: 'a', rtt: 100 }]
    const result = helper('orderedCandidates')(candidates, { a: { ...base, [field]: better }, b: base })
    assert.deepEqual(result.map((row) => row.ip), ['a', 'b'])
  })
}

test('all legacy and historical v2 score fields are neutral; only RTT and IP order their tier', () => {
  for (const version of [undefined, 0, 1, 3, '2', 2]) {
    const legacy = { scoringVersion: version, historical: version === 2, samples: [{}], tps: 1 }
    const rows = {
      a: { ...legacy, stabilityScore: 1e9, reliableRuns: 1e9, effectiveTps: 1e9, conservativeTps: 1e9, ttftMs: 0 },
      b: { ...legacy, stabilityScore: 0, reliableRuns: 0, effectiveTps: 0, conservativeTps: 0, ttftMs: 1e9 },
    }
    assert.deepEqual(helper('orderedCandidates')([{ ip: 'a', rtt: 20 }, { ip: 'b', rtt: 10 }], rows).map((row) => row.ip), ['b', 'a'])
    assert.deepEqual(helper('orderedCandidates')([{ ip: 'b', rtt: 10 }, { ip: 'a', rtt: 10 }], rows).map((row) => row.ip), ['a', 'b'])
  }
})

test('v2 RTT treats NaN and either infinity as missing, with IP as the final tie-break', () => {
  const candidates = [{ ip: 'e', rtt: -Infinity }, { ip: 'd', rtt: NaN }, { ip: 'c', rtt: Infinity }, { ip: 'b' }, { ip: 'a', rtt: 50 }]
  const rows = Object.fromEntries(candidates.map(({ ip }) => [ip, { scoringVersion: 2, stabilityScore: 100 }]))
  assert.deepEqual(helper('orderedCandidates')(candidates, rows).map((row) => row.ip), ['a', 'b', 'c', 'd', 'e'])
})

test('slot placeholders follow real samples, distinguishing skipped from pending without mutating the summary', () => {
  const bench = { samples: [{ tps: 120 }, { error: 'timeout' }], plannedRuns: 5, skippedRuns: 2, pendingRuns: 1, skippedReason: 'optimistic-bound' }
  const before = structuredClone(bench), t = (key) => key
  assert.equal(helper('sampleValues')(bench, t), '(120.0, sampleFailed, sampleSkipped, sampleSkipped, sampleMissing)')
  const slots = helper('sampleSlots')(bench)
  assert.equal(slots[0].sample, bench.samples[0])
  assert.equal(slots[1].sample, bench.samples[1])
  assert.ok(slots.slice(2).every((slot) => slot.sample === undefined))
  const details = helper('sampleDetails')(bench, t).split('\n')
  assert.deepEqual(details.slice(2), ['run3: sampleSkipped; optimistic-bound', 'run4: sampleSkipped; optimistic-bound', 'run5: sampleMissing'])
  assert.deepEqual(bench, before)
  assert.equal(helper('sampleValues')({ plannedRuns: 1, samples: [{ tps: 1 }, { tps: 2 }] }, t), '(1.0, 2.0)', 'a smaller plan never hides real attempts')
})

test('high-capped samples retain raw TPS, scoring TPS, reliability, timeout and non-failure explanations', () => {
  const scoringContext = buildScoringContext([[rawRun(100), rawRun(100)], [rawRun(110), rawRun(110)], [rawRun(120), rawRun(10000)]])
  const bench = summarize([rawRun(120), rawRun(10000, { timeoutMs: 12000 })], { plannedRuns: 3, scoringContext })
  assert.equal(bench.samples[1].reliable, true)
  assert.ok(bench.samples[1].flags.includes('high-capped'))
  assert.equal(bench.failed, 0)
  for (const language of ['en', 'zh']) {
    const t = translator(language), details = helper('sampleDetails')(bench, t)
    assert.equal(helper('sampleValues')(bench, t), `(120.0, 10000.0⚠, ${t('sampleMissing')})`)
    assert.ok(details.includes(`${t('scoredTps')}: ${scoringContext.speedCap}`))
    assert.ok(details.includes('10000 TPS'))
    assert.ok(details.includes(`${t('timeoutBudget')}: 12000 ms`))
    assert.ok(details.includes(t('sampleReasons.high-capped')))
    assert.match(t('sampleReasons.high-capped'), /not a request failure|不是请求失败/)
    const score = renderComponent('ResultScore', { bench }, language)
    assert.ok(renderedText(score).includes(`2 ${t('successfulSamples')} · 0 ${t('failedSamples')} · 2 ${t('reliableSamples')}`))
  }
})

test('legacy high-outlier flags are clearly legacy, while low-tail diagnostics retain their real values', () => {
  const bench = { scoringVersion: 1, samples: [{ tps: 10000, flags: ['high-outlier'] }, { tps: 1, flags: ['low-tail'] }] }
  for (const language of ['en', 'zh']) {
    const t = translator(language)
    assert.equal(helper('sampleValues')(bench, t), '(10000.0⚠, 1.0⚠)')
    const details = helper('sampleDetails')(bench, t)
    assert.match(details, /legacy high-outlier|旧版高值异常/)
    assert.ok(details.includes(t('sampleReasons.low-tail')))
    assert.ok(renderedText(renderComponent('ResultScore', { bench }, language)).includes(t('legacyRecord')))
  }
})

test('cancelled samples never become failed badges, counts or unusable TTFT', () => {
  const bench = summarize([{ cancelled: true, error: 'test stopped' }], { plannedRuns: 3 })
  for (const language of ['en', 'zh']) {
    const t = translator(language)
    assert.equal(helper('sampleValues')(bench, t), `(${t('sampleStopped')}, ${t('sampleMissing')}, ${t('sampleMissing')})`)
    assert.ok(!helper('sampleDetails')(bench, t).includes(`${t('sampleFailed')};`))
    assert.ok(renderedText(renderComponent('ResultScore', { bench }, language)).includes(`0 ${t('successfulSamples')} · 0 ${t('failedSamples')}`))
    const timing = renderedText(renderComponent('ResultTiming', { row: { rtt: 20 }, bench }, language))
    assert.ok(timing.includes(`${t('ttft')}: ${t('sampleStopped')}`))
    assert.ok(!timing.includes(t('unusable')))
  }
})

test('empty samples do not invent a badge, while planned unstarted slots stay not-tested', () => {
  assert.equal(renderComponent('SampleBadges', { bench: { samples: [] } }), null)
  const tree = renderComponent('SampleBadges', { bench: { samples: [], plannedRuns: 3, pendingRuns: 3 } })
  const badges = tree.children
  assert.equal(badges.length, 3)
  assert.ok(badges.every((badge) => badge.children.includes('not tested')))
  assert.ok(!renderedText(tree).includes('failed'))
  assert.equal(helper('sampleValues')({ tps: 100, plannedRuns: 3 }, translator()), 'individual samples unavailable; retest')
})

for (const [status, bench] of [
  ['confirmed', reliableSummary(3)],
  ['provisional', reliableSummary(1)],
  ['provisional', reliableSummary(2)],
  ['eliminated', summarize([rawRun()], { plannedRuns: 3, skippedRuns: 2, skippedReason: 'optimistic-bound' })],
  ['legacyRecord', { ...reliableSummary(3), scoringVersion: 1 }],
  ['legacyRecord', { ...reliableSummary(3), historical: true, benchmarkId: 'old-cohort' }],
]) {
  test(`score status is ${status} for ${bench.historical ? 'historical v2' : `version ${bench.scoringVersion}, ${bench.runs} real attempts`}`, () => {
    const t = translator(), tree = renderComponent('ResultScore', { bench })
    assert.ok(renderedText(tree).includes(t(status)))
    assert.ok(renderedText(tree).includes(bench.stabilityScore.toFixed(1)), 'a provisional or legacy number is shown but explicitly qualified')
    if (status === 'provisional' && bench.reliableRuns < 2) assert.ok(renderedText(tree).includes(t('samplesInsufficient')))
    if (status === 'legacyRecord') assert.equal(tree.props.title, t('legacyRecord') + `\n${t('measurementConfidence')}: 100%`)
  })
}

test('live rows use complete server summaries and a shared context, preserving server rank order mid-round', () => {
  const groups = [[rawRun(100), rawRun(100)], [rawRun(110), rawRun(110)], [rawRun(120), rawRun(10000)]]
  const context = buildScoringContext(groups)
  const rows = groups.map((runs, index) => ({
    ip: `node-${index}`, rank: [7, 2, 9][index], colo: 'TEST', summary: summarize(runs, { plannedRuns: 3, scoringContext: context }),
    runs: [{ tps: 999999, error: 'decoy reduced payload' }],
  }))
  const before = structuredClone(rows)
  const tree = renderComponent('RunsTable', { progress: { stage: 'confirm', round: 2, rounds: 3, rows, scoringContext: context } })
  const bodyRows = nodes(tree).find((node) => node.type === 'tbody').children
  assert.deepEqual(bodyRows.map((row) => row.children[0].children[0].children[0]), ['7. node-0', '2. node-1', '9. node-2'])
  assert.deepEqual(bodyRows.map((row) => row.children[0].children[1]?.children[0]), ['TEST', 'TEST', 'TEST'])
  assert.equal(bodyRows[2].children[3].children[0], '10000.0⚠')
  assert.ok(bodyRows[2].children[3].props.title.includes(`TPS used for scoring: ${context.speedCap}`))
  assert.ok(!renderedText(tree).includes('999999'))
  for (let index = 0; index < rows.length; index++) {
    const score = bodyRows[index].children[1].children[0]
    assert.ok(renderedText(score).includes(rows[index].summary.stabilityScore.toFixed(1)))
    assert.ok(score.props.title.includes(`Shared speed reference: ${context.speedReference} TPS`))
    assert.ok(score.props.title.includes(`Shared speed cap: ${context.speedCap} TPS`))
    assert.equal(bodyRows[index].children.at(-1).children[0], 'not tested')
  }
  assert.deepEqual(rows, before)
})

test('live skipped slots do not look like failures and summary plans can extend the live columns', () => {  const summary = summarize([rawRun(100), { error: 'timeout', timeoutMs: 30000 }], { plannedRuns: 5, skippedRuns: 2, skippedReason: 'optimistic-bound' })
  const tree = renderComponent('RunsTable', { progress: { round: 3, rounds: 3, rows: [{ ip: 'tail', rank: 4, summary }] } })
  const row = nodes(tree).find((node) => node.type === 'tbody').children[0]
  assert.deepEqual(row.children.slice(2).map((cell) => cell.children[0]), ['100.0', 'failed', 'skipped', 'skipped', 'not tested'])
  assert.match(row.children[4].props.title, /optimistic-bound/)
  assert.ok(renderedText(row.children[1]).includes('1 successful · 1 failed · 1 reliable'))
  assert.ok(renderedText(row.children[1]).includes('Eliminated / skipped'))
})

test('old live snapshots still show real attempts, not an invented v2 score', () => {
  const tree = renderComponent('RunsTable', { progress: { rounds: 3, rows: [{ ip: 'old', runs: [{ tps: 12 }, { error: 'timeout' }] }] } })
  const row = nodes(tree).find((node) => node.type === 'tbody').children[0]
  assert.deepEqual(row.children.slice(2).map((cell) => cell.children[0]), ['12.0', 'failed', 'not tested'])
  assert.ok(renderedText(row.children[1]).includes('—'))
})

test('reduced current-address and legacy live cancellation payloads stay stopped, not failed', () => {
  const sample = { tps: null, error: 'test stopped' }
  const tree = renderComponent('RunsTable', { progress: { rounds: 3, rows: [{ ip: 'current', runs: [sample] }] } })
  const row = nodes(tree).find((node) => node.type === 'tbody').children[0]
  assert.deepEqual(row.children.slice(2).map((cell) => cell.children[0]), ['stopped', 'not tested', 'not tested'])
  assert.match(row.children[2].props.title, /stopped/)
  assert.ok(!row.children[2].props.title.includes('failed'))
  const bench = { samples: [sample], eligible: false, error: 'test stopped' }
  assert.ok(renderedText(renderComponent('ResultTiming', { row: { rtt: 10 }, bench })).includes('First token: stopped'))
  assert.ok(renderedText(renderComponent('ResultScore', { bench })).includes('0 successful · 0 failed · 0 reliable'))
})

test('real transport failures remain failures while technically unreliable successes remain successful requests', () => {
  const failed = summarize([{ error: 'timeout' }], { plannedRuns: 3 })
  assert.ok(renderedText(renderComponent('ResultTiming', { row: { rtt: 10 }, bench: failed })).includes('First token: unusable'))
  assert.ok(renderedText(renderComponent('ResultScore', { bench: failed })).includes('0 successful · 1 failed · 0 reliable'))
  const unreliable = summarize([rawRun(100, { outputTokens: 20, decodeMs: 100 })], { plannedRuns: 3 })
  const score = renderComponent('ResultScore', { bench: unreliable })
  assert.ok(renderedText(score).includes('1 successful · 0 failed · 0 reliable'))
  assert.ok(renderedText(score).includes('insufficient reliable samples'))
  const badges = renderComponent('SampleBadges', { bench: unreliable })
  assert.ok(badges.children[0].children.includes('100.0⚠'))
  assert.match(badges.children[0].props.title, /fewer than 32 output tokens|decode window below 200 ms/)
})

test('uncalibrated provisional scores expose their shared default units and confidence', () => {
  const bench = reliableSummary(1)
  assert.equal(bench.measurementConfidence, 0.5)
  const score = renderComponent('ResultScore', { bench })
  assert.ok(score.props.title.includes('Shared speed reference: 100 TPS'))
  assert.ok(score.props.title.includes('Shared speed cap: not capped'))
  assert.ok(score.props.title.includes('Measurement confidence: 50%'))
  assert.ok(score.props.title.includes('Provisional calibration'))
  assert.ok(renderedText(score).includes('50.0'))
})

test('progress describes measured plus skipped budget, rounds and provisional leader without counting skips as failures', () => {
  const describe = helper('describeProgress'), t = translator()
  const progress = { round: 3, rounds: 3, timing: 10, skipped: 2, timingTotal: 12, leading: 'leader', rows: [{}, {}, {}, {}] }
  for (const stage of ['timing', 'confirm', 'stopping', 'stopped', 'done']) {
    const text = describe({ ...progress, stage }, t)
    assert.ok(text.includes('10 tested + 2 skipped / 12 planned'))
    assert.ok(text.includes('Round 3/3'))
    assert.ok(!text.includes('failed'))
    if (stage === 'timing' || stage === 'confirm') assert.ok(text.includes('Provisional leader: leader'))
  }
  assert.match(describe({ stage: 'timing' }, t), /0 tested \+ 0 skipped \/ 0 planned/)
  assert.match(describe({ stage: 'discover', resolvers: 4, resolversDone: 2 }, t), /2\/4/)
  assert.match(describe({ stage: 'scan', attempted: 20, total: 30, usable: 3 }, t), /20\/30 tried · 3 usable/)
})

for (const [name, bench] of [
  ['single reliable sample', reliableSummary(1)],
  ['legacy v1', { ...reliableSummary(3), scoringVersion: 1 }],
  ['historical v2 from another cohort', { ...reliableSummary(3), historical: true, benchmarkId: 'old' }],
  ['eliminated v2', { ...reliableSummary(3), eliminated: true, skippedRuns: 1 }],
]) {
  test(`${name} cannot turn a stale recommendation into a new leaderboard recommendation`, async () => {
    const tree = await renderPanel(measuredState({ '203.0.113.1': bench }, { recommended: '203.0.113.1' }), 'en')
    assert.equal(buttonWithText(tree, 'Apply recommended IP'), undefined)
    assert.ok(!nodes(tree).some((node) => node.children.includes('Recommended') || node.children.includes('Recommended: 203.0.113.1')))
    assert.equal(applyButtons(tree).length, 2, 'manual application remains available in table and card')
  })
}

test('client does not invent a formal recommendation from positive pending scores without a backend recommendation', async () => {
  const tree = await renderPanel(measuredState({ '203.0.113.1': reliableSummary(2) }), 'en')
  assert.equal(buttonWithText(tree, 'Apply recommended IP'), undefined)
  assert.ok(!nodes(tree).some((node) => node.children.includes('Recommended')))
  assert.ok(renderedText(tree).includes('Provisional'))
})

test('only the backend recommended IP is marked even when a single-sample provisional score ranks higher', async () => {
  const confirmed = reliableSummary(3)
  const provisional = { ...reliableSummary(1), stabilityScore: confirmed.stabilityScore * 100 }
  const tree = await renderPanel(measuredState({ '203.0.113.1': provisional, '203.0.113.2': confirmed }, { recommended: '203.0.113.2' }), 'en')
  const body = nodes(tree).find((node) => node.type === 'tbody')
  assert.ok(!renderedText(body.children[0]).includes('Recommended'))
  assert.ok(renderedText(body.children[1]).includes('Recommended'))
  const cards = nodes(tree).filter((node) => node.type === 'article')
  assert.ok(!renderedText(cards[0]).includes('Recommended'))
  assert.ok(renderedText(cards[1]).includes('Recommended'))
  assert.ok(buttonWithText(tree, 'Apply recommended IP').props.title.includes('203.0.113.2'))
})

test('table, card and shortcut really dispatch the same explicit manual action with incomplete warning titles', async () => {
  const requests = [], ip = '203.0.113.1'
  const state = measuredState({ [ip]: reliableSummary(2) }, { recommended: ip, stopped: true })
  const ui = await renderPanel(state, 'en', { interactive: true, call: async (path, payload) => { requests.push({ path, payload }); return state } })
  const buttons = applyButtons(ui.render())
  assert.equal(buttons.length, 3)
  for (const button of buttons) {
    assert.equal(button.props.disabled, false)
    assert.match(button.props.title, /Incomplete retest/)
    assert.ok(button.props['aria-label'].includes(ip))
    await button.props.onClick()
  }
  assert.deepEqual(requests.filter((request) => request.path === '/select'), Array.from({ length: 3 }, () => ({ path: '/select', payload: { host: 'api.example.test', provider: 'p1', ip, testOnly: false } })))
  assert.ok(renderedText(ui.render()).includes('Address applied manually before the full retest completed; this result is not confirmed.'))
})

test('legacy and historical manual apply warnings are advisory, not disabled controls', async () => {
  for (const bench of [{ ...reliableSummary(3), scoringVersion: 1 }, { ...reliableSummary(3), historical: true }]) {
    const requests = [], state = measuredState({ '203.0.113.1': bench })
    const ui = await renderPanel(state, 'en', { interactive: true, call: async (path, payload) => { requests.push({ path, payload }); return state } })
    for (const button of applyButtons(ui.render())) {
      assert.equal(button.props.disabled, false)
      assert.match(button.props.title, /Legacy record; retest required/)
      await button.props.onClick()
    }
    assert.equal(requests.filter((request) => request.path === '/select').length, 2)
    assert.ok(renderedText(ui.render()).includes('Address applied manually from a legacy record; retest with scoring v2 before relying on it.'))
  }
})

test('confirmed manual buttons have no early/legacy warning and selected rows show In use without a redundant action', () => {
  const bench = reliableSummary(3), chosen = []
  const button = renderComponent('ResultApply', { ip: 'ip', bench, disabled: false, onChoose: (ip) => chosen.push(ip) })
  assert.equal(button.props.title, 'Apply this address: ip')
  button.props.onClick()
  assert.deepEqual(chosen, ['ip'])
  const selected = renderComponent('ResultApply', { ip: 'ip', bench, selected: true })
  assert.equal(selected.type, 'span')
  assert.equal(renderedText(selected), '✓ In use')
})

test('manual apply save errors survive the state refresh', async () => {
  const f = fixture()
  f.dependencies.call = async () => ({ result: { saveError: 'could not save selected address' } })
  f.dependencies.load = async () => f.dependencies.setError(null)
  await action('choose', f.dependencies)('203.0.113.1')
  assert.equal(f.errors.at(-1), 'could not save selected address')
})

test('done without a recommendation explains insufficient evidence rather than recommending a dash', async () => {
  const f = fixture()
  f.dependencies.pollUntilDone = async () => ({ stage: 'done', recommended: undefined, applied: false })
  await action('runAutoTest', f.dependencies)()
  assert.equal(f.notes.at(-1), 'noRecommendationHint')
})

test('polling rejects both live and retained replacement IDs before exposing another run', async () => {
  for (const value of [{ progress: { runId: 'other', stage: 'done' } }, { progress: null, lastRun: { runId: 'other', stage: 'stopped' } }]) {
    const ticks = []
    const poll = poller({ call: async () => value })
    await assert.rejects(poll((progress) => ticks.push(progress), 'test-run'), /replaced by another run|outcome is no longer available/)
    assert.deepEqual(ticks, [])
  }
})

for (const name of ['runAutoTest', 'runTimeCurrent']) {
  test(`${name} preserves poll identity errors without refreshing away the failure`, async () => {
    const f = fixture(), loads = []
    f.dependencies.pollUntilDone = async () => { throw new Error('measurement was replaced by another run') }
    f.dependencies.load = async () => loads.push('load')
    await action(name, f.dependencies)()
    assert.deepEqual(loads, [])
    assert.equal(f.errors.at(-1), 'measurement was replaced by another run')
    assert.deepEqual(f.notes, [null])
  })
}

test('retained stopped summaries preserve real samples and sticky current-address results after refresh', async () => {
  const f = fixture(), results = [], sticky = [], summary = summarize([rawRun(), { cancelled: true, error: 'test stopped' }], { plannedRuns: 3 })
  f.dependencies.pollUntilDone = poller({ call: async () => ({ progress: null, lastRun: { runId: 'test-run', stage: 'stopped', address: '203.0.113.1', summary } }) })
  f.dependencies.setTimeResult = (value) => results.push(value)
  f.dependencies.setStickySummary = (value) => sticky.push(value)
  f.dependencies.load = async () => f.dependencies.setError(null)
  await action('runTimeCurrent', f.dependencies)()
  assert.deepEqual(results.at(-1), { ip: '203.0.113.1', runs: 3, summary })
  assert.deepEqual(sticky.at(-1), results.at(-1))
  assert.equal(f.notes.at(-1), 'stoppedHint')
  assert.equal(f.errors.at(-1), null)
  assert.equal(results.at(-1).summary.samples.length, 2)
  assert.equal(results.at(-1).summary.failed, 0)
})

// Gate the second mocked poll: the panel stays live without a timer, network or server.
test('live v2 progress renders round summaries while every apply surface is locked until the terminal poll', async () => {
  const ip = '203.0.113.1', summary = reliableSummary(3), state = measuredState({ [ip]: summary }, { recommended: ip })
  let release, pollCount = 0
  const gate = new Promise((resolve) => { release = resolve })
  const live = { runId: 'test-run', stage: 'confirm', round: 3, rounds: 3, timing: 2, skipped: 1, timingTotal: 3, leading: ip,
    rows: [{ ip, rank: 1, summary: summarize([rawRun()], { plannedRuns: 3, skippedRuns: 1 }) }] }
  const ui = await renderPanel(state, 'en', { interactive: true, call: async (path) => {
    if (path === '/auto') return { runId: 'test-run' }
    if (path === '/progress') return ++pollCount === 1 ? { progress: live } : gate
    return state
  } })
  const running = buttonWithText(ui.render(), 'Auto speed test').props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  try {
    const tree = ui.render()
    assert.ok(renderedText(tree).includes('2 tested + 1 skipped / 3 planned · Round 3/3'))
    assert.ok(renderedText(tree).includes(`Provisional leader: ${ip}`))
    assert.ok(applyButtons(tree).every((button) => button.props.disabled))
    assert.equal(limitSelect(tree).props.disabled, true)
    assert.equal(buttonWithText(tree, 'Stop test').props.disabled, false)
  } finally {
    release({ progress: { ...live, stage: 'done', applied: false, recommended: ip } })
    await running
  }
  assert.ok(applyButtons(ui.render()).every((button) => !button.props.disabled))
})
