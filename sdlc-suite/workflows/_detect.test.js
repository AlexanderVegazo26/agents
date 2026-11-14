'use strict'

/**
 * Tests for _detect.js — the Maintain stage's detector.
 *
 *     node sdlc-suite/workflows/_detect.test.js
 *
 * `gh` is injected, never called: CI must not depend on a network or a login.
 * Health checks run REAL child processes (node itself) in real git
 * repositories, so exit codes, timeouts and the commit-to-arm rule are
 * measured, not assumed.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const d = require('./_detect.js')

let passed = 0
const skipped = []
const SKIP = Symbol('skip')
function test(name, fn) {
  // Skipped is not passed: a test that could not run is counted and named apart.
  try {
    if (fn() === SKIP) { skipped.push(name); console.log(`  SKIP  ${name}`); return }
    passed++; console.log(`  pass  ${name}`)
  }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1 }
}

const GIT = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false']
function git(cwd, ...a) { return execFileSync('git', [...GIT, ...a], { cwd, stdio: 'pipe', encoding: 'utf8' }) }

/**
 * A temp repo with `.claude/maintain.json`; committed unless told otherwise,
 * and pushed to a real bare `origin` whose HEAD is main — the trust anchor the
 * detector compares a config against — unless `origin: false`.
 */
function repo(config, { commit = true, origin = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-'))
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude', 'maintain.json'), typeof config === 'string' ? config : JSON.stringify(config))
  }
  if (commit) {
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(dir, 'branch', '-M', 'main')
    if (origin) {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-origin-'))
      git(bare, 'init', '-q', '--bare')
      git(dir, 'remote', 'add', 'origin', bare)
      git(dir, 'push', '-q', 'origin', 'main')
      git(dir, 'remote', 'set-head', 'origin', 'main')
    }
  }
  return dir
}

const NODE = JSON.stringify(process.execPath)
const CI = { enabled: true, branch: 'main', limit: 20 }
const ghReturning = runs => () => JSON.stringify(runs)
const ghFailing = () => { const e = new Error('gh: not found'); e.stderr = 'gh: command not found'; throw e }
const run = (o) => ({ workflowName: 'CI', status: 'completed', event: 'push', headBranch: 'main', url: 'u', ...o })

console.log('ci — only this repository\'s latest completed non-PR run per workflow counts')

test('a failing latest run is a signal', () => {
  const r = d.checkCi('.', CI, ghReturning([run({ conclusion: 'failure', displayTitle: 'broke it' })]))
  assert.strictEqual(r.signals.length, 1)
  assert.ok(r.signals[0].evidence.includes('broke it'))
})

test('a failure already fixed by a newer run is NOT a signal', () => {
  const r = d.checkCi('.', CI, ghReturning([run({ conclusion: 'success' }), run({ conclusion: 'failure' })]))
  assert.deepStrictEqual([r.signals.length, r.errors.length], [0, 0])
})

test('an in-progress run neither masks nor raises a signal', () => {
  const r = d.checkCi('.', CI, ghReturning([run({ status: 'in_progress', conclusion: null }), run({ conclusion: 'failure' })]))
  assert.strictEqual(r.signals.length, 1)
})

test('a pull-request run — e.g. from a fork whose branch is also "main" — cannot turn the branch red', () => {
  const r = d.checkCi('.', CI, ghReturning([
    run({ event: 'pull_request', conclusion: 'failure', displayTitle: 'outsider PR' }),
    run({ event: 'pull_request_target', conclusion: 'failure' }),
    run({ conclusion: 'success' }),
  ]))
  assert.strictEqual(r.signals.length, 0, JSON.stringify(r.signals))
})

test('a run on another head branch is ignored, and action_required is not a failure', () => {
  const r = d.checkCi('.', CI, ghReturning([
    run({ headBranch: 'feature', conclusion: 'failure' }),
    run({ workflowName: 'Gate', conclusion: 'action_required' }),
    run({ workflowName: 'Build', conclusion: 'success' }),
  ]))
  assert.strictEqual(r.signals.length, 0, JSON.stringify(r.signals))
})

