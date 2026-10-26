import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { readState, resolveStateDir, statePath, writeState } from '../store.js'

const storeURL = new URL('../store.js', import.meta.url).href
const record = (ip, extra = {}) => ({ candidates: [{ ip }], selected: ip, ...extra })
const document = (hosts) => ({ version: 1, hosts })

function fixture(t) {
  const base = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(base, 'dsh-best-ip-store-safe-'))
  // Verify the absolute cleanup target before permitting a recursive deletion.
  assert.equal(path.dirname(root), base)
  assert.ok(path.basename(root).startsWith('dsh-best-ip-store-safe-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), base)
    assert.ok(path.basename(root).startsWith('dsh-best-ip-store-safe-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const home = path.join(root, 'home')
  const profile = path.join(root, 'profiles', 'desktop')
  const env = {
    DSH_HOME: home,
    DSH_PROFILE_DIR: profile,
    DSH_PROFILE: 'desktop',
    USERPROFILE: path.join(root, 'user'),
    HOME: path.join(root, 'user'),
  }
  return { root, home, profile, env }
}

function putFile(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
}

function assertNoArtifacts(env) {
  const dir = path.dirname(statePath(env))
  if (!fs.existsSync(dir)) return
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.lock') || name.endsWith('.tmp')), [])
}

test('state paths use the profile, then the legacy home; fallback env is injected', (t) => {
  const { env, profile, home, root } = fixture(t)
  assert.equal(resolveStateDir(env), profile)
  assert.equal(statePath(env), path.join(profile, 'dsh-best-ip', 'state.json'))
  const unprofiled = { ...env, DSH_PROFILE_DIR: undefined }
  assert.equal(resolveStateDir(unprofiled), home)
  assert.equal(resolveStateDir({ USERPROFILE: path.join(root, 'injected-user') }), path.join(root, 'injected-user', '.dsh'))
  assert.equal(resolveStateDir({ HOME: path.join(root, 'injected-home') }), path.join(root, 'injected-home', '.dsh'))
})

test('an absent file reads empty without creating profile directories', (t) => {
  const { env, profile } = fixture(t)
  assert.deepEqual(readState(env), document({}))
  assert.equal(fs.existsSync(profile), false)
})

test('only explicitly identified desktop profiles may borrow absent legacy state', (t) => {
  const { env, home, profile } = fixture(t)
  const legacy = path.join(home, 'dsh-best-ip', 'state.json')
  const old = document({ 'api.example': record('192.0.2.1') })
  putFile(legacy, old)
  const before = fs.readFileSync(legacy, 'utf8')
  assert.deepEqual(readState(env), old)
  for (const DSH_PROFILE of ['web', 're', 'Desktop', '', undefined]) {
    assert.deepEqual(readState({ ...env, DSH_PROFILE }), document({}))
  }
  assert.equal(fs.existsSync(profile), false, 'readState must not eagerly migrate or create anything')
  assert.equal(fs.readFileSync(legacy, 'utf8'), before)
})

test('existing profile state, including an empty document, always beats legacy', (t) => {
  const { env, home } = fixture(t)
  putFile(path.join(home, 'dsh-best-ip', 'state.json'), document({ legacy: record('192.0.2.1') }))
  putFile(statePath(env), document({}))
  assert.deepEqual(readState(env), document({}))
  putFile(statePath(env), document({ local: record('192.0.2.2') }))
  assert.deepEqual(readState(env).hosts, { local: record('192.0.2.2') })
})

test('malformed, unknown-version and invalid shape files are rejected without legacy reuse', (t) => {
  const { env, home } = fixture(t)
  putFile(path.join(home, 'dsh-best-ip', 'state.json'), document({ legacy: record('192.0.2.1') }))
  const invalid = [
    '{', null, [], 1,
    { hosts: {} },
    { version: 2, hosts: {} },
    { version: '1', hosts: {} },
    { version: 1, hosts: [] },
    { version: 1, hosts: null },
    { version: 1, hosts: { broken: [] } },
    { version: 1, hosts: { broken: 'not a record' } },
    { version: 1, hosts: { broken: { candidates: {} } } },
    { version: 1, hosts: { broken: { benchmarks: [] } } },
  ]
  for (const value of invalid) {
    putFile(statePath(env), typeof value === 'string' ? value : JSON.stringify(value))
    assert.deepEqual(readState(env), document({}), JSON.stringify(value))
  }
})

test('an unreadable existing profile document does not fall back to legacy', (t) => {
  const { env, home } = fixture(t)
  const target = statePath(env)
  putFile(target, document({ local: record('192.0.2.2') }))
  putFile(path.join(home, 'dsh-best-ip', 'state.json'), document({ legacy: record('192.0.2.1') }))
  const originalRead = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === target) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return originalRead(file, ...args)
  })
  assert.deepEqual(readState(env), document({}))
})

