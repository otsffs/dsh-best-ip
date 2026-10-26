// Candidate selection for one pinned hostname.
//
// Why this exists: a Cloudflare-proxied hostname resolves to the same anycast
// addresses everywhere, and which datacenter those addresses reach depends on
// this network's BGP path. On a mainland connection the default answer can land
// in Los Angeles or San Jose (160-250ms, often lossy) while other Cloudflare
// addresses serving the very same zone land in Hong Kong (~55ms). Changing the
// resolver does not help: every public resolver returned the same two IPs.
//
// So the resolver is only a *source of candidates*. The IP actually used is
// chosen by measuring this machine's real path to it:
//
//   TCP connect RTT    ICMP is filtered on many Cloudflare edges (ping reports
//                      100% loss where TLS works fine on the same IP), so ping
//                      cannot be the metric.
//   TLS certificate    Validate the real hostname as SNI, then separately check
//                      an API response; a certificate alone does not prove routing.
//   datacenter         cf-ray, when present, identifies the responding edge.
//
// Never trust an address that fails certificate validation. Routes change, so a
// measurement is only a snapshot; callers must decide when to re-test it.

import net from 'node:net'
import tls from 'node:tls'

/**
 * Candidate inventory: https://www.cloudflare.com/ips-v4 (verified 2026-10-26).
 * A static snapshot, not a runtime fetch, geographic prior, or assurance that
 * any address serves the target hostname. Every candidate still needs inspection.
 */
const EDGE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
]

/** Datacenters that are close to mainland China, best first. */
const NEAR_COLOS = ['HKG', 'TPE', 'NRT', 'KIX', 'ICN', 'SIN', 'BKK', 'MNL', 'SGN', 'SZX', 'CAN', 'PVG']

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) >>> 0) + Number(octet), 0) >>> 0
}

function intToIp(value) {
  const v = value >>> 0
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.')
}

/** Sample addresses out of a CIDR without touching every address in it. */
export function sampleRange(cidr, stride) {
  if (!Number.isInteger(stride) || stride < 1) throw new RangeError('stride must be a positive integer')
  const [base, bits] = cidr.split('/')
  const addressBits = 32 - Number(bits)
  const total = 2 ** addressBits
  const start = ipToInt(base)
  const ips = []
  for (let offset = 1; offset < total; offset += stride) {
    const ip = intToIp(start + offset)
    // Conservatively omit .0/.255 host shapes, not whole subnet boundaries.
    if (!ip.endsWith('.0') && !ip.endsWith('.255')) ips.push(ip)
  }
  return ips
}

/**
 * Split only larger CIDRs into /16 search units; narrower ranges retain their
 * true boundaries. /16 is a sampling convention, not a BGP or service guarantee.
 * Round-robin parents before children so even a small budget covers more CIDRs.
 */
const SCAN_UNITS = (() => {
  const parents = EDGE_RANGES.map((cidr) => {
    const [base, bits] = cidr.split('/')
    const start = ipToInt(base)
    const total = 2 ** (32 - Number(bits))
    const units = []
    for (let offset = 0; offset < total; offset += 65536) {
      units.push({ start: start + offset, total: Math.min(65536, total - offset) })
    }
    return units
  })
  const units = []
  for (let round = 0; round < Math.max(...parents.map((parent) => parent.length)); round++) {
    for (const parent of parents) {
      if (parent[round] !== undefined) units.push(parent[round])
    }
  }
  return units
})()

/** Stable FNV-1a salt: vary positions by unit without randomness or run history. */
function sampleHash(start, sample) {
  const key = `${start}:${sample}`
  let hash = 2166136261
  for (let index = 0; index < key.length; index++) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619)
  }
  return hash >>> 0
}

/**
 * Balance the budget over clipped /16 units, then pick one address within each
 * disjoint stratum using a unit-specific salt. Interleave units and keep the
 * .0/.255 exclusion convention. This prioritizes breadth, not uniform random
 * IP sampling, and cannot establish a global TPS maximum or guarantee success.
 */