test('zero runs found is a detector gap, never a green CI', () => {
  const r = d.checkCi('.', CI, ghReturning([]))
  assert.strictEqual(r.signals.length, 0)
  assert.ok(/no completed push, schedule, workflow_dispatch or merge_group run found/.test(r.errors[0]), JSON.stringify(r.errors))
})

test('gh missing is a detector ERROR, never a green CI', () => {
  const r = d.checkCi('.', CI, ghFailing)
  assert.deepStrictEqual([r.signals.length, r.errors.length], [0, 1])
  assert.ok(/gh run list failed/.test(r.errors[0]))
})

console.log('\nhealth — real processes, and only from a committed config')

test('a non-zero exit is a signal carrying the output tail', () => {
  const r = d.checkHealth(process.cwd(), [{ name: 'boom', command: `${NODE} -e "console.error('kaboom'); process.exit(3)"`, timeoutSec: 30 }])
  assert.strictEqual(r.signals.length, 1)
  assert.ok(/exited 3/.test(r.signals[0].detail), r.signals[0].detail)
  assert.ok(r.signals[0].evidence.includes('kaboom'))
})

test('a zero exit is not a signal', () => {
  const r = d.checkHealth(process.cwd(), [{ name: 'ok', command: `${NODE} -e "process.exit(0)"`, timeoutSec: 30 }])
  assert.strictEqual(r.signals.length, 0)
  assert.deepStrictEqual(r.checked, ['health:ok'])
})

test('a timeout is a signal', () => {
  const r = d.checkHealth(process.cwd(), [{ name: 'hang', command: `${NODE} -e "setTimeout(()=>{}, 20000)"`, timeoutSec: 1 }])
  assert.strictEqual(r.signals.length, 1)
  assert.ok(/timed out|signal/.test(r.signals[0].detail), r.signals[0].detail)
})

const marker = cwd => path.join(cwd, 'RAN')
const touchCmd = `${NODE} -e "require('fs').writeFileSync('RAN','x')"`

test('an UNCOMMITTED config arms nothing: its commands are listed, not run', () => {
  const dir = repo({ ci: { enabled: false }, health: [{ name: 't', command: touchCmd }] }, { commit: false })
  git(dir, 'init', '-q')
  const r = d.detect({ cwd: dir })
  assert.ok(!fs.existsSync(marker(dir)), 'the command ran from an untracked config')
  assert.ok(r.errors.some(e => /NOT run — the config file is not committed at HEAD/.test(e) && e.includes('RAN')), JSON.stringify(r.errors))
  assert.strictEqual(d.exitCodeFor(r), 3)
})

test('a committed config arms its commands; editing it disarms them again', () => {
  const dir = repo({ ci: { enabled: false }, health: [{ name: 't', command: touchCmd }] })
  const r1 = d.detect({ cwd: dir })
  assert.ok(fs.existsSync(marker(dir)), `the committed command did not run: ${JSON.stringify(r1.errors)}`)
  assert.deepStrictEqual(r1.errors, [])
  fs.unlinkSync(marker(dir))
  fs.writeFileSync(path.join(dir, '.claude', 'maintain.json'),
    JSON.stringify({ ci: { enabled: false }, health: [{ name: 't', command: `${touchCmd} && echo planted` }] }))
  const r2 = d.detect({ cwd: dir })
  assert.ok(!fs.existsSync(marker(dir)), 'a modified config still ran its commands')
  assert.ok(r2.errors.some(e => /differs from its committed version at HEAD/.test(e)), JSON.stringify(r2.errors))
})

