// Pure metadata/default/auth policy tests. Never mount DNS hooks, invoke native
// auth flows, read real credentials, or contact provider endpoints.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createProviderAccess, createDefaultFollower, loadHostCatalog } from '../providers.js'
import { privacyIssues } from '../scripts/check-package.mjs'

const PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
const alpha = { api: 'openai-responses', baseURL: 'https://alpha.example.test/v1', apiKeyEnv: 'ALPHA_API_KEY', models: [{ id: 'm1' }] }
const beta = { api: 'anthropic-messages', baseURL: 'https://beta.example.test/v1', apiKeyEnv: 'BETA_API_KEY', models: [{ id: 'm2' }] }
const emptyCatalog = { getBuiltinModel: () => undefined, getBuiltinModels: () => [], builtinProviders: () => [] }
function fixture({ profiles = { alpha, beta }, nativeAuth = {}, records = {}, refs = { ALPHA_API_KEY: 'fake-a', BETA_API_KEY: 'fake-b' }, catalog = emptyCatalog, env = {}, rawProfiles } = {}) {
  profiles = Object.fromEntries(Object.entries(profiles).map(([id, profile]) => [id, { models: [{ id: id === 'beta' ? 'm2' : 'm1' }], ...profile }]))
  const calls = { resolve: [], read: [], describeRecord: [], describe: [], settings: [] }
  let selection = { provider: 'alpha', model: 'm1' }, live = profiles
  const owner = { entry: { options: { id: 'model-settings', name: PACKAGE } }, inherited: {}, override: { providers: rawProfiles ?? profiles } }
  let directory = Object.keys(profiles).map((provider) => ({ provider, displayName: provider, settingsNs: 'model-settings', settingsPath: ['providers', provider], nativeAuth: nativeAuth[provider] }))
  const credentials = {
    describeRecord: async (key) => { calls.describeRecord.push(key); const record = records[key]; return { configured: Boolean(record), ...(record ? { kind: record.kind } : {}) } },
    describe: async (ref) => { calls.describe.push(ref); return { configured: Boolean(refs[ref]) } },
    resolve: async (ref) => { calls.resolve.push(ref); return refs[ref] ? { value: refs[ref], source: 'fixture' } : undefined },
    readRecord: async (key) => { calls.read.push(key); return records[key] },
  }
  const services = {
    agentDefaultModel: { currentSelection: () => structuredClone(selection) },
    configEditor: { configuration: () => [owner] },
    llm: { listConfigurableProviders: () => directory, listProviders: () => Object.keys(live).map((id) => ({ id, name: id })) },
    settings: { describe: (options) => { calls.settings.push(options); return [{ ns: 'model-settings', value: { providers: live } }] } },
    credentials,
  }
  const ctx = { get: (name) => services[name] }
  const access = createProviderAccess(ctx, { catalog, env })
  const profile = () => access.readProviderProfiles().get(selection?.provider)
  return { ctx, services, access, profile, calls, credentials,
    select(value) { selection = value }, setLive(value) { live = value }, setDirectory(value) { directory = value } }
}

test('exact DSH default wins over old personal route and model-list order', () => {
  const f = fixture({ profiles: { alpha: { ...alpha, models: [{ id: 'wrong-first' }, { id: 'm1' }] }, beta } })
  assert.deepEqual(f.access.readDefaultSelection(), { provider: 'alpha', model: 'm1', source: 'default' })
  assert.deepEqual([...f.access.readProviderProfiles().keys()], ['alpha'])
  assert.equal(f.profile().model, 'm1')
  f.select({ provider: 'beta', model: 'm2' })
  assert.deepEqual([...f.access.readProviderProfiles().keys()], ['beta'])
  assert.equal(f.profile().baseURL, beta.baseURL)
})

test('resolved/redacted settings beat raw inert profile expressions', () => {
  const f = fixture({ rawProfiles: { alpha: { baseURL: { __jsExpr: 'do not evaluate' }, api: { __jsExpr: 'protocol' } } } })
  assert.equal(f.profile().baseURL, alpha.baseURL)
  assert.equal(f.profile().api, 'openai-responses')
  assert.ok(f.calls.settings.every((options) => options.redactSecrets === true))
})

