/**
 * Tests for init.mjs. Run with `node sdlc-suite/tools/init.test.mjs`.
 *
 * No test framework: this repository has no package.json, so adding one would be
 * a new runtime dependency for every adopter. The exit code is the result.
 *
 * Every case spawns the real CLI with `spawnSync(process.execPath, …)` and
 * asserts on `status`, not on what was printed. A tool whose whole interface is
 * "exit non-zero when the instance is not ready" cannot be tested by reading its
 * output — that is the pipeline-swallows-the-status failure this repository has
 * already been bitten by, one level up.
 *
 * Nothing here touches the repository it lives in. Every case runs in its own
 * `fs.mkdtempSync` directory, because `.claude/` in this repo is a generated
 * tree and init writes into `.claude/`.
 *
 * Proven capable of failing
 * -------------------------
 * init.mjs is new, so there is no unfixed state to run these against. Instead
 * defects were injected into the finished code, ONE AT A TIME, each
 * restored before the next, and the assertion that went red recorded. Driver
 * output is in the change report; the mapping is:
 *
 *   A1  --check reports [exists] where the memory root is absent
 *         -> "--check fails and names the missing memory directory"
 *   A2  --check mkdirSync's the memory root instead of only inspecting it
 *         -> the same test, plus "--check writes nothing at all"
 *   B   the JSON.parse catch reports [missing] instead of [error]
 *         -> "unparseable JSON is reported as unparseable, not as absent"
 *   C   the intact-memory-root early return is removed
 *         -> "a second run writes nothing and reports [exists] for all four"
 *   D   autonomy.json is written unconditionally
 *         -> six tests, including "an existing valid autonomy.json is
 *            byte-identical afterwards"
 *   E   an existing CLAUDE.md is replaced rather than appended to
 *         -> "an existing CLAUDE.md keeps every byte it had"
 *   F   a [warn] is made fatal
 *         -> ten tests, including "no allowlist warns but still exits 0"
 *   G   a stale routing block is reported [missing] rather than [stale]
 *         -> "--check calls a stale routing block [stale] and does NOT fail"
 *   H   the routing refresh drops everything after the end marker
 *         -> "a write run refreshes the block and leaves everything outside
 *            the markers alone"
 *   I1  --check stops looking inside an existing memory root
 *         -> "--check warns and names the absent file, without repairing it"
 *   I2  the repair overwriting adopter-edited memory files is guarded TWICE —
 *       the copy loop iterates `missing` rather than `wanted`, and each write is
 *       preceded by an existsSync check. Removing either alone leaves the test
 *       green (I2a, I2b, both exit 0); only removing both makes
 *       "a memory file the adopter edited is never overwritten" go red (I2c).
 *       Recorded rather than papered over: that assertion's resolution is the
 *       conjunction of two guards, not either one.
 *
 * A2 is why the "writes nothing" assertion checks for the directory and not
 * only for files: the first version of it counted files, and an injected
 * mkdirSync passed it. That is a finding about the test, not about the code.
 */

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Imported as a module as well as spawned: the argv path cannot carry a NUL,
// so the allowlist itself has to be exercised directly for that one case.
import { validateProject } from './init.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INIT = path.join(HERE, 'init.mjs')
const SUITE_ROOT = path.resolve(HERE, '..')
const TEMPLATE = path.join(SUITE_ROOT, 'memory-template')