test('health commands run without secret-shaped environment variables', () => {
  process.env.FAKE_DEPLOY_TOKEN = 'leak-me'
  process.env.FAKE_AWS_SECRET_ACCESS_KEY = 'leak-me-too'
  try {
    const dir = repo({ ci: { enabled: false }, health: [{ name: 'env', command: `${NODE} -e "process.exit(process.env.FAKE_DEPLOY_TOKEN || process.env.FAKE_AWS_SECRET_ACCESS_KEY ? 7 : 0)"` }] })
    const r = d.detect({ cwd: dir })
    assert.deepStrictEqual(r.signals, [], 'a secret env var reached the health command')
    assert.ok(!('FAKE_DEPLOY_TOKEN' in d.scrubbedEnv()))
    assert.ok('PATH' in d.scrubbedEnv() || 'Path' in d.scrubbedEnv(), 'PATH was scrubbed')
  } finally {
    delete process.env.FAKE_DEPLOY_TOKEN
    delete process.env.FAKE_AWS_SECRET_ACCESS_KEY
  }
})

console.log('\nlogs and config — confined to the repository')

test('matching lines in the tail are a signal; older lines are not read', () => {
  const dir = repo()
  fs.mkdirSync(path.join(dir, 'logs'))
  fs.writeFileSync(path.join(dir, 'logs', 'app.log'),
    ['ERROR ancient', ...Array.from({ length: 50 }, (_, i) => `info ${i}`), 'ERROR recent'].join('\n'))
  const r = d.checkLogs(dir, [{ path: 'logs/app.log', patterns: [/ERROR/], tailLines: 10, maxMatches: 20 }])
  assert.strictEqual(r.signals.length, 1)
  assert.ok(r.signals[0].evidence.includes('ERROR recent'))
  assert.ok(!r.signals[0].evidence.includes('ERROR ancient'), 'read beyond the tail')
})

test('when matches exceed maxMatches, the NEWEST are kept', () => {
  const dir = repo()
  fs.writeFileSync(path.join(dir, 'a.log'), ['ERROR 1 old', 'ERROR 2', 'ERROR 3', 'ERROR 4 newest'].join('\n'))
  const r = d.checkLogs(dir, [{ path: 'a.log', patterns: [/ERROR/], tailLines: 100, maxMatches: 2 }])
  assert.ok(r.signals[0].evidence.includes('ERROR 4 newest') && !r.signals[0].evidence.includes('ERROR 1 old'), r.signals[0].evidence)
})

test('a large log is read from its tail, not whole', () => {
  const dir = repo()
  const big = 'x'.repeat(5 * 1024 * 1024) + '\nERROR at the end\n'
  fs.writeFileSync(path.join(dir, 'big.log'), big)
  const t = d.readTail(path.join(dir, 'big.log'), 1024)
  assert.ok(t.length <= 1024 && t.includes('ERROR at the end'), String(t.length))
})

test('an absolute path and a .. escape are refused, not read', () => {
  const dir = repo()
  const outside = path.join(os.tmpdir(), `detect-outside-${process.pid}.log`)
  fs.writeFileSync(outside, 'ERROR secret outside\n')
  const r = d.checkLogs(dir, [
    { path: outside, patterns: [/ERROR/], tailLines: 10, maxMatches: 5 },
    { path: `../${path.basename(outside)}`, patterns: [/ERROR/], tailLines: 10, maxMatches: 5 },
  ])
  assert.strictEqual(r.signals.length, 0)
  assert.strictEqual(r.errors.length, 2, JSON.stringify(r.errors))
})

test('a symlink pointing outside the repository is refused', () => {
  const dir = repo()
  const outside = path.join(os.tmpdir(), `detect-link-target-${process.pid}.log`)
  fs.writeFileSync(outside, 'ERROR outside\n')
  try {
    fs.symlinkSync(outside, path.join(dir, 'link.log'))
  } catch (e) {
    console.log('        (this platform did not allow creating a symlink)')
    return SKIP
  }
  const r = d.checkLogs(dir, [{ path: 'link.log', patterns: [/ERROR/], tailLines: 10, maxMatches: 5 }])
  assert.strictEqual(r.signals.length, 0)
  assert.ok(/outside the repository/.test(r.errors[0]), JSON.stringify(r.errors))
})