test('no default never falls back to the old configured first provider', async () => {
  const f = fixture(); f.select(undefined)
  assert.equal(f.access.readDefaultSelection(), undefined)
  assert.equal(f.access.readProviderProfiles().size, 0)
  assert.equal((await f.access.describeBenchmark(undefined)).supported, false)
})

test('native metadata is selected by exact model API and baseUrl, not a provider-wide guess', () => {
  const models = [{ id: 'm1', api: 'openai-responses', baseUrl: 'https://native.example.test/v1' }, { id: 'other', api: 'openai-completions', baseUrl: 'https://older.example.test/v1' }]
  const catalog = { getBuiltinModel: (provider, id) => provider === 'alpha' ? models.find((model) => model.id === id) : undefined,
    getBuiltinModels: () => models, builtinProviders: () => [{ id: 'alpha', name: 'Display label only', baseUrl: 'https://provider-default.example.test/v1' }] }
  const f = fixture({ profiles: { alpha: { apiKeyEnv: 'ALPHA_API_KEY' } }, catalog })
  assert.equal(f.profile().api, 'openai-responses')
  assert.equal(f.profile().baseURL, models[0].baseUrl)
  f.setLive({ alpha: { apiKeyEnv: 'ALPHA_API_KEY', models: [{ id: 'unknown' }] } })
  f.select({ provider: 'alpha', model: 'unknown' })
  assert.equal(f.profile().api, undefined)
  assert.equal(f.profile().benchmarkError, 'UNRESOLVED_ENDPOINT')
})

test('complete explicit profiles work without any installed native SDK catalog', () => {
  const f = fixture()
  assert.equal(f.profile().benchmarkError, undefined)
  assert.equal(f.profile().api, 'openai-responses')
})

test('another adapter namespace is never interpreted as OpenAI or pi-ai', async () => {
  const f = fixture()
  f.setDirectory([{ provider: 'alpha', settingsNs: 'different-adapter', settingsPath: [] }])
  assert.equal(f.profile().benchmarkError, 'UNSUPPORTED_ADAPTER')
  assert.equal((await f.access.describeBenchmark(f.profile())).supported, false)
  assert.equal(f.calls.resolve.length, 0)
})

test('OAuth capability does not reject an explicit API-key override or read the stored grant', async () => {
  const f = fixture({ nativeAuth: { alpha: { oauth: true, env: ['ALPHA_API_KEY'] } },
    records: { 'llm-pi-ai/alpha': { kind: 'grant', payload: 'must not be read' } }, refs: { ALPHA_API_KEY: 'fake-key' } })
  assert.deepEqual(await f.access.describeBenchmark(f.profile()), { supported: true, authType: 'api-key' })
  assert.equal(await f.access.resolveApiKey(f.profile()), 'fake-key')
  assert.deepEqual(f.calls.describeRecord, [])
  assert.deepEqual(f.calls.read, [])
})

test('stored OAuth is rejected without resolving, reading or refreshing its payload', async () => {
  const grant = { kind: 'grant', get payload() { throw new Error('OAuth payload must remain opaque') } }
  const f = fixture({ profiles: { alpha: { api: 'openai-responses', baseURL: alpha.baseURL } }, records: { 'llm-pi-ai/alpha': grant } })
  assert.deepEqual(await f.access.describeBenchmark(f.profile()), { supported: false, authType: 'oauth', reasonCode: 'OAUTH_UNSUPPORTED' })
  await assert.rejects(f.access.resolveApiKey(f.profile()), (error) => error.code === 'OAUTH_UNSUPPORTED')
  assert.deepEqual(f.calls.read, [])
  assert.deepEqual(f.calls.resolve, [])
})