export function scanCandidates(limit = 512) {
  const budget = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  const baseQuota = Math.floor(budget / SCAN_UNITS.length)
  const remainder = budget % SCAN_UNITS.length
  const groups = SCAN_UNITS.map(({ start, total }, index) => {
    const usable = (total / 256) * 254
    const quota = Math.min(usable, baseQuota + (index < remainder ? 1 : 0))
    return Array.from({ length: quota }, (_, sample) => {
      const from = Math.floor((sample * usable) / quota)
      const to = Math.floor(((sample + 1) * usable) / quota)
      const position = from + sampleHash(start, sample) % (to - from)
      const offset = Math.floor(position / 254) * 256 + (position % 254) + 1
      return intToIp(start + offset)
    })
  })
  const out = []
  const rounds = Math.max(0, ...groups.map((group) => group.length))
  for (let round = 0; round < rounds; round++) {
    for (const group of groups) {
      if (group[round] !== undefined) out.push(group[round])
    }
  }
  return out
}

/** TCP connect time in ms, or null on failure or cancellation. */
export function tcpRtt(ip, port = 443, timeout = 1500, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null)
    const started = process.hrtime.bigint()
    const socket = net.connect({ host: ip, port })
    let settled = false
    const onConnect = () => finish(true)
    const onFailure = () => finish(false)
    const finish = (ok) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onFailure)
      socket.removeListener('connect', onConnect)
      socket.removeListener('timeout', onFailure)
      socket.removeListener('error', onFailure)
      socket.removeListener('close', onFailure)
      socket.setTimeout(0)
      socket.destroy()
      resolve(ok && !signal?.aborted ? Number(process.hrtime.bigint() - started) / 1e6 : null)
    }
    socket.once('connect', onConnect)
    socket.once('timeout', onFailure)
    socket.once('error', onFailure)
    socket.once('close', onFailure)
    signal?.addEventListener('abort', onFailure, { once: true })
    // Also catches an abort triggered while a mocked/native connector starts.
    if (signal?.aborted) return finish(false)
    socket.setTimeout(timeout)
  })
}

/**
 * One TLS request to a fixed address with a chosen SNI.
 * `verify` decides whether the certificate must validate against `servername`.
 * `signal` cancels with the ordinary `{ ok: false }` result, never a success.
 *
 * `socket.setTimeout` alone is not a deadline: it only fires on socket
 * inactivity, so a handshake that trickles, or a server that accepts the TCP
 * connection and then stalls, can outlive it — measured at 9221ms against a
 * 6000ms value. A real timer is therefore armed as well, and whichever fires
 * first settles the probe.
 */
export function tlsRequest(ip, servername, { verify, path, port = 443, timeout, method = 'GET', headers = {}, body, signal } = {}) {
  const budget = timeout ?? 6000
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false })
    const started = process.hrtime.bigint()
    let settled = false
    let deadline
    let tlsMs
    let authorized = false
    let buffer = ''
    const socket = tls.connect({
      host: ip,
      port: Number(port),
      servername,
      rejectUnauthorized: verify === true,
      timeout: budget,
    })
    function done(result) {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      signal?.removeEventListener('abort', onFailure)
      socket.removeListener('secureConnect', onSecureConnect)
      socket.removeListener('data', onData)
      socket.removeListener('close', onClose)
      socket.removeListener('timeout', onTimeout)
      socket.removeListener('error', onFailure)
      socket.setTimeout?.(0)
      socket.destroy()
      resolve(signal?.aborted ? { ok: false } : result)
    }
    function onFailure() { done({ ok: false }) }
    function onTimeout() { done({ ok: false, timedOut: true }) }
    function onData(chunk) {
      if (!settled && !signal?.aborted) buffer += chunk.toString('latin1')
    }
    function onClose() {
      if (tlsMs === undefined || signal?.aborted) return onFailure()
      const status = Number(buffer.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0)
      done({ ok: true, authorized, tlsMs, status, raw: buffer })
    }
    function onSecureConnect() {
      if (settled) return
      if (signal?.aborted) return onFailure()
      tlsMs = Number(process.hrtime.bigint() - started) / 1e6
      authorized = socket.authorized === true
      const head = [
        `${method} ${path ?? '/'} HTTP/1.1`,
        `Host: ${servername}${Number(port) === 443 ? '' : `:${port}`}`,
        'User-Agent: dsh-best-ip',
        'Accept: */*',
        'Connection: close',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        ...(body === undefined ? [] : [`Content-Length: ${Buffer.byteLength(body)}`]),
        '',
        body ?? '',
      ].join('\r\n')
      socket.write(head)
    }
    // Install response handlers before write: a fixture (or a synchronous
    // transport wrapper) may deliver data/close from inside socket.write().
    socket.once('secureConnect', onSecureConnect)
    socket.on('data', onData)
    socket.once('close', onClose)
    socket.once('timeout', onTimeout)
    socket.once('error', onFailure)
    signal?.addEventListener('abort', onFailure, { once: true })
    if (signal?.aborted) return onFailure()
    deadline = setTimeout(onTimeout, budget)
    deadline.unref?.()
  })
}

