// Dependency-free, offline release guard. Run with `npm run check:package`.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
export const RELEASE_FILES = [
  'LICENSE', 'README.md', 'bench.js', 'client.js', 'cordis.patch.yml',
  'icon.svg', 'index.js', 'locale/en.json', 'locale/zh.json', 'package.json',
  'probe.js', 'providers.js', 'store.js',
].sort()

export function verifyManifest(manifest) {
  assert.equal(manifest.name, 'dsh-best-ip')
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.equal(manifest.private, false, 'the package must be publishable')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.repository?.url, 'git+https://github.com/otsffs/dsh-best-ip.git')
  assert.equal(manifest.publishConfig?.access, 'public')
  assert.equal(manifest.publishConfig?.registry, 'https://registry.npmjs.org/')
  assert.ok(manifest.engines?.node && manifest.engines?.dsh, 'declare Node and DSH compatibility')
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.exports?.['.'], './index.js')
  assert.equal(manifest.exports?.['./client'], './client.js')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(manifest.scripts?.[hook], undefined, `unexpected install-time hook: ${hook}`)
  }
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, 'runtime dependencies must not silently grow')
}

export function verifyReleaseFiles(files) {
  const names = files.map((entry) => typeof entry === 'string' ? entry : entry.path).sort()
  assert.deepEqual(names, RELEASE_FILES, 'unexpected or missing files in the release package')
}

// These checks are deliberately generic: never copy a real private value into
// a negative test. They complement manual review, not a complete secret scanner.
export function privacyIssues(source) {
  const issues = []
  for (const [kind, pattern] of [
    ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
    ['provider token', /\bsk-[A-Za-z0-9_-]{24,}\b/],
    ['cloud access key', /\bAKIA[0-9A-Z]{16}\b/],
    ['personal Windows path', /\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+/i],
    ['personal POSIX path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  ]) {
    if (pattern.test(source)) issues.push(kind)
  }
  const publicHosts = new Set(['github.com', 'registry.npmjs.org', 'www.cloudflare.com', 'www.w3.org'])
  for (const match of source.matchAll(/https?:\/\/([a-z\d.-]+)(?=[/:\s'"`]|$)/gi)) {
    const host = match[1].toLowerCase()
    if (!publicHosts.has(host) && !host.endsWith('.test') && !host.endsWith('.invalid') && !host.endsWith('.example')) {
      issues.push('unreviewed literal URL host')
    }
  }
  return [...new Set(issues)]
}

function verifyContent() {
  for (const name of RELEASE_FILES) {
    const source = fs.readFileSync(path.join(root, name), 'utf8')
    assert.deepEqual(privacyIssues(source), [], `${name}: possible private material; inspect locally before publishing`)
  }
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: dsh-best-ip/)
  assert.match(patch, /name: dsh-best-ip/)
  assert.match(patch, /maxBenchmarkIps: 0/)
  assert.doesNotMatch(patch, /\b(?:providers|extraHosts|baseURL|apiKey|selected)\s*:/, 'bundle must not ship a personal route or pin')
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /^MIT License/)
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  verifyManifest(manifest)
  verifyContent()
  const npmCli = process.env.npm_execpath
  assert.ok(npmCli && fs.existsSync(npmCli), 'run this check through npm run check:package')
  // Ignore lifecycle scripts to avoid recursing from prepack, and stay offline.
  const result = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts', '--offline'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  })
  if (result.error) throw new Error('could not run the offline npm pack check', { cause: result.error })
  assert.equal(result.status, 0, `offline npm pack check failed (exit ${result.status})`)
  const report = JSON.parse(result.stdout)
  assert.equal(report.length, 1)
  verifyReleaseFiles(report[0].files)
  console.log(`Release verified: ${manifest.name}@${manifest.version}, ${report[0].files.length} allowlisted files, no install hooks.`)
  console.log('Dry-run only: nothing was installed, published or uploaded.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