test('a missing explicit key never falls back to a stored OAuth grant', async () => {
  const f = fixture({ refs: {}, records: { 'llm-pi-ai/alpha': { kind: 'grant' } } })
  await assert.rejects(f.access.resolveApiKey(f.profile()), (error) => error.code === 'MISSING_CREDENTIAL')
  assert.deepEqual(f.calls.read, [])
  assert.deepEqual(f.calls.describeRecord, [])
})

test('API-key record metadata is safe to display; its key is read only for a requested test', async () => {
  const f = fixture({ profiles: { alpha: { api: alpha.api, baseURL: alpha.baseURL } }, records: { 'llm-pi-ai/alpha': { kind: 'api-key', key: 'fake-native-key' } } })
  assert.equal((await f.access.describeBenchmark(f.profile())).supported, true)
  assert.deepEqual(f.calls.read, [])
  assert.equal(await f.access.resolveApiKey(f.profile()), 'fake-native-key')
  assert.deepEqual(f.calls.read, ['llm-pi-ai/alpha'])
})

test('an auth-mode race from API key to OAuth cannot send the grant as a key', async () => {
  const f = fixture({ profiles: { alpha: { api: alpha.api, baseURL: alpha.baseURL } }, records: { 'llm-pi-ai/alpha': { kind: 'api-key', key: 'fake-key' } } })
  f.credentials.readRecord = async () => ({ kind: 'grant', get payload() { throw new Error('opaque') } })
  await assert.rejects(f.access.resolveApiKey(f.profile()), (error) => error.code === 'OAUTH_UNSUPPORTED')
})

test('native env bundles are not guessed to be bearer API keys', async () => {
  const f = fixture({ profiles: { alpha: { api: alpha.api, baseURL: alpha.baseURL } }, records: { 'llm-pi-ai/alpha': { kind: 'api-key', env: { AWS_PROFILE: 'example' } } } })
  await assert.rejects(f.access.resolveApiKey(f.profile()), (error) => error.code === 'UNRESOLVED_AUTH')
})

test('Anthropic ambient bearer/OAuth wins over API_KEY metadata rather than being silently ignored', async () => {
  for (const [tokenRef, expected] of [['ANTHROPIC_AUTH_TOKEN', 'UNRESOLVED_AUTH'], ['ANTHROPIC_OAUTH_TOKEN', 'OAUTH_UNSUPPORTED']]) {
    const f = fixture({ profiles: { anthropic: { api: 'anthropic-messages', baseURL: beta.baseURL, models: [{ id: 'claude-test' }] } },
      nativeAuth: { anthropic: { env: ['ANTHROPIC_API_KEY'] } }, refs: { [tokenRef]: 'fake-token', ANTHROPIC_API_KEY: 'fake-api-key' } })
    f.select({ provider: 'anthropic', model: 'claude-test' })
    assert.equal((await f.access.describeBenchmark(f.profile())).reasonCode, expected)
    assert.deepEqual(f.calls.resolve, [])
  }
})

test('one unambiguous native API-key environment reference can be used', async () => {
  const f = fixture({ profiles: { alpha: { api: alpha.api, baseURL: alpha.baseURL } }, nativeAuth: { alpha: { env: ['ALPHA_API_KEY'], oauth: true } }, refs: { ALPHA_API_KEY: 'fake-key' } })
  assert.equal((await f.access.describeBenchmark(f.profile())).supported, true)
  assert.equal(await f.access.resolveApiKey(f.profile()), 'fake-key')
})

test('unsupported protocol and dynamic endpoint fail closed before key reads', async () => {
  const f = fixture({ profiles: { alpha: { api: 'openai-codex-responses', baseURL: alpha.baseURL, apiKeyEnv: 'ALPHA_API_KEY' } }, refs: { ALPHA_API_KEY: 'fake-key' } })
  assert.equal((await f.access.describeBenchmark(f.profile())).reasonCode, 'UNSUPPORTED_PROTOCOL')
  await assert.rejects(f.access.resolveApiKey(f.profile()), (error) => error.code === 'UNSUPPORTED_PROTOCOL')
  assert.deepEqual(f.calls.resolve, [])
})