let passed = 0
function test(name, fn) {
  let dir
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-init-'))
    fn(dir)
    passed++
    console.log(`  pass  ${name}`)
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`)
    process.exitCode = 1
  } finally {
    // Only ever a directory this test made, never a path derived from input.
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* leave it */ }
  }
}

function init(cwd, ...args) {
  const r = spawnSync(process.execPath, [INIT, ...args], { cwd, encoding: 'utf8' })
  if (r.error) throw r.error
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

/** Map of relative path -> bytes, for every regular file under `dir`. */
function snapshot(dir, prefix = '', out = new Map()) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return out
    throw e
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) snapshot(path.join(dir, entry.name), rel, out)
    else if (entry.isFile()) out.set(rel, fs.readFileSync(path.join(dir, entry.name)))
  }
  return out
}

function sameBytes(a, b) {
  if (a.size !== b.size) return `file count differs: ${a.size} vs ${b.size}`
  for (const [rel, bytes] of a) {
    if (!b.has(rel)) return `missing after second run: ${rel}`
    if (!bytes.equals(b.get(rel))) return `content changed: ${rel}`
  }
  return null
}

// --------------------------------------------------------------------------- //
console.log('scaffold — the five things, measured rather than asserted')

test('a fresh repo gets all four writable artifacts, exit 0', dir => {
  const { status, out } = init(dir, '--project', 'demo')
  assert.strictEqual(status, 0, `expected exit 0, got ${status}\n${out}`)
  for (const p of [
    '.claude/memory/demo/', '.claude/autonomy.json',
    '.claude/CLAUDE.md', '.claude/runs/.gitignore',
  ]) {
    assert.ok(out.includes(`[created]`) && out.includes(p), `no [created] line for ${p}\n${out}`)
  }
  assert.strictEqual((out.match(/\[created\]/g) || []).length, 4, `expected 4 [created]\n${out}`)
  assert.ok(/\[warn\]|\[checked\]/.test(out), `expected a permissions line\n${out}`)
})

test('the memory root is the template, byte for byte, and the reported count is the real one', dir => {
  const { out } = init(dir, '--project', 'demo')
  const want = snapshot(TEMPLATE)
  const got = snapshot(path.join(dir, '.claude', 'memory', 'demo'))
  const diff = sameBytes(want, got)
  assert.strictEqual(diff, null, `memory root is not the template: ${diff}`)
  assert.ok(want.size > 0, 'memory-template is empty — the fixture proves nothing')
  // The printed number must equal what is actually on disk. The review's
  // illustrative "13 files, 6 directories" is neither; it is measured, not typed.
  const m = out.match(/(\d+) files, (\d+) directories/)
  assert.ok(m, `no measured count in the memory line\n${out}`)
  assert.strictEqual(Number(m[1]), got.size, `reported ${m[1]} files, found ${got.size}`)
})

test('the routing markers are the ones commands/install-routing.md documents', dir => {
  init(dir, '--project', 'demo')
  const text = fs.readFileSync(path.join(dir, '.claude', 'CLAUDE.md'), 'utf8')
  const doc = fs.readFileSync(path.join(SUITE_ROOT, 'commands', 'install-routing.md'), 'utf8')
  for (const marker of ['<!-- sdlc-suite:routing:start -->', '<!-- sdlc-suite:routing:end -->']) {
    assert.ok(text.includes(marker), `installed file lacks ${marker}`)
    assert.ok(doc.includes(marker), `install-routing.md no longer documents ${marker} — the two have drifted`)
  }
  // The installed body must be ROUTING.md, not a paraphrase of it.
  const routing = fs.readFileSync(path.join(SUITE_ROOT, 'ROUTING.md'), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(text.includes(routing.trimEnd()), 'the installed block is not ROUTING.md verbatim')
})

test('the run-state .gitignore lands where _state.js says runs go', dir => {
  const { RUNS_DIR_NAME } = require(path.join(SUITE_ROOT, 'workflows', '_state.js'))
  init(dir, '--project', 'demo')
  const f = path.join(dir, RUNS_DIR_NAME, '.gitignore')
  assert.ok(fs.existsSync(f), `no .gitignore at ${RUNS_DIR_NAME}`)
  assert.ok(fs.readFileSync(f, 'utf8').includes('*'), 'the .gitignore excludes nothing')
})

test('every file written is LF — a CRLF definition has unregistered agents here before', dir => {
  init(dir, '--project', 'demo')
  for (const rel of snapshot(path.join(dir, '.claude')).keys()) {
    const bytes = fs.readFileSync(path.join(dir, '.claude', rel))
    assert.ok(!bytes.includes(Buffer.from('\r\n')), `CRLF in .claude/${rel}`)
  }
})

// --------------------------------------------------------------------------- //
console.log('\nidempotence — safe inside a repeated setup script')

test('a second run writes nothing and reports [exists] for all four', dir => {
  assert.strictEqual(init(dir, '--project', 'demo').status, 0)
  const before = snapshot(path.join(dir, '.claude'))
  const { status, out } = init(dir, '--project', 'demo')
  assert.strictEqual(status, 0, `second run exited ${status}\n${out}`)
  const after = snapshot(path.join(dir, '.claude'))
  const diff = sameBytes(before, after)
  assert.strictEqual(diff, null, `the second run changed the tree: ${diff}`)
  assert.strictEqual((out.match(/\[created\]/g) || []).length, 0, `second run created something\n${out}`)
  assert.strictEqual((out.match(/\[exists\]/g) || []).length, 4, `expected 4 [exists]\n${out}`)
})

test('--check writes nothing at all, on a repo that has nothing', dir => {
  const { status, out } = init(dir, '--project', 'demo', '--check')
  assert.strictEqual(status, 1, `--check on an empty repo must fail, got ${status}\n${out}`)
  for (const p of ['.claude/memory/demo/', '.claude/autonomy.json', '.claude/CLAUDE.md', '.claude/runs/.gitignore']) {
    assert.ok(out.includes(p), `--check did not name ${p}\n${out}`)
  }
  // Directories, not just files. An earlier version of this assertion counted
  // files only, and an injected `mkdirSync` in the --check branch slipped past it.
  assert.strictEqual(snapshot(dir).size, 0, '--check wrote a file into the repo')
  assert.ok(!fs.existsSync(path.join(dir, '.claude')), '--check created .claude/')
})

// --------------------------------------------------------------------------- //
console.log('\nno overwrite — autonomy.json and CLAUDE.md are the adopter\'s once made')

test('an existing valid autonomy.json is byte-identical afterwards', dir => {
  const custom = JSON.parse(fs.readFileSync(path.join(SUITE_ROOT, 'autonomy.json'), 'utf8'))
  custom.preAuthorized.decide.defectFiling = true          // differs from the shipped default
  custom.preAuthorized.decide.roadmapCommit = false
  const text = `${JSON.stringify(custom, null, 4)}\n`      // and a different indent, so bytes differ too
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
  const dest = path.join(dir, '.claude', 'autonomy.json')
  fs.writeFileSync(dest, text, 'utf8')
  const before = fs.readFileSync(dest)

  const { status, out } = init(dir, '--project', 'demo')
  assert.strictEqual(status, 0, `exited ${status}\n${out}`)
  assert.ok(fs.readFileSync(dest).equals(before), 'autonomy.json was rewritten')
  assert.ok(/\[exists\][^\n]*autonomy\.json/.test(out), `autonomy.json not reported [exists]\n${out}`)
  // And the summary is computed from the adopter's file, not from the default.
  assert.ok(/6 decide \(5 on\), 8 act \(0 on\)/.test(out), `gate summary not recomputed\n${out}`)
})

test('an existing CLAUDE.md keeps every byte it had; routing is appended under its marker', dir => {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
  const dest = path.join(dir, '.claude', 'CLAUDE.md')
  const original = '# House rules\n\nNever push to main on a Friday.\n'
  fs.writeFileSync(dest, original, 'utf8')

  const { status, out } = init(dir, '--project', 'demo')
  assert.strictEqual(status, 0, `exited ${status}\n${out}`)
  const after = fs.readFileSync(dest, 'utf8')
  assert.ok(after.startsWith(original), 'the adopter\'s CLAUDE.md was not preserved as a prefix')
  assert.ok(after.includes('<!-- sdlc-suite:routing:start -->'), 'routing block not appended')
  assert.ok(/\[appended\][^\n]*CLAUDE\.md/.test(out), `not reported [appended]\n${out}`)
})

// --------------------------------------------------------------------------- //
console.log('\na file missing INSIDE a directory that exists')

// The case a directory-existence check cannot see. It is not hypothetical here:
// `commandcode-suite/skills/exploration-charter/` was present but missing
// `personas-schema-template.yaml`, so skip-if-exists never re-copied it and
// every name-level parity check reported the tree clean.

test('--check warns and names the absent file, without repairing it', dir => {
  init(dir, '--project', 'demo')
  const victim = path.join(dir, '.claude', 'memory', 'demo', 'risks.md')
  assert.ok(fs.existsSync(victim), 'fixture invalid: risks.md was never copied')
  fs.rmSync(victim)

  const { status, out } = init(dir, '--project', 'demo', '--check')
  // Survivable: the directory exists, so writes land. A warning, not a failure.
  assert.strictEqual(status, 0, `a missing template file failed the run\n${out}`)
  assert.ok(/\[warn\][^\n]*memory\/demo/.test(out), `no warning for the memory root\n${out}`)
  assert.ok(out.includes('risks.md'), `--check did not name the absent file\n${out}`)
  assert.ok(!fs.existsSync(victim), '--check repaired what it was asked to inspect')
})

test('a write run restores it byte-identically and then settles to [exists]', dir => {
  init(dir, '--project', 'demo')
  const rel = 'risks.md'
  const victim = path.join(dir, '.claude', 'memory', 'demo', rel)
  const want = fs.readFileSync(path.join(TEMPLATE, rel))
  fs.rmSync(victim)

  const { status, out } = init(dir, '--project', 'demo')
  assert.strictEqual(status, 0, `exited ${status}\n${out}`)
  assert.ok(/\[updated\][^\n]*memory\/demo/.test(out), `not reported [updated]\n${out}`)
  assert.ok(fs.readFileSync(victim).equals(want), 'the restored file is not the template')

  const second = init(dir, '--project', 'demo')
  assert.strictEqual((second.out.match(/\[updated\]/g) || []).length, 0,
    `the repair is not idempotent\n${second.out}`)
  assert.ok(/\[exists\][^\n]*memory\/demo/.test(second.out), `did not settle to [exists]\n${second.out}`)
})

test('a memory file the adopter edited is never overwritten by the repair', dir => {
  init(dir, '--project', 'demo')
  const kept = path.join(dir, '.claude', 'memory', 'demo', 'risks.md')
  fs.writeFileSync(kept, '# Risks\n\nR-1 the vendor contract lapses in March.\n', 'utf8')
  const before = fs.readFileSync(kept)
  fs.rmSync(path.join(dir, '.claude', 'memory', 'demo', 'glossary.md'))

  init(dir, '--project', 'demo')
  assert.ok(fs.readFileSync(kept).equals(before), 'the adopter\'s memory content was replaced by the template')
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'memory', 'demo', 'glossary.md')), 'the absent file was not restored')
})

// --------------------------------------------------------------------------- //
console.log('\nrouting refresh — the block moves, the adopter\'s own text does not')

function withStaleRouting(dir) {
  init(dir, '--project', 'demo')
  const dest = path.join(dir, '.claude', 'CLAUDE.md')
  const text = fs.readFileSync(dest, 'utf8')
  const START = '<!-- sdlc-suite:routing:start -->'
  const END = '<!-- sdlc-suite:routing:end -->'
  const head = text.slice(0, text.indexOf(START))
  const tail = text.slice(text.indexOf(END) + END.length)
  fs.writeFileSync(dest,
    `${head}${START}\nan older routing policy\n${END}${tail}\n## Instance configuration\n\nCanonical tree: sdlc-suite/\n`,
    'utf8')
  return dest
}

