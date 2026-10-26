// dsh-best-ip — explicit provider-IP discovery, benchmarking and DNS pinning.
// Only explicitly applied pins affect new dns.lookup connections for managed
// hostnames. Discovery is manual; unrelated traffic keeps native system DNS.

import dns from 'node:dns'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'

import { inspectAll as inspectAllDefault, rankAddresses, scanCandidates, NEAR_COLOS } from './probe.js'
import { measureStream as measureStreamDefault, summarize, supportsBenchmarkApi, sampleError } from './bench.js'
import { createProviderAccess, createDefaultFollower } from './providers.js'
import { readState as readStateDefault, writeState as writeStateDefault, statePath } from './store.js'

const name = 'dsh-best-ip'
const BENCHMARK_MAX_TOKENS = 256

/**
 * Common public resolvers shipped as the default discovery set.
 *
 * Discovery benefits from several vantage points: a resolver in a different
 * network can return a different Cloudflare pair, and the system resolver alone
 * gives one opinion. These are the widely reachable ones for users here, listed
 * mainland-first because that path is usually the shortest.
 *
 * They are only ever used to LOOK UP candidate addresses during an optimize run;
 * requests afterwards go straight to the measured IP.
 */
const DEFAULT_DNS_SERVERS = [
  // Mainland China
  '223.5.5.5', // AliDNS
  '119.29.29.29', // DNSPod / Tencent
  '114.114.114.114', // 114DNS
  '180.76.76.76', // Baidu
  // Public international
  '8.8.8.8', // Google
  '1.1.1.1', // Cloudflare
  '9.9.9.9', // Quad9
  '208.67.222.222', // OpenDNS
]

/**
 * Load the schema library from the installed profile rather than from this
 * checkout.
 *
 * A locally installed bundle is linked into the profile by directory, so bare
 * specifiers resolve against this checkout, which has no node_modules. The
 * profile usually has the library the Harness itself uses, and resolving there
 * keeps the plugin on the exact same Schemastery major as the Loader that
 * validates this row.
 *
 * A profile is not guaranteed to carry it: the library only arrives with a
 * package that depends on it (the bundled `dsh-web-app`/`dsh-settings`/
 * `dsh-tools` do, but a profile composed without them has no top-level copy).
 * So the Harness's own installation is tried as well — `process.resourcesPath`
 * is where Electron keeps it, and DSH's asar-aware loader can resolve inside
 * the archive. These are runtime locations, never author paths.
 */
function loadSchemaLibrary() {
  // The no-network test preloader also prevents loading live profile modules.
  if (process.env.DSH_BEST_IP_ISOLATED_TESTS === '1') return undefined
  const anchors = [process.env.DSH_PROFILE_DIR, process.env.DSH_HOME, process.cwd()]
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .map((directory) => path.join(directory, 'package.json'))
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    anchors.push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'))
    anchors.push(path.join(process.resourcesPath, 'app', 'dsh', 'package.json'))
  }
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      const resolved = require.resolve('@deepseek-ai/schemastery')
      return require(resolved)
    } catch {
      /* try the next anchor */
    }
  }
  return undefined
}

const schemasteryModule = loadSchemaLibrary()
const z = schemasteryModule === undefined ? undefined : (schemasteryModule.default ?? schemasteryModule)

/**
 * The row schema.
 *
 * The loader requires a native Schemastery graph to project this entry into a
 * settings form. When the library cannot be located the plugin still runs: a
 * missing schema costs the form, not the capability, and `normalizeConfig`
 * below supplies every default regardless.
 */
const Config =
  z === undefined
    ? undefined
    : z
        .object({
          enabled: z.boolean().default(true).description('Use explicitly selected provider IPs for new connections. With no pin, use native system DNS.'),
          dnsServers: z
            .array(z.string())
            .default([...DEFAULT_DNS_SERVERS])
            .description(
              'Resolvers used to DISCOVER candidate addresses during an optimize run. Requests never resolve through them. The system resolver is always queried as well, so an empty list still works.',
            ),
          providers: z
            .array(z.string())
            .default([])
            .description('Deprecated and ignored: managed routing follows the DSH default provider automatically. Kept only so older patch rows still load.'),
          extraHosts: z
            .array(z.string())
            .default([])
            .description('Additional hostnames to pin, for endpoints that are not a provider route.'),
          includeSubdomains: z.boolean().default(true).description('Also pin subdomains of each configured host.'),
          fallbackToSystem: z
            .boolean()
            .default(true)
            .description('Fall back to the system resolver when the pinned servers fail.'),
          ttlSeconds: z.number().min(1).default(300).description('How long one resolved answer is reused.'),
          timeoutMs: z.number().min(100).default(4000).description('Per-query timeout for the pinned servers.'),
          scanEdges: z
            .boolean()
            .default(true)
            .description(
              'When a probe runs, also sample Cloudflare edge ranges instead of only the addresses DNS returns. Needed to escape a far datacenter.',
            ),
          preferNearEdges: z
            .boolean()
            .default(false)
            .description(
              'Optionally order discovery results by nearby datacenters. Off by default: low TCP latency does not establish fast model throughput.',
            ),
          probeConcurrency: z
            .number()
            .min(1)
            .max(256)
            .default(48)
            .description('Parallel probes during the Cloudflare edge scan. The first DNS-answer round stays capped at 8 so a large value cannot flood a shared resolver.'),
          maxCandidates: z
            .number()
            .min(1)
            .max(4096)
            .default(160)
            .description('Upper bound on extra scanned addresses during discovery, excluding DNS answers. Independent of the paid speed-test IP limit.'),
          maxBenchmarkIps: z
            .number()
            .min(0)
            .max(Number.MAX_SAFE_INTEGER)
            .default(0)
            .description('Maximum usable IPs to speed-test, lowest ping first. 0 tests all. Discovery and per-IP run counts are unchanged.'),
          benchmarkRuns: z
            .number()
            .min(1)
            .max(5)
            .default(3)
            .description('Streaming requests per address. The median is reported, so more runs cost more but vary less.'),
          benchmarkMessage: z
            .string()
            .default('Count slowly from 1 to 30, one number per line.')
            .description(
              'Default test prompt. It must ask for enough output for tokens/second to be meaningful; a greeting produces too few tokens.',
            ),
        })
        .description('Discover and benchmark provider IPs; testing is safe by default and application requires explicit opt-in.')

function isBenchmarkIpLimit(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Normalize a row's raw config. Runs unchanged whether or not a schema was
 * available, so the runtime behavior never depends on the form being present.
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const strings = (value, fallback) => {
    const list = Array.isArray(value) ? value : fallback
    return list.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
  }
  const number = (value, fallback, minimum) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed) || parsed < minimum) return fallback
    return parsed
  }
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  return {
    enabled: bool(source.enabled, true),
    // An explicitly empty list means "use only the system resolver", which is a
    // legitimate choice once resolvers are just discovery sources. Only a missing
    // field falls back to the default — treating [] as absent would silently
    // re-add a server the user just removed.
    dnsServers: Array.isArray(source.dnsServers)
      ? strings(source.dnsServers, [])
      : [...DEFAULT_DNS_SERVERS],
    providers: strings(source.providers, []),
    extraHosts: strings(source.extraHosts, []),
    includeSubdomains: bool(source.includeSubdomains, true),
    fallbackToSystem: bool(source.fallbackToSystem, true),
    ttlSeconds: number(source.ttlSeconds, 300, 1),
    timeoutMs: number(source.timeoutMs, 4000, 100),
    scanEdges: bool(source.scanEdges, true),
    preferNearEdges: bool(source.preferNearEdges, false),
    probeConcurrency: Math.min(256, Math.floor(number(source.probeConcurrency, 48, 1))),
    maxCandidates: Math.min(4096, Math.floor(number(source.maxCandidates, 160, 1))),
    maxBenchmarkIps: isBenchmarkIpLimit(source.maxBenchmarkIps) ? source.maxBenchmarkIps : 0,
    benchmarkRuns: Math.min(5, Math.floor(number(source.benchmarkRuns, 3, 1))),
    benchmarkMessage:
      typeof source.benchmarkMessage === 'string' && source.benchmarkMessage.trim().length > 0
        ? source.benchmarkMessage.trim()
        : 'Count slowly from 1 to 30, one number per line.',
  }
}

// Captured when this module loads, which is before any patch below is
// installed, so these stay the runtime's own functions. Nothing here may
// recurse back through `dns.lookup`: that would loop forever.
const DNS_RUNTIME = Symbol.for('dsh-best-ip/dns-runtime')
const interception = globalThis[DNS_RUNTIME] ??= { nativeLookup: dns.lookup, nativePromiseLookup: dns.promises.lookup }
const NATIVE_LOOKUP = interception.nativeLookup
const NATIVE_PROMISE_LOOKUP = interception.nativePromiseLookup

/**
 * The single live interception, shared by every activation in this process.
 *
 * A reload can leave the old and new activation both mounted for a moment, and
 * each one would otherwise chain its wrapper onto the other's and then restore
 * whatever it happened to see. One owner keeps the process at exactly one
 * patch: the newest activation installs it, and dispose only ever unwinds a
 * patch that is still the live one.
 */
// Interception ownership is in the process-wide registry above.

/** Everything that must not be routed to a remote resolver. */
function isLocalName(hostname) {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  // An address literal never reaches DNS; leave it to the original lookup.
  if (net.isIP(host) !== 0) return true
  if (host === '0.0.0.0' || host === '::1' || host === '::') return true
  return false
}

/**
 * Read the Subagent parallelism limit from the live composition.
 *
 * `@deepseek-ai/dsh-subagent` declares
 * `maxActiveSubagents: z.number().default(8).volatile()`, exposed in Settings as
 * "Subagent parallelism limit" — the total live Subagents under one main Agent.
 * The value is per-profile, so it is read from the loader entries here rather
 * than assumed. A deployment that does not compose the subagent plugin (or a
 * profile that pins its own number) still yields the declared default.
 *
 * Reusing this number keeps the speed test inside the parallelism budget the
 * user already chose, instead of inventing a second, conflicting limit.
 */
const SUBAGENT_PACKAGE = '@deepseek-ai/dsh-subagent'
const SUBAGENT_PARALLELISM_DEFAULT = 8

function readSubagentParallelism(ctx, logger) {
  const editor = ctx.get('configEditor')
  if (editor !== undefined && typeof editor.configuration === 'function') {
    try {
      for (const { entry, override, inherited } of editor.configuration()) {
        if (entry?.options?.name !== SUBAGENT_PACKAGE) continue
        const raw = { ...inherited, ...override }
        const value = raw?.maxActiveSubagents
        if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.floor(value)
      }
    } catch (error) {
      logger?.warn('dsh-best-ip: could not read the subagent parallelism limit; using the default')
    }
  }
  return SUBAGENT_PARALLELISM_DEFAULT
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Results keep the input order. A rejected worker settles its own slot instead
 * of aborting the batch: one unreachable address must not cancel the others.
 */
function stoppedError() {
  return Object.assign(new Error('test stopped'), { name: 'AbortError', cancelled: true })
}
function abortable(value, signal) {
  if (!signal) return Promise.resolve(value)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, result) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      fn(result)
    }
    const abort = () => finish(reject, stoppedError())
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(value).then((result) => finish(resolve, result), (error) => finish(reject, error))
    if (signal.aborted) abort()
  })
}

async function mapWithConcurrency(items, limit, worker, signal) {
  const list = [...items]
  const results = new Array(list.length)
  const width = Math.max(1, Math.min(limit, list.length))
  let next = 0
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      if (signal?.aborted) return
      const index = next++
      if (index >= list.length) return
      try {
        results[index] = await worker(list[index], index)
      } catch (error) {
        // Keep going: a single failure is reported through its own result.
        results[index] = undefined
        void error
      }
    }
  })
  await Promise.all(runners)
  return results
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * Numeric value of a dotted-quad address, or +Infinity when it is not one.
 *
 * Resolvers return the same record set in whatever order their answer packet
 * listed it, so eight servers agreeing perfectly still looked like eight
 * different answers in the panel. Sorting by octets (104.21.45.58 before
 * 172.67.210.105) makes identical answers render identically.
 */
function addressValue(address) {
  const parts = String(address).split('.')
  if (parts.length !== 4) return Number.POSITIVE_INFINITY
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return Number.POSITIVE_INFINITY
    const octet = Number(part)
    if (octet > 255) return Number.POSITIVE_INFINITY
    value = value * 256 + octet
  }
  return value
}

/** Ascending numeric address order; unparsable entries sort last, never dropped. */
function sortAddresses(addresses) {
  if (!Array.isArray(addresses)) return []
  return [...addresses].sort((left, right) => {
    const delta = addressValue(left) - addressValue(right)
    return delta !== 0 ? delta : String(left).localeCompare(String(right))
  })
}

function orderCandidates(candidates, benchmarks) {
  const tier = (candidate) => {
    const row = benchmarks?.[candidate.ip]
    if (row?.rankEligible && row.scoringVersion === 1 && Number.isFinite(row.stabilityScore)) return 0
    if (Array.isArray(row?.samples) && row.samples.length > 0) return 1
    if (Number.isFinite(row?.tps)) return 2
    return 3
  }
  return [...(candidates ?? [])].sort((a, b) => tier(a) - tier(b) ||
    ((benchmarks?.[b.ip]?.stabilityScore ?? -1) - (benchmarks?.[a.ip]?.stabilityScore ?? -1)) ||
    (a.rtt ?? Infinity) - (b.rtt ?? Infinity) || String(a.ip).localeCompare(String(b.ip)))
}