/**
 * Full inspection of one address for one hostname.
 *
 * Certificate validation alone is NOT enough. Some Cloudflare edges hold a valid
 * certificate for the zone yet answer every API request with a Cloudflare
 * platform error (1034 "DNS resolution error" / a 403 firewall deny) because
 * that address is not actually serving the zone on this network. Measured
 * example: 162.159.39.45 validated its certificate and returned NRT at 98ms,
 * but every /v1 request came back `403 error code: 1034`, while
 * 104.21.85.64 (HKG) returned 200 for the same request.
 *
 * So an address is a candidate only when a real request to the API path comes
 * back with a status that means "the zone answered": 2xx, 401/429 or an
 * API-authored 403/404.
 *
 * Two connections, not four: a TCP probe screens the address cheaply (this is
 * the latency figure used for ranking), then ONE TLS request to the API path
 * carries the certificate check, the colo lookup and the routing verdict. The
 * earlier shape opened four sockets per address and, on a dead address, waited
 * for every one of them.
 *
 * @returns the measurement, or null when rejected or cancelled.
 */
export async function inspectAddress(ip, hostname, { timeout = 6000, apiPath = '/v1/models', port = 443, signal } = {}) {
  if (signal?.aborted) return null
  // 1. Cheap screen. A refused/black-holed address stops here without TLS.
  const rtt = await tcpRtt(ip, Number(port), Math.min(1500, timeout), signal)
  if (rtt === null || signal?.aborted) return null

  // 2. One verified TLS request to the real API path.
  const api = await tlsRequest(ip, hostname, { verify: true, path: apiPath, port, timeout, signal })
  if (signal?.aborted || api.ok !== true || api.authorized !== true) return null
  if (!isServedByZone(api)) return null

  // 3. Reuse the same response for the datacenter: a Cloudflare response carries
  //    the serving edge in cf-ray, so no extra /cdn-cgi/trace round trip.
  const cfRay = String(api.raw ?? '').match(/^cf-ray:\s*\S*-([A-Z]{3})\s*$/im)
  // No cf-ray is a normal result for a non-Cloudflare endpoint. Do not probe
  // cloudflare.com against an unrelated provider IP just to label its location.
  const colo = cfRay?.[1]

  return {
    ip,
    rtt,
    colo,
    status: api.status,
  }
}

/**
 * Does this response prove the zone answered at that address?
 *
 * 2xx / 3xx / 401 / 403-with-an-API-body / 404 / 429 are reachability hints,
 * not proof that authenticated model streaming works. All 5xx are rejected.
 * Cloudflare platform failures (1034 DNS
 * resolution error, 1016 origin DNS, 523-530) mean the address cannot serve it.
 * A 403 is ambiguous, so the body decides: the zone's own API errors are JSON,
 * while the platform inserts `error code: <n>`.
 */