test('--check calls a stale routing block [stale] and does NOT fail the run', dir => {
  const dest = withStaleRouting(dir)
  const before = fs.readFileSync(dest)
  const { status, out } = init(dir, '--project', 'demo', '--check')
  // Deliberately survivable: a routing policy one version behind still binds the
  // caller, where a missing memory root loses every write. Different severities.
  assert.strictEqual(status, 0, `a stale routing block failed the run\n${out}`)
  assert.ok(/\[stale\][^\n]*CLAUDE\.md/.test(out), `not reported [stale]\n${out}`)
  assert.ok(fs.readFileSync(dest).equals(before), '--check rewrote CLAUDE.md')
})

test('a write run refreshes the block and leaves everything outside the markers alone', dir => {
  const dest = withStaleRouting(dir)
  const { status, out } = init(dir, '--project', 'demo')
  assert.strictEqual(status, 0, `exited ${status}\n${out}`)
  assert.ok(/\[updated\][^\n]*CLAUDE\.md/.test(out), `not reported [updated]\n${out}`)
  const text = fs.readFileSync(dest, 'utf8')
  assert.ok(!text.includes('an older routing policy'), 'the stale block survived the refresh')
  assert.ok(text.includes('## Instance configuration'), 'the adopter\'s section below the block was destroyed')
  assert.ok(text.startsWith('Agent routing policy for this repository.'), 'the text above the block was destroyed')
  const routing = fs.readFileSync(path.join(SUITE_ROOT, 'ROUTING.md'), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(text.includes(routing.trimEnd()), 'the refreshed block is not ROUTING.md verbatim')
  // And it settles: a further run is a no-op rather than appending again.
  const after = fs.readFileSync(dest)
  init(dir, '--project', 'demo')
  assert.ok(fs.readFileSync(dest).equals(after), 'the refresh is not idempotent')
})

// --------------------------------------------------------------------------- //
console.log('\nfault 1 — a deleted memory root must be named, not passed over')

test('--check fails and names the missing memory directory', dir => {
  assert.strictEqual(init(dir, '--project', 'demo').status, 0)
  fs.rmSync(path.join(dir, '.claude', 'memory', 'demo'), { recursive: true })

  const { status, out } = init(dir, '--project', 'demo', '--check')
  assert.strictEqual(status, 1, `--check passed with the memory root deleted\n${out}`)
  assert.ok(/\[missing\][^\n]*\.claude\/memory\/demo\//.test(out),
    `--check did not name .claude/memory/demo/ as missing\n${out}`)
  // And it did not quietly repair what it was asked only to inspect.
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'memory', 'demo')), '--check recreated the directory')
})

