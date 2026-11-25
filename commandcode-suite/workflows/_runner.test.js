#!/usr/bin/env node
'use strict'
/**
 * Tests for the commandcode-suite runner's worktree isolation, and an
 * end-to-end run of sdlc-feature.js against a fake `cmdc`.
 *
 *     node commandcode-suite/workflows/_runner.test.js
 *
 * No framework; the exit code is the result. No network, no LLM: CMDC_BIN
 * points at a stub that plays every agent from the task text.
 *
 * What it pins (each seen red against the code before 2026-11-13, where the
 * worktree was detached and force-removed with nothing preserved):
 *  - a builder's edits survive the worktree's removal, as a commit on a branch;
 *  - the verifiers (code-reviewer, qa-engineer, security, performance) and the
 *    readiness agents run in a tree that CONTAINS the change;
 *  - the caller's working tree is never modified, and no worktree is leaked.
 *
 * And runAgent's fail-closed contract: a session that exits non-zero or is
 * killed at its timeout yields null even when it printed something (before
 * 2026-11-13 any stdout was returned as a schema-less agent's answer).
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { withWorktree, mergeBranches, runAgent } = require('./_runner')

const failures = []
function check(name, cond, detail = '') {
  if (cond) console.log(`ok   ${name}`)
  else {
    failures.push(name)
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false']
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { status: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() }
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdcode-runner-test-'))
  git(['init', '-q', '-b', 'main'], dir)
  fs.writeFileSync(path.join(dir, 'README'), 'base\n')
  git(['add', '-A'], dir)
  git([...IDENT, 'commit', '-q', '-m', 'base'], dir)
  return dir
}

// A clean HOME without a git identity, so the runner's own fallback identity
// is what lets the preservation commit succeed (as on a fresh CI machine).
const bareHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdcode-runner-home-'))
process.env.HOME = bareHome
process.env.GIT_CONFIG_NOSYSTEM = '1'
delete process.env.GIT_AUTHOR_NAME
delete process.env.GIT_AUTHOR_EMAIL
delete process.env.GIT_COMMITTER_NAME
delete process.env.GIT_COMMITTER_EMAIL

async function unitTests() {
  const repo = makeRepo()
  const base = git(['rev-parse', 'HEAD'], repo).out

  // 1. A callback's edits survive as a commit on a kept branch.
  let seenDir = null
  const run = await withWorktree(async (dir, { isolated }) => {
    seenDir = dir
    fs.writeFileSync(path.join(dir, 'new.txt'), 'built\n')
    fs.appendFileSync(path.join(dir, 'README'), 'edited\n')
    return { isolated }
  }, { cwd: repo, label: 'build-backend' })
  check('callback value comes back under `value`', run.value && run.value.isolated === true, JSON.stringify(run))
  check('the run reports a change and a branch', run.changed === true && typeof run.branch === 'string', JSON.stringify(run))
  check('the worktree directory is removed', seenDir && !fs.existsSync(seenDir))
  check('the branch holds the new file', git(['show', `${run.branch}:new.txt`], repo).out === 'built')
  check('the branch holds the edit', git(['show', `${run.branch}:README`], repo).out === 'base\nedited')
  check('the branch starts at the base commit', git(['merge-base', base, run.branch], repo).out === base)
  check("the caller's tree is untouched", !fs.existsSync(path.join(repo, 'new.txt')) && git(['status', '--porcelain'], repo).out === '')
  check('no worktree is left registered', git(['worktree', 'list', '--porcelain'], repo).out.split('\n').filter(l => l.startsWith('worktree ')).length === 1)

  // 2. A builder that commits its own work is preserved the same way.
  const selfCommit = await withWorktree(async dir => {
    fs.writeFileSync(path.join(dir, 'own.txt'), 'own\n')
    git(['add', '-A'], dir)
    git([...IDENT, 'commit', '-q', '-m', 'own'], dir)
    return 'done'
  }, { cwd: repo, label: 'build-frontend' })
  check('a self-committed change is kept on its branch', selfCommit.changed === true && git(['show', `${selfCommit.branch}:own.txt`], repo).out === 'own')

  // 3. No change: no branch is left behind.
  const before = git(['branch', '--list'], repo).out
  const idle = await withWorktree(async () => 'nothing', { cwd: repo, label: 'build-idle' })
  check('an unchanged run reports changed=false and no branch', idle.changed === false && idle.branch === null, JSON.stringify(idle))
  check('an unchanged run deletes its branch', git(['branch', '--list'], repo).out === before)

  // 4. A callback that throws leaves its worktree in place (never destroyed unpreserved).
  let thrownDir = null
  let threw = false
  try {
    await withWorktree(async dir => {
      thrownDir = dir
      fs.writeFileSync(path.join(dir, 'half.txt'), 'half\n')
      throw new Error('builder crashed')
    }, { cwd: repo, label: 'build-crash' })
  } catch (e) {
    threw = /builder crashed/.test(e.message)
  }
  check('a throwing callback propagates its error', threw)
  check('a throwing callback leaves its worktree and work in place', thrownDir && fs.existsSync(path.join(thrownDir, 'half.txt')))
  if (thrownDir) git(['worktree', 'remove', '--force', thrownDir], repo)

  // 5. Merging builder branches: clean merges land, a conflict aborts cleanly.
  const a = await withWorktree(async dir => { fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n') }, { cwd: repo, label: 'm-a' })
  const b = await withWorktree(async dir => { fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n') }, { cwd: repo, label: 'm-b' })
  const c = await withWorktree(async dir => { fs.writeFileSync(path.join(dir, 'a.txt'), 'conflict\n') }, { cwd: repo, label: 'm-c' })
  const integ = await withWorktree(async dir => {
    const ok = mergeBranches(dir, [a.branch, b.branch])
    const both = fs.existsSync(path.join(dir, 'a.txt')) && fs.existsSync(path.join(dir, 'b.txt'))
    const bad = mergeBranches(dir, [c.branch])
    const clean = git(['status', '--porcelain'], dir).out === ''
    return { ok, both, bad, clean }
  }, { cwd: repo, label: 'integration' })
  check('clean branches merge into one tree', integ.value.ok.ok === true && integ.value.both)
  check('a conflicting branch is refused by name', integ.value.bad.ok === false && integ.value.bad.branch === c.branch)
  check('a refused merge is aborted, leaving a clean tree', integ.value.clean)

  // 6. Outside a git repository the helper degrades and says so.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdcode-runner-plain-'))
  const deg = await withWorktree(async (dir, { isolated }) => ({ dir, isolated }), { cwd: plain, label: 'plain' })
  check('outside git the callback runs in place, unisolated', deg.isolated === false && deg.value.dir === plain && deg.value.isolated === false && /not a git repo/.test(deg.note))

  fs.rmSync(plain, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
}

// The fake cmdc: plays each agent from its task text. Builders write
// feature.txt into their working directory; every other agent records
// whether feature.txt is present in its own.
const FAKE_CMDC = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const prompt = process.argv[process.argv.indexOf('-p') + 1] || ''
const task = prompt.slice(prompt.indexOf('===== TASK ====='))
const cwd = process.cwd()
if (process.env.FAKE_MODE === 'fail-with-output') { process.stdout.write('partial output before the crash'); process.exit(3) }
if (process.env.FAKE_MODE === 'hang') { process.stdout.write('partial'); setInterval(() => {}, 1000); return }
if (process.env.FAKE_MODE === 'ok') { process.stdout.write('a real answer'); process.exit(0) }
const record = (role) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ role, cwd, seen: fs.existsSync(path.join(cwd, 'feature.txt')) }) + '\\n')
if (task.includes('Convert this initiative into implementation-ready requirements')) {
  // Fenced: extractJson() takes the LAST '{' of unfenced output, which for
  // nested JSON is an inner object.
  process.stdout.write('\\x60\\x60\\x60json\\n' + JSON.stringify({ criteria: [{ id: 'AC-1', text: 'feature.txt exists' }], assumptions: [], openQuestions: [], surfaces: ['backend'] }) + '\\n\\x60\\x60\\x60')
} else if (task.includes('Assess the architecture')) {
  process.stdout.write('Tier 1.')
} else if (task.includes('Implement the backend')) {
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'the feature\\n')
  process.stdout.write('Wrote feature.txt (AC-1).')
} else if (task.includes('Assess release readiness')) {
  record('release-manager'); process.stdout.write('Go, pending human confirmation.')
} else if (task.includes('Draft the user-facing documentation')) {
  record('technical-writer'); process.stdout.write('Docs.')
} else if (task.includes('Review by reading')) {
  record('code-reviewer'); process.stdout.write(JSON.stringify({ verdict: 'ok', findings: [] }))
} else if (task.includes('Verify by executing')) {
  record('qa-engineer'); process.stdout.write(JSON.stringify({ verdict: 'ok', findings: [] }))
} else if (task.includes('Review mode')) {
  record('security-engineer'); process.stdout.write(JSON.stringify({ verdict: 'ok', findings: [] }))
} else if (task.includes('Trace the target')) {
  record('performance-engineer'); process.stdout.write(JSON.stringify({ verdict: 'ok', findings: [] }))
} else {
  process.stdout.write('unrecognised task')
}
`

function endToEnd() {
  const repo = makeRepo()
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdcode-fake-cmdc-'))
  const stub = path.join(stubDir, 'cmdc')
  fs.writeFileSync(stub, FAKE_CMDC, { mode: 0o755 })
  const logFile = path.join(stubDir, 'agents.jsonl')
  fs.writeFileSync(logFile, '')
  const r = spawnSync(process.execPath, [path.join(__dirname, 'sdlc-feature.js'), 'write feature.txt'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CMDC_BIN: stub, FAKE_LOG: logFile, CMDC_MODEL: '' },
    timeout: 120000,
  })
  check('sdlc-feature exits 0 against the fake cmdc', r.status === 0, (r.stderr || '').slice(-800))
  let report = null
  try { report = JSON.parse(r.stdout) } catch { /* reported below */ }
  check('sdlc-feature prints a JSON report', report && report.initiative === 'write feature.txt', (r.stdout || '').slice(0, 400))
  const seen = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const roles = new Set(seen.map(s => s.role))
  check('every verifier and readiness agent ran', ['code-reviewer', 'qa-engineer', 'security-engineer', 'performance-engineer', 'release-manager', 'technical-writer'].every(x => roles.has(x)), JSON.stringify([...roles]))
  check('every verifier ran in a tree containing the change', seen.length > 0 && seen.every(s => s.seen), JSON.stringify(seen))
  check('no verifier ran in the caller\'s tree', seen.every(s => path.resolve(s.cwd) !== path.resolve(repo)))
  const branch = report && report.change && report.change.branch
  check('the report names the branch holding the change', typeof branch === 'string' && git(['show', `${branch}:feature.txt`], repo).out === 'the feature', JSON.stringify(report && report.change))
  check('the merge decision is left to a human', report && report.humanDecisionRequired.some(h => h.includes(branch)))
  check("the caller's tree is untouched", !fs.existsSync(path.join(repo, 'feature.txt')) && git(['status', '--porcelain'], repo).out === '')
  check('no worktree is leaked', git(['worktree', 'list', '--porcelain'], repo).out.split('\n').filter(l => l.startsWith('worktree ')).length === 1)
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(stubDir, { recursive: true, force: true })
}

