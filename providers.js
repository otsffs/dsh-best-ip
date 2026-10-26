// Read-only bridge to the target Harness's own default route and credentials.
// Never rewrites providers/default selection or invokes OAuth auth/refresh flows.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const PI_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
const RECORD_PREFIX = 'llm-pi-ai/'
import { supportsBenchmarkApi } from './bench.js'
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const descend = (root, parts) => parts.reduce((value, key) => object(value) ? value[key] : undefined, root)
const error = (code, message) => Object.assign(new Error(message), { code })
let catalogPromise
let hostCatalog

// Reuse only the optional public SDK from the SAME installed Harness adapter.
// Complete custom profiles do not require this catalog and no dependency download
// or OS-specific command is performed. These are runtime paths, not author paths.
function runtimeAnchors() {
  const anchors = [import.meta.url]
  for (const directory of [process.env.DSH_PROFILE_DIR, process.env.DSH_HOME, process.cwd()]) {
    if (text(directory)) anchors.push(path.join(directory, 'package.json'))
  }
  if (text(process.argv[1])) {
    try { anchors.push(fs.realpathSync(process.argv[1])) } catch { /* no launch-file anchor */ }
  }
  if (text(process.resourcesPath)) {
    anchors.push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'))
    anchors.push(path.join(process.resourcesPath, 'app', 'dsh', 'package.json'))
  }
  return anchors
}
function installedPackage(require, name) {
  for (const directory of require.resolve.paths(name) ?? []) {
    const filename = path.join(directory, name, 'package.json')
    try {
      const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'))
      if (manifest.name === name) return { filename: fs.realpathSync(filename), manifest }
    } catch { /* next standard Node resolution directory */ }
  }
  return undefined
}
export function loadHostCatalog({ anchors, cache = anchors === undefined } = {}) {
  if (cache && catalogPromise) return catalogPromise
  const load = async () => {
    for (const anchor of anchors ?? runtimeAnchors()) {
      try {
        const adapter = installedPackage(createRequire(anchor), PI_PACKAGE)
        if (!adapter) continue
        const sdk = installedPackage(createRequire(adapter.filename), '@earendil-works/pi-ai')
        if (!sdk) continue
        const declaration = sdk.manifest.exports?.['./providers/all'] ?? sdk.manifest.exports?.['./providers/*']
        // Follow the declared PUBLIC import export. CJS require conditions do not
        // select pi-ai's import-only entry, even on Node versions supporting ESM.
        const entry = typeof declaration === 'string' ? declaration : declaration?.import
        if (typeof entry !== 'string' || !entry.startsWith('./')) continue
        const root = path.dirname(sdk.filename), filename = path.resolve(root, entry.replaceAll('*', 'all'))
        if (!filename.startsWith(root + path.sep)) continue
        const module = await import(pathToFileURL(filename).href)
        if (typeof module.getBuiltinModel === 'function' && typeof module.getBuiltinModels === 'function' && typeof module.builtinProviders === 'function') return module
      } catch { /* explicit profiles remain supported without native metadata */ }
    }
    return undefined
  }
  const result = load()
  if (cache) catalogPromise = result.then((value) => { hostCatalog = value; if (!value) catalogPromise = undefined; return value })
  return cache ? catalogPromise : result
}