// Preserve only non-secret workload metadata, including for legacy records.
// A full endpoint can contain credentials in userinfo, path, query or fragment.
function sanitizeBenchmarkContext(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const context = {}
  for (const key of ['provider', 'model']) if (typeof value[key] === 'string') context[key] = value[key]
  for (const key of ['maxTokens', 'runs', 'maxBenchmarkIps']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) context[key] = value[key]
  }
  try {
    const endpoint = new URL(value.endpointOrigin ?? value.baseURL)
    if (endpoint.protocol === 'https:') context.endpointOrigin = endpoint.origin
  } catch { /* omit an invalid legacy endpoint instead of echoing it */ }
  return context
}

async function resolveBenchmarkKey(resolveApiKey, profile) {
  try { return await resolveApiKey(profile) }
  catch (error) {
    if (error?.code === 'OAUTH_UNSUPPORTED') throw new Error('OAuth providers are not supported for speed testing yet')
    // Credential backends can include secret values in their exception text.
    throw new Error('could not resolve API-key credentials; check the default provider settings')
  }
}

/**
 * The pinning engine. One instance per plugin activation; it patches the two
 * `dns.lookup` entry points and restores them on dispose.
 */
function createResolver(config, logger, dependencies = {}) {
  // Dependency injection is only for isolated tests: no live DNS, disk or API.
  const inspectAll = dependencies.inspectAll ?? inspectAllDefault
  const measureStream = dependencies.measureStream ?? measureStreamDefault
  const readState = dependencies.readState ?? readStateDefault
  const writeState = dependencies.writeState ?? writeStateDefault
  const nativeLookup = dependencies.nativeLookup ?? NATIVE_LOOKUP
  const nativePromiseLookup = dependencies.nativePromiseLookup ?? NATIVE_PROMISE_LOOKUP
  let operationBusy = false
  let disposed = false
  let activeRun
  async function exclusive(work, hostname, reporter) {
    if (disposed) throw new Error('plugin was disposed')
    if (operationBusy) throw new Error('a measurement is already running')
    if (reporter !== undefined) {
      if (activeRun?.report !== reporter) throw new Error('measurement reporter was replaced')
    } else {
      reporter = beginProgress(hostname)
    }
    const run = activeRun
    operationBusy = true
    try {
      const result = await work(run.controller.signal, reporter)
      const stopped = run.controller.signal.aborted || result?.stopped === true
      reporter({ stage: stopped ? 'stopped' : result?.benchmarkFailed || result?.summary?.error ? 'failed' : 'done',
        finishedAt: Date.now(), stopped, applied: stopped ? false : result?.applied,
        recommended: result?.recommended, testOnly: result?.testOnly, reasonCode: result?.reasonCode,
        message: result?.message ?? result?.summary?.error,
        ...(result?.summary ? { summary: result.summary, address: result.ip } : {}), saveError: result?.saveError })
      return result
    } catch (error) {
      if (run.controller.signal.aborted || error?.name === 'AbortError') {
        reporter({ stage: 'stopped', stopped: true, applied: false, finishedAt: Date.now(), message: 'test stopped; current address unchanged' })
        return { hostname, stopped: true, applied: false, message: 'test stopped; current address unchanged' }
      }
      reporter({ stage: 'failed', message: error?.message ?? String(error), finishedAt: Date.now() })
      throw error
    } finally { operationBusy = false }
  }
  const providerId = (provider) => typeof provider === 'string' ? provider : provider?.provider
  const canonicalHost = (hostname) => String(hostname).toLowerCase().replace(/\.$/, '')
  const recordKey = (hostname, provider) => JSON.stringify([providerId(provider) ?? '', canonicalHost(hostname)])
  const recordFor = (hostname, provider) => {
    if (provider !== undefined) return results.get(recordKey(hostname, provider))
    const matches = [...results.values()].filter((entry) => entry.hostname === canonicalHost(hostname))
    return matches.length === 1 ? matches[0] : undefined
  }
  const dirtyKeys = new Set()
  const deletedKeys = new Set()
  const storeRecord = (record, dirty = true) => {
    record = { ...record, hostname: canonicalHost(record.hostname), benchmarkContext: sanitizeBenchmarkContext(record.benchmarkContext) }
    const key = recordKey(record.hostname, record.provider)
    results.set(key, record)
    if (dirty) { dirtyKeys.add(key); deletedKeys.delete(key) }
  }

  // Mutable on purpose: saving settings changes the configuration, and a frozen
  // snapshot would keep serving the old values — which is why a removed DNS
  // server kept reappearing after a save. `reconfigure` below replaces it.
  let current = config
  // No fallback list here: an empty configuration means discovery uses only the
  // system resolver, and re-adding a default would undo the user's choice.
  let ttlMs = current.ttlSeconds * 1000

  let generation = 0
  let resolver = new dns.Resolver({ timeout: current.timeoutMs, tries: 1 })
  // Setting an empty server list leaves the Resolver unable to answer anything,
  // so an empty configuration keeps the runtime's own servers instead.
  if (current.dnsServers.length > 0) resolver.setServers(current.dnsServers)

  /** host|family -> { expires, list } */
  const cache = new Map()
  /** host -> last failure, so the log reports a reason rather than a bare error. */
  const lastFailure = new Map()
  let inflight = new Map()
  const stats = {
    pinned: 0,
    cacheHits: 0,
    failures: 0,
    fallbacks: 0,
    optimizes: 0,
    optimizeReused: 0,
    optimizeMisses: 0,
  }

  const originalLookup = nativeLookup
  const originalPromiseLookup = nativePromiseLookup

  /** Live host set, replaced whenever configuration changes. */
  let matcher = { exact: new Set(), suffixes: [] }

  let hostProviders = new Map()
  function setHosts(hosts, bindings = new Map()) {
    hostProviders = bindings
    const exact = new Set()
    for (const host of hosts) {
      const clean = String(host).trim().toLowerCase()
      if (clean.length > 0 && !isLocalName(clean)) exact.add(clean)
    }
    matcher = { exact, suffixes: [...exact] }
  }

  function matches(hostname) {
    const host = hostname.toLowerCase().replace(/\.$/, '')
    if (matcher.exact.has(host)) return true
    if (!current.includeSubdomains) return false
    return matcher.suffixes.some((base) => host.endsWith(`.${base}`))
  }

  function shouldPin(hostname) {
    if (!current.enabled) return false
    if (matcher.exact.size === 0) return false
    return !isLocalName(hostname) && matches(hostname)
  }

  function queryViaPinned(hostname, family) {
    const key = `${hostname}|${family}|${generation}`
    const queryGeneration = generation
    const cached = cache.get(key)
    if (cached !== undefined && cached.expires > Date.now()) {
      stats.cacheHits++
      return Promise.resolve(cached.list)
    }
    const pending = inflight.get(key)
    if (pending !== undefined) return pending

    const run = new Promise((resolve, reject) => {
      const done = (error, addresses) => {
        inflight.delete(key)
        if (error !== undefined) {
          lastFailure.set(hostname, `${error.code ?? error.name ?? 'error'}: ${error.message ?? String(error)}`)
          reject(error)
          return
        }
        if (!Array.isArray(addresses) || addresses.length === 0) {
          const blank = Object.assign(new Error(`pinned DNS returned no ${family === 6 ? 'AAAA' : 'A'} record`), {
            code: 'ENOTFOUND',
          })
          lastFailure.set(hostname, 'ENOTFOUND: no records returned')
          reject(blank)
          return
        }
        lastFailure.delete(hostname)
        const list = addresses.map((address) => ({ address, family: family === 6 ? 6 : 4 }))
        if (queryGeneration === generation) cache.set(key, { expires: Date.now() + ttlMs, list })
        stats.pinned++
        resolve(list)
      }
      // With no configured server there is nothing pinned to query: fall back to
      // the runtime's own resolver. This is a real configuration now (resolvers
      // are only discovery sources), and an empty `Resolver` would fail every
      // query with UNKNOWN_ARES_ERROR.
      if (current.dnsServers.length === 0) {
        nativePromiseLookup.call(dns.promises, hostname, { all: true, family: family === 6 ? 6 : 4 })
          .then((answer) => {
            // `done` wraps whatever it receives into `{ address, family }`, so it
            // must be handed bare address strings — passing objects here produced
            // `{ address: { address, family } }` and broke every caller.
            const raw = Array.isArray(answer) ? answer : [answer]
            const strings = raw
              .map((entry) => (typeof entry === 'string' ? entry : entry?.address))
              .filter((address) => typeof address === 'string' && address.length > 0)
            if (strings.length === 0) {
              done(Object.assign(new Error('the system resolver returned no address'), { code: 'ENOTFOUND' }))
              return
            }
            done(undefined, strings)
          })
          .catch((error) => done(error))
        return
      }
      const method = family === 6 ? 'resolve6' : 'resolve4'
      resolver[method](hostname, (error, addresses) => done(error ?? undefined, addresses))
    })
    inflight.set(key, run)
    return run
  }

  /**
   * Ask one specific DNS server for a hostname's A records.
   *
   * Candidate discovery only: the pin never resolves through a server after a
   * probe, it uses the measured address. Each server gets its own Resolver
   * because `setServers` is per-instance state.
   */
  function queryOneServer(server, hostname, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve({ server, addresses: [], error: 'test stopped' })
      const one = new dns.Resolver({ timeout: Math.max(current.timeoutMs, 2000), tries: 1 })
      let settled = false
      const abort = () => {
        finish(stoppedError())
        one.cancel()
      }
      try {
        one.setServers([server])
      } catch (error) {
        resolve({ server, addresses: [], error: `${error?.message ?? String(error)}` })
        return
      }
      const finish = (error, addresses) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        resolve({
          server,
          addresses: Array.isArray(addresses) ? addresses : [],
          ...(error === null || error === undefined
            ? {}
            : { error: `${error.code ?? error.name ?? 'error'}: ${error.message ?? String(error)}` }),
        })
      }
      try {
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) return abort()
        one.resolve4(hostname, finish)
      } catch (error) {
        finish(error)
      }
    })
  }

  /**
   * Query every configured server plus the system resolver, in parallel.
   *
   * Returns each server's own answer, because the panel shows which server
   * supplied which address and the user needs to see a dead server rather than
   * have it silently dropped.
   */
  async function discoverFromResolvers(hostname, report, signal) {
    const servers = [...current.dnsServers]
    report?.({ stage: 'discover', resolvers: servers.length + 1, resolversDone: 0 })
    const querySystem = async () => {
      let timer
      let system = { server: 'system', addresses: [], system: true }
      try {
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('system DNS lookup timed out'), { code: 'ETIMEOUT' })), Math.max(current.timeoutMs, 2000))
          timer.unref?.()
        })
        const answer = await abortable(Promise.race([
          nativePromiseLookup.call(dns.promises, hostname, { all: true, family: 4 }), deadline,
        ]), signal)
        system.addresses = sortAddresses((Array.isArray(answer) ? answer : [answer])
          .map((entry) => typeof entry === 'string' ? entry : entry?.address)
          .filter((address) => net.isIP(address ?? '') === 4))
      } catch (error) {
        system.error = `${error.code ?? error.name ?? 'error'}: ${error.message ?? String(error)}`
      } finally { clearTimeout(timer) }
      report?.({ resolversDone: 1 })
      return system
    }
    return Promise.all([
      ...servers.map(async (server) => {
        const answer = await queryOneServer(server, hostname, signal)
        report?.({ resolversDone: 1 })
        return { ...answer, addresses: sortAddresses(answer.addresses) }
      }),
      querySystem(),
    ])
  }

  // ------------------------------------------------------------------- probe
  //
  // Probing is a user action, not a background reflex.
  //
  // The earlier design measured automatically on first use, which meant every
  // cold start paid for a network sweep nobody asked for and the result was lost
  // on restart. Now a probe runs only when triggered, measures the full
  // candidate set once, lists what it found, and persists the choice — so a
  // restart reuses the stored address with no network activity at all.
  //
  // `results` mirrors the persisted document: [provider, hostname] -> measured candidates
  // plus the selected address.
  const persisted = readState()
  const results = new Map()

  /**
   * Live progress of the run in flight, or undefined when idle.
   *
   * Status is polled by the panel, so this is plain mutable state rather than a
   * stream. It is deliberately small and overwritten in place: a run is short,
   * and the panel only ever renders the latest snapshot.
   */
  let progress
  let runSequence = 0

  /**
   * The most recent finished run, kept separately from `progress`.
   *
   * `progress` is cleared shortly after a run ends so the panel knows it is idle.
   * The outcome must not disappear with it: a poll that lands just after the
   * clear would otherwise lose the summary entirely, which is exactly why the
   * "test this address" result sometimes vanished. This outlives the clear.
   */
  let lastRun

  function beginProgress(hostname) {
    if (operationBusy || (progress && !['done', 'failed', 'stopped'].includes(progress.stage))) throw new Error('a measurement is already running')
    progress = {
      hostname,
      runId: `${Date.now()}-${++runSequence}`,
      stage: 'starting',
      startedAt: Date.now(),
      resolvers: 0,
      resolversDone: 0,
      attempted: 0,
      usable: 0,
      total: 0,
      timing: 0,
      timingTotal: 0,
      // Each finished timing, newest first, so the panel can show real numbers
      // appearing instead of an opaque "measuring…".
      results: [],
    }
    const snapshot = progress
    const controller = new AbortController()
    const report = (patch) => {
      if (progress !== snapshot || disposed) return
      if (patch.resolversDone !== undefined && patch.resolvers === undefined) {
        patch = { ...patch, resolversDone: (progress.resolversDone ?? 0) + patch.resolversDone }
      }
      if (controller.signal.aborted && !['done', 'failed', 'stopped'].includes(patch.stage)) patch = { ...patch, stage: 'stopping' }
      Object.assign(progress, patch)
      // A terminal snapshot is also stored as the durable outcome, so it survives
      // `endProgress`.
      if (['done', 'failed', 'stopped'].includes(progress.stage)) {
        lastRun = { ...progress, finishedAt: progress.finishedAt ?? Date.now() }
      }
    }
    activeRun = { controller, report, runId: progress.runId }
    return report
  }

  function endProgress() {
    if (operationBusy) return
    progress = undefined
  }

  for (const [hostname, entry] of Object.entries(persisted.hosts ?? {})) {
    if (entry !== null && typeof entry === 'object' && Array.isArray(entry.candidates)) {
      storeRecord({
        ...entry,
        hostname: entry.hostname ?? hostname,
        // Per-provider identity is part of the record: the panel groups by it and
        // a host shared by two providers stays two decisions.
        provider: typeof entry.provider === 'string' ? entry.provider : undefined,
        candidates: entry.candidates,
        selected: net.isIP(entry.selected ?? '') === 4 ? entry.selected : undefined,
        recommended: entry.benchmarks?.[entry.recommended]?.scoringVersion === 1 ? entry.recommended : undefined,
        selectedSource: typeof entry.selectedSource === 'string' ? entry.selectedSource : 'rtt',
        probedAt: typeof entry.probedAt === 'number' ? entry.probedAt : 0,
        dnsAnswers: Array.isArray(entry.dnsAnswers) ? entry.dnsAnswers : [],
        systemAnswers: Array.isArray(entry.systemAnswers) ? entry.systemAnswers : [],
        resolvers: Array.isArray(entry.resolvers) ? entry.resolvers : [],
        message: typeof entry.message === 'string' ? entry.message : undefined,
        benchmarks: entry.benchmarks !== null && typeof entry.benchmarks === 'object' ? entry.benchmarks : {},
      }, false)
      const migratedKey = recordKey(entry.hostname ?? hostname, entry.provider)
      if (migratedKey !== hostname) { dirtyKeys.add(migratedKey); deletedKeys.add(hostname) }
    }
  }

  /** Write the current results back to disk; failures must not break the plugin. */
  function persist() {
    try {
      writeState({ hosts: Object.fromEntries(results) }, process.env, { changedKeys: [...dirtyKeys], deletedKeys: [...deletedKeys] })
      dirtyKeys.clear()
      deletedKeys.clear()
      return undefined
    } catch (error) {
      const message = 'dsh-best-ip: could not save probe results; check local storage permissions and available space'
      logger?.warn(message)
      return message
    }
  }

  /**
   * Measure every candidate for one hostname and record the outcome.
   *
   * Measures DNS answers first (cheap, usually already good), then the edge
   * ranges when enabled, and keeps EVERY usable candidate so
   * the user can pick one instead of accepting the ranking.
   */
  async function probeHostname(hostname, provider, report, { commit = true, signal } = {}) {
    const previous = recordFor(hostname, provider)
    stats.optimizes++

    // Discovery only: ask every configured server and the system resolver in
    // parallel. A server that fails is recorded as failed rather than dropped,
    // so the panel can show a dead resolver instead of hiding it.
    report?.({ stage: 'discover' })
    const discoveries = await discoverFromResolvers(hostname, report, signal)
    if (disposed) throw new Error('plugin was disposed')
    const sourcesFor = new Map()
    for (const discovery of discoveries) {
      for (const address of discovery.addresses) {
        const list = sourcesFor.get(address) ?? []
        list.push(discovery.server)
        sourcesFor.set(address, list)
      }
    }
    const dnsAddresses = sortAddresses(
      discoveries
        .filter((entry) => entry.system !== true)
        .flatMap((entry) => entry.addresses)
        .filter((address, index, all) => all.indexOf(address) === index),
    )
    const systemAddresses = discoveries.find((entry) => entry.system === true)?.addresses ?? []
    // Sorted, so the probe order (and therefore early progress reporting) does
    // not depend on which resolver happened to answer first.
    const initial = sortAddresses([...sourcesFor.keys()])

    // Nothing resolved anywhere: report it instead of scanning on a guess.
    if (initial.length === 0) {
      const result = {
        hostname,
        provider: typeof provider === 'string' ? provider : provider?.provider,
        candidates: signal?.aborted ? previous?.candidates ?? [] : [],
        stopped: signal?.aborted === true,
        selected: previous?.selected,
        selectedSource: previous?.selectedSource ?? 'none',
        probedAt: Date.now(),
        dnsAnswers: [],
        systemAnswers: [],
        resolvers: discoveries,
        benchmarks: signal?.aborted ? previous?.benchmarks ?? {} : {},
        message: 'no configured resolver returned an address for this host',
      }
      stats.optimizeMisses++
      if (commit && !disposed) storeRecord(result)
      return { ...result, saveError: commit && !disposed ? persist() : undefined }
    }

    report?.({ stage: 'inspect', total: initial.length, attempted: 0, usable: 0 })
    const base = typeof provider?.baseURL === 'string' ? new URL(provider.baseURL) : undefined
    const endpoint = { apiPath: base ? `${base.pathname.replace(/\/+$/, '')}/models` : '/v1/models',
      port: base?.port ? Number(base.port) : 443 }
    let found = signal?.aborted ? [] : await inspectAll(initial, hostname, {
      signal,
      ...endpoint,
      concurrency: Math.min(current.probeConcurrency, 8),
      timeout: Math.min(Math.max(current.timeoutMs, 2000), 6000),
      waveSize: 8,
      onProgress: ({ attempted, usable, total }) => report?.({ attempted, usable, total }),
    })

    if (disposed) throw new Error('plugin was disposed')
    if (current.scanEdges && !signal?.aborted) {
      const extra = scanCandidates(current.maxCandidates).filter((ip) => !initial.includes(ip))
      const scanTotal = Math.min(extra.length, current.maxCandidates)
      report?.({ stage: 'scan', total: scanTotal, attempted: 0, usable: found.length })
      const scanned = await inspectAll(extra.slice(0, current.maxCandidates), hostname, {
        signal,
        ...endpoint,
        concurrency: current.probeConcurrency,
        timeout: Math.max(current.timeoutMs, 6000),
        onProgress: ({ attempted, usable }) => report?.({ attempted, usable: found.length + usable }),
      })
      found = [...found, ...scanned]
    }

    // De-duplicate by address, keeping the fastest measurement for each.
    const byIp = new Map()
    for (const entry of found) {
      const previous = byIp.get(entry.ip)
      if (previous === undefined || (entry.rtt ?? 1e9) < (previous.rtt ?? 1e9)) byIp.set(entry.ip, entry)
    }

    // Candidate ORDER here is only a starting suggestion. Ranked by RTT it can be
    // actively misleading — measured on this line, Hong Kong addresses answered
    // TCP in 51-65ms while their first token arrived at 1631-3423ms, slower than
    // a San Jose address at 1149ms. Which address actually wins is decided by
    // `benchmark`, not here.
    const ranked = rankAddresses([...byIp.values()], { preferNear: current.preferNearEdges })
    const candidates = ranked.map((entry) => ({
      ip: entry.ip,
      colo: entry.colo ?? 'unknown',
      rtt: entry.rtt === undefined ? undefined : Math.round(entry.rtt),
      // Which resolver produced this address, so the panel can show the
      // baseline and the user can tell "the default answer" from "a scanned
      // alternative".
      fromDns: dnsAddresses.includes(entry.ip),
      fromSystem: systemAddresses.includes(entry.ip),
      sources: sourcesFor.get(entry.ip) ?? [],
    }))

    const result = {
      hostname,
      // Only the provider ID is stored: the profile holds a credential reference
      // and model list, and persisting that would duplicate configuration into a
      // second place that can drift from the real one.
      provider: typeof provider === 'string' ? provider : provider?.provider,
      stopped: signal?.aborted === true,
      candidates,
      // Discovery never changes the live selection, even if it disappeared
      // from this snapshot. A successful explicit apply is the only authority.
      selected: previous?.selected,
      selectedSource: previous?.selectedSource ?? 'none',
      probedAt: Date.now(),
      dnsAnswers: dnsAddresses,
      // Both resolver sets are kept: the panel shows which servers answered and
      // which addresses came from the system resolver, i.e. what this machine
      // would use without the plugin.
      systemAnswers: systemAddresses,
      resolvers: discoveries,
      // Benchmarks are kept across a re-probe when the address survives, so a
      // re-scan does not throw away measurements that are still valid.
      benchmarks: pruneBenchmarks(previous?.benchmarks, candidates),
    }
    if (commit && !disposed) storeRecord(result)
    if (candidates.length === 0) stats.optimizeMisses++
    const saveError = commit && !disposed ? persist() : undefined
    return { ...result, saveError }
  }

  /** Drop benchmark entries whose address is no longer a candidate. */
  function pruneBenchmarks(previous, candidates) {
    const keep = new Set(candidates.map((entry) => entry.ip))
    const out = {}
    for (const [ip, measurement] of Object.entries(previous ?? {})) {
      if (keep.has(ip)) out[ip] = measurement
    }
    return out
  }

  /**
   * Order candidates for benchmarking: lowest RTT first.
   *
   * Ping is the *search order*, not the decision. Measuring the nearest edges
   * first and keeping the best stream is what the user asked for, and it means a
   * good answer usually appears within the first few paid requests.
   */
  function byRtt(candidates) {
    const rtt = (entry) => Number.isFinite(entry.rtt) && entry.rtt >= 0 ? entry.rtt : Number.POSITIVE_INFINITY
    return [...candidates].sort((a, b) => rtt(a) - rtt(b))
  }

  function benchmarkIpLimit(options) {
    const limit = options.maxBenchmarkIps === undefined ? current.maxBenchmarkIps : options.maxBenchmarkIps
    if (!isBenchmarkIpLimit(limit)) throw new Error('maxBenchmarkIps must be a non-negative safe integer (0 = all)')
    return limit
  }

  /** Rank only reliable, current-policy samples by conservative stability score. */
  function rankByStability(benchmarks) {
    return Object.values(benchmarks ?? {})
      .filter((entry) => entry.rankEligible === true && entry.scoringVersion === 1 && Number.isFinite(entry.stabilityScore) && entry.stabilityScore > 0)
      .sort((a, b) => b.stabilityScore - a.stabilityScore || b.conservativeTps - a.conservativeTps || (a.ttftMs ?? Infinity) - (b.ttftMs ?? Infinity))
  }

  /**
   * Time usable candidates in lowest-ping order, up to the configured IP limit.
   *
   * Discovery keeps the full usable set. Only the paid speed-test subset is
   * capped (0 = all), before workers launch, so concurrency cannot exceed the
   * address budget. Failures consume a slot too; they never trigger backfilling.
   * Each chosen IP still receives the same number of runs.
   *
   * `message` is the user's own test prompt: a short greeting produces too few
   * tokens for a meaningful rate, so the text is theirs to choose rather than
   * baked in here.
   */
  async function benchmarkHostname(hostname, options, report) {
    const maxBenchmarkIps = benchmarkIpLimit(options)
    if (options.provider?.authType === 'oauth') throw new Error('OAuth providers are not supported for speed testing yet')
    const record = options.record ?? recordFor(hostname, options.provider)
    if (!Number.isFinite(options.runs ?? 3) || !Number.isFinite(options.parallelism ?? SUBAGENT_PARALLELISM_DEFAULT)) throw new Error('runs and parallelism must be finite numbers')
    const api = options.provider?.api ?? 'openai-completions'
    if (!supportsBenchmarkApi(api)) throw new Error(`benchmark does not support provider API: ${api}`)
    if (new URL(options.provider.baseURL).protocol !== 'https:') throw new Error('benchmark requires an HTTPS endpoint')
    if (record === undefined) throw new Error(`no probe result for ${hostname}; probe first`)
    const { provider, message, model, maxTokens = BENCHMARK_MAX_TOKENS, only, signal } = options
    report?.({ provider: provider.provider, model })
    if (hostnameOf(provider.baseURL) !== hostname) throw new Error('provider baseURL does not match the requested host')
    if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
      throw new Error('no credential could be resolved for this provider; check its API key setting')
    }
    const runs = Math.min(5, Math.max(1, Math.floor(options.runs ?? 3)))
    const parallelism = Math.max(1, Math.floor(options.parallelism ?? SUBAGENT_PARALLELISM_DEFAULT))
    const orderedTargets = byRtt(record.candidates.filter((entry) => only === undefined || only.includes(entry.ip)))
    const targets = maxBenchmarkIps === 0 ? orderedTargets : orderedTargets.slice(0, maxBenchmarkIps)
    const raw = new Map(targets.map((entry) => [entry.ip, []]))
    const rows = targets.map((entry) => ({ ip: entry.ip, colo: entry.colo ?? 'unknown', runs: [] }))
    const measure = async (candidate) => {
      if (disposed || signal?.aborted) return
      let measurement
      try {
        measurement = await abortable(measureStream({ provider, apiKey: options.apiKey, ip: candidate.ip,
          message, model, maxTokens, timeout: 60000, signal }), signal)
      } catch (error) {
        measurement = { ip: candidate.ip, error: error?.message ?? String(error), ...(signal?.aborted ? { cancelled: true } : {}) }
      }
      raw.get(candidate.ip).push(measurement)
      rows.find((row) => row.ip === candidate.ip).runs.push({
        ttftMs: measurement.ttftMs ?? null, tps: measurement.tps ?? null,
        ...(measurement.error === undefined ? {} : { error: sampleError(measurement) }),
        ...(measurement.cancelled ? { cancelled: true } : {}),
      })
      report?.({ timing: rows.reduce((n, row) => n + row.runs.length, 0), timingTotal: targets.length * runs,
        rows: rows.map((row) => ({ ...row, runs: [...row.runs] })) })
    }
    // Equal sample counts for all selected candidates. Mixing a single lucky screening
    // score with a leader's median biased the old final ranking.
    for (let round = 0; round < runs; round++) {
      if (disposed || signal?.aborted) break
      report?.({ stage: round === 0 ? 'timing' : 'confirm', timingTotal: targets.length * runs, rows })
      const offset = round % Math.max(1, targets.length)
      const ordered = [...targets.slice(offset), ...targets.slice(0, offset)]
      await mapWithConcurrency(ordered, parallelism, measure, signal)
    }
    // Ranking is strictly this run + this model/prompt, never stale records or
    // addresses outside an explicit subset.
    const fresh = Object.fromEntries(targets.map((candidate) => [candidate.ip, {
      ...summarize(raw.get(candidate.ip), { plannedRuns: runs }), ip: candidate.ip, colo: candidate.colo,
      rtt: candidate.rtt, at: Date.now(), confirmed: raw.get(candidate.ip).length === runs && !raw.get(candidate.ip).some((entry) => entry.cancelled),
    }]))
    const best = rankByStability(fresh)[0]
    const testOnly = options.testOnly !== false
    const stopped = signal?.aborted === true
    const mayApply = typeof options.canApply !== 'function' || options.canApply() === true
    const next = {
      ...record, stopped, benchmarks: { ...(record.benchmarks ?? {}), ...fresh },
      benchmarkContext: sanitizeBenchmarkContext({ provider: provider.provider, baseURL: provider.baseURL, model, maxTokens, runs, maxBenchmarkIps }),
      recommended: best?.ip, testOnly, applied: false,
      benchmarkFailed: !stopped && best === undefined,
      defaultChanged: !stopped && !testOnly && !mayApply,
      message: stopped ? 'test stopped; partial results saved; current address unchanged' : best && !testOnly && !mayApply ? 'default provider or model changed; results saved without applying an address' : best === undefined ? 'no candidate produced a reliable measurable stream; previous selection kept' : undefined,
    }
    if (best !== undefined && !testOnly && !disposed && !stopped && mayApply) {
      next.selected = best.ip
      next.selectedSource = 'benchmark'
      next.applied = true
    }
    if (!disposed) {
      storeRecord(next)
      next.applied = !stopped && !testOnly && mayApply && best !== undefined && activeAddressFor(hostname) === best.ip
      storeRecord(next)
    }
    const saveError = disposed ? 'plugin was disposed; results not applied' : persist()
    return { ...next, saveError }
  }

  /**
   * The one-click flow: discover usable addresses, then measure throughput
   * lowest-RTT first, then keep the fastest stream.
   *
   * Steps, and why each exists:
   *   1. Probe. Discover addresses that answer a real API request, ordered by
   *      RTT. This filters out unreachable and non-serving edges before any
   *      paid request is made.
   *   2. Speed-test in RTT order. Cheap-per-connection edges are tried first,
   *      which usually finds a good answer in a few requests.
   *   3. Select the best conservative speed-and-stability score, not the
   *      highest lucky TPS/median or the lowest RTT.
   */
  async function autoOptimize(hostname, options, report) {
    const maxBenchmarkIps = benchmarkIpLimit(options)
    if (options.provider?.authType === 'oauth') throw new Error('OAuth providers are not supported for speed testing yet')
    report?.({ provider: options.provider?.provider, model: options.model })
    if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) throw new Error('no credential could be resolved for this provider')
    if (hostnameOf(options.provider.baseURL) !== hostname) throw new Error('provider baseURL does not match the requested host')
    if (new URL(options.provider.baseURL).protocol !== 'https:') throw new Error('benchmark requires an HTTPS endpoint')
    if (!supportsBenchmarkApi(options.provider.api)) throw new Error(`benchmark does not support provider API: ${options.provider.api}`)
    // Job-local discovery: no intermediate pin, no rollback of live state.
    const probed = await probeHostname(hostname, options.provider, report, { commit: false, signal: options.signal })
    if (options.signal?.aborted || probed.candidates.length === 0) {
      const failed = { ...probed, stage: 'probe', benchmarked: false, stopped: options.signal?.aborted === true, benchmarkFailed: !options.signal?.aborted,
        applied: false, testOnly: options.testOnly !== false,
        reasonCode: options.signal?.aborted ? undefined : 'NO_USABLE_IP',
        message: 'no usable candidate; previous selection kept' }
      if (!disposed) storeRecord(failed)
      return { ...failed, saveError: disposed ? 'plugin was disposed' : persist() }
    }
    const benched = await benchmarkHostname(hostname, { ...options, maxBenchmarkIps, record: probed }, report)
    return { ...benched, stage: 'benchmark', benchmarked: true }
  }

  /** Record a user's explicit choice from the measured candidates. */
  function selectAddress(hostname, ip, options = {}) {
    if (operationBusy || disposed) throw new Error('a measurement is running or plugin was disposed')
    if (options.testOnly !== false) throw new Error('test-only mode cannot apply an address')
    const current = recordFor(hostname, options.provider)
    if (current === undefined) throw new Error(`no probe result for ${hostname}; run a probe first`)
    if (!current.candidates.some((entry) => entry.ip === ip)) {
      throw new Error(`"${ip}" is not one of the measured candidates for ${hostname}`)
    }
    const next = { ...current, selected: ip, selectedSource: 'manual', chosenAt: Date.now() }
    storeRecord(next)
    const saveError = persist()
    return { ...next, saveError }
  }

  /**
   * Resolve a hostname, substituting the stored selection when there is one.
   *
   * Never probes: a lookup must stay a lookup. The stored address goes first and
   * the resolver's own answers follow, so a stored address that stopped working
   * still leaves the connection a way out.
   */
  function activeAddressFor(hostname) {
    hostname = canonicalHost(hostname)
    if (!current.enabled || !matches(hostname)) return undefined
    const records = [...results.values()].filter((entry) => entry.hostname === hostname)
    const bindings = hostProviders.get(hostname)
    const scoped = bindings?.length ? bindings.map((id) => recordFor(hostname, id))
      : records.filter((entry) => net.isIP(entry.selected ?? '') === 4)
    if (scoped.length === 0 || scoped.some((entry) => net.isIP(entry?.selected ?? '') !== 4)) return undefined
    const addresses = new Set(scoped.map((entry) => entry.selected))
    // DNS sees a hostname, not the provider. Conflicting same-host decisions
    // cannot safely be applied independently; leave them on system DNS.
    return addresses.size === 1 ? [...addresses][0] : undefined
  }

  async function resolveHost(hostname, family) {
    const chosen = family === 6 ? undefined : activeAddressFor(hostname)
    if (chosen !== undefined) {
      stats.optimizeReused++
      return [{ address: chosen, family: 4 }]
    }
    return nativePromiseLookup.call(dns.promises, hostname, { all: true, family })
  }

  /** Turn a resolved list into the shape the two lookup signatures expect. */
  function settle(callback, list, all, familyWanted) {
    if (all) {
      callback(null, list)
      return
    }
    const first = familyWanted === 6 ? list.find((entry) => entry.family === 6) : list[0]
    if (first === undefined) {
      const error = Object.assign(new Error('pinned DNS returned no usable address'), { code: 'ENOTFOUND' })
      callback(error)
      return
    }
    callback(null, first.address, first.family)
  }

  /**
   * Resolve one hostname through the pinned servers, honoring Node's two
   * lookup call shapes: `(host, opts, cb)` with `opts.all` or `opts.family`,
   * and the legacy numeric family form.
   */
  function pinnedLookup(hostname, options, callback) {
    let opts = options
    let cb = callback
    if (typeof opts === 'function') {
      cb = opts
      opts = {}
    }
    if (typeof opts === 'number') opts = { family: opts }
    const family = opts?.family === 6 || opts?.family === 'IPv6' ? 6 : 4
    const all = opts?.all === true

    resolveHost(hostname, family).then(
      (list) => settle(cb, list, all, family),
      (error) => {
        stats.failures++
        if (current.fallbackToSystem) {
          stats.fallbacks++
          logger?.warn(
            `dsh-best-ip: ${hostname} failed on ${current.dnsServers.join(', ')} (${error.code ?? error.message}); falling back to the system resolver`,
          )
          return originalLookup.call(dns, hostname, options, callback)
        }
        cb(error)
      },
    )
  }

  function pinnedPromiseLookup(hostname, options = {}) {
    const family = options?.family === 6 || options?.family === 'IPv6' ? 6 : 4
    const all = options?.all === true
    return resolveHost(hostname, family).then(
      (list) => (all ? list : settleToObject(list, family)),
      (error) => {
        stats.failures++
        if (current.fallbackToSystem) {
          stats.fallbacks++
          logger?.warn(
            `dsh-best-ip: ${hostname} failed on ${current.dnsServers.join(', ')} (${error.code ?? error.message}); falling back to the system resolver`,
          )
          return originalPromiseLookup.call(dns.promises, hostname, options)
        }
        throw error
      },
    )
  }

  function settleToObject(list, familyWanted) {
    const first = familyWanted === 6 ? list.find((entry) => entry.family === 6) : list[0]
    if (first === undefined) {
      throw Object.assign(new Error('pinned DNS returned no usable address'), { code: 'ENOTFOUND' })
    }
    return { address: first.address, family: first.family }
  }

  /**
   * Swap in the patched functions, never stacking a second patch on top of a
   * previous one: `previous` is what restore must put back, and the wrapper
   * always delegates to the native functions captured at module load. A
   * reload therefore replaces the patch instead of wrapping it again.
   */
  function install() {
    const token = {}
    const patched = function lookup(hostname, options, callback) {
      if (!shouldPin(hostname) || activeAddressFor(hostname) === undefined) return nativeLookup.call(dns, hostname, options, callback)
      return pinnedLookup(hostname, options, callback)
    }
    const patchedPromise = function lookup(hostname, options) {
      if (!shouldPin(hostname) || activeAddressFor(hostname) === undefined) return nativePromiseLookup.call(dns.promises, hostname, options)
      return pinnedPromiseLookup(hostname, options)
    }
    dns.lookup = patched
    dns.promises.lookup = patchedPromise
    interception.owner = token
    interception.wrapper = patched
    return () => {
      // A newer activation already replaced this patch and owns the restore.
      if (interception.owner !== token) return
      dns.lookup = NATIVE_LOOKUP
      dns.promises.lookup = NATIVE_PROMISE_LOOKUP
      interception.owner = undefined
      interception.wrapper = undefined
    }
  }

  function probe(hostname, family = 4) {
    return queryViaPinned(hostname, family).then((list) => list)
  }

  return {
    setHosts,
    install,
    probe,
    shouldPin,
    /** The address currently in use for a host, for display. */
    selectedFor: (hostname, provider) => recordFor(hostname, provider)?.selected,
    activeAddressFor,
    /** Live progress of the run in flight, or undefined when idle. */
    progress: () => (progress === undefined ? undefined : { ...progress }),
    /** The last finished run's outcome, which survives `endProgress`. */
    lastRun: () => (lastRun === undefined ? undefined : { ...lastRun }),
    /** Begin a run and return its reporter; call `endProgress` when finished. */
    beginProgress: (hostname) => beginProgress(hostname),
    endProgress: () => endProgress(),
    /**
     * Whether a run is actually still executing.
     *
     * A finished snapshot lingers so a late poll can read the outcome, so
     * `progress() !== undefined` is NOT the same as "busy" — gating a new run on
     * it would block the next action for the whole linger window.
     */
    busy() {
      if (operationBusy) return true
      if (progress === undefined) return false
      return !['done', 'failed', 'stopped'].includes(progress.stage)
    },
    /**
     * Time the address in use, right now, without re-probing or re-ranking.
     *
     * This exists so the user can answer "is the current pin still good?" at the
     * cost of `runs` requests, instead of paying for a full sweep. It updates
     * that address's stored benchmark but never changes the selection.
     */
    timeSelected: (hostname, options) => exclusive(async (signal, report) => {
      if (options.provider?.authType === 'oauth') throw new Error('OAuth providers are not supported for speed testing yet')
      if (!supportsBenchmarkApi(options.provider?.api)) throw new Error('unsupported benchmark API')
      report?.({ provider: options.provider?.provider, model: options.model })
      const record = recordFor(hostname, options.provider)
      let ip = activeAddressFor(hostname)
      if (ip === undefined) {
        const answer = await abortable(nativePromiseLookup.call(dns.promises, hostname, { all: true, family: 4 }), signal)
        ip = answer[0]?.address
      }
      if (net.isIP(ip ?? '') !== 4) throw new Error('no current IPv4 address is available')
      if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) throw new Error('no credential could be resolved for this provider')
      const runs = Math.min(5, Math.max(1, Math.floor(options.runs ?? 3)))
      const measurements = []
      for (let index = 0; index < runs; index++) {
        if (disposed || signal.aborted) break
        try {
          measurements.push(await abortable(measureStream({ ...options, ip, timeout: 60000, signal }), signal))
        } catch (error) { measurements.push({ ip, error: error?.message ?? String(error), ...(signal.aborted ? { cancelled: true } : {}) }) }
        report?.({ stage: 'timing', timing: index + 1, timingTotal: runs, address: ip,
          rows: [{ ip, colo: record?.candidates.find((entry) => entry.ip === ip)?.colo ?? '',
            runs: measurements.map((entry) => ({ ttftMs: entry.ttftMs ?? null, tps: entry.tps ?? null,
              ...(entry.error === undefined ? {} : { error: sampleError(entry) }) })) }] })
      }
      const summary = summarize(measurements, { plannedRuns: runs })
      // Current-address tests remain observational: progress keeps all samples,
      // without overwriting an optimization record from another workload.
      return { hostname, ip, runs, summary, stopped: signal.aborted, applied: false }
    }, hostname, options.report),
    stats: () => ({ ...stats, cacheEntries: cache.size }),
    state: () => ({
      enabled: current.enabled,
      // Read from the live config, never a captured snapshot: this is what the
      // panel shows after a save.
      servers: [...current.dnsServers],
      hosts: [...matcher.exact].sort(),
      includeSubdomains: current.includeSubdomains,
      fallbackToSystem: current.fallbackToSystem,
      ttlSeconds: current.ttlSeconds,
      // The configured selectors, so a settings panel can show what is chosen
      // rather than re-deriving it from the resolved host list.
      providerIds: [...new Set([...hostProviders.values()].flat())],
      extraHosts: [...current.extraHosts],
      scanEdges: current.scanEdges,
      maxBenchmarkIps: current.maxBenchmarkIps,
      preferNearEdges: current.preferNearEdges,
      neighbors: [...NEAR_COLOS],
    }),
    /**
     * Adopt a new configuration without recreating the plugin.
     *
     * A saved settings change must take effect immediately: the engine caches the
     * resolver and the TTL, so without this it kept answering with the values it
     * was constructed with. The DNS cache is cleared because answers resolved
     * under the old servers should not outlive the change.
     */
    reconfigure(nextConfig) {
      if (operationBusy) throw new Error('cannot reconfigure during a measurement')
      const replacement = new dns.Resolver({ timeout: nextConfig.timeoutMs, tries: 1 })
      if (nextConfig.dnsServers.length > 0) replacement.setServers(nextConfig.dnsServers)
      current = nextConfig
      ttlMs = current.ttlSeconds * 1000
      resolver = replacement
      generation++
      cache.clear()
      lastFailure.clear()
      inflight = new Map()
      return { servers: [...nextConfig.dnsServers] }
    },
    /** Every stored probe result, one record per provider host. */
    findings: () =>
      [...results.values()]
        .map((entry) => ({
          hostname: entry.hostname,
          provider: entry.provider,
          selected: entry.selected,
          selectedSource: entry.selectedSource,
          recommended: entry.recommended,
          testOnly: entry.testOnly,
          applied: entry.applied,
          benchmarkFailed: entry.benchmarkFailed,
          stopped: entry.stopped,
          activeAddress: activeAddressFor(entry.hostname),
          benchmarkContext: entry.benchmarkContext,
          probedAt: entry.probedAt,
          candidates: orderCandidates(entry.candidates, entry.benchmarks),
          dnsAnswers: entry.dnsAnswers,
          // The panel shows which servers answered; the system resolver is the
          // "what this machine would use without the plugin" baseline.
          systemAnswers: entry.systemAnswers ?? [],
          resolvers: entry.resolvers ?? [],
          ...(typeof entry.message === 'string' ? { message: entry.message } : {}),
          benchmarks: entry.benchmarks ?? {},
        }))
        .sort((a, b) => (b.probedAt ?? 0) - (a.probedAt ?? 0)),
    lastFailure: (hostname) => lastFailure.get(hostname),
    clearCache: () => {
      generation++
      cache.clear()
    },
    describeHosts: () => [...matcher.exact].sort(),
    /** Where the persisted results live, for the panel and diagnostics. */
    statePath: () => statePath(),
    /** Probe one provider host and store the measured candidates. */
    probeNow: (hostname, provider) => exclusive((signal, report) => probeHostname(hostname, provider, report, { signal }), hostname),
    /** Adopt a user's address choice for one provider host. */
    select: (hostname, ip, options) => selectAddress(hostname, ip, options),
    /** Run real streaming requests and rank by TTFT/TPS. */
    benchmark: (hostname, options, report) => exclusive((signal, reporter) => benchmarkHostname(hostname, { ...options, signal }, reporter), hostname, report),
    /** Probe, measure in RTT order, recommend the best robust score. */
    autoOptimize: (hostname, options, report) => exclusive((signal, reporter) => autoOptimize(hostname, { ...options, signal }, reporter), hostname, report),
    /** Current benchmark map for one host. */
    benchmarksFor: (hostname, provider) => recordFor(hostname, provider)?.benchmarks ?? {},
    /** Forget stored results for one host (or all of them). */
    stop(runId) {
      if (typeof runId !== 'string' || !runId) throw new Error('runId is required')
      if (activeRun?.runId !== runId) throw new Error('measurement runId no longer matches')
      const active = operationBusy || (progress && !['done', 'failed', 'stopped'].includes(progress.stage))
      if (!active) return { requested: false, runId, stage: progress?.stage ?? 'idle' }
      activeRun.report({ stage: 'stopping', stopped: true, applied: false })
      activeRun.controller.abort()
      return { requested: true, runId, stage: 'stopping' }
    },
    dispose() { disposed = true; activeRun?.controller.abort() },
    forget(hostname, provider) {
      if (operationBusy || disposed) throw new Error('a measurement is running or plugin was disposed')
      if (hostname === undefined) throw new Error('an explicit host is required')
      for (const [key, record] of results) {
        if (record.hostname === canonicalHost(hostname) && (provider === undefined || record.provider === provider)) {
          results.delete(key); dirtyKeys.delete(key); deletedKeys.add(key)
        }
      }
      const error = persist()
      return error
    },
  }
}