test('the first desktop delta write migrates valid legacy state, leaving legacy bytes untouched', (t) => {
  const { env, home } = fixture(t)
  const legacy = path.join(home, 'dsh-best-ip', 'state.json')
  putFile(legacy, document({ old: record('192.0.2.1') }))
  const before = fs.readFileSync(legacy, 'utf8')
  writeState({ hosts: { fresh: record('192.0.2.2') } }, env, { changedKeys: ['fresh'] })
  assert.deepEqual(readState(env).hosts, { old: record('192.0.2.1'), fresh: record('192.0.2.2') })
  assert.equal(fs.readFileSync(legacy, 'utf8'), before)
  assert.equal(fs.existsSync(statePath(env)), true)
  assertNoArtifacts(env)
})

test('non-desktop and unknown profiles create isolated files without copying legacy', (t) => {
  const { env, home, root } = fixture(t)
  putFile(path.join(home, 'dsh-best-ip', 'state.json'), document({ legacy: record('192.0.2.1') }))
  for (const name of ['web', 'unknown']) {
    const other = {
      ...env,
      DSH_PROFILE: name === 'unknown' ? undefined : name,
      DSH_PROFILE_DIR: path.join(root, 'profiles', name),
    }
    writeState({ hosts: { [name]: record('192.0.2.2') } }, other, { changedKeys: [name] })
    assert.deepEqual(Object.keys(readState(other).hosts), [name])
  }
  assert.equal(fs.existsSync(statePath(env)), false)
})

test('unprofiled launches retain the legacy read/write path', (t) => {
  const { env, home } = fixture(t)
  const unprofiled = { ...env, DSH_PROFILE_DIR: undefined, DSH_PROFILE: undefined }
  writeState({ hosts: { old: record('192.0.2.1') } }, unprofiled)
  assert.equal(statePath(unprofiled), path.join(home, 'dsh-best-ip', 'state.json'))
  assert.deepEqual(readState(unprofiled).hosts, { old: record('192.0.2.1') })
  assertNoArtifacts(unprofiled)
})

test('no write options retain replacement semantics; empty options mean an empty delta', (t) => {
  const { env } = fixture(t)
  writeState({ hosts: { old: record('192.0.2.1') } }, env)
  writeState({ hosts: { fresh: record('192.0.2.2') } }, env)
  assert.deepEqual(Object.keys(readState(env).hosts), ['fresh'])
  writeState({ hosts: { ignored: record('192.0.2.3') } }, env, {})
  assert.deepEqual(Object.keys(readState(env).hosts), ['fresh'])
  writeState({ hosts: {} }, env, undefined)
  assert.deepEqual(readState(env), document({}))
  assertNoArtifacts(env)
})

test('empty deltas are side-effect-free and do not eagerly migrate legacy state', (t) => {
  const { env, home, profile } = fixture(t)
  putFile(path.join(home, 'dsh-best-ip', 'state.json'), document({ legacy: record('192.0.2.1') }))
  writeState(readState(env), env, { changedKeys: [], deletedKeys: new Set() })
  assert.equal(fs.existsSync(profile), false)
  putFile(statePath(env), '{  "version":1, "hosts":{} }')
  const before = fs.readFileSync(statePath(env), 'utf8')
  writeState({ hosts: {} }, env, {})
  assert.equal(fs.readFileSync(statePath(env), 'utf8'), before)
  assertNoArtifacts(env)
})

