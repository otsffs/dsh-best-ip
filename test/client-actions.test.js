// Test real actions and render the panel with lightweight injected React hooks.
// No browser, network request or installed plugin is involved.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

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

function helper(name) {
  const start = source.indexOf(`    function ${name}(`)
  assert.notEqual(start, -1)
  const end = source.indexOf('\n    }\n', start) + '\n    }'.length
  assert.ok(end > start)
  return new Function(`${source.slice(start, end)}; return ${name}`)()
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

test('client orders robust eligible candidates before unstable high medians and legacy results', () => {
  const ordered = helper('orderedCandidates')
  const candidates = [{ ip: 'a', rtt: 1 }, { ip: 'b', rtt: 20 }, { ip: 'c', rtt: 30 }, { ip: 'd', rtt: 0 }]
  const rows = { a: { rankEligible: false, tps: 10000, samples: [{}] },
    b: { rankEligible: true, scoringVersion: 1, stabilityScore: 100 },
    c: { rankEligible: true, scoringVersion: 1, stabilityScore: 90 }, d: { tps: 99999 } }
  assert.deepEqual(ordered(candidates, rows).map((row) => row.ip), ['b', 'c', 'a', 'd'])
  assert.deepEqual(candidates.map((row) => row.ip), ['a', 'b', 'c', 'd'])
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
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
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
  new Function('window', 'fetch', source)(
    { __ModuleLoader__: { load: ({ factory }) => factory(() => react).apply(ctx) } },
    async (url, options) => ({ ok: true, json: async () => ({ ok: true, value: call ? await call(url.replace('/api/dsh-best-ip', ''), JSON.parse(options.body)) : state }) }),
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
    '按 160 个有效 IP × 每 IP 3 次 × 每次最多 256 输出 token 估算：约 122,880 输出 token 预算，另计输入 token。实际消耗取决于有效 IP 数和输出长度。 “全部”以额外扫描上限 160 个 IP 为例；DNS 返回的地址不计入扫描上限，实际 IP 数可能更多。')
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