function apply(ctx, rawConfig, dependencies = {}) {
  // `let` so a saved settings change can replace it: every closure below reads
  // the current value rather than a snapshot from activation time.
  let config = normalizeConfig(rawConfig)
  const engine = dependencies.engine ?? createResolver(config, ctx.logger)

  /**
   * Read this plugin's own saved row back out of the loader configuration.
   *
   * The live `Config` reference is not reachable from here, so a save is
   * confirmed by reading what was written. Returning `undefined` means the read
   * failed and the caller should keep the configuration it has.
   */
  function readOwnConfig() {
    const editor = ctx.get('configEditor')
    if (editor === undefined || typeof editor.configuration !== 'function') return undefined
    try {
      for (const { entry, override, inherited } of editor.configuration()) {
        if (entry?.options?.id !== 'dsh-best-ip' && !entry?.id?.endsWith(':dsh-best-ip')) continue
        return { ...inherited, ...override }
      }
    } catch (error) {
      ctx.logger?.warn('dsh-best-ip: could not re-read its own config')
    }
    return undefined
  }

  const access = dependencies.providerAccess ?? createProviderAccess(ctx)
  const { ready, readDefaultSelection, readProviderProfiles, resolveApiKey, describeBenchmark, isCurrentDefault } = access
  const follower = createDefaultFollower(engine, access, () => config)
  const refreshHosts = (options) => follower.refresh(options).catch(() => {
    ctx.logger?.warn('dsh-best-ip: could not follow the current default provider')
    return []
  })

  let restore = undefined
  ctx.effect(() => {
    void refreshHosts()
    restore = engine.install()
    const hosts = engine.describeHosts()
    ctx.logger?.info(
      hosts.length === 0
        ? 'dsh-best-ip: enabled but no host matched yet; add a provider whose baseURL host should use the pinned servers'
        : `dsh-best-ip: routing ${hosts.join(', ')} through ${config.dnsServers.join(', ')}`,
    )
    return () => {
      follower.dispose()
      engine.dispose()
      if (restore !== undefined) restore()
      restore = undefined
    }
  }, 'dsh-best-ip: dns.lookup interception')

  // Follow resolved Settings, topology and credential changes; never mutate
  // the default model/provider or invoke native OAuth resolution/refresh.
  ctx.effect(() => {
    const disposers = [
      ctx.on('app-boot/config-reload', () => { void refreshHosts() }),
      ctx.on('settings/document-updated', () => { void refreshHosts() }),
      ctx.on('llm/adapters-updated', () => { void refreshHosts() }),
      ctx.on('credentials/record-updated', (key) => {
        const selected = readDefaultSelection()
        if (key === readProviderProfiles().get(selected?.provider)?.credentialKey) void refreshHosts({ credentialsChanged: true })
      }),
      ctx.on('credentials/reference-updated', (ref) => {
        const selected = readDefaultSelection(), profile = readProviderProfiles().get(selected?.provider)
        if (profile?.apiKeyEnv === ref || profile?.nativeAuth?.env?.includes(ref)) void refreshHosts({ credentialsChanged: true })
      }),
    ]
    return () => { for (const dispose of disposers) dispose?.() }
  }, 'dsh-best-ip: follow the DSH default provider')

  // Read at run start: a changed Subagent parallelism limit must affect the next
  // measurement without requiring this plugin to be reactivated.
  const subagentParallelism = () => readSubagentParallelism(ctx, ctx.logger)

  // A save must reach the closures that read configuration. Passing a setter
  // rather than the value keeps `config` and the engine in step.
  const applyConfig = (next) => {
    config = next
    engine.reconfigure(config)
    void refreshHosts()
  }

  registerTools(ctx, engine, refreshHosts, { readProviderProfiles, resolveApiKey, readDefaultSelection, subagentParallelism, describeBenchmark, isCurrentDefault, ready })
  registerHttpBridge(ctx, engine, refreshHosts, config, {
    readProviderProfiles,
    resolveApiKey,
    readDefaultSelection,
    subagentParallelism,
    describeBenchmark,
    isCurrentDefault,
    ready,
    readOwnConfig,
    applyConfig,
  })
}