export function createProviderAccess(ctx, { catalog, env = process.env } = {}) {
  let nativeCatalog = catalog
  const ready = async () => { if (nativeCatalog === undefined) nativeCatalog = await loadHostCatalog() }
  const readDefaultSelection = () => {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      const provider = text(selection?.provider), model = text(selection?.model)
      if (!provider) return undefined
      return { provider, ...(model ? { model } : {}),
        ...(text(selection?.reasoningEffort) ? { reasoningEffort: selection.reasoningEffort } : {}), source: 'default' }
    } catch { return undefined }
  }
  const readRows = () => {
    try { return ctx.get('configEditor')?.configuration?.() ?? [] } catch { return [] }
  }
  const readDirectory = () => {
    try { return ctx.get('llm')?.listConfigurableProviders?.() ?? [] } catch { return [] }
  }
  const readDescriptors = () => {
    try { return ctx.get('settings')?.describe?.({ redactSecrets: true }) ?? [] } catch { return [] }
  }

  function readProviderProfiles() {
    const selection = readDefaultSelection()
    if (!selection) return new Map()
    const id = selection.provider
    const rows = readRows()
    const directory = readDirectory().find((entry) => entry.provider === id)
    const owners = rows.filter(({ entry }) => entry?.options?.name === PI_PACKAGE)
    const owner = directory
      ? owners.find(({ entry }) => [entry?.options?.id, entry?.id].includes(directory.settingsNs))
      : owners.find(({ override, inherited }) => object({ ...inherited, ...override }.providers?.[id]))
    if (!owner) {
      return new Map([[id, { provider: id, model: selection.model, displayName: directory?.displayName ?? id,
        benchmarkError: 'UNSUPPORTED_ADAPTER', models: selection.model ? [selection.model] : [] }]])
    }
    const { entry, override, inherited } = owner
    const namespace = directory?.settingsNs ?? entry?.options?.id ?? entry?.id
    const descriptor = readDescriptors().find((item) => item.ns === namespace)
    const profilePath = directory?.settingsPath ?? ['providers', id]
    const live = descriptor ? descend(descriptor.value, profilePath) : undefined
    const raw = descend({ ...inherited, ...override }, profilePath)
    if (!object(live) && !object(raw)) return new Map([[id, { provider: id, model: selection.model, benchmarkError: 'NO_ACTIVE_PROVIDER' }]])
    const profile = object(live) ? live : raw
    // A provider from another adapter must not be interpreted as pi-ai config.
    if (directory && (profilePath.length !== 2 || profilePath[0] !== 'providers' || profilePath[1] !== id)) {
      return new Map([[id, { provider: id, model: selection.model, displayName: directory.displayName ?? id,
        benchmarkError: 'UNSUPPORTED_ADAPTER', models: selection.model ? [selection.model] : [] }]])
    }
    const native = nativeCatalog ?? hostCatalog
    let nativeModel, nativeModels = [], nativeProvider
    try {
      nativeModel = selection.model ? native?.getBuiltinModel(id, selection.model) : undefined
      nativeModels = native?.getBuiltinModels(id) ?? []
      nativeProvider = native?.builtinProviders().find((item) => item.id === id)
    } catch { /* unresolved native metadata is not a guessed protocol */ }
    const apis = new Set(nativeModels.map((model) => text(model.api)).filter(Boolean))
    const api = text(profile.api) ?? text(nativeModel?.api) ?? (apis.size === 1 ? [...apis][0] : undefined)
    const baseURL = text(profile.baseURL) ?? text(nativeModel?.baseUrl) ?? text(nativeProvider?.baseUrl) ?? text(directory?.defaultBaseURL)
    const models = (Array.isArray(profile.models) ? profile.models : []).map((model) => text(model?.id)).filter(Boolean)
    const result = {
      provider: id, model: selection.model, displayName: text(profile.displayName) ?? directory?.displayName ?? id,
      api, baseURL, models: models.length ? models : selection.model ? [selection.model] : [],
      apiKeyEnv: text(profile.apiKeyEnv), credentialKey: `${RECORD_PREFIX}${id}`,
      nativeAuth: directory?.nativeAuth,
      baseURLEnv: Array.isArray(directory?.baseURLEnv) ? directory.baseURLEnv : text(directory?.baseURLEnv) ? [directory.baseURLEnv] : [],
    }
    if (selection.model && (models.length > 0 ? !models.includes(selection.model) : nativeModel?.id !== selection.model)) result.benchmarkError = 'UNKNOWN_MODEL'
    else if (directory?.error) result.benchmarkError = 'PROVIDER_ERROR'
    else if (!api || !baseURL || /\{[^}]+\}/.test(baseURL)) result.benchmarkError = 'UNRESOLVED_ENDPOINT'
    else if (!supportsBenchmarkApi(api)) result.benchmarkError = 'UNSUPPORTED_PROTOCOL'
    else {
      try { if (new URL(baseURL).protocol !== 'https:') result.benchmarkError = 'HTTPS_REQUIRED' }
      catch { result.benchmarkError = 'UNRESOLVED_ENDPOINT' }
    }
    // Native auth may replace a catalog endpoint. Never pin a known alternate
    // environment-based endpoint while claiming the displayed default is exact.
    if (!result.apiKeyEnv && result.baseURLEnv.some((ref) => text(env[ref]))) result.benchmarkError = 'DYNAMIC_ENDPOINT'
    try {
      const llm = ctx.get('llm')
      if (typeof llm?.listProviders === 'function' && !llm.listProviders().some((provider) => provider.id === id)) result.benchmarkError = 'NO_ACTIVE_PROVIDER'
    } catch { result.benchmarkError = 'NO_ACTIVE_PROVIDER' }
    return new Map([[id, result]])
  }

  async function describeAuth(profile) {
    if (!profile) return { authType: 'unknown', reasonCode: 'NO_DEFAULT_PROVIDER' }
    const credentials = ctx.get('credentials')
    if (profile.apiKeyEnv) {
      try {
        const info = credentials?.describe ? await credentials.describe(profile.apiKeyEnv) : { configured: Boolean(text(env[profile.apiKeyEnv])) }
        return { authType: 'api-key', ref: profile.apiKeyEnv, ...(!info.configured ? { reasonCode: 'MISSING_CREDENTIAL' } : {}) }
      } catch { return { authType: 'unknown', reasonCode: 'UNRESOLVED_AUTH' } }
    }
    if (!profile.credentialKey) return { authType: 'unknown', reasonCode: 'UNRESOLVED_AUTH' }
    if (!credentials?.describeRecord) return { authType: 'unknown', reasonCode: 'UNRESOLVED_AUTH' }
    let record
    try { record = await credentials.describeRecord(profile.credentialKey) }
    catch { return { authType: 'unknown', reasonCode: 'UNRESOLVED_AUTH' } }
    if (record?.configured && record.kind === 'grant') return { authType: 'oauth', reasonCode: 'OAUTH_UNSUPPORTED' }
    if (record?.configured && record.kind === 'api-key') return { authType: 'api-key', record: true }
    // Only plain API-key environment names can be used as bearer/x-api-key.
    // OAuth tokens, AWS profiles/files and specialized native auth are not guessed.
    const hints = [...new Set([...(profile.nativeAuth?.env ?? []), ...(profile.provider === 'anthropic' ? ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN'] : [])])]
    for (const ref of hints.filter((ref) => typeof ref === 'string' && !/_API_KEY$/.test(ref) && (profile.provider !== 'anthropic' || /^ANTHROPIC_(AUTH|OAUTH)_TOKEN$/.test(ref)))) {
      try {
        const info = credentials?.describe ? await credentials.describe(ref) : { configured: Boolean(text(env[ref])) }
        if (info.configured) return /OAUTH/i.test(ref) ? { authType: 'oauth', reasonCode: 'OAUTH_UNSUPPORTED' } : { authType: 'unknown', reasonCode: 'UNRESOLVED_AUTH' }
      } catch { return { authType: 'unknown', reasonCode: 'UNRESOLVED_AUTH' } }
    }
    const refs = hints.filter((ref) => typeof ref === 'string' && /_API_KEY$/.test(ref) && !/OAUTH/i.test(ref))
    const configured = []
    for (const ref of refs) {
      try {
        const info = credentials?.describe ? await credentials.describe(ref) : { configured: Boolean(text(env[ref])) }
        if (info.configured) configured.push(ref)
      } catch { return { authType: 'unknown', reasonCode: 'UNRESOLVED_AUTH' } }
    }
    if (configured.length === 1) return { authType: 'api-key', ref: configured[0] }
    return { authType: 'unknown', reasonCode: configured.length > 1 ? 'UNRESOLVED_AUTH' : 'MISSING_CREDENTIAL' }
  }

  async function describeBenchmark(profile) {
    const auth = await describeAuth(profile)
    const reasonCode = auth.authType === 'oauth' ? 'OAUTH_UNSUPPORTED'
      : profile?.benchmarkError ?? (!profile?.model ? 'NO_DEFAULT_MODEL' : auth.reasonCode)
    return { supported: !reasonCode, authType: auth.authType, ...(reasonCode ? { reasonCode } : {}) }
  }

  async function resolveApiKey(profile) {
    const auth = await describeAuth(profile)
    if (auth.authType === 'oauth') throw error('OAUTH_UNSUPPORTED', 'OAuth providers are not supported for speed testing yet')
    if (auth.reasonCode) throw error(auth.reasonCode, 'no usable API-key authentication is configured for the default provider')
    if (profile?.benchmarkError) throw error(profile.benchmarkError, 'the default provider endpoint or protocol cannot be safely benchmarked')
    if (!profile?.model) throw error('NO_DEFAULT_MODEL', 'select a default model before speed testing')
    const credentials = ctx.get('credentials')
    let key
    if (auth.ref) {
      // An explicit reference wins over a stored grant. If absent, fail loudly;
      // never fall back to OAuth or a different stored credential.
      if (credentials?.resolve) key = (await credentials.resolve(auth.ref))?.value
      else key = env[auth.ref]
    } else if (auth.record) {
      if (!credentials?.readRecord) throw error('UNRESOLVED_AUTH', 'native API-key credentials cannot be read by this Harness version')
      const record = await credentials.readRecord(profile.credentialKey)
      if (record?.kind === 'grant') throw error('OAUTH_UNSUPPORTED', 'OAuth providers are not supported for speed testing yet')
      if (record?.kind === 'api-key') key = record.key
      // A native env bundle is not necessarily a generic API key. Refuse it.
      if (!text(key)) throw error('UNRESOLVED_AUTH', 'this native credential has no direct API key; configure an API-key reference for speed testing')
    }
    if (!text(key)) throw error(auth.reasonCode ?? 'MISSING_CREDENTIAL', 'no API key could be resolved for the default provider')
    profile.authType = 'api-key'
    return key
  }

  function isCurrentDefault(profile, model = profile?.model) {
    const selection = readDefaultSelection()
    if (!selection || !profile || selection.provider !== profile.provider || selection.model !== model) return false
    const current = readProviderProfiles().get(selection.provider)
    return !current?.benchmarkError && current?.baseURL === profile?.baseURL && current?.api === profile?.api && current?.apiKeyEnv === profile?.apiKeyEnv
  }
  return { ready, readDefaultSelection, readProviderProfiles, describeAuth, describeBenchmark, resolveApiKey, isCurrentDefault }
}

export function createDefaultFollower(engine, access, getConfig) {
  let revision = 0, disposed = false, lastTarget
  async function refresh({ credentialsChanged = false } = {}) {
    if (disposed) return []
    const generation = ++revision
    await access.ready?.()
    if (disposed || generation !== revision) return []
    const selection = access.readDefaultSelection()
    const profile = selection ? access.readProviderProfiles().get(selection.provider) : undefined
    const extras = [...new Set((getConfig()?.extraHosts ?? []).map((host) => String(host).trim().toLowerCase()).filter(Boolean))]
    const target = JSON.stringify([selection?.provider, selection?.model, profile?.baseURL, profile?.api, profile?.apiKeyEnv, profile?.benchmarkError])
    const targetChanged = lastTarget !== undefined && lastTarget !== target
    if (lastTarget !== target || credentialsChanged) {
      // Remove the old managed scope before waiting for auth metadata. No lookup,
      // provider mutation or test runs as a side effect of following the default.
      engine.setHosts(extras, new Map())
      lastTarget = target
    }
    const run = engine.progress?.()
    if (engine.busy?.() && run?.provider && (run.provider !== selection?.provider || run.model !== selection?.model || targetChanged || credentialsChanged)) {
      engine.stop(run.runId)
    }
    const availability = await access.describeBenchmark(profile)
    if (disposed || generation !== revision) return []
    const hosts = new Set(extras), bindings = new Map()
    if (profile) {
      let host
      try { host = new URL(profile.baseURL).hostname.replace(/^\[|\]$/g, '').toLowerCase() } catch { /* unresolved endpoint */ }
      if (host && availability.authType === 'oauth') hosts.delete(host)
      else if (host && availability.supported && access.isCurrentDefault(profile)) { hosts.add(host); bindings.set(host, [profile.provider]) }
    }
    engine.setHosts([...hosts], bindings)
    return [...hosts]
  }
  return { refresh, dispose() { disposed = true; revision++ } }
}
