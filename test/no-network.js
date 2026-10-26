// Fail closed: the default test command cannot accidentally contact live DNS,
// providers, loopback services, or fetch URLs. Individual tests may install a
// scoped mock over these throwing sentinels, never over a real network function.
import dns from 'node:dns'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'

// Test children must not require modules from the user's running DSH profile.
process.env.DSH_BEST_IP_ISOLATED_TESTS = '1'

const blocked = (operation) => function () { throw new Error(`network forbidden in isolated tests: ${operation}`) }
for (const [target, names, prefix] of [
  [net, ['connect', 'createConnection'], 'net'],
  [tls, ['connect'], 'tls'],
  [http, ['request', 'get'], 'http'],
  [https, ['request', 'get'], 'https'],
  [dns, ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse'], 'dns'],
  [dns.promises, ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse'], 'dns.promises'],
  [dns.Resolver.prototype, ['resolve', 'resolve4', 'resolve6', 'reverse'], 'dns.Resolver'],
]) {
  for (const name of names) target[name] = blocked(`${prefix}.${name}`)
}
globalThis.fetch = blocked('fetch')