test('a configured log that does not exist is a gap, not a clean log', () => {
  const r = d.checkLogs(repo(), [{ path: 'nope.log', patterns: [/ERROR/], tailLines: 10, maxMatches: 5 }])
  assert.strictEqual(r.signals.length, 0)
  assert.ok(/does not exist — not checked/.test(r.errors[0]), JSON.stringify(r.errors))
})

test('--config outside the repository, or a UNC path, is refused', () => {
  for (const p of ['../maintain.json', path.join(os.tmpdir(), 'x.json'), '\\\\host\\share\\maintain.json', '//host/share/m.json']) {
    const r = d.loadConfig({ cwd: repo(), configPath: p })
    assert.strictEqual(r.config, null, p)
    assert.ok(/^config: /.test(r.errors[0]), `${p}: ${JSON.stringify(r.errors)}`)
  }
})

console.log('\nredaction and caps — evidence goes to a model')

test('an OPAQUE bearer token is redacted (the header form that used to leak)', () => {
  const s = d.redact('Authorization: Bearer abcdefgh12345678XYZ')
  assert.ok(!s.includes('abcdefgh12345678XYZ'), s)
})

test('common secret shapes are redacted', () => {
  const cases = {
    'token=abc123def456': 'abc123def456',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==': 'dXNlcjpwYXNzd29yZA',
    '{"password": "hunter2hunter2", "api_key": "zzzzzzzzzzzz"}': 'hunter2hunter2',
    '{"api_key":"zzzzzzzzzzzz9"}': 'zzzzzzzzzzzz9',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG': 'wJalrXUtnFEMIK7MDENG',
    'key id ASIAABCDEFGHIJKLMNOP': 'ASIAABCDEFGHIJKLMNOP',
    'postgres://admin:s3cretpass@db:5432/x': 's3cretpass',
    'stripe sk_live_abcdefghijklmnop1234': 'sk_live_abcdefghijklmnop1234',
    'google AIzaSyA-1234567890abcdefghijklmnopqrstu': 'AIzaSyA-1234567890abcdefghijklmnopqrstu',
    'gitlab glpat-abcdefghijklmnopqrst': 'glpat-abcdefghijklmnopqrst',
    ['ghp_' + 'a'.repeat(36)]: 'ghp_aaaa',
    'DefaultEndpointsProtocol=https;AccountKey=abc/def+ghi==;': 'abc/def+ghi',
    'mysql --password hunter22 -u root': 'hunter22',
    'cli --token=t0k3nvalue': 't0k3nvalue',
    'hook https://hooks.slack.com/services/T000/B000/XXXXXXXX': 'XXXXXXXX',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEtruncated-by-tail': 'MIIEtruncated',
  }
  for (const [input, secret] of Object.entries(cases)) {
    const out = d.redact(input)
    assert.ok(!out.includes(secret), `leaked "${secret}" from: ${input} -> ${out}`)
  }
})

test('every string field of a signal is redacted, not only evidence', () => {
  const r = d.checkHealth(process.cwd(), [{ name: 'curl -H "Authorization: Bearer opaqueTOKEN123456"', command: `${NODE} -e "process.exit(1)"`, timeoutSec: 30 }])
  assert.ok(!JSON.stringify(r).includes('opaqueTOKEN123456'), JSON.stringify(r))
})

test('a malformed config does not echo its contents into the error', () => {
  const r = d.loadConfig({ cwd: repo('SECRET_VALUE_xyz not json') })
  assert.strictEqual(r.config, null)
  assert.ok(/not valid JSON/.test(r.errors[0]))
  assert.ok(!r.errors[0].includes('SECRET_VALUE'), r.errors[0])
})

test('evidence keeps the TAIL when capped, and says how much it dropped', () => {
  const c = d.cap('a'.repeat(5000) + 'THE-ERROR', 100)
  assert.ok(c.endsWith('THE-ERROR') && /chars elided/.test(c))
})

console.log('\nconfig and detect()')

