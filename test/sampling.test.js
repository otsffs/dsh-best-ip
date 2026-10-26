// No real sockets: sampling is pure, inspection is injected, net/tls are mocked.
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import net from 'node:net'
import tls from 'node:tls'
import test from 'node:test'
import { sampleRange, scanCandidates, inspectAll, inspectAddress, tcpRtt, tlsRequest, rankAddresses } from '../probe.js'

// Independent expected inventory, not imported from the sampler under test.
// Source: https://www.cloudflare.com/ips-v4 (verified 2026-10-26).
const expectedCidrs = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
]
const unitPrefixes = [
  // First cover each parent CIDR, then alternate its remaining /16 children.
  '173.245', '103.21', '103.22', '103.31', '141.101', '108.162', '190.93', '188.114',
  '197.234', '198.41', '162.158', '104.16', '104.24', '172.64', '131.0',
  '162.159', '104.17', '104.25', '172.65',
  '104.18', '104.26', '172.66', '104.19', '104.27', '172.67',
  '104.20', '172.68', '104.21', '172.69', '104.22', '172.70', '104.23', '172.71',
]
const prefix = (ip) => ip.split('.').slice(0, 2).join('.')
const ipNumber = (ip) => ip.split('.').reduce((value, octet) => value * 256 + Number(octet), 0)
const expectedRanges = expectedCidrs.map((cidr) => {
  const [base, bits] = cidr.split('/')
  const start = ipNumber(base)
  return { cidr, start, end: start + 2 ** (32 - Number(bits)) }
})
const parentFor = (ip) => {
  const value = ipNumber(ip)
  return expectedRanges.find((range) => value >= range.start && value < range.end)
}

for (const budget of [0, 1, 14, 15, 16, 17, 32, 33, 34, 159, 160, 512, 4096]) {
  test(`scan budget ${budget} is exact, unique, balanced, and inside the official CIDRs`, () => {
    const ips = scanCandidates(budget)
    assert.equal(ips.length, budget)
    assert.equal(new Set(ips).size, budget)
    const counts = unitPrefixes.map((unit) => ips.filter((ip) => prefix(ip) === unit).length)
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1)
    for (const ip of ips) {
      assert.equal(net.isIP(ip), 4)
      assert.ok(unitPrefixes.includes(prefix(ip)), `unexpected unit: ${ip}`)
      assert.ok(parentFor(ip), `${ip} must stay inside the actual /20, /22 or larger CIDR`)
      const host = Number(ip.split('.')[3])
      assert.ok(host > 0 && host < 255)
    }
    assert.deepEqual(scanCandidates(budget), ips)
    assert.deepEqual(ips.slice(0, Math.min(33, budget)).map(prefix), unitPrefixes.slice(0, Math.min(33, budget)))
    if (budget >= 15) assert.equal(new Set(ips.map((ip) => parentFor(ip).cidr)).size, 15)
    if (budget >= 33) assert.equal(new Set(ips.map(prefix)).size, 33)
  })
}

test('default budget and the complete inventory retain their intended bounds', () => {
  assert.deepEqual(scanCandidates(), scanCandidates(512))
  assert.equal(expectedRanges.reduce((total, range) => total + range.end - range.start, 0), 1524736)
  const counts = unitPrefixes.map((unit) => scanCandidates(160).filter((ip) => prefix(ip) === unit).length)
  assert.equal(counts.filter((count) => count === 5).length, 28)
  assert.equal(counts.filter((count) => count === 4).length, 5)
})

test('formerly absent regions are represented without probing outside their inventory', () => {
  const ips = scanCandidates(160)
  for (const unit of ['162.158', '104.22', '104.23', '104.26', '172.65', '172.68', '172.69', '172.70', '172.71', '198.41']) {
    assert.ok(ips.some((ip) => prefix(ip) === unit), `missing ${unit}`)
  }
  for (const cidr of ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
    '190.93.240.0/20', '197.234.240.0/22', '198.41.128.0/17', '131.0.72.0/22']) {
    assert.ok(ips.some((ip) => parentFor(ip)?.cidr === cidr), `missing ${cidr}`)
  }
})

