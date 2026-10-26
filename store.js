// Profile-scoped probe results. Reads never create or migrate files: a legacy
// desktop document is copied into its profile only by the next explicit write.
// Atomic rename prevents partial documents; an exclusive lock plus delta merges
// also prevents independent writers from replacing unrelated records.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const FILE_NAME = 'dsh-best-ip/state.json'
const VERSION = 1
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0

function legacyStateDir(env) {
  return nonempty(env.DSH_HOME)
    ? env.DSH_HOME
    : path.join(env.USERPROFILE ?? env.HOME ?? process.cwd(), '.dsh')
}

/** Profiles own their state; unprofiled launches retain the historical path. */
export function resolveStateDir(env = process.env) {
  return nonempty(env.DSH_PROFILE_DIR) ? env.DSH_PROFILE_DIR : legacyStateDir(env)
}

export function statePath(env = process.env) {
  return path.join(resolveStateDir(env), FILE_NAME)
}

function emptyState() {
  return { version: VERSION, hosts: {} }
}

function invalidState(message, cause) {
  return Object.assign(new Error(`invalid dsh-best-ip state: ${message}`, cause === undefined ? undefined : { cause }), {
    code: 'ERR_DSH_BEST_IP_STATE_INVALID',
  })
}

function validateHosts(hosts) {
  if (!isRecord(hosts)) throw invalidState('hosts must be a record, not an array or null')
  for (const [key, entry] of Object.entries(hosts)) {
    if (key.length === 0 || !isRecord(entry)) throw invalidState('each host entry must be a named record')
    // Preserve fields added by the engine without interpreting provider keys or
    // selection policy here. Reject broken known container shapes, however.
    if (hasOwn(entry, 'candidates') && !Array.isArray(entry.candidates)) {
      throw invalidState(`candidates for ${key} must be an array`)
    }
    if (hasOwn(entry, 'benchmarks') && !isRecord(entry.benchmarks)) {
      throw invalidState(`benchmarks for ${key} must be a record`)
    }
  }
  return hosts
}

function decodeState(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw invalidState('malformed JSON', error)
  }
  if (!isRecord(parsed) || parsed.version !== VERSION) {
    throw invalidState('unsupported or missing version')
  }
  return { version: VERSION, hosts: validateHosts(parsed.hosts) }
}

function readFileState(target) {
  let raw
  try {
    raw = fs.readFileSync(target, 'utf8')
  } catch (error) {
    return { missing: error?.code === 'ENOENT', error }
  }
  try {
    return { state: decodeState(raw) }
  } catch (error) {
    return { missing: false, error }
  }
}

function readAvailableState(env) {
  const target = statePath(env)
  const local = readFileState(target)
  if (!local.missing) return local
  // The historical shared document belonged to desktop. Do not infer this
  // identity from a folder name, and never borrow it for another/unknown profile.
  if (nonempty(env.DSH_PROFILE_DIR) && env.DSH_PROFILE === 'desktop') {
    const legacy = path.join(legacyStateDir(env), FILE_NAME)
    if (path.resolve(legacy) !== path.resolve(target)) {
      const previous = readFileState(legacy)
      if (previous.state !== undefined) return previous
    }
  }
  return local
}

/** Absent, unreadable, malformed and unsupported documents read as empty. */
export function readState(env = process.env) {
  return readAvailableState(env).state ?? emptyState()
}

function changeKeys(value, field) {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) && !(value instanceof Set)) {
    throw invalidState(`${field} must be an array or Set of nonempty strings`)
  }
  const keys = new Set(value)
  if ([...keys].some((key) => typeof key !== 'string' || key.length === 0)) {
    throw invalidState(`${field} must contain only nonempty strings`)
  }
  return keys
}

function prepareChanges(options, incoming) {
  if (options === undefined) return undefined
  if (!isRecord(options)) throw invalidState('write options must be a record')
  const changed = changeKeys(options.changedKeys, 'changedKeys')
  const deleted = changeKeys(options.deletedKeys, 'deletedKeys')
  for (const key of changed) {
    if (!hasOwn(incoming, key)) throw invalidState(`changed key ${key} is missing from hosts`)
    if (deleted.has(key)) throw invalidState(`key ${key} cannot be both changed and deleted`)
  }
  return { changed, deleted }
}

/**
 * Write atomically, without waiting for another writer.
 *
 * With no third argument this replaces the document (legacy contract). Passing
 * { changedKeys, deletedKeys } merges only those keys into the latest on-disk
 * document while holding `${statePath(env)}.lock`. Arrays and Sets are accepted;
 * a changed key must exist in state.hosts, and changed/deleted must be disjoint.
 * Empty deltas are side-effect-free no-ops, not replacement or eager migration.
 * Read-modify-write refuses an existing malformed/unknown-version document rather
 * than erasing it.
 *
 * Throws ERR_DSH_BEST_IP_STATE_LOCKED on contention; never steals a stale lock.
 * Other write failures are thrown too. Only this writer's temp/lock are cleaned.
 */
export function writeState(state, env = process.env, options) {
  if (!isRecord(state) || (state.version !== undefined && state.version !== VERSION)) {
    throw invalidState('write requires a state record with a supported version')
  }
  const incoming = validateHosts(state.hosts === undefined ? {} : state.hosts)
  const changes = prepareChanges(options, incoming)
  if (changes !== undefined && changes.changed.size === 0 && changes.deleted.size === 0) return
  const target = statePath(env)
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true })
  const lock = `${target}.lock`
  let lockFd
  try {
    lockFd = fs.openSync(lock, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw Object.assign(new Error(`dsh-best-ip state is locked by another writer: ${lock}`, { cause: error }), {
        code: 'ERR_DSH_BEST_IP_STATE_LOCKED',
      })
    }
    throw error
  }

  let temp
  let tempFd
  let tempOwned = false
  let failed = false
  let failure
  const cleanupErrors = []
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8')
    let hosts = incoming
    if (changes !== undefined) {
      const latest = readAvailableState(env)
      if (latest.state === undefined && !latest.missing) throw latest.error
      // Use a Map so arbitrary provider keys (including '__proto__') stay data.
      const merged = new Map(Object.entries(latest.state?.hosts ?? {}))
      for (const key of changes.deleted) merged.delete(key)
      for (const key of changes.changed) merged.set(key, incoming[key])
      hosts = Object.fromEntries(merged)
    }
    const payload = JSON.stringify({ version: VERSION, hosts }, undefined, 2)
    // toJSON hooks must not be able to serialize a different/invalid shape.
    decodeState(payload)
    temp = `${target}.${process.pid}.${randomUUID()}.tmp`
    tempFd = fs.openSync(temp, 'wx', 0o600)
    tempOwned = true
    fs.writeFileSync(tempFd, payload, 'utf8')
    fs.closeSync(tempFd)
    tempFd = undefined
    fs.renameSync(temp, target)
    tempOwned = false
  } catch (error) {
    failed = true
    failure = error
  } finally {
    const clean = (action) => {
      try {
        action()
      } catch (error) {
        if (error?.code !== 'ENOENT') cleanupErrors.push(error)
      }
    }
    if (tempFd !== undefined) clean(() => fs.closeSync(tempFd))
    if (tempOwned) clean(() => fs.unlinkSync(temp))
    clean(() => fs.closeSync(lockFd))
    clean(() => fs.unlinkSync(lock))
  }
  if (failed) {
    if (cleanupErrors.length > 0 && failure instanceof Error) failure.cleanupErrors = cleanupErrors
    throw failure
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'could not clean dsh-best-ip state write artifacts')
}

export { FILE_NAME }