test('a non-check run restores it and --check goes green again', dir => {
  init(dir, '--project', 'demo')
  fs.rmSync(path.join(dir, '.claude', 'memory', 'demo'), { recursive: true })
  assert.strictEqual(init(dir, '--project', 'demo').status, 0)
  const { status, out } = init(dir, '--project', 'demo', '--check')
  assert.strictEqual(status, 0, `--check still failing after repair\n${out}`)
})

// --------------------------------------------------------------------------- //
console.log('\nfault 2 — invalid must not degrade into absent')

test('a schema-invalid autonomy.json fails --check with the schema error', dir => {
  assert.strictEqual(init(dir, '--project', 'demo').status, 0)
  const dest = path.join(dir, '.claude', 'autonomy.json')
  const bad = JSON.parse(fs.readFileSync(dest, 'utf8'))
  bad.preAuthorized.act.deploi = true          // the exact typo _policy.js's header names
  delete bad.preAuthorized.act.deploy
  fs.writeFileSync(dest, `${JSON.stringify(bad, null, 2)}\n`, 'utf8')
  const before = fs.readFileSync(dest)

  const { status, out } = init(dir, '--project', 'demo', '--check')
  assert.strictEqual(status, 1, `an invalid policy passed --check\n${out}`)
  assert.ok(/\[error\][^\n]*autonomy\.json/.test(out), `not reported as [error]\n${out}`)
  assert.ok(out.includes('deploi'), `the error does not name the offending key\n${out}`)
  // The distinction this case exists for: invalid, NOT absent.
  assert.ok(!/\[missing\][^\n]*autonomy\.json/.test(out),
    `an invalid policy was reported as missing — absent and invalid are different states\n${out}`)
  assert.ok(fs.readFileSync(dest).equals(before), 'the invalid file was overwritten')
})