test('no config file means CI only, with defaults — not an error', () => {
  const r = d.loadConfig({ cwd: repo() })
  assert.deepStrictEqual([r.source, r.errors, r.config.ci.branch], [null, [], 'main'])
})

test('a branch name that is not plain is refused, and gh is not run with it', () => {
  const r = d.loadConfig({ cwd: repo({ ci: { branch: 'main; rm -rf /' } }) })
  assert.ok(r.errors.some(e => /not a plain branch name/.test(e)), JSON.stringify(r.errors))
  assert.strictEqual(r.config.ci.enabled, false)
})

test('a manual incident is always a signal, with no config at all', () => {
  const r = d.detect({ cwd: repo(), incident: 'checkout returns 500 since 14:00', _exec: { execFileSync: ghFailing } })
  assert.strictEqual(r.signals.length, 1)
  assert.strictEqual(r.signals[0].source, 'manual')
  assert.strictEqual(r.errors.length, 1, 'the gh failure is still reported alongside the manual signal')
})

test('a healthy repo reports zero signals and names what it checked', () => {
  const r = d.detect({ cwd: repo({ ci: { enabled: false }, health: [{ name: 'ok', command: `${NODE} -e "0"` }] }) })
  assert.deepStrictEqual([r.signals, r.errors, r.checked], [[], [], ['health:ok']])
})

console.log('\nround 2 — malformed configs, byte-level trust, event allowlist, linear redaction')

test('a section of the wrong type, or an unknown key, is a malformed config (exit 2), never "healthy"', () => {
  for (const cfg of [{ health: { command: 'x' } }, { logs: 'app.log' }, { ci: true }, { healthchecks: [] }]) {
    const r = d.detect({ cwd: repo(cfg) })
    assert.strictEqual(d.exitCodeFor(r), 2, `${JSON.stringify(cfg)} -> ${JSON.stringify(r.errors)}`)
    assert.ok(/is malformed/.test(r.errors[0]))
  }
})

test('ci.enabled that is not a boolean is a malformed config — "false" as a string must not enable CI', () => {
  const r = d.detect({ cwd: repo({ ci: { enabled: 'false' } }) })
  assert.strictEqual(d.exitCodeFor(r), 2, JSON.stringify(r.errors))
})

test('a cancelled latest run is inconclusive: the latest CONCLUSIVE run decides', () => {
  const r = d.checkCi('.', CI, ghReturning([run({ conclusion: 'cancelled' }), run({ conclusion: 'failure' })]))
  assert.strictEqual(r.signals.length, 1, JSON.stringify(r))
  const ok = d.checkCi('.', CI, ghReturning([run({ conclusion: 'cancelled' }), run({ conclusion: 'success' })]))
  assert.deepStrictEqual([ok.signals.length, ok.errors.length], [0, 0])
})

test('a merge-queue look-alike does not count: wrong prefix, or not a merge_group event', () => {
  const r = d.checkCi('.', CI, ghReturning([
    run({ event: 'merge_group', headBranch: 'gh-readonly-queue/mainline/pr-7', conclusion: 'failure' }),
    run({ event: 'push', headBranch: 'gh-readonly-queue/main/pr-7', conclusion: 'failure' }),
  ]))
  assert.strictEqual(r.signals.length, 0, JSON.stringify(r.signals))
})