test('delta updates merge stale writer snapshots and explicit deletions under the lock', (t) => {
  const { env } = fixture(t)
  writeState({ hosts: { seed: record('192.0.2.1'), obsolete: record('192.0.2.2') } }, env)
  const a = readState(env)
  const b = readState(env)
  a.hosts.alpha = record('192.0.2.3', { customField: 'preserved' })
  delete a.hosts.obsolete
  b.hosts.beta = record('192.0.2.4')
  writeState(a, env, { changedKeys: new Set(['alpha']), deletedKeys: new Set(['obsolete']) })
  writeState(b, env, { changedKeys: ['beta'] })
  assert.deepEqual(readState(env).hosts, {
    seed: record('192.0.2.1'),
    alpha: record('192.0.2.3', { customField: 'preserved' }),
    beta: record('192.0.2.4'),
  })
  writeState({ hosts: {} }, env, { deletedKeys: ['already-absent', 'seed'] })
  assert.deepEqual(Object.keys(readState(env).hosts).sort(), ['alpha', 'beta'])
  assertNoArtifacts(env)
})

test('arbitrary provider keys remain data, including __proto__ and grouped keys', (t) => {
  const { env } = fixture(t)
  const grouped = 'provider-a\u0000api.example'
  const hosts = Object.fromEntries([
    ['__proto__', record('192.0.2.1')],
    [grouped, record('192.0.2.2')],
  ])
  writeState({ hosts }, env, { changedKeys: Object.keys(hosts) })
  const read = readState(env).hosts
  assert.deepEqual(Object.keys(read).sort(), ['__proto__', grouped].sort())
  assert.deepEqual(Object.getOwnPropertyDescriptor(read, '__proto__').value, record('192.0.2.1'))
  assert.equal(Object.prototype.selected, undefined)
})

test('invalid input and contradictory deltas fail without modifying the document', (t) => {
  const { env } = fixture(t)
  writeState({ hosts: { good: record('192.0.2.1') } }, env)
  const before = fs.readFileSync(statePath(env), 'utf8')
  const cases = [
    () => writeState({ version: 2, hosts: {} }, env),
    () => writeState({ hosts: [] }, env),
    () => writeState({ hosts: null }, env),
    () => writeState({ hosts: { broken: null } }, env),
    () => writeState({ hosts: {} }, env, { changedKeys: ['missing'] }),
    () => writeState({ hosts: { a: {} } }, env, { changedKeys: ['a'], deletedKeys: ['a'] }),
    () => writeState({ hosts: {} }, env, { changedKeys: 'not-an-array' }),
    () => writeState({ hosts: {} }, env, { deletedKeys: [1] }),
    () => writeState({ hosts: {} }, env, null),
  ]
  for (const call of cases) {
    assert.throws(call, { code: 'ERR_DSH_BEST_IP_STATE_INVALID' })
    assert.equal(fs.readFileSync(statePath(env), 'utf8'), before)
    assertNoArtifacts(env)
  }
})

test('delta writes refuse corrupt/unknown current files while explicit replacement can repair', (t) => {
  const { env } = fixture(t)
  for (const before of ['{', JSON.stringify({ version: 999, hosts: {} })]) {
    putFile(statePath(env), before)
    assert.throws(() => writeState({ hosts: { a: record('192.0.2.1') } }, env, { changedKeys: ['a'] }), {
      code: 'ERR_DSH_BEST_IP_STATE_INVALID',
    })
    assert.equal(fs.readFileSync(statePath(env), 'utf8'), before)
    assertNoArtifacts(env)
  }
  writeState({ hosts: { repaired: record('192.0.2.1') } }, env)
  assert.deepEqual(Object.keys(readState(env).hosts), ['repaired'])
})

test('lock contention fails immediately and never removes another owner lock', (t) => {
  const { env } = fixture(t)
  writeState({ hosts: { old: record('192.0.2.1') } }, env)
  const lock = `${statePath(env)}.lock`
  const owner = 'another writer owns this file'
  putFile(lock, owner)
  const before = fs.readFileSync(statePath(env), 'utf8')
  assert.throws(() => writeState({ hosts: {} }, env), { code: 'ERR_DSH_BEST_IP_STATE_LOCKED' })
  assert.equal(fs.readFileSync(lock, 'utf8'), owner)
  assert.equal(fs.readFileSync(statePath(env), 'utf8'), before)
})