test('a schema-invalid autonomy.json also fails a write run, without overwriting it', dir => {
  assert.strictEqual(init(dir, '--project', 'demo').status, 0)
  const dest = path.join(dir, '.claude', 'autonomy.json')
  const bad = JSON.parse(fs.readFileSync(dest, 'utf8'))
  bad.preAuthorized.act.deploi = true
  fs.writeFileSync(dest, `${JSON.stringify(bad, null, 2)}\n`, 'utf8')
  const before = fs.readFileSync(dest)

  const { status, out } = init(dir, '--project', 'demo')
  assert.strictEqual(status, 1, `a write run accepted an invalid policy\n${out}`)
  assert.ok(fs.readFileSync(dest).equals(before), 'the invalid file was replaced by the default')
})

test('unparseable JSON is reported as unparseable, not as absent', dir => {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
  const dest = path.join(dir, '.claude', 'autonomy.json')
  fs.writeFileSync(dest, '{ "mode": "unattended",\n', 'utf8')

  const { status, out } = init(dir, '--project', 'demo', '--check')
  assert.strictEqual(status, 1, `unparseable JSON passed --check\n${out}`)
  assert.ok(/\[error\][^\n]*autonomy\.json[^\n]*not valid JSON/.test(out),
    `not reported as invalid JSON\n${out}`)
  assert.ok(!/\[missing\][^\n]*autonomy\.json/.test(out), 'unparseable was reported as absent')
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), '{ "mode": "unattended",\n', 'the file was rewritten')
})

