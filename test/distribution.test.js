// Pure release contracts: no npm install/publish or live DSH is involved.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { RELEASE_FILES, verifyManifest, verifyReleaseFiles, privacyIssues } from '../scripts/check-package.mjs'

const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('manifest is a public MIT DSH bundle with ready-to-load server/client artifacts', () => {
  verifyManifest(manifest)
  assert.match(fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'), /^MIT License/)
  for (const file of RELEASE_FILES) assert.ok(fs.statSync(new URL(`../${file}`, import.meta.url)).isFile(), file)
  assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'), false)
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