test('a second process is excluded while a real writer holds the commit lock', (t) => {
  const { env } = fixture(t)
  writeState({ hosts: { seed: record('192.0.2.1') } }, env)
  const originalRename = fs.renameSync
  let checked = false
  t.mock.method(fs, 'renameSync', (from, to) => {
    assert.equal(to, statePath(env))
    const code = `
      import assert from 'node:assert/strict';
      import { writeState } from ${JSON.stringify(storeURL)};
      assert.throws(() => writeState({hosts:{child:{candidates:[]}}}, ${JSON.stringify(env)}, {changedKeys:['child']}),
        {code:'ERR_DSH_BEST_IP_STATE_LOCKED'});
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'inherit' })
    assert.equal(child.error, undefined)
    assert.equal(child.status, 0)
    checked = true
    return originalRename(from, to)
  })
  writeState({ hosts: { parent: record('192.0.2.2') } }, env, { changedKeys: ['parent'] })
  assert.equal(checked, true)
  assert.deepEqual(Object.keys(readState(env).hosts).sort(), ['parent', 'seed'])
  assertNoArtifacts(env)
})

test('serialization failure cleans the lock and leaves existing bytes unchanged', (t) => {
  const { env } = fixture(t)
  writeState({ hosts: { old: record('192.0.2.1') } }, env)
  const before = fs.readFileSync(statePath(env), 'utf8')
  assert.throws(() => writeState({ hosts: { broken: { candidates: [], value: 1n } } }, env), TypeError)
  assert.equal(fs.readFileSync(statePath(env), 'utf8'), before)
  assertNoArtifacts(env)
})

test('even a non-Error serialization throw releases the lock and reports failure', (t) => {
  const { env } = fixture(t)
  const hosts = { a: record('192.0.2.1') }
  Object.defineProperty(hosts, 'toJSON', { value: () => { throw undefined }, enumerable: false })
  let threw = false
  try {
    writeState({ hosts }, env)
  } catch (error) {
    threw = true
    assert.equal(error, undefined)
  }
  assert.equal(threw, true)
  assert.equal(fs.existsSync(statePath(env)), false)
  assertNoArtifacts(env)
})

test('a toJSON shape change is rejected and cleans the lock', (t) => {
  const { env } = fixture(t)
  const hosts = { a: record('192.0.2.1') }
  Object.defineProperty(hosts, 'toJSON', { value: () => [], enumerable: false })
  assert.throws(() => writeState({ hosts }, env), { code: 'ERR_DSH_BEST_IP_STATE_INVALID' })
  assert.equal(fs.existsSync(statePath(env)), false)
  assertNoArtifacts(env)
})

test('partial temporary write failure cleans both temporary file and lock', (t) => {
  const { env } = fixture(t)
  writeState({ hosts: { old: record('192.0.2.1') } }, env)
  const before = fs.readFileSync(statePath(env), 'utf8')
  const originalWrite = fs.writeFileSync
  let fdWrites = 0
  t.mock.method(fs, 'writeFileSync', (file, data, ...args) => {
    if (typeof file === 'number' && ++fdWrites === 2) {
      fs.writeSync(file, 'partial')
      throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' })
    }
    return originalWrite(file, data, ...args)
  })
  assert.throws(() => writeState({ hosts: { fresh: record('192.0.2.2') } }, env), { code: 'EIO' })
  assert.equal(fs.readFileSync(statePath(env), 'utf8'), before)
  assertNoArtifacts(env)
})

test('lock metadata write failure releases the acquired lock', (t) => {
  const { env } = fixture(t)
  t.mock.method(fs, 'writeFileSync', () => {
    throw Object.assign(new Error('simulated metadata failure'), { code: 'EIO' })
  })
  assert.throws(() => writeState({ hosts: {} }, env), { code: 'EIO' })
  assert.equal(fs.existsSync(statePath(env)), false)
  assertNoArtifacts(env)
})

test('rename failure preserves the original and cleans temporary file plus lock', (t) => {
  const { env } = fixture(t)
  writeState({ hosts: { old: record('192.0.2.1') } }, env)
  const before = fs.readFileSync(statePath(env), 'utf8')
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' })
  })
  assert.throws(() => writeState({ hosts: { fresh: record('192.0.2.2') } }, env), { code: 'EIO' })
  assert.equal(fs.readFileSync(statePath(env), 'utf8'), before)
  assertNoArtifacts(env)
})