for (const budget of [160, 4096]) {
  test(`budget ${budget} places each point inside its own disjoint stratum`, () => {
    const ips = scanCandidates(budget)
    for (const unit of unitPrefixes) {
      const group = ips.filter((ip) => prefix(ip) === unit)
      assert.ok(group.length > 0, `missing ${unit}`)
      const parent = parentFor(group[0])
      assert.ok(parent, `unexpected CIDR for ${group[0]}`)
      const blockStart = Math.floor(ipNumber(group[0]) / 65536) * 65536
      const start = Math.max(blockStart, parent.start)
      const end = Math.min(blockStart + 65536, parent.end)
      const usable = (end - start) / 256 * 254
      group.forEach((ip, index) => {
        const offset = ipNumber(ip) - start
        const position = Math.floor(offset / 256) * 254 + offset % 256 - 1
        assert.ok(position >= Math.floor(index * usable / group.length))
        assert.ok(position < Math.floor((index + 1) * usable / group.length))
      })
    }
  })
}

test('same-sized strata use unit-specific offsets rather than copying one host pattern', () => {
  const ips = scanCandidates(160)
  const patterns = ['162.158', '104.16', '104.24', '172.64'].map((unit) =>
    ips.filter((ip) => prefix(ip) === unit).map((ip) => ip.split('.').slice(2).join('.')).join(','))
  assert.equal(new Set(patterns).size, patterns.length)
})

test('sampling normalizes finite budgets and rejects non-progressing strides', () => {
  assert.deepEqual(scanCandidates(-1), [])
  assert.deepEqual(scanCandidates(Infinity), [])
  assert.deepEqual(scanCandidates(NaN), [])
  assert.deepEqual(scanCandidates(16.9), scanCandidates(16))
  for (const stride of [0, -1, 0.5, Infinity, NaN]) {
    assert.throws(() => sampleRange('104.21.0.0/16', stride), /positive integer/)
  }
})

test('known remote colos precede unknown ones when near preference is enabled', () => {
  const entries = [
    { ip: 'unknown', rtt: 1 }, { ip: 'far', colo: 'LAX', rtt: 50 }, { ip: 'near', colo: 'HKG', rtt: 60 },
  ]
  assert.deepEqual(rankAddresses(entries).map((entry) => entry.ip), ['near', 'far', 'unknown'])
  assert.deepEqual(rankAddresses(entries, { preferNear: false }).map((entry) => entry.ip), ['unknown', 'far', 'near'])
})