// --------------------------------------------------------------------------- //
console.log('\n--project is the one input that becomes a path')

for (const bad of ['../escape', 'a/b', 'a\\b', '..', '', '.hidden', 'C:evil', 'x y']) {
  test(`--project ${JSON.stringify(bad)} is rejected with exit 2 and writes nothing`, dir => {
    const { status, out } = init(dir, '--project', bad)
    assert.strictEqual(status, 2, `expected usage exit 2, got ${status}\n${out}`)
    assert.strictEqual(snapshot(dir).size, 0, 'a rejected project name still wrote files')
  })
}

test('a NUL byte in the project name is rejected by the validator itself', () => {
  // Not spawned: Node refuses to pass an argv entry containing a NUL, so the
  // CLI can never see this one. The allowlist is still what has to reject it,
  // because runInit() is exported and callable in-process.
  // Built with fromCharCode, never as a literal: a stray NUL in a source file
  // is invisible in every editor, and two got into this file by accident while
  // it was being written.
  const NUL = String.fromCharCode(0)
  assert.ok(validateProject(`x${NUL}y`), 'a NUL byte passed validateProject')
  assert.ok(validateProject(`demo${NUL}/../etc`), 'a NUL-truncation attempt passed validateProject')
  assert.strictEqual(validateProject('my-service'), null, 'a legitimate name was rejected')
})

test('a missing --project is a usage error, not a default', dir => {
  const { status } = init(dir)
  assert.strictEqual(status, 2)
  assert.strictEqual(snapshot(dir).size, 0)
})

test('an unknown flag is a usage error rather than being ignored', dir => {
  const { status, out } = init(dir, '--project', 'demo', '--force')
  assert.strictEqual(status, 2, `unknown flag accepted\n${out}`)
  assert.strictEqual(snapshot(dir).size, 0)
})

// --------------------------------------------------------------------------- //
console.log('\npermissions — a warning, never a failure')

test('permissions.allow present is [checked] and does not change readiness', dir => {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(git status)', 'Bash(node *)'] } }, null, 2), 'utf8')
  const { status, out } = init(dir, '--project', 'demo')
  assert.strictEqual(status, 0, `exited ${status}\n${out}`)
  assert.ok(/\[checked\][^\n]*permissions\.allow present, 2 entries/.test(out),
    `permissions not reported as checked with a count\n${out}`)
})

test('no allowlist warns but still exits 0 — init cannot fix it, so it must not block', dir => {
  const { status, out } = init(dir, '--project', 'demo')
  assert.strictEqual(status, 0, `a missing allowlist made init fail\n${out}`)
  assert.ok(/\[warn\][^\n]*permissions\.allow/.test(out), `no permissions warning\n${out}`)
})

test('an unparseable settings.json warns rather than failing the run', dir => {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{ oops', 'utf8')
  const { status, out } = init(dir, '--project', 'demo')
  assert.strictEqual(status, 0, `a broken settings.json blocked init\n${out}`)
  assert.ok(/\[warn\]/.test(out), `no warning for a broken settings.json\n${out}`)
})

console.log(`\n${passed} passed, exit ${process.exitCode || 0}`)