test('apply guard rejects a default model, provider or endpoint changed during a run', () => {
  const f = fixture(), initial = f.profile()
  assert.equal(f.access.isCurrentDefault(initial), true)
  f.select({ provider: 'alpha', model: 'different' }); assert.equal(f.access.isCurrentDefault(initial), false)
  f.select({ provider: 'beta', model: 'm2' }); assert.equal(f.access.isCurrentDefault(initial), false)
  f.select({ provider: 'alpha', model: 'm1' }); f.setLive({ alpha: { ...alpha, baseURL: 'https://changed.example.test/v1' } })
  assert.equal(f.access.isCurrentDefault(initial), false)
})

function followerFixture(access) {
  const scopes = [], stopped = []
  let run
  const engine = { setHosts: (hosts, bindings) => scopes.push({ hosts, bindings }), progress: () => run, busy: () => Boolean(run), stop: (id) => { stopped.push(id); run = undefined } }
  const follower = createDefaultFollower(engine, access, () => ({ providers: ['legacy-provider'], extraHosts: [] }))
  return { follower, scopes, stopped, active(value) { run = value } }
}

test('routing follows the DSH default, ignores personal provider arrays, and never starts a probe', async () => {
  const f = fixture(), h = followerFixture(f.access)
  await h.follower.refresh()
  assert.deepEqual(h.scopes.at(-1).hosts, ['alpha.example.test'])
  assert.deepEqual(h.scopes.at(-1).bindings.get('alpha.example.test'), ['alpha'])
  f.select({ provider: 'beta', model: 'm2' })
  await h.follower.refresh()
  assert.deepEqual(h.scopes.at(-1).hosts, ['beta.example.test'])
})

test('switching default cancels an old target run and does not overwrite saved selections', async () => {
  const f = fixture(), h = followerFixture(f.access)
  await h.follower.refresh()
  h.active({ runId: 'run-a', provider: 'alpha', model: 'm1' })
  f.select({ provider: 'beta', model: 'm2' }); await h.follower.refresh()
  assert.deepEqual(h.stopped, ['run-a'])
  assert.deepEqual(h.scopes.at(-1).hosts, ['beta.example.test'])
})

test('late metadata cannot restore an old provider scope or a disposed follower', async () => {
  const f = fixture(), real = f.access.describeBenchmark
  let release
  f.access.describeBenchmark = (profile) => profile?.provider === 'alpha' ? new Promise((resolve) => { release = resolve }) : real(profile)
  const h = followerFixture(f.access), first = h.follower.refresh()
  await Promise.resolve()
  f.select({ provider: 'beta', model: 'm2' }); await h.follower.refresh()
  release({ supported: true, authType: 'api-key' }); await first
  assert.deepEqual(h.scopes.at(-1).hosts, ['beta.example.test'])
  f.select({ provider: 'alpha', model: 'm1' }); const pending = h.follower.refresh()
  await Promise.resolve()
  h.follower.dispose(); const before = h.scopes.length
  release({ supported: true, authType: 'api-key' }); await pending
  assert.equal(h.scopes.length, before)
})

test('OAuth default has no managed DNS route, even with a saved result', async () => {
  const f = fixture({ profiles: { alpha: { api: alpha.api, baseURL: alpha.baseURL } }, records: { 'llm-pi-ai/alpha': { kind: 'grant' } } })
  const h = followerFixture(f.access); await h.follower.refresh()
  assert.deepEqual(h.scopes.at(-1).hosts, [])
  assert.equal(h.scopes.at(-1).bindings.size, 0)
})

test('an explicitly removed model, missing key and dormant route cannot be advertised usable', async () => {
  const f = fixture({ profiles: { alpha: { ...alpha, models: [{ id: 'allowed' }] } } })
  assert.equal((await f.access.describeBenchmark(f.profile())).reasonCode, 'UNKNOWN_MODEL')
  const missing = fixture({ refs: {} })
  assert.equal((await missing.access.describeBenchmark(missing.profile())).reasonCode, 'MISSING_CREDENTIAL')
  const dormant = fixture()
  dormant.setLive({})
  assert.equal((await dormant.access.describeBenchmark(dormant.profile())).reasonCode, 'NO_ACTIVE_PROVIDER')
  assert.deepEqual(dormant.calls.resolve, [])
})