test('inspectAll forwards endpoint options and respects its concurrency bound', async () => {
  const controller = new AbortController()
  const called = []
  const reports = []
  let active = 0
  let peak = 0
  const found = await inspectAll(['a', 'b', 'c', 'd', 'e'], 'api.example.test', {
    concurrency: 2, waveSize: 5, timeout: 1234, apiPath: '/custom/models', port: '8443', signal: controller.signal,
    inspect: async (ip, hostname, options) => {
      active++
      peak = Math.max(active, peak)
      called.push({ ip, hostname, options })
      await Promise.resolve()
      active--
      return ip === 'b' ? null : { ip, rtt: 10 }
    },
    onProgress: (value) => reports.push(value),
  })
  assert.equal(peak, 2)
  assert.equal(called.length, 5)
  assert.equal(found.length, 4)
  for (const call of called) {
    assert.equal(call.hostname, 'api.example.test')
    assert.deepEqual(call.options, { timeout: 1234, apiPath: '/custom/models', port: '8443', signal: controller.signal })
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.deepEqual(reports.at(-1), { attempted: 5, usable: 4, total: 5 })
})

function mockSockets(t, raw) {
  const tcp = []
  const secure = []
  const requests = []
  t.mock.method(net, 'connect', (options) => {
    tcp.push(options)
    const socket = new EventEmitter()
    socket.destroy = () => {}
    socket.setTimeout = () => {}
    queueMicrotask(() => socket.emit('connect'))
    return socket
  })
  t.mock.method(tls, 'connect', (options) => {
    secure.push(options)
    const socket = new EventEmitter()
    socket.authorized = true
    socket.destroy = () => {}
    socket.setTimeout = () => {}
    socket.write = (head) => {
      requests.push(head)
      queueMicrotask(() => {
        socket.emit('data', Buffer.from(raw))
        socket.emit('close')
      })
    }
    queueMicrotask(() => socket.emit('secureConnect'))
    return socket
  })
  return { tcp, secure, requests }
}

test('inspection uses provider path/port, verifies SNI, and never falls back to another hostname', async (t) => {
  const captured = mockSockets(t, 'HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\n{}')
  const result = await inspectAddress('192.0.2.7', 'api.example.test', {
    timeout: 1000, apiPath: '/custom/models', port: '8443',
  })
  assert.equal(result.ip, '192.0.2.7')
  assert.equal(result.colo, undefined)
  assert.equal(captured.tcp[0].port, 8443)
  assert.equal(captured.secure.length, 1, 'no cloudflare.com trace fallback')
  assert.equal(captured.secure[0].port, 8443)
  assert.equal(captured.secure[0].servername, 'api.example.test')
  assert.equal(captured.secure[0].rejectUnauthorized, true)
  assert.match(captured.requests[0], /^GET \/custom\/models HTTP\/1\.1\r\n/)
  assert.match(captured.requests[0], /\r\nHost: api\.example\.test:8443\r\n/)
})

test('default TLS port omits a redundant Host port and cf-ray supplies the colo', async (t) => {
  const captured = mockSockets(t, 'HTTP/1.1 200 OK\r\ncf-ray: abc123-LAX\r\nContent-Length: 2\r\n\r\n{}')
  const result = await inspectAddress('192.0.2.7', 'api.example.test')
  assert.equal(result.colo, 'LAX')
  assert.equal(captured.secure[0].port, 443)
  assert.match(captured.requests[0], /\r\nHost: api\.example\.test\r\n/)
  assert.equal(captured.secure.length, 1)
})

test('tlsRequest forwards a non-default port without changing SNI', async (t) => {
  const captured = mockSockets(t, 'HTTP/1.1 200 OK\r\n\r\n')
  const result = await tlsRequest('192.0.2.9', 'api.example.test', { verify: true, port: 9443, path: '/health' })
  assert.equal(result.status, 200)
  assert.equal(captured.secure[0].port, 9443)
  assert.equal(captured.secure[0].servername, 'api.example.test')
  assert.match(captured.requests[0], /Host: api\.example\.test:9443/)
})

// These fixtures never create a socket or a timer. Destruction emits close
// synchronously to expose re-entrancy, and captured callbacks can be invoked
// after cleanup to model already-queued events without EventEmitter errors.
function controlledSockets(t, { startTcp, startTls, writeTls } = {}) {
  const tcp = []
  const secure = []
  const makeSocket = (options) => {
    const socket = new EventEmitter()
    socket.options = options
    socket.timeouts = []
    socket.writes = []
    socket.destroyed = 0
    socket.authorized = true
    socket.setTimeout = (value) => { socket.timeouts.push(value) }
    socket.destroy = () => { socket.destroyed++; socket.emit('close') }
    socket.write = (value) => { socket.writes.push(value); writeTls?.(socket) }
    return socket
  }
  t.mock.method(net, 'connect', (options) => {
    const socket = makeSocket(options)
    tcp.push(socket)
    startTcp?.(socket)
    return socket
  })
  t.mock.method(tls, 'connect', (options) => {
    const socket = makeSocket(options)
    secure.push(socket)
    startTls?.(socket)
    return socket
  })
  const timers = new Map()
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    const timer = { unref() {} }
    timers.set(timer, { callback, ms })
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', (timer) => { timers.delete(timer) })
  return { tcp, secure, timers }
}

function assertCleanSocket(socket, signal) {
  assert.equal(socket.destroyed, 1)
  assert.equal(socket.timeouts.at(-1), 0, 'socket inactivity timer is disabled')
  assert.deepEqual(socket.eventNames(), [], 'probe-owned socket listeners are removed')
  if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0)
}