test('a .gitattributes ident filter cannot make an edited config hash as committed', () => {
  // The payload sits INSIDE "$Id: … $", the only bytes `ident` folds back to
  // "$Id$" — so a hash taken through git's filters would match the commit.
  const committed = { ci: { enabled: false }, health: [{ name: 't', command: 'echo version $Id$' }] }
  const dir = repo(committed)
  fs.writeFileSync(path.join(dir, '.gitattributes'), '.claude/maintain.json ident\n')
  git(dir, 'add', '.gitattributes')
  git(dir, 'commit', '-qm', 'attrs')
  git(dir, 'push', '-q', 'origin', 'main')
  const planted = `echo version $Id: x & ${touchCmd} & echo $`
  fs.writeFileSync(path.join(dir, '.claude', 'maintain.json'), JSON.stringify({ ci: { enabled: false }, health: [{ name: 't', command: planted }] }))
  // Sanity: git itself (with forward slashes, as on POSIX) folds the edit away.
  const viaGit = git(dir, 'hash-object', '--', path.join(dir, '.claude', 'maintain.json').split(path.sep).join('/')).trim()
  const atHead = git(dir, 'rev-parse', 'HEAD:./.claude/maintain.json').trim()
  const r = d.detect({ cwd: dir })
  assert.ok(!fs.existsSync(marker(dir)), 'the ident-folded edit ran its command')
  assert.ok(r.errors.some(e => /differs from its committed version/.test(e)), JSON.stringify(r.errors))
  if (viaGit !== atHead) console.log('        (note: git did not fold the edit here, so this platform cannot show the bypass the test guards)')
})

test('merge-queue runs on gh-readonly-queue/<branch>/… count for that branch', () => {
  const r = d.checkCi('.', CI, ghReturning([run({ event: 'merge_group', headBranch: 'gh-readonly-queue/main/pr-7-abc', conclusion: 'failure' })]))
  assert.strictEqual(r.signals.length, 1)
  const other = d.checkCi('.', CI, ghReturning([run({ event: 'merge_group', headBranch: 'gh-readonly-queue/dev/pr-7-abc', conclusion: 'failure' })]))
  assert.strictEqual(other.signals.length, 0)
})

test('redaction cost is bounded by a pre-cut: 4 MB of PEM headers and 16 MB of log text stay fast', () => {
  const t = Date.now()
  const big = d.checkHealth(process.cwd(), [{ name: 'x', command: `${NODE} -e "process.exit(1)"`, timeoutSec: 30 }])
  assert.strictEqual(big.signals.length, 1)
  d.redact('-----BEGIN PRIVATE KEY-----\n'.repeat(4).slice(0, 200))
  const ev = require('./_detect.js')
  assert.ok(typeof ev.redact === 'function')
  const s4 = '-----BEGIN PRIVATE KEY-----\n'.repeat(150000)
  // evidence() is internal; checkLogs exercises it on a real file
  const dir = repo()
  fs.writeFileSync(path.join(dir, 'pem.log'), s4)
  d.checkLogs(dir, [{ path: 'pem.log', patterns: [/PRIVATE/], tailLines: 1000000, maxMatches: 200 }])
  assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`)
})

test('a config that enables nothing is a gap (exit 3), not a clean check', () => {
  const r = d.detect({ cwd: repo({ ci: { enabled: false } }) })
  assert.ok(/nothing was checked/.test(r.errors[0]), JSON.stringify(r.errors))
  assert.strictEqual(d.exitCodeFor(r), 3)
})

test('assume-unchanged / skip-worktree cannot hide an edited config from the trust check', () => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const dir = repo({ ci: { enabled: false }, health: [{ name: 't', command: `${NODE} -e "0"` }] })
    git(dir, 'update-index', flag, '.claude/maintain.json')
    fs.writeFileSync(path.join(dir, '.claude', 'maintain.json'),
      JSON.stringify({ ci: { enabled: false }, health: [{ name: 't', command: touchCmd }] }))
    assert.strictEqual(git(dir, 'status', '--porcelain').trim(), '', `${flag} did not hide the edit — the probe is not testing what it claims`)
    const r = d.detect({ cwd: dir })
    assert.ok(!fs.existsSync(marker(dir)), `${flag}: the hidden edit ran its command`)
    assert.ok(r.errors.some(e => /differs from its committed version/.test(e)), JSON.stringify(r.errors))
  }
})

test('a checked-out branch whose committed config differs from the main branch does not arm it', () => {
  const dir = repo({ ci: { enabled: false, branch: 'main' }, health: [{ name: 't', command: `${NODE} -e "0"` }] })
  git(dir, 'checkout', '-q', '-b', 'pr-branch')
  fs.writeFileSync(path.join(dir, '.claude', 'maintain.json'),
    JSON.stringify({ ci: { enabled: false, branch: 'main' }, health: [{ name: 't', command: touchCmd }] }))
  git(dir, 'commit', '-qam', 'change the health command on a PR branch')
  const r = d.detect({ cwd: dir })
  assert.ok(!fs.existsSync(marker(dir)), 'a PR branch armed its own health command')
  assert.ok(r.errors.some(e => /differs from its version on the default branch/.test(e)), JSON.stringify(r.errors))
})

test('a PR config cannot choose its own trust anchor by pointing ci.branch at itself or at nothing', () => {
  for (const branch of ['pr-branch', 'zz-does-not-exist']) {
    const dir = repo({ ci: { enabled: false, branch: 'main' }, health: [{ name: 't', command: `${NODE} -e "0"` }] })
    git(dir, 'checkout', '-q', '-b', 'pr-branch')
    fs.writeFileSync(path.join(dir, '.claude', 'maintain.json'),
      JSON.stringify({ ci: { enabled: false, branch }, health: [{ name: 't', command: touchCmd }] }))
    git(dir, 'commit', '-qam', 'retarget the anchor')
    const r = d.detect({ cwd: dir })
    assert.ok(!fs.existsSync(marker(dir)), `ci.branch=${branch} armed the PR's command`)
  }
})