/** Agent-facing operations: inspect state and verify resolution. */
function registerTools(ctx, engine, refreshHosts, providers) {
  const { readProviderProfiles, resolveApiKey, readDefaultSelection, subagentParallelism, describeBenchmark = async () => ({ supported: true }), isCurrentDefault = () => true, ready } = providers
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => {
      const disposeState = toolsCtx.tools.register({
        name: 'best_ip_status',
        description:
          'Report active provider pins, saved test recommendations, resolver candidates, and measurement statistics.',
        // `tools.register` takes a complete JSON Schema here, not the property
        // map `defineTool` accepts. A bare `{}` or a property map makes the
        // root schema invalid under the provider's strict tool validation.
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              enabled: { type: 'boolean' },
              servers: { type: 'array', items: { type: 'string' } },
              hosts: { type: 'array', items: { type: 'string' } },
              providerIds: { type: 'array', items: { type: 'string' } },
              extraHosts: { type: 'array', items: { type: 'string' } },
              includeSubdomains: { type: 'boolean' },
              fallbackToSystem: { type: 'boolean' },
              ttlSeconds: { type: 'number' },
              scanEdges: { type: 'boolean' },
              maxBenchmarkIps: { type: 'number' },
              preferNearEdges: { type: 'boolean' },
              neighbors: { type: 'array', items: { type: 'string' } },
              run: { type: 'object', additionalProperties: false, properties: { runId: { type: 'string' }, hostname: { type: 'string' }, stage: { type: 'string' } } },
              measurements: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    hostname: { type: 'string' },
                    provider: { type: 'string' },
                    selected: { type: 'string' },
                    selectedSource: { type: 'string' },
                    recommended: { type: 'string' },
                    activeAddress: { type: 'string' },
                    testOnly: { type: 'boolean' },
                    ageSeconds: { type: 'number' },
                    dnsAnswers: { type: 'array', items: { type: 'string' } },
                    systemAnswers: { type: 'array', items: { type: 'string' } },
                    resolvers: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          server: { type: 'string' },
                          addresses: { type: 'array', items: { type: 'string' } },
                          system: { type: 'boolean' },
                          error: { type: 'string' },
                        },
                      },
                    },
                    candidates: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          ip: { type: 'string' },
                          colo: { type: 'string' },
                          rtt: { type: 'number' },
                          ttftMs: { type: 'number' },
                          tps: { type: 'number' },
                          stabilityScore: { type: 'number' },
                          rankEligible: { type: 'boolean' },
                          runTps: { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'null' }] } },
                          outputTokens: { type: 'number' },
                          benchmarked: { type: 'boolean' },
                          failed: { type: 'boolean' },
                        },
                      },
                    },
                  },
                },
              },
              pinned: { type: 'number' },
              cacheHits: { type: 'number' },
              failures: { type: 'number' },
              fallbacks: { type: 'number' },
              cacheEntries: { type: 'number' },
              optimizes: { type: 'number' },
              optimizeReused: { type: 'number' },
              optimizeMisses: { type: 'number' },
            },
          },
          render(_args, value) {
            const lines = [
              `enabled: ${value.enabled}`,
              `servers: ${value.servers.length > 0 ? value.servers.join(', ') : '(none)'}`,
              `providers: ${value.providerIds.length > 0 ? value.providerIds.join(', ') : '(none)'}`,
              `hosts: ${value.hosts.length > 0 ? value.hosts.join(', ') : '(none)'}`,
              `ttl: ${value.ttlSeconds}s · queries: pinned=${value.pinned} cacheHits=${value.cacheHits} failures=${value.failures} fallbacks=${value.fallbacks}`,
            ]
            if (value.run) lines.push(`run: ${value.run.runId} · ${value.run.stage}`)
            if (value.measurements.length === 0) {
              lines.push('measurements: (none — run a probe to collect addresses)')
            }
            for (const measurement of value.measurements) {
              lines.push(
                `${measurement.hostname}${measurement.provider === undefined ? '' : ` [${measurement.provider}]`} -> ${measurement.selected ?? '(unset)'} via ${measurement.selectedSource ?? '?'} · ${measurement.ageSeconds}s ago`,
              )
              for (const candidate of measurement.candidates) {
                const timing = candidate.benchmarked
                  ? `TTFT=${candidate.ttftMs === undefined ? '-' : `${candidate.ttftMs}ms`} TPS=${candidate.tps === undefined ? '-' : candidate.tps}`
                  : candidate.failed
                    ? 'unusable'
                    : 'not benchmarked'
                lines.push(
                  `  ${candidate.ip.padEnd(16)} ${(candidate.colo ?? '?').padEnd(5)} rtt=${String(candidate.rtt ?? '?').padStart(4)}ms  ${timing}${candidate.runTps ? ` (${candidate.runTps.map((n) => n ?? '-').join(', ')})` : ''}${candidate.stabilityScore === undefined ? '' : ` score=${candidate.stabilityScore}`}`,
                )
              }
            }
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        async execute() {
          await refreshHosts()
          const state = engine.state()
          const measurements = engine.findings().map((finding) => ({
            hostname: finding.hostname,
            // Optional fields are omitted, never set to undefined: the output
            // schema is closed and the runtime rejects a non-lossless payload.
            ...(typeof finding.provider === 'string' ? { provider: finding.provider } : {}),
            ...(typeof finding.selected === 'string' ? { selected: finding.selected } : {}),
            ...(typeof finding.selectedSource === 'string' ? { selectedSource: finding.selectedSource } : {}),
            ...(typeof finding.recommended === 'string' ? { recommended: finding.recommended } : {}),
            ...(typeof finding.activeAddress === 'string' ? { activeAddress: finding.activeAddress } : {}),
            ...(typeof finding.testOnly === 'boolean' ? { testOnly: finding.testOnly } : {}),
            ageSeconds: Math.max(0, Math.round((Date.now() - (finding.probedAt ?? 0)) / 1000)),
            // Per-resolver answers are part of the record: they show which server
            // supplied which address, and with them sorted the same answer set
            // renders identically regardless of arrival order.
            dnsAnswers: finding.dnsAnswers ?? [],
            systemAnswers: finding.systemAnswers ?? [],
            resolvers: (finding.resolvers ?? []).map((entry) => ({
              server: entry.server,
              addresses: entry.addresses ?? [],
              ...(entry.system === true ? { system: true } : {}),
              ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
            })),
            candidates: (finding.candidates ?? []).map((candidate) => {
              const bench = finding.benchmarks?.[candidate.ip]
              // Omit unmeasured figures instead of setting them to undefined:
              // the output schema is closed and the runtime rejects a payload
              // that is not lossless JSON.
              return {
                ip: candidate.ip,
                colo: candidate.colo ?? 'unknown',
                rtt: candidate.rtt ?? 0,
                ...(typeof bench?.ttftMs === 'number' ? { ttftMs: bench.ttftMs } : {}),
                ...(Number.isFinite(bench?.tps) ? { tps: bench.tps } : {}),
                ...(Number.isFinite(bench?.stabilityScore) ? { stabilityScore: bench.stabilityScore } : {}),
                ...(typeof bench?.rankEligible === 'boolean' ? { rankEligible: bench.rankEligible } : {}),
                ...(Array.isArray(bench?.samples) ? { runTps: bench.samples.map((sample) => Number.isFinite(sample.tps) ? sample.tps : null) } : {}),
                ...(typeof bench?.outputTokens === 'number' ? { outputTokens: bench.outputTokens } : {}),
                benchmarked: bench?.eligible === true && Number.isFinite(bench?.tps),
                failed: bench !== undefined && bench.error !== undefined,
              }
            }),
          }))
          const run = engine.progress()
          return { ...state, measurements, ...engine.stats(), ...(run ? { run: { runId: run.runId, hostname: run.hostname, stage: run.stage } } : {}) }
        },
      })

      const disposeProbe = toolsCtx.tools.register({
        name: 'best_ip_resolve',
        description:
          'Inspect DNS candidates and the saved selection; optionally discover or benchmark IPs. Benchmarks cost API tokens and default to test-only, leaving active routing unchanged.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            host: { type: 'string', description: 'Hostname to resolve, for example api.vendor.example.' },
            probe: {
              type: 'boolean',
              description: 'Collect candidate addresses for this host and store them. Slow: measures many addresses.',
            },
            benchmark: {
              type: 'boolean',
              description:
                'Measure stored candidates and recommend fast, stable throughput. Requires probe results; uses the default model for this host.',
            },
            testOnly: { type: 'boolean', description: 'Default true: save measurements without changing the active address. Set false only when explicitly asked to apply the result.' },
            message: {
              type: 'string',
              description: 'Test prompt for the benchmark. A short greeting produces too few tokens to time.',
            },
          },
          required: ['host'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              host: { type: 'string' },
              covered: { type: 'boolean' },
              servers: { type: 'array', items: { type: 'string' } },
              addresses: { type: 'array', items: { type: 'string' } },
              selected: { type: 'string' },
              selectedSource: { type: 'string' },
              recommended: { type: 'string' },
              applied: { type: 'boolean' },
              measured: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    ip: { type: 'string' },
                    colo: { type: 'string' },
                    rtt: { type: 'number' },
                    fromDns: { type: 'boolean' },
                    ttftMs: { type: 'number' },
                    tps: { type: 'number' },
                    stabilityScore: { type: 'number' },
                    rankEligible: { type: 'boolean' },
                    runTps: { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'null' }] } },
                  },
                },
              },
              error: { type: 'string' },
            },
          },
          render(_args, value) {
            if (value.error !== undefined) {
              return [{ type: 'text', text: `${value.host}: FAILED via ${value.servers.join(', ')} — ${value.error}` }]
            }
            const lines = [
              `${value.host} -> ${value.addresses.join(', ')} (via ${value.servers.join(', ')}; ${value.covered ? 'pinned' : 'not covered by the pin'})`,
            ]
            if (value.measured.length > 0) {
              lines.push('candidates:')
              for (const entry of value.measured) {
                const timing = entry.ttftMs === undefined
                  ? 'not benchmarked'
                  : `TTFT=${entry.ttftMs}ms TPS=${entry.tps ?? '-'}`
                lines.push(
                  `  ${entry.ip.padEnd(16)} ${String(entry.colo).padEnd(5)} rtt=${String(entry.rtt).padStart(4)}ms  ${timing}${entry.runTps ? ` (${entry.runTps.map((n) => n ?? '-').join(', ')})` : ''}${entry.stabilityScore === undefined ? '' : ` score=${entry.stabilityScore}`}${entry.fromDns ? '  (from DNS)' : ''}`,
                )
              }
            }
            lines.push(`selected: ${value.selected === undefined || value.selected === '' ? '(none)' : value.selected} via ${value.selectedSource ?? '?'}`)
            if (value.recommended) lines.push(`recommended: ${value.recommended}; applied: ${value.applied === true}`)
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        async execute(args) {
          const host = String(args?.host ?? '').trim().toLowerCase()
          if (host.length === 0) throw new Error('host is required')
          await refreshHosts()
          const servers = engine.state().servers
          const covered = engine.shouldPin(host)
          try {
            const selection = readDefaultSelection()
            const profiles = [...readProviderProfiles().values()].filter((profile) => hostnameOf(profile.baseURL) === host)
            const profile = profiles.find((entry) => entry.provider === selection?.provider) ?? profiles[0]
            if ((args?.probe || args?.benchmark) && engine.busy()) throw new Error('a measurement is already running')
            let outcome
            if (args?.benchmark === true) {
              if (!profile) throw new Error('no configured provider for this hostname')
              const beforeKey = await describeBenchmark(profile)
              if (!beforeKey.supported) throw new Error(beforeKey.reasonCode === 'OAUTH_UNSUPPORTED' ? 'OAuth providers are not supported for speed testing yet' : 'the default provider is not available for speed testing')
              const model = selection?.provider === profile.provider ? selection.model : undefined
              if (!model) throw new Error('no model configured for this provider')
              const message = String(args?.message ?? '').trim()
              if (!message) throw new Error('message is required to benchmark')
              const options = { provider: profile, apiKey: await resolveBenchmarkKey(resolveApiKey, profile), message, model,
                runs: 3, parallelism: typeof subagentParallelism === 'function' ? subagentParallelism() : subagentParallelism, testOnly: args?.testOnly !== false, canApply: () => isCurrentDefault(profile, model) }
              const availability = await describeBenchmark(profile)
              if (!availability.supported) throw new Error(availability.reasonCode === 'OAUTH_UNSUPPORTED' ? 'OAuth providers are not supported for speed testing yet' : 'the default provider is not available for speed testing')
              if (!isCurrentDefault(profile, model)) throw new Error('default provider or model changed; retry with the current default')
              // No intermediate probe commit in the combined operation.
              outcome = args?.probe === true ? await engine.autoOptimize(host, options) : await engine.benchmark(host, options)
            } else if (args?.probe === true) {
              if (profile) {
                const availability = await describeBenchmark(profile)
                if (!availability.supported) throw new Error(availability.reasonCode === 'OAUTH_UNSUPPORTED' ? 'OAuth providers are not supported for speed testing yet' : 'the default provider is not available for speed testing')
              }
              await engine.probeNow(host, profile)
            }

            const list = await engine.probe(host, 4)
            const addresses = list.map((entry) => entry.address)
            const stored = engine.findings().find((finding) => finding.hostname === host && (!profile || finding.provider === profile.provider))
            const measured = (stored?.candidates ?? []).map((candidate) => {
              const bench = stored?.benchmarks?.[candidate.ip]
              // Only defined fields: the declared output schema is closed and
              // the runtime rejects a payload carrying `undefined`.
              return {
                ip: candidate.ip,
                colo: candidate.colo ?? 'unknown',
                rtt: candidate.rtt ?? 0,
                fromDns: addresses.includes(candidate.ip),
                ...(typeof bench?.ttftMs === 'number' ? { ttftMs: bench.ttftMs } : {}),
                ...(Number.isFinite(bench?.tps) ? { tps: bench.tps } : {}),
                ...(Number.isFinite(bench?.stabilityScore) ? { stabilityScore: bench.stabilityScore } : {}),
                ...(typeof bench?.rankEligible === 'boolean' ? { rankEligible: bench.rankEligible } : {}),
                ...(Array.isArray(bench?.samples) ? { runTps: bench.samples.map((sample) => Number.isFinite(sample.tps) ? sample.tps : null) } : {}),
              }
            })
            return {
              host,
              covered,
              servers,
              addresses,
              selected: stored?.selected ?? '',
              selectedSource: stored?.selectedSource ?? '',
              ...(outcome?.recommended ? { recommended: outcome.recommended } : {}),
              applied: outcome?.applied === true,
              ...(outcome?.benchmarkFailed ? { error: outcome.message } : {}),
              measured,
            }
          } catch (error) {
            return {
              host,
              covered,
              servers,
              addresses: [],
              selected: '',
              selectedSource: '',
              measured: [],
              error: `${error?.code ?? error?.name ?? 'error'}: ${error?.message ?? String(error)}`,
            }
          }
        },
      })

      const disposeStop = toolsCtx.tools.register({
        name: 'best_ip_stop',
        description: 'Stop an IP speed test, cancel active requests and retain completed samples without applying an address.',
        parameters: { type: 'object', additionalProperties: false, required: ['runId'], properties: {
          runId: { type: 'string', description: 'Exact current run ID from best_ip_status. A stale ID cannot stop a different run.' },
        } },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {
            requested: { type: 'boolean' }, runId: { type: 'string' }, stage: { type: 'string' },
          } },
          render(_args, value) { return [{ type: 'text', text: `${value.runId}: ${value.stage}; stop requested=${value.requested}` }] },
        },
        isConcurrencySafe: () => true,
        async execute(args) { return engine.stop(args?.runId) },
      })

      return () => {
        disposeState()
        disposeProbe()
        disposeStop()
      }
    }, 'dsh-best-ip: agent tools')
  })
}