test('pre-aborted TCP/TLS/address inspection never starts a connection or deadline', async (t) => {
  const sockets = controlledSockets(t)
  const controller = new AbortController()
  controller.abort()
  assert.equal(await tcpRtt('192.0.2.1', 8443, 100, controller.signal), null)
  assert.deepEqual(await tlsRequest('192.0.2.1', 'api.example.test', { signal: controller.signal }), { ok: false })
  assert.equal(await inspectAddress('192.0.2.1', 'api.example.test', { signal: controller.signal }), null)
  assert.equal(sockets.tcp.length, 0)
  assert.equal(sockets.secure.length, 0)
  assert.equal(sockets.timers.size, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('TCP abort destroys immediately, clears listeners, and ignores queued success/error callbacks', async (t) => {
  const { tcp } = controlledSockets(t)
  const controller = new AbortController()
  const pending = tcpRtt('192.0.2.2', 8443, 123, controller.signal)
  const socket = tcp[0]
  assert.deepEqual(socket.options, { host: '192.0.2.2', port: 8443 })
  assert.deepEqual(socket.timeouts, [123])
  const lateConnect = socket.listeners('connect')[0]
  const lateError = socket.listeners('error')[0]
  controller.abort()
  assertCleanSocket(socket, controller.signal)
  lateConnect()
  lateError(new Error('late TCP error'))
  assert.equal(await pending, null)
  assert.equal(socket.destroyed, 1)
})

for (const event of ['connect', 'timeout', 'error', 'close']) {
  test(`TCP ${event} settles once and clears socket/abort listeners`, async (t) => {
    const { tcp } = controlledSockets(t)
    const controller = new AbortController()
    const pending = tcpRtt('192.0.2.2', 443, 123, controller.signal)
    tcp[0].emit(event)
    const result = await pending
    if (event === 'connect') assert.equal(typeof result, 'number')
    else assert.equal(result, null)
    assertCleanSocket(tcp[0], controller.signal)
  })
}

for (const transport of ['TCP', 'TLS']) {
  test(`abort triggered inside the ${transport} connector cannot escape cancellation`, async (t) => {
    const controller = new AbortController()
    const sockets = controlledSockets(t, {
      ...(transport === 'TCP' ? { startTcp: () => controller.abort() } : { startTls: () => controller.abort() }),
    })
    const result = transport === 'TCP'
      ? await tcpRtt('192.0.2.2', 443, 123, controller.signal)
      : await tlsRequest('192.0.2.2', 'api.example.test', { signal: controller.signal })
    assert.deepEqual(result, transport === 'TCP' ? null : { ok: false })
    assertCleanSocket(transport === 'TCP' ? sockets.tcp[0] : sockets.secure[0], controller.signal)
    assert.equal(sockets.timers.size, 0)
  })
}

for (const duringResponse of [false, true]) {
  test(`TLS abort during ${duringResponse ? 'response' : 'handshake'} closes immediately without a successful result`, async (t) => {
    const { secure, timers } = controlledSockets(t)
    const controller = new AbortController()
    const pending = tlsRequest('192.0.2.3', 'api.example.test', { verify: true, timeout: 321, signal: controller.signal })
    const socket = secure[0]
    const lateSecure = socket.listeners('secureConnect')[0]
    const lateData = socket.listeners('data')[0]
    const lateClose = socket.listeners('close')[0]
    const lateError = socket.listeners('error')[0]
    const lateDeadline = [...timers.values()][0].callback
    assert.equal([...timers.values()][0].ms, 321)
    if (duringResponse) {
      socket.emit('secureConnect')
      socket.emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n{}'))
    }
    const writes = socket.writes.length
    controller.abort()
    assertCleanSocket(socket, controller.signal)
    assert.equal(timers.size, 0, 'absolute deadline is cleared synchronously')
    lateSecure()
    lateData(Buffer.from('HTTP/1.1 200 OK\r\n\r\nlate'))
    lateClose()
    lateError(new Error('late TLS error'))
    lateDeadline()
    assert.deepEqual(await pending, { ok: false })
    assert.equal(socket.writes.length, writes, 'no request is written after cancellation')
    assert.equal(socket.destroyed, 1)
  })
}

for (const event of ['timeout', 'error', 'close', 'deadline']) {
  test(`TLS ${event} before secureConnect preserves its failure shape and clears all timers/listeners`, async (t) => {
    const { secure, timers } = controlledSockets(t)
    const controller = new AbortController()
    const pending = tlsRequest('192.0.2.3', 'api.example.test', { timeout: 321, signal: controller.signal })
    if (event === 'deadline') [...timers.values()][0].callback()
    else secure[0].emit(event)
    assert.deepEqual(await pending, event === 'timeout' || event === 'deadline' ? { ok: false, timedOut: true } : { ok: false })
    assertCleanSocket(secure[0], controller.signal)
    assert.equal(timers.size, 0)
  })
}

test('TLS response listeners precede write, including synchronous data/close fixtures', async (t) => {
  const raw = 'HTTP/1.1 200 OK\r\ncf-ray: abc-HKG\r\n\r\n{}'
  const { secure, timers } = controlledSockets(t, {
    writeTls: (socket) => { socket.emit('data', Buffer.from(raw)); socket.emit('close') },
  })
  const controller = new AbortController()
  const pending = tlsRequest('192.0.2.3', 'api.example.test', {
    verify: true, path: '/custom', port: '9443', method: 'POST', body: '{}', headers: { 'X-Test': 'value' }, signal: controller.signal,
  })
  secure[0].emit('secureConnect')
  const result = await pending
  assert.deepEqual(Object.keys(result).sort(), ['authorized', 'ok', 'raw', 'status', 'tlsMs'])
  assert.equal(result.ok, true)
  assert.equal(result.authorized, true)
  assert.equal(result.status, 200)
  assert.equal(result.raw, raw)
  assert.equal(typeof result.tlsMs, 'number')
  assert.match(secure[0].writes[0], /^POST \/custom HTTP\/1\.1\r\nHost: api\.example\.test:9443\r\n/)
  assert.match(secure[0].writes[0], /X-Test: value\r\nContent-Length: 2\r\n\r\n\{\}/)
  assertCleanSocket(secure[0], controller.signal)
  assert.equal(timers.size, 0)
})

for (const stage of ['TCP', 'between stages', 'TLS', 'after TLS']) {
  test(`inspectAddress abort ${stage} never becomes a usable result`, async (t) => {
    const { tcp, secure, timers } = controlledSockets(t)
    const controller = new AbortController()
    const pending = inspectAddress('192.0.2.4', 'api.example.test', {
      timeout: 321, port: '9443', apiPath: '/custom/models', signal: controller.signal,
    })
    if (stage !== 'TCP') tcp[0].emit('connect')
    if (stage === 'TLS' || stage === 'after TLS') {
      await Promise.resolve()
      assert.equal(secure.length, 1)
      secure[0].emit('secureConnect')
      if (stage === 'after TLS') {
        secure[0].emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n{}'))
        secure[0].emit('close')
      }
    }
    controller.abort()
    assert.equal(await pending, null)
    assertCleanSocket(tcp[0], controller.signal)
    if (secure.length) assertCleanSocket(secure[0], controller.signal)
    else assert.ok(stage === 'TCP' || stage === 'between stages', 'no TLS dispatch after cancellation')
    assert.equal(timers.size, 0)
  })
}

test('inspectAll default inspection closes every in-flight TCP socket on the same abort signal', async (t) => {
  const { tcp, secure, timers } = controlledSockets(t)
  const controller = new AbortController()
  const pending = inspectAll(['192.0.2.1', '192.0.2.2', '192.0.2.3'], 'api.example.test', {
    concurrency: 2, waveSize: 3, signal: controller.signal,
  })
  assert.equal(tcp.length, 2)
  controller.abort()
  for (const socket of tcp) assertCleanSocket(socket, controller.signal)
  assert.deepEqual(await pending, [])
  assert.equal(tcp.length, 2)
  assert.equal(secure.length, 0)
  assert.equal(timers.size, 0)
})