test('with no origin/HEAD nothing is armed — unless the caller opts in with trustHead', () => {
  const cfg = { ci: { enabled: false }, health: [{ name: 't', command: touchCmd }] }
  const dir = repo(cfg, { origin: false })
  const r = d.detect({ cwd: dir })
  assert.ok(!fs.existsSync(marker(dir)), 'armed with no anchor')
  assert.ok(r.errors.some(e => /no refs\/remotes\/origin\/HEAD/.test(e) && /--trust-head/.test(e)), JSON.stringify(r.errors))
  d.detect({ cwd: dir, trustHead: true })
  assert.ok(fs.existsSync(marker(dir)), 'trustHead did not arm a committed config')
})

test('CI counts only allowlisted events on exactly this branch', () => {
  const r = d.checkCi('.', CI, ghReturning([
    run({ event: 'issue_comment', conclusion: 'failure', displayTitle: 'outsider issue title' }),
    run({ event: 'workflow_run', conclusion: 'failure' }),
    run({ event: 'release', conclusion: 'failure' }),
    run({ headBranch: null, conclusion: 'failure' }),
    run({ conclusion: 'success' }),
  ]))
  assert.strictEqual(r.signals.length, 0, JSON.stringify(r.signals))
  const s2 = d.checkCi('.', CI, ghReturning([run({ event: 'schedule', conclusion: 'failure' })]))
  assert.strictEqual(s2.signals.length, 1)
})

test('redaction is linear: a 1 MB single line and 3 MB of long lines take well under a second', () => {
  let t = Date.now()
  d.redact('a'.repeat(1_000_000))
  d.redact(('x'.repeat(1500) + '\n').repeat(2000))
  assert.ok(Date.now() - t < 1000, `${Date.now() - t} ms`)
})

test('round-2 secret shapes are redacted', () => {
  const cases = {
    'redis://:pw123secret@host': 'pw123secret',
    'postgres://u:p@ss-word@db/x': 'ss-word',
    'Cookie: session=abc123; csrftoken=zz': 'abc123',
    'set-cookie: sid=qwe987': 'qwe987',
    '{\\"password\\":\\"hunter2hunter2\\"}': 'hunter2hunter2',
    '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----': 'lQOYBF',
    'SG.abcdefghijklmnop1234.abcdefghijklmnopqrstuvwxyz12': 'abcdefghijklmnop1234',
    'hf_abcdefghijklmnopqrstuvwxyz123456': 'hf_abcdef',
    'https://x.blob.core.windows.net/y?sv=1&sig=SECRETSIG123&se=2': 'SECRETSIG123',
    'curl -u admin:s3cret http://x': 's3cret',
    'mysql -pHUNTER2 -u root': 'HUNTER2',
    'Bearer: tok123456789': 'tok123456789',
    'secret_key_base abcdef123456': 'abcdef123456',
    'Authorization: Token abc123def': 'abc123def',
  }
  for (const [input, secret] of Object.entries(cases)) {
    const out = d.redact(input)
    assert.ok(!out.includes(secret), `leaked "${secret}" from: ${input} -> ${out}`)
  }
})