async function failClosedTests() {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdcode-fake-cmdc-'))
  const stub = path.join(stubDir, 'cmdc')
  fs.writeFileSync(stub, FAKE_CMDC, { mode: 0o755 })
  // resolveCmdc() caches its first answer, so this must be set before the
  // first runAgent call in this process; FAKE_MODE is read per spawn.
  process.env.CMDC_BIN = stub
  const ask = mode => {
    process.env.FAKE_MODE = mode
    return runAgent({ name: 'general', task: 'say something', timeoutMs: 1500, retries: 1 })
  }
  check('a clean exit returns the output', (await ask('ok')) === 'a real answer')
  check('a non-zero exit with output is null', (await ask('fail-with-output')) === null)
  check('a timeout with partial output is null', (await ask('hang')) === null)
  delete process.env.FAKE_MODE
  fs.rmSync(stubDir, { recursive: true, force: true })
}

async function main() {
  await unitTests()
  await failClosedTests()
  endToEnd()
  fs.rmSync(bareHome, { recursive: true, force: true })
  if (failures.length) {
    console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`)
    process.exit(1)
  }
  console.log('\nall _runner checks passed')
}

if (require.main === module) {
  main().catch(e => {
    console.error(e && e.stack ? e.stack : e)
    process.exit(1)
  })
}