/** Settings panel bridge: state, probe, and cache reset over the Web server. */
function registerHttpBridge(ctx, engine, refreshHosts, config, providers) {
  const { readProviderProfiles, resolveApiKey, readDefaultSelection, subagentParallelism, readOwnConfig, applyConfig, describeBenchmark = async () => ({ supported: true }), isCurrentDefault = () => true, ready } = providers
  const BASE = '/api/dsh-best-ip'

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const writeJson = (res, status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
        res.end(JSON.stringify(body))
      }

      // Trust rule for this administration route: the request must be
      // same-origin, and must come from a loopback client. Requiring a browser
      // session credential would tie the panel to one transport; requiring
      // loopback keeps the rule narrow while working for the settings page.
      const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])
      const hostnameOfAuthority = (authority) => {
        if (typeof authority !== 'string') return undefined
        try {
          return new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, '')
        } catch {
          return undefined
        }
      }
      const isLoopbackAddress = (address) => {
        if (typeof address !== 'string') return false
        const clean = address.startsWith('::ffff:') ? address.slice(7) : address
        return LOOPBACK.has(address) || (net.isIP(clean) === 4 && clean.startsWith('127.'))
      }
      const allowed = (req) => {
        const host = req.headers?.host
        if (typeof host !== 'string') return false
        if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
        const origin = req.headers?.origin
        if (origin !== undefined) {
          try {
            if (new URL(origin).host !== host) return false
          } catch {
            return false
          }
        }
        // The request reached a loopback listener from a loopback peer.
        if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
        const hostName = hostnameOfAuthority(host)
        if (hostName === undefined) return false
        if (isLoopbackAddress(hostName) || hostName === 'localhost') return true
        // A bound non-loopback host serving this panel: accept only when the
        // socket really is that address, which keeps the check address-based
        // rather than name-based.
        const local = req.socket?.localAddress
        return typeof local === 'string' && local === hostName
      }

      const readBody = async (req) => {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 64 * 1024) return undefined
          chunks.push(chunk)
        }
        try {
          return JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          return undefined
        }
      }

      const routes = [
        {
          kind: 'exact',
          path: `${BASE}/state`,
          handler: async (req, res) => {
            if (!allowed(req)) return writeJson(res, 403, { ok: false, message: 'forbidden' })
            if (req.method !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
            await refreshHosts()
            writeJson(res, 200, {
              ok: true,
              value: {
                ...engine.state(),
                ...engine.stats(),
                measurements: engine.findings(),
                statePath: engine.statePath(),
                // The panel shows only this provider and model, matching what a
                // new session would use.
                defaultSelection: readDefaultSelection(),
                 benchmarkAvailability: await describeBenchmark(readProviderProfiles().get(readDefaultSelection()?.provider)),
                benchmarkMessage: config.benchmarkMessage,
                benchmarkRuns: config.benchmarkRuns,
                benchmarkMaxTokens: BENCHMARK_MAX_TOKENS,
                maxCandidates: config.maxCandidates,
                // The panel offers these as one-click additions, so a user can
                // restore a removed resolver without typing an address.
                dnsPresets: DEFAULT_DNS_SERVERS,
              },
            })
          },
        },
        {
          // One click: discover usable addresses, speed-test them lowest-RTT
          // first, then keep the highest throughput.
          kind: 'exact',
          path: `${BASE}/auto`,
          handler: async (req, res) => {
            if (!allowed(req)) return writeJson(res, 403, { ok: false, message: 'forbidden' })
            if (req.method !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
            const body = await readBody(req)
            if (body === null || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, { ok: false, message: 'a JSON object body is required' })
            if (body.maxBenchmarkIps !== undefined && !isBenchmarkIpLimit(body.maxBenchmarkIps)) return writeJson(res, 400, { ok: false, message: 'maxBenchmarkIps must be a non-negative safe integer (0 = all)' })
            const maxBenchmarkIps = body.maxBenchmarkIps === undefined ? config.maxBenchmarkIps : body.maxBenchmarkIps
            await ready?.()
            const selection = readDefaultSelection()
            const providerId = String(selection?.provider ?? '').trim()
            if ((body?.provider !== undefined && body.provider !== providerId) || (body?.model !== undefined && body.model !== selection?.model)) return writeJson(res, 409, { ok: false, message: 'default provider or model changed; refresh the panel before testing' })
            if (providerId.length === 0) {
              return writeJson(res, 400, { ok: false, message: 'no default provider is configured' })
            }
            const profile = readProviderProfiles().get(providerId)
            if (profile === undefined) {
              return writeJson(res, 400, {
                ok: false,
                message: `provider "${providerId}" is not a configured route with a baseURL`,
              })
            }
            const availability = await describeBenchmark(profile)
            if (!availability.supported) return writeJson(res, 200, { ok: false, reasonCode: availability.reasonCode, message: availability.reasonCode === 'OAUTH_UNSUPPORTED' ? 'OAuth providers are not supported for speed testing yet' : 'the default provider is not available for speed testing' })
            const host = hostnameOf(profile.baseURL)
            if (host === undefined) return writeJson(res, 400, { ok: false, message: 'this provider has no usable baseURL' })
            const model = String(selection?.model ?? '').trim()
            if (model.length === 0) {
              return writeJson(res, 400, { ok: false, message: 'no model is available for this provider' })
            }
            const message = String(body?.message ?? config.benchmarkMessage).trim()
            if (message.length === 0) return writeJson(res, 400, { ok: false, message: 'a test message is required' })
            // Start the run in the background and answer at once, so the panel can
            // poll `/progress` and render real numbers instead of waiting on one
            // opaque request. A second run while one is in flight is refused
            // rather than interleaved: both would write the same state.
            if (engine.busy()) {
              return writeJson(res, 409, { ok: false, message: 'a measurement is already running' })
            }
            let apiKey
            try {
              apiKey = await resolveBenchmarkKey(resolveApiKey, profile)
            } catch (error) {
              return writeJson(res, 200, { ok: false, message: `${error?.message ?? String(error)}` })
            }
            const latestAvailability = await describeBenchmark(profile)
            if (!latestAvailability.supported) return writeJson(res, 200, { ok: false, reasonCode: latestAvailability.reasonCode, message: latestAvailability.reasonCode === 'OAUTH_UNSUPPORTED' ? 'OAuth providers are not supported for speed testing yet' : 'the default provider is not available for speed testing' })
            if (!isCurrentDefault(profile, model)) return writeJson(res, 409, { ok: false, message: 'default provider or model changed; refresh the panel before testing' })
            if (engine.busy()) return writeJson(res, 409, { ok: false, message: 'a measurement is already running' })
            const report = engine.beginProgress(host)
            report({ kind: 'auto' })
            const job = (async () => {
              try {
                const result = await engine.autoOptimize(
                  host,
                  {
                    provider: profile,
                    apiKey,
                    canApply: () => isCurrentDefault(profile, model),
                    message,
                    model,
                    runs: config.benchmarkRuns,
                    maxBenchmarkIps,
                    maxTokens: BENCHMARK_MAX_TOKENS,
                    testOnly: body?.testOnly !== false,
                    parallelism: typeof subagentParallelism === 'function' ? subagentParallelism() : subagentParallelism,
                  },
                  report,
                )
                report({ stage: result.stopped ? 'stopped' : result.benchmarkFailed ? 'failed' : 'done', finishedAt: Date.now(),
                  message: result.message, reasonCode: result.reasonCode, recommended: result.recommended, testOnly: result.testOnly,
                  applied: result.applied, defaultChanged: result.defaultChanged, saveError: result.saveError })
                return { host, provider: providerId, model, result, findings: engine.findings() }
              } catch (error) {
                report({ stage: 'failed', message: `${error?.message ?? String(error)}` })
                throw error
              } finally {
                // Terminal snapshots remain until the next run.
              }
            })()
            job.catch(() => {})
            writeJson(res, 202, { ok: true, value: { started: true, host, provider: providerId, model, runId: engine.progress()?.runId } })
          },
        },
        {
          kind: 'exact', path: `${BASE}/stop`,
          handler: async (req, res) => {
            if (!allowed(req)) return writeJson(res, 403, { ok: false, message: 'forbidden' })
            if (req.method !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
            const body = await readBody(req)
            if (typeof body?.runId !== 'string' || !body.runId) return writeJson(res, 400, { ok: false, message: 'runId is required' })
            try { writeJson(res, 200, { ok: true, value: engine.stop(body.runId) }) }
            catch (error) { writeJson(res, 409, { ok: false, message: error?.message ?? String(error) }) }
          },
        },
        {
          // Poll the live progress of the run in flight.
          kind: 'exact',
          path: `${BASE}/progress`,
          handler: async (req, res) => {
            if (!allowed(req)) return writeJson(res, 403, { ok: false, message: 'forbidden' })
            if (req.method !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
            // `lastRun` is returned alongside the live snapshot so a client that
            // polls just after the snapshot was cleared still receives the
            // outcome instead of losing it.
            writeJson(res, 200, {
              ok: true,
              value: { progress: engine.progress() ?? null, lastRun: engine.lastRun() ?? null },
            })
          },
        },
        {
          // Time the address in use: three streaming requests, no re-probe and no
          // change of selection. Answers "is the current pin still good?" cheaply.
          kind: 'exact',
          path: `${BASE}/time`,
          handler: async (req, res) => {
            if (!allowed(req)) return writeJson(res, 403, { ok: false, message: 'forbidden' })
            if (req.method !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
            const body = await readBody(req)
            if (body === null || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, { ok: false, message: 'a JSON object body is required' })
            await ready?.()
            const selection = readDefaultSelection()
            const providerId = String(selection?.provider ?? '').trim()
            if ((body?.provider !== undefined && body.provider !== providerId) || (body?.model !== undefined && body.model !== selection?.model)) return writeJson(res, 409, { ok: false, message: 'default provider or model changed; refresh the panel before testing' })
            const profile = readProviderProfiles().get(providerId)
            if (profile === undefined) {
              return writeJson(res, 400, { ok: false, message: `provider "${providerId}" is not a configured route` })
            }
            const availability = await describeBenchmark(profile)
            if (!availability.supported) return writeJson(res, 200, { ok: false, reasonCode: availability.reasonCode, message: availability.reasonCode === 'OAUTH_UNSUPPORTED' ? 'OAuth providers are not supported for speed testing yet' : 'the default provider is not available for speed testing' })
            const host = hostnameOf(profile.baseURL)
            if (host === undefined) return writeJson(res, 400, { ok: false, message: 'this provider has no usable baseURL' })
            const model = String(selection?.model ?? '').trim()
            if (model.length === 0) return writeJson(res, 400, { ok: false, message: 'no model is available' })
            const message = String(body?.message ?? config.benchmarkMessage).trim()
            if (message.length === 0) return writeJson(res, 400, { ok: false, message: 'a test message is required' })
            if (engine.busy()) {
              return writeJson(res, 409, { ok: false, message: 'a measurement is already running' })
            }
            // Background it like /auto. A blocking response cannot be polled, so
            // the panel would sit on "Testing…" with no idea how many runs are
            // left or what the earlier ones measured.
            let apiKey
            try {
              apiKey = await resolveBenchmarkKey(resolveApiKey, profile)
            } catch (error) {
              return writeJson(res, 200, { ok: false, message: `${error?.message ?? String(error)}` })
            }
            const latestAvailability = await describeBenchmark(profile)
            if (!latestAvailability.supported) return writeJson(res, 200, { ok: false, reasonCode: latestAvailability.reasonCode, message: latestAvailability.reasonCode === 'OAUTH_UNSUPPORTED' ? 'OAuth providers are not supported for speed testing yet' : 'the default provider is not available for speed testing' })
            if (!isCurrentDefault(profile, model)) return writeJson(res, 409, { ok: false, message: 'default provider or model changed; refresh the panel before testing' })
            if (engine.busy()) return writeJson(res, 409, { ok: false, message: 'a measurement is already running' })
            const report = engine.beginProgress(host)
            const runs = 3
            report({
              kind: 'time',
              stage: 'timing',
              timing: 0,
              timingTotal: runs,
              address: engine.activeAddressFor(host),
              rows: [],
            })
            const job = (async () => {
              try {
                const result = await engine.timeSelected(host, {
                  provider: profile,
                  apiKey,
                  canApply: () => isCurrentDefault(profile, model),
                  message,
                  model,
                  runs,
                  report,
                })
                report({ stage: result.stopped ? 'stopped' : result.summary?.error ? 'failed' : 'done', message: result.summary?.error,
                  finishedAt: Date.now(), summary: result.summary, address: result.ip })
                return result
              } catch (error) {
                report({ stage: 'failed', message: `${error?.message ?? String(error)}` })
                throw error
              } finally {
                // Terminal snapshots remain until the next run; no stale timer can clear it.
              }
            })()
            job.catch(() => {})
            writeJson(res, 202, { ok: true, value: { started: true, host, runs, ip: engine.activeAddressFor(host), runId: engine.progress()?.runId } })
          },
        },
        {
          // Probe one provider host on demand: measure every candidate address
          // and store the result. This is the explicit action that replaces the
          // old automatic sweep.
          kind: 'exact',
          path: `${BASE}/probe`,
          handler: async (req, res) => {
            if (!allowed(req)) return writeJson(res, 403, { ok: false, message: 'forbidden' })
            if (req.method !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
            if (engine.busy()) return writeJson(res, 409, { ok: false, message: 'a measurement is already running' })
            const body = await readBody(req)
            if (body === null || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, { ok: false, message: 'a JSON object body is required' })
            const host = String(body?.host ?? '').trim().toLowerCase()
            if (host.length === 0) return writeJson(res, 400, { ok: false, message: 'host is required' })
            await ready?.()
            const selection = readDefaultSelection()
            const provider = readProviderProfiles().get(String(body?.provider ?? selection?.provider ?? ''))
            const availability = await describeBenchmark(provider)
            if (!provider || !availability.supported) return writeJson(res, 200, { ok: false, reasonCode: availability.reasonCode, message: availability.reasonCode === 'OAUTH_UNSUPPORTED' ? 'OAuth providers are not supported for speed testing yet' : 'the default provider is not available for speed testing' })
            if (!isCurrentDefault(provider, selection?.model) || hostnameOf(provider.baseURL) !== host) return writeJson(res, 409, { ok: false, message: 'the probe target must match the current default provider' })
            try {
              const result = await engine.probeNow(host, provider)
              writeJson(res, 200, { ok: true, value: { host, result, findings: engine.findings() } })
            } catch (error) {
              writeJson(res, 200, { ok: false, message: `${error?.message ?? String(error)}` })
            }
          },
        },
        {
          // Real-request measurement: TTFT and TPS per candidate, ranked the way
          // the harness itself measures a step.
          kind: 'exact',
          path: `${BASE}/benchmark`,
          handler: async (req, res) => {
            if (!allowed(req)) return writeJson(res, 403, { ok: false, message: 'forbidden' })
            if (req.method !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
            if (engine.busy()) return writeJson(res, 409, { ok: false, message: 'a measurement is already running' })
            const body = await readBody(req)
            if (body === null || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, { ok: false, message: 'a JSON object body is required' })
            const host = String(body?.host ?? '').trim().toLowerCase()
            if (host.length === 0) return writeJson(res, 400, { ok: false, message: 'host is required' })
            await ready?.()
            const selection = readDefaultSelection()
            if ((body?.provider !== undefined && body.provider !== selection?.provider) || (body?.model !== undefined && body.model !== selection?.model)) return writeJson(res, 409, { ok: false, message: 'default provider or model changed; refresh the panel before testing' })
            const profile = readProviderProfiles().get(selection?.provider)
            if (profile === undefined) {
              return writeJson(res, 400, { ok: false, message: `unknown provider "${body?.provider ?? ''}"` })
            }
            const availability = await describeBenchmark(profile)
            if (!availability.supported) return writeJson(res, 200, { ok: false, reasonCode: availability.reasonCode, message: availability.reasonCode === 'OAUTH_UNSUPPORTED' ? 'OAuth providers are not supported for speed testing yet' : 'the default provider is not available for speed testing' })
            const message = String(body?.message ?? '').trim()
            if (message.length === 0) return writeJson(res, 400, { ok: false, message: 'message is required' })
            const model = String(selection?.model ?? '').trim()
            if (model === undefined) return writeJson(res, 400, { ok: false, message: 'no model configured for this provider' })
            try {
              const apiKey = await resolveBenchmarkKey(resolveApiKey, profile)
              const latestAvailability = await describeBenchmark(profile)
              if (!latestAvailability.supported) return writeJson(res, 200, { ok: false, reasonCode: latestAvailability.reasonCode, message: latestAvailability.reasonCode === 'OAUTH_UNSUPPORTED' ? 'OAuth providers are not supported for speed testing yet' : 'the default provider is not available for speed testing' })
              if (!isCurrentDefault(profile, model)) return writeJson(res, 409, { ok: false, message: 'default provider or model changed; refresh the panel before testing' })
              const result = await engine.benchmark(host, {
                provider: profile,
                apiKey,
                canApply: () => isCurrentDefault(profile, model),
                message,
                model,
                maxTokens: Number.isFinite(body?.maxTokens) ? body.maxTokens : BENCHMARK_MAX_TOKENS,
                runs: Number.isFinite(body?.runs) ? Math.min(Math.max(body.runs, 1), 5) : 3,
                parallelism: typeof subagentParallelism === 'function' ? subagentParallelism() : subagentParallelism,
                testOnly: body?.testOnly !== false,
              })
              writeJson(res, 200, { ok: true, value: { host, result, findings: engine.findings() } })
            } catch (error) {
              writeJson(res, 200, { ok: false, message: `${error?.message ?? String(error)}` })
            }
          },
        },
        {
          // Adopt the user's own choice of address.
          kind: 'exact',
          path: `${BASE}/select`,
          handler: async (req, res) => {
            if (!allowed(req)) return writeJson(res, 403, { ok: false, message: 'forbidden' })
            if (req.method !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
            if (engine.busy()) return writeJson(res, 409, { ok: false, message: 'a measurement is already running' })
            const body = await readBody(req)
            if (body === null || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, { ok: false, message: 'a JSON object body is required' })
            const host = String(body?.host ?? '').trim().toLowerCase()
            const ip = String(body?.ip ?? '').trim()
            if (host.length === 0 || ip.length === 0) {
              return writeJson(res, 400, { ok: false, message: 'host and ip are required' })
            }
            await ready?.()
            const selection = readDefaultSelection()
            if (body?.provider !== undefined && body.provider !== selection?.provider) return writeJson(res, 409, { ok: false, message: 'default provider changed; refresh the panel' })
            const profile = readProviderProfiles().get(selection?.provider)
            const availability = await describeBenchmark(profile)
            if (!profile || hostnameOf(profile.baseURL) !== host || !availability.supported) return writeJson(res, 400, { ok: false, message: availability.reasonCode === 'OAUTH_UNSUPPORTED' ? 'OAuth providers are not supported for speed testing yet' : 'this address is not available for the current default provider' })
            try {
              if (!isCurrentDefault(profile, selection?.model)) return writeJson(res, 409, { ok: false, message: 'default provider or model changed; refresh the panel' })
              const result = engine.select(host, ip, { provider: profile.provider, testOnly: body?.testOnly !== false })
              writeJson(res, 200, { ok: true, value: { host, result, findings: engine.findings() } })
            } catch (error) {
              writeJson(res, 200, { ok: false, message: `${error?.message ?? String(error)}` })
            }
          },
        },
        {
          // Forget stored results so the next probe starts clean.
          kind: 'exact',
          path: `${BASE}/forget`,
          handler: async (req, res) => {
            if (!allowed(req)) return writeJson(res, 403, { ok: false, message: 'forbidden' })
            if (req.method !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
            if (engine.busy()) return writeJson(res, 409, { ok: false, message: 'a measurement is already running' })
            const body = await readBody(req)
            if (body === null || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, { ok: false, message: 'a JSON object body is required' })
            const host = typeof body?.host === 'string' && body.host.trim().length > 0
              ? body.host.trim().toLowerCase()
              : undefined
            if (host === undefined) return writeJson(res, 400, { ok: false, message: 'an explicit host is required' })
            if (body?.testOnly !== false) return writeJson(res, 400, { ok: false, message: 'test-only mode cannot clear the active address' })
            const saveError = engine.forget(host, body?.provider)
            writeJson(res, 200, { ok: true, value: { forgot: host ?? '*', saveError, findings: engine.findings() } })
          },
        },
        {
          kind: 'exact',
          path: `${BASE}/resolve`,
          handler: async (req, res) => {
            if (!allowed(req)) return writeJson(res, 403, { ok: false, message: 'forbidden' })
            if (req.method !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
            const body = await readBody(req)
            if (body === null || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, { ok: false, message: 'a JSON object body is required' })
            const host = String(body?.host ?? '').trim().toLowerCase()
            if (host.length === 0) return writeJson(res, 400, { ok: false, message: 'host is required' })
            await refreshHosts()
            const servers = engine.state().servers
            const covered = engine.shouldPin(host)
            try {
              const list = await engine.probe(host, 4)
              const addresses = list.map((entry) => entry.address)
              writeJson(res, 200, {
                ok: true,
                value: { host, covered, servers, addresses, findings: engine.findings() },
              })
            } catch (error) {
              writeJson(res, 200, {
                ok: true,
                value: {
                  host,
                  covered,
                  servers,
                  addresses: [],
                  error: `${error?.code ?? error?.name ?? 'error'}: ${error?.message ?? String(error)}`,
                },
              })
            }
          },
        },
        {
          kind: 'exact',
          path: `${BASE}/clear-cache`,
          handler: async (req, res) => {
            if (!allowed(req)) return writeJson(res, 403, { ok: false, message: 'forbidden' })
            if (req.method !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
            engine.clearCache()
            writeJson(res, 200, { ok: true, value: { cleared: true } })
          },
        },
        {
          // Persist through the config editor so the change lands in this
          // row of cordis.patch.yml and the Loader then reconciles it. Writing
          // the file here would bypass schema validation and the reload.
          kind: 'exact',
          path: `${BASE}/save`,
          handler: async (req, res) => {
            if (!allowed(req)) return writeJson(res, 403, { ok: false, message: 'forbidden' })
            if (req.method !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
            if (engine.busy()) return writeJson(res, 409, { ok: false, message: 'a measurement is already running' })
            const body = await readBody(req)
            if (body === null || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, { ok: false, message: 'a JSON object body is required' })
            if (body === undefined || body === null || typeof body !== 'object') {
              return writeJson(res, 400, { ok: false, message: 'malformed JSON body' })
            }
            if (body.maxBenchmarkIps !== undefined && !isBenchmarkIpLimit(body.maxBenchmarkIps)) return writeJson(res, 400, { ok: false, message: 'maxBenchmarkIps must be a non-negative safe integer (0 = all)' })
            const editor = ctx.get('configEditor')
            if (editor === undefined) {
              return writeJson(res, 409, { ok: false, message: 'the config editor is unavailable in this profile' })
            }
            const entry = editor.entries().find((candidate) => candidate.options?.id === 'dsh-best-ip')
            if (entry === undefined) {
              return writeJson(res, 409, { ok: false, message: 'the dsh-best-ip entry is not active' })
            }
            const next = {}
            if (typeof body.enabled === 'boolean') next.enabled = body.enabled
            if (Array.isArray(body.dnsServers)) {
              next.dnsServers = body.dnsServers.map((value) => String(value).trim()).filter((value) => value.length > 0)
            }
            if (Array.isArray(body.providers)) {
              // `providers` is deprecated and never read for routing. Refusing
              // it outright is better than accepting a value that would look
              // saved while changing nothing.
              return writeJson(res, 400, {
                ok: false,
                message: 'providers is deprecated and ignored; routing follows the DSH default provider',
              })
            }
            if (Array.isArray(body.extraHosts)) {
              next.extraHosts = body.extraHosts.map((value) => String(value).trim()).filter((value) => value.length > 0)
            }
            if (typeof body.includeSubdomains === 'boolean') next.includeSubdomains = body.includeSubdomains
            if (typeof body.fallbackToSystem === 'boolean') next.fallbackToSystem = body.fallbackToSystem
            if (Number.isFinite(body.ttlSeconds)) next.ttlSeconds = body.ttlSeconds
            if (body.maxBenchmarkIps !== undefined) next.maxBenchmarkIps = body.maxBenchmarkIps
            if (typeof body.scanEdges === 'boolean') next.scanEdges = body.scanEdges
            if (typeof body.preferNearEdges === 'boolean') next.preferNearEdges = body.preferNearEdges
            if (typeof body.benchmarkMessage === 'string' && body.benchmarkMessage.trim()) next.benchmarkMessage = body.benchmarkMessage.trim()
            if (Object.keys(next).length === 0) {
              return writeJson(res, 400, { ok: false, message: 'no editable field was supplied' })
            }
            try {
              await editor.edit(entry, (existing) => ({ ...existing, ...next }))
              // Re-read the saved row and adopt it. Without this the engine kept
              // the configuration it was built with, so a server removed in the
              // panel reappeared on the next read.
              const saved = readOwnConfig()
              if (saved !== undefined) {
                config = normalizeConfig(saved)
                applyConfig(config)
              }
              await refreshHosts()
              writeJson(res, 200, { ok: true, value: { ...engine.state(), ...engine.stats() } })
            } catch (error) {
              writeJson(res, 200, {
                ok: false,
                message: 'could not save plugin configuration; check the configuration editor and local permissions',
              })
            }
          },
        },
        {
          // The provider list comes from the adapter's configurable-provider
          // directory, so the panel offers what this profile actually has
          // instead of a hard-coded set.
          kind: 'exact',
          path: `${BASE}/providers`,
          handler: async (req, res) => {
            if (!allowed(req)) return writeJson(res, 403, { ok: false, message: 'forbidden' })
            if (req.method !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
            const list = []
            // Models come from the provider's own profile, not from the adapter
            // directory: the benchmark needs the exact ids this route is
            // configured with, and a catalog entry may not carry them.
            const profiles = readProviderProfiles()
            const llm = ctx.get('llm')
            if (llm !== undefined && typeof llm.listConfigurableProviders === 'function') {
              try {
                for (const provider of await llm.listConfigurableProviders()) {
                  list.push({
                    provider: provider.provider,
                    displayName: provider.displayName ?? provider.provider,
                    baseURL: typeof provider.defaultBaseURL === 'string' ? provider.defaultBaseURL : '',
                    models: profiles.get(provider.provider)?.models ?? [],
                  })
                }
              } catch (error) {
                ctx.logger?.warn('dsh-best-ip: could not list providers')
              }
            }
            // A configured provider that the adapter directory does not report
            // must still be selectable, or the panel would hide the only route
            // this profile actually uses.
            for (const [id, profile] of profiles) {
              if (!list.some((entry) => entry.provider === id)) {
                list.push({
                  provider: id,
                  displayName: profile.displayName ?? id,
                  baseURL: profile.baseURL,
                  models: profile.models,
                })
              }
            }
            writeJson(res, 200, { ok: true, value: { providers: list } })
          },
        },
      ]

      const disposers = routes.map((route) => webCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            /* already gone */
          }
        }
      }
    }, 'dsh-best-ip: settings bridge')
  })
}

export { Config, apply, name, createResolver, normalizeConfig, registerHttpBridge, registerTools, orderCandidates }
export default { Config, apply, name }