export function isServedByZone(response) {
  if (response?.ok !== true) return false
  const status = response.status
  const body = String(response.raw ?? '')
  const platform = body.match(/error code:\s*(\d{4})/i)
  if (platform !== null) {
    const code = Number(platform[1])
    // 10xx are platform/proxy errors, 52x/53x are origin-unreachable from this edge.
    if (code >= 1000 && code < 1100) return false
  }
  if (status >= 200 && status < 400) return true
  if (status === 401 || status === 429) return true
  if (status === 403) {
    // The API answers JSON; the platform's block page is not JSON.
    return /\{/.test(body)
  }
  if (status === 404) return true
  if (status >= 500 && status < 600) return false
  return false
}

/**
 * Optional geographic ordering: known near, known remote, then unknown.
 * Within each group compare TCP latency. This is never a TPS ranking.
 */
export function rankAddresses(entries, { preferNear = true } = {}) {
  const nearRank = (entry) => {
    if (!preferNear) return 0
    if (typeof entry.colo !== 'string' || entry.colo === 'unknown') return NEAR_COLOS.length + 1
    const index = NEAR_COLOS.indexOf(entry.colo)
    return index === -1 ? NEAR_COLOS.length : index
  }
  return [...entries].sort((a, b) => {
    const byNear = nearRank(a) - nearRank(b)
    if (byNear !== 0) return byNear
    return (a.rtt ?? Number.POSITIVE_INFINITY) - (b.rtt ?? Number.POSITIVE_INFINITY)
  })
}

/**
 * Probe many addresses with bounded concurrency.
 *
 * `enough` makes this a staged probe rather than one flat pass, for a measured
 * reason: cost here is dominated by the slowest address in flight. A flat pass
 * at concurrency 48 found its first Hong Kong edge at 746ms but did not return
 * until 6101ms, because the other workers were still waiting out their own
 * addresses. So candidates are walked in small waves, and a wave is abandoned
 * the moment it satisfies `enough` — the pending probes are left to settle on
 * their own instead of being awaited. Cancellation also returns the completed
 * results immediately, even when an injected inspector ignores the signal.
 */
export async function inspectAll(
  ips,
  hostname,
  {
    concurrency = 48, timeout = 6000, onFound, onProgress, enough, waveSize,
    inspect = inspectAddress, apiPath = '/v1/models', port = 443, signal,
  } = {},
) {
  const found = []
  if (signal?.aborted) return found
  let stopped = false
  let releaseAbort
  const aborted = new Promise((resolve) => { releaseAbort = resolve })
  const onAbort = () => {
    stopped = true
    releaseAbort()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const inactive = () => stopped || signal?.aborted === true
  const wave = Math.max(1, waveSize ?? Math.min(concurrency, 16))
  // One counter across every wave, so a caller sees honest "attempted / usable"
  // totals rather than a per-wave figure that resets.
  let attempted = 0
  let usable = 0
  const report = () => {
    if (!inactive()) onProgress?.({ attempted, usable, total: ips.length })
  }
  const options = { timeout, apiPath, port, ...(signal === undefined ? {} : { signal }) }
  try {
    for (let start = 0; start < ips.length && !inactive(); start += wave) {
      const slice = ips.slice(start, start + wave)
      let cursor = 0
      let satisfied = false
      let release
      const satisfiedSignal = new Promise((resolve) => {
        release = resolve
      })
      const workers = Array.from({ length: Math.min(concurrency, slice.length) }, async () => {
        while (cursor < slice.length && !satisfied && !inactive()) {
          const ip = slice[cursor++]
          const info = await inspect(ip, hostname, { ...options })
          // A sibling or an abort may already have returned the wave. Late
          // completions must not mutate the returned list or publish callbacks.
          if (satisfied || inactive()) return
          attempted++
          if (info === null) {
            // A failed address is progress too: the user should see the sweep
            // moving instead of a frozen count on a mostly-empty range.
            report()
            continue
          }
          usable++
          found.push(info)
          onFound?.(info)
          report()
          // Callbacks can synchronously abort, so re-check before publishing
          // enough or dispatching another address.
          if (!inactive() && enough !== undefined && enough(info, found)) {
            satisfied = true
            release()
          }
        }
      })
      const batch = Promise.all(workers)
      // The race observes rejections too, but an explicit handler keeps detached
      // workers safe if cancellation/enough wins before an inspector rejects.
      void batch.catch(() => {})
      const waiting = [batch]
      if (enough !== undefined) waiting.push(satisfiedSignal)
      if (signal !== undefined) waiting.push(aborted)
      await Promise.race(waiting)
      if (satisfied || inactive()) return found
    }
    return found
  } finally {
    stopped = true
    signal?.removeEventListener('abort', onAbort)
  }
}

export { NEAR_COLOS }