test('endpoint or API-key reference changes cancel the previous target and invalidate apply', async () => {
  const f = fixture(), h = followerFixture(f.access), old = f.profile()
  await h.follower.refresh()
  h.active({ runId: 'old-endpoint', provider: 'alpha', model: 'm1' })
  f.setLive({ alpha: { ...alpha, baseURL: 'https://moved.example.test/v1' } })
  await h.follower.refresh()
  assert.deepEqual(h.stopped, ['old-endpoint'])
  assert.equal(f.access.isCurrentDefault(old), false)
  h.active({ runId: 'old-ref', provider: 'alpha', model: 'm1' })
  f.setLive({ alpha: { ...alpha, baseURL: 'https://moved.example.test/v1', apiKeyEnv: 'ANOTHER_API_KEY' } })
  await h.follower.refresh()
  assert.deepEqual(h.stopped, ['old-endpoint', 'old-ref'])
  assert.deepEqual(h.scopes.at(-1).hosts, [])
})

test('configured native endpoint env is refused rather than pinning the default host', async () => {
  const f = fixture({ profiles: { alpha: { api: alpha.api, baseURL: alpha.baseURL } },
    env: { ALPHA_BASE_URL: 'https://other.example.test/v1' }, records: { 'llm-pi-ai/alpha': { kind: 'api-key', key: 'fake-key' } } })
  f.setDirectory([{ provider: 'alpha', settingsNs: 'model-settings', settingsPath: ['providers', 'alpha'], baseURLEnv: ['ALPHA_BASE_URL'] }])
  assert.equal((await f.access.describeBenchmark(f.profile())).reasonCode, 'DYNAMIC_ENDPOINT')
  assert.deepEqual(f.calls.read, [])
})

test('public import-only native metadata loads from the installed adapter dependency', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-best-ip-catalog-'))
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('dsh-best-ip-catalog-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const adapter = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai')
  const sdk = path.join(adapter, 'node_modules', '@earendil-works', 'pi-ai')
  fs.mkdirSync(path.join(sdk, 'dist', 'providers'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'isolated-metadata-fixture' }))
  fs.writeFileSync(path.join(adapter, 'package.json'), JSON.stringify({ name: PACKAGE, type: 'module', exports: { '.': { default: './index.js' } } }))
  fs.writeFileSync(path.join(adapter, 'index.js'), 'throw new Error("adapter code must not be executed")')
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', type: 'module', exports: { './providers/*': { import: './dist/providers/*.js' } } }))
  fs.writeFileSync(path.join(sdk, 'dist', 'providers', 'all.js'), 'export const getBuiltinModel=(p,id)=>({id,provider:p,api:"openai-responses"}); export const getBuiltinModels=()=>[]; export const builtinProviders=()=>[];')
  const catalog = await loadHostCatalog({ anchors: [path.join(root, 'package.json')], cache: false })
  assert.equal(catalog.getBuiltinModel('alpha', 'm1').api, 'openai-responses')
})

test('distribution patch is generic and contains no personal provider binding', () => {
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /name: dsh-best-ip/)
  assert.match(patch, /maxBenchmarkIps: 0/)
  assert.doesNotMatch(patch, /\b(?:providers|extraHosts|baseURL|apiKey|selected)\s*:/)
})

test('shipped sources and locale metadata never name a real vendor endpoint', () => {
  const files = ['index.js', 'client.js', 'bench.js', 'probe.js', 'store.js', 'providers.js', 'cordis.patch.yml', 'README.md',
    'locale/en.json', 'locale/zh.json']
  for (const file of files) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.deepEqual(privacyIssues(source), [], `${file} contains unreviewed private material or endpoint literals`)
  }
})