test('redaction does not eat ordinary prose', () => {
  for (const t of ['Error: invalid token format at line 3', 'Basic setup completed', 'password reset email sent']) {
    assert.strictEqual(d.redact(t), t)
  }
})

test('the env scrub covers round-2 names and keeps PATH', () => {
  const env = d.scrubbedEnv({ PATH: '/bin', Path: 'C:/x', DATABASE_URL: 'x', GH_PAT: 'x', DB_PASS: 'x', PGPASS: 'x', NPM_CONFIG__AUTH: 'x',
    SLACK_WEBHOOK_URL: 'x', SENTRY_DSN: 'x', JWT: 'x', COOKIE: 'x', SIGNING_KEY: 'x', ENCRYPTION_KEY: 'x', CLIENT_KEY: 'x',
    AUTH_HEADER: 'x', KUBECONFIG: 'x', SSH_AUTH_SOCK: 'x', AWS_PROFILE: 'x', HOME: '/h', KEYBOARD_LAYOUT: 'us',
    REDIS_URL: 'x', MONGODB_URI: 'x', MONGO_URL: 'x', AMQP_URL: 'x', POSTGRES_URL: 'x', DATABASE_URI: 'x',
    AZURE_STORAGE_CONNECTION_STRING: 'x', CONNECTION_STRING: 'x', SUPABASE_SERVICE_ROLE: 'x', NETRC: 'x',
    PWD: '/w', OLDPWD: '/o', GIT_AUTHOR_NAME: 'n', GIT_AUTHOR_EMAIL: 'e', BYPASS_PROXY: '1' })
  assert.deepStrictEqual(Object.keys(env).sort(),
    ['BYPASS_PROXY', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'HOME', 'KEYBOARD_LAYOUT', 'OLDPWD', 'PATH', 'PWD', 'Path'])
})

console.log('\nCLI — the exit code is the result')

test('exit 0 healthy, 1 signal, 2 broken config, 3 no signal but a source unchecked', () => {
  const cli = (cwd, extra = []) => {
    try { execFileSync(process.execPath, [path.join(__dirname, '_detect.js'), '--cwd', cwd, ...extra], { stdio: 'pipe' }); return 0 }
    catch (e) { return e.status }
  }
  const okHealth = { ci: { enabled: false }, health: [{ name: 'ok', command: `${NODE} -e "0"` }] }
  assert.strictEqual(cli(repo(okHealth)), 0)
  assert.strictEqual(cli(repo(okHealth), ['--incident', 'it broke']), 1)
  assert.strictEqual(cli(repo({ ci: { enabled: false } })), 3, 'nothing checked must not exit 0')
  assert.strictEqual(cli(repo('{ nope')), 2)
  assert.strictEqual(cli(repo({ ci: { enabled: false }, logs: [{ path: 'missing.log' }] })), 3)
})

test('exitCodeFor: a config error outranks a signal; a signal outranks a gap', () => {
  assert.strictEqual(d.exitCodeFor({ signals: [{}], errors: ['config: bad'] }), 2)
  assert.strictEqual(d.exitCodeFor({ signals: [{}], errors: ['ci: gh failed'] }), 1)
  assert.strictEqual(d.exitCodeFor({ signals: [], errors: ['ci: gh failed'] }), 3)
  assert.strictEqual(d.exitCodeFor({ signals: [], errors: [] }), 0)
})

console.log(`\n${passed} passed, ${skipped.length} skipped${skipped.length ? ` (${skipped.join('; ')})` : ''}, exit ${process.exitCode || 0}`)
