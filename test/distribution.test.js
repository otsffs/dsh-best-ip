// Pure release contracts: no npm install/publish or live DSH is involved.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { RELEASE_FILES, verifyManifest, verifyReleaseFiles, privacyIssues } from '../scripts/check-package.mjs'

const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('manifest is a public MIT DSH bundle with ready-to-load server/client artifacts', () => {
  verifyManifest(manifest)
  assert.match(fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'), /^MIT License/)
  for (const file of RELEASE_FILES) assert.ok(fs.statSync(new URL(`../${file}`, import.meta.url)).isFile(), file)
  assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'), false)
})

test('DSH compatibility starts at rc.1 and imposes no future-version ceiling', () => {
  assert.equal(manifest.engines.dsh, '>=0.2.1-rc.1')
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(readme.includes('`>=0.2.1-rc.1`'))
})

test('DSH prerelease boundaries accept rc.1/rc.2 and newer hosts but reject older releases', { skip: !process.env.npm_execpath }, () => {
  // npm already supplies semver; use its real comparator instead of inventing
  // a test-only version parser or adding a production dependency.
  const semver = createRequire(process.env.npm_execpath)('semver')
  for (const version of ['0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.10', '0.2.1', '0.2.2', '0.3.0', '1.0.0']) {
    assert.equal(semver.satisfies(version, manifest.engines.dsh, { includePrerelease: true }), true, version)
  }
  for (const version of ['0.2.0', '0.2.1-alpha.9', '0.2.1-beta.9', '0.2.1-rc.0']) {
    assert.equal(semver.satisfies(version, manifest.engines.dsh, { includePrerelease: true }), false, version)
  }
})

test('publication guard rejects private packages, wrong bundle entries and install-time hooks', () => {
  for (const change of [
    { private: true }, { license: undefined }, { main: 'missing.js' },
    { dsh: { ...manifest.dsh, bundle: { patch: 'missing.yml' } } },
    { scripts: { ...manifest.scripts, postinstall: 'unexpected-command' } },
    { dependencies: { 'unexpected-package': '*' } },
  ]) assert.throws(() => verifyManifest({ ...manifest, ...change }))
})

test('release file allowlist excludes tests, tooling, profiles, credentials and generated artifacts', () => {
  verifyReleaseFiles(RELEASE_FILES.map((path) => ({ path })))
  for (const extra of ['test/privacy.test.js', '.env', '.npmrc', '.git/config', 'state.json', 'profiles/current.json', 'dist/release.tgz', 'scripts/check-package.mjs']) {
    assert.throws(() => verifyReleaseFiles([...RELEASE_FILES, extra]), extra)
  }
  assert.throws(() => verifyReleaseFiles(RELEASE_FILES.filter((name) => name !== 'client.js')))
})

test('generic privacy rules detect synthetic secrets without retaining any real private value', () => {
  for (const value of [
    '-----BEGIN ' + 'PRIVATE KEY-----',
    'ghp_' + 'A'.repeat(36), 'sk-' + 'b'.repeat(32), 'AKIA' + 'C'.repeat(16),
    ['C:', 'Users', 'example', 'private.js'].join('\\'),
    ['', 'home', 'example', 'private.js'].join('/'),
    'https://' + 'unreviewed-service.example.org/v1',
  ]) assert.ok(privacyIssues(value).length > 0)
  for (const value of [
    'https://api.example.test/v1', 'https://private.invalid/fixture',
    'https://github.com/otsffs/dsh-best-ip', 'https://registry.npmjs.org/',
    'apiKey: fake-key; PUBLIC_DNS=1.1.1.1',
  ]) assert.deepEqual(privacyIssues(value), [])
})

test('release content has no detected secrets, author paths or unreviewed literal URL hosts', () => {
  for (const file of RELEASE_FILES) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.deepEqual(privacyIssues(source), [], `${file}: review possible private material locally`)
  }
})

test('Git ignore rules keep local authentication and measurement files out of source control', () => {
  const rules = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split(/\r?\n/)
  for (const rule of ['node_modules/', '.env', '.env.*', '.npmrc', 'state.json', 'profiles/', '*.tgz', '*.log']) assert.ok(rules.includes(rule), rule)
  assert.ok(!rules.includes('cordis.patch.yml'), 'the install layer is source, not local state')
})
