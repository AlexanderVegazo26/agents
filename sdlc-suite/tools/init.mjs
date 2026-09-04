#!/usr/bin/env node
/**
 * Scaffold an SDLC-suite instance into a consuming repository, and verify it.
 *
 *     node "${CLAUDE_PLUGIN_ROOT}/tools/init.mjs" --project my-service
 *     node "${CLAUDE_PLUGIN_ROOT}/tools/init.mjs" --project my-service --check
 *
 * Why this exists
 * ---------------
 * `USAGE.md` used to give three manual pre-flight steps, each of which fails
 * silently. The memory one is the clearest, and `USAGE.md` conceded it in
 * writing: *"In a fresh repo that tree doesn't exist and nobody is watching the
 * write fail."* An adopter runs `/sdlc-suite:sdlc-feature`, eleven agents are
 * instructed to record durable context in `.claude/memory/<project>/`, every
 * write goes to a directory that does not exist, and the run reports success.
 *
 * Five things, each reported on its own line:
 *
 *   1. `.claude/memory/<project>/`  — copied from `memory-template/`
 *   2. `.claude/autonomy.json`      — copied from the suite default, then validated
 *   3. `.claude/CLAUDE.md`          — routing policy from `ROUTING.md`, in markers
 *   4. `.claude/runs/.gitignore`    — run state kept out of version control
 *   5. `.claude/settings.json`      — permissions.allow *checked*, never written
 *
 * Contract
 * --------
 * This writes into somebody else's repository, which is the one thing in this
 * platform that does. Three properties follow from that and are tested:
 *
 *   **Idempotent.** A second run reports `[exists]` and writes nothing, so the
 *   command is safe inside a repeated setup script.
 *
 *   **Never overwrites `autonomy.json` or `CLAUDE.md`.** Once an adopter has
 *   edited either, it is their decision, not ours. `CLAUDE.md` gets the routing
 *   policy appended under a marked section instead — the same markers
 *   `commands/install-routing.md` documents, so the two agree.
 *
 *   **`--check` writes nothing at all** and reports readiness through the exit
 *   code, for CI or a pre-run gate.
 *
 * Absent is not the same state as invalid
 * ---------------------------------------
 * A malformed `autonomy.json` must fail loudly with the schema error rather than
 * degrading into "no policy file". `loadPolicy()` in `workflows/_policy.js`
 * deliberately collapses both into `degraded: true` because a *run* has to keep
 * going either way; an init gate must not, so this reads the file itself and only
 * `ENOENT` counts as absent. It still reuses that module's `validate()` and
 * `GATES` rather than restating the gate list — there are already two mirrors of
 * it (`_policy.js` and `tools/validate-autonomy.py`, kept honest by
 * `validate-autonomy.py --selftest`) and a third would drift.
 *
 * Exit codes — the actual interface for `--check`:
 *   0  ready (warnings are allowed and do not change this)
 *   1  not ready: something required is missing, or a file present is invalid
 *   2  usage error
 *
 * Stdlib only, and no `package.json` anywhere in this repository, so there is no
 * dependency floor to raise. Written against Node 20 (what CI pins): no
 * `import.meta.dirname` (20.11+), no `fs.cpSync`, no `fs.globSync`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// _policy.js is CommonJS; this file is ESM. createRequire is the bridge.
const require = createRequire(import.meta.url)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SUITE_ROOT = path.resolve(HERE, '..')

const ROUTING_START = '<!-- sdlc-suite:routing:start -->'
const ROUTING_END = '<!-- sdlc-suite:routing:end -->'

const RUNS_GITIGNORE = [
  '# Run state written by the SDLC suite workflows (see workflows/_state.js).',
  '# One directory per run: phase artifacts, failures.jsonl, outcome.json.',
  '# These are a transcript of what agents returned, not a build input, and they',
  '# can contain whatever the repository under review contained. Not committed.',
  '*',
  '!.gitignore',
  '',
].join('\n')

const USAGE = [
  'usage: node init.mjs --project <name> [--check]',
  '',
  '  --project <name>  memory root is .claude/memory/<name>/; one path segment,',
  '                    [A-Za-z0-9] then [A-Za-z0-9._-], max 64 characters',
  '  --check           report readiness and write nothing (for CI or a pre-run gate)',
  '',
  'exit: 0 ready · 1 not ready · 2 usage error',
].join('\n')

// --------------------------------------------------------------------------- //
// Reporting
// --------------------------------------------------------------------------- //

/**
 * Tags are the contract this command's tests and `commands/init.md` grep for.
 * `error` and `missing` are the only two that make the run not-ready; `warn` is
 * explicitly survivable, because the thing it reports is not something init can
 * fix (see the permissions step).
 */
const FATAL_TAGS = new Set(['error', 'missing'])

class Report {
  constructor() {
    this.lines = []
    this.counts = { created: 0, updated: 0, appended: 0, exists: 0, checked: 0, warn: 0, error: 0, missing: 0, stale: 0 }
  }

  add(tag, subject, detail) {
    this.counts[tag] = (this.counts[tag] || 0) + 1
    this.lines.push({ tag, subject, detail })
    return tag
  }

  get ready() {
    return !this.lines.some(l => FATAL_TAGS.has(l.tag))
  }

  render() {
    const width = Math.max(0, ...this.lines.map(l => l.subject.length))
    const out = this.lines.map(l => {
      const tag = `[${l.tag}]`.padEnd(11)
      const subject = l.detail ? l.subject.padEnd(width) : l.subject
      return `  ${tag}${subject}${l.detail ? `  ${l.detail}` : ''}`.trimEnd()
    })

    const parts = []
    for (const [k, one, many] of [
      ['created', 'created', 'created'],
      ['updated', 'updated', 'updated'],
      ['appended', 'appended', 'appended'],
      ['exists', 'already present', 'already present'],
      ['checked', 'checked', 'checked'],
      ['stale', 'stale', 'stale'],
      ['warn', 'warning', 'warnings'],
      ['missing', 'missing', 'missing'],
      ['error', 'error', 'errors'],
    ]) {
      const n = this.counts[k] || 0
      if (n) parts.push(`${n} ${n === 1 ? one : many}`)
    }
    out.push(`  ${this.ready ? 'ready' : 'NOT READY'}: ${parts.join(', ') || 'nothing to do'}`)
    return out.join('\n')
  }
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

/** Display paths with forward slashes on every platform, so output is stable. */
function show(p) {
  return p.split(path.sep).join('/')
}

/**
 * `--project` is the only externally-supplied value that becomes a filesystem
 * path, so it is validated by allowlist and rejected rather than sanitized.
 * `..`, separators, absolute forms, NUL and Windows drive letters all fail here.
 */
const RESERVED_WINDOWS = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

function validateProject(name) {
  // Windows reserved device names pass every other check and then fail at
  // mkdir with an opaque error instead of the clean message the other
  // rejections get. Cheap to name explicitly.
  if (typeof name === 'string' && RESERVED_WINDOWS.has(name.toLowerCase().split('.')[0])) {
    return `"${name}" is a reserved device name on Windows`
  }
  if (typeof name !== 'string' || name.length === 0) return 'a project name is required'
  if (name.length > 64) return `project name is ${name.length} characters; maximum is 64`
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return `invalid project name ${JSON.stringify(name)} — one path segment only, ` +
      '[A-Za-z0-9] followed by [A-Za-z0-9._-]'
  }
  if (name === '.' || name === '..') return `invalid project name ${JSON.stringify(name)}`
  return null
}

function readTextOr(file, fallback) {
  try {
    // Normalize CRLF on read. A CRLF ROUTING.md landing in a consuming repo is
    // the same byte-level hazard that has silently unregistered agents here.
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  } catch (e) {
    if (e.code === 'ENOENT') return fallback
    throw e
  }
}

/** Explicit LF. Node does not translate newlines, but say so where it matters. */
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text.replace(/\r\n/g, '\n'), 'utf8')
}

/**
 * Every regular file under `dir`, as paths relative to it, sorted.
 *
 * Recursive on purpose. A directory-existence check cannot see a file missing
 * *inside* a directory that exists — that is exactly how
 * `commandcode-suite/skills/exploration-charter/` lost
 * `personas-schema-template.yaml` while every name-level parity check passed.
 */
function walkFiles(dir, prefix = '', out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return out
    throw e
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) walkFiles(path.join(dir, entry.name), rel, out)
    else if (entry.isFile()) out.push(rel)
    // Anything else (symlink, socket, device) is deliberately skipped rather
    // than followed: the template ships regular files only, and following a
    // link placed there would copy from outside the suite.
  }
  return out
}

// --------------------------------------------------------------------------- //
// Step 1 — memory root
// --------------------------------------------------------------------------- //

function stepMemory(report, { repo, project, check }) {
  const template = path.join(SUITE_ROOT, 'memory-template')
  const memoryRoot = path.resolve(repo, '.claude', 'memory')
  const dest = path.resolve(memoryRoot, project)

  // Belt and braces after validateProject: prove the resolved path is inside
  // the memory root rather than trusting the pattern to have covered every form.
  if (dest !== memoryRoot && !dest.startsWith(memoryRoot + path.sep)) {
    return report.add('error', show(path.join('.claude', 'memory', project)),
      'resolves outside .claude/memory/ — refusing')
  }

  const wanted = walkFiles(template)
  if (wanted.length === 0) {
    return report.add('error', show(path.relative(repo, template)) || 'memory-template/',
      `not found or empty at ${show(template)} — the suite install is incomplete`)
  }

  const subject = `${show(path.join('.claude', 'memory', project))}/`
  const rootExists = fs.existsSync(dest)
  const present = new Set(walkFiles(dest))
  const missing = wanted.filter(rel => !present.has(rel))

  if (check) {
    if (!rootExists) {
      return report.add('missing', subject,
        `does not exist — ${wanted.length} template file(s) belong here, and every ` +
        'agent memory write in every workflow targets this path')
    }
    if (missing.length) {
      return report.add('warn', subject,
        `${missing.length} template file(s) absent, first: ${missing.slice(0, 3).join(', ')}` +
        ' — run init without --check to restore them')
    }
    const dirs = new Set(['']);
    for (const rel of wanted) { const d = path.posix.dirname(rel); if (d !== '.') dirs.add(d) }
    return report.add('exists', subject, `${present.size} files, ${dirs.size} directories`)
  }

  if (rootExists && missing.length === 0) {
    const dirs = new Set(['']);
    for (const rel of wanted) { const d = path.posix.dirname(rel); if (d !== '.') dirs.add(d) }
    return report.add('exists', subject, `${present.size} files, ${dirs.size} directories`)
  }

  const dirsMade = new Set()
  fs.mkdirSync(dest, { recursive: true })
  dirsMade.add('')
  for (const rel of missing) {
    const target = path.join(dest, ...rel.split('/'))
    const parent = path.posix.dirname(rel)
    if (parent !== '.' && !dirsMade.has(parent)) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      dirsMade.add(parent)
    }
    // Never clobber: `missing` was computed from the destination, but a race or
    // a case-insensitive filesystem could still land on an existing file.
    if (fs.existsSync(target)) continue
    fs.copyFileSync(path.join(template, ...rel.split('/')), target)
  }

  const after = walkFiles(dest)
  const allDirs = new Set([''])
  for (const rel of after) { const d = path.posix.dirname(rel); if (d !== '.') allDirs.add(d) }
  if (rootExists) {
    return report.add('updated', subject,
      `${missing.length} missing template file(s) restored; now ${after.length} files, ${allDirs.size} directories`)
  }
  return report.add('created', subject, `${after.length} files, ${allDirs.size} directories`)
}

// --------------------------------------------------------------------------- //
// Step 2 — autonomy policy
// --------------------------------------------------------------------------- //

function summarizePolicy(parsed, GATES) {
  const on = cls => GATES[cls].filter(g => parsed.preAuthorized[cls][g] === true).length
  return `validated: ${GATES.decide.length} decide (${on('decide')} on), ` +
    `${GATES.act.length} act (${on('act')} on)`
}

function stepAutonomy(report, { repo, check }) {
  const { validate, GATES } = require(path.join(SUITE_ROOT, 'workflows', '_policy.js'))
  const dest = path.resolve(repo, '.claude', 'autonomy.json')
  const subject = show(path.join('.claude', 'autonomy.json'))

  let raw = null
  try {
    raw = fs.readFileSync(dest, 'utf8')
  } catch (e) {
    // ENOENT is the ONLY absent. A permission error, a directory in the way, or
    // anything else is a state the adopter needs told about, not silently
    // overwritten with a default.
    if (e.code !== 'ENOENT') {
      return report.add('error', subject, `cannot be read — ${e.code}: ${e.message}`)
    }
  }

  if (raw !== null) {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      return report.add('error', subject, `not valid JSON — ${e.message}`)
    }
    const errors = validate(parsed)
    if (errors.length) {
      return report.add('error', subject, `fails the autonomy schema — ${errors.join('; ')}`)
    }
    return report.add('exists', subject, `${summarizePolicy(parsed, GATES)} — left as found`)
  }

  const source = path.join(SUITE_ROOT, 'autonomy.json')
  const template = readTextOr(source, null)
  if (template === null) {
    return report.add('error', subject, `no default policy at ${show(source)} — the suite install is incomplete`)
  }
  let parsed
  try {
    parsed = JSON.parse(template)
  } catch (e) {
    return report.add('error', subject, `the suite default at ${show(source)} is not valid JSON — ${e.message}`)
  }
  // Validate what we are about to write, not merely what we find later. A
  // scaffold that installs a policy failing its own schema is worse than none.
  const errors = validate(parsed)
  if (errors.length) {
    return report.add('error', subject, `the suite default fails its own schema — ${errors.join('; ')}`)
  }

  if (check) {
    return report.add('missing', subject,
      'does not exist — without it every gate reads not-authorized and the run reports degraded')
  }
  writeText(dest, template.endsWith('\n') ? template : `${template}\n`)
  return report.add('created', subject, summarizePolicy(parsed, GATES))
}

// --------------------------------------------------------------------------- //
// Step 3 — routing policy in CLAUDE.md
// --------------------------------------------------------------------------- //

function routingBlock(body) {
  return `${ROUTING_START}\n${body.replace(/\s+$/, '')}\n${ROUTING_END}\n`
}

function stepRouting(report, { repo, check }) {
  const source = path.join(SUITE_ROOT, 'ROUTING.md')
  const subject = show(path.join('.claude', 'CLAUDE.md'))
  const routing = readTextOr(source, null)
  if (routing === null) {
    return report.add('error', subject, `no routing policy at ${show(source)} — the suite install is incomplete`)
  }
  const block = routingBlock(routing)
  const dest = path.resolve(repo, '.claude', 'CLAUDE.md')
  const existing = readTextOr(dest, null)

  if (existing === null) {
    if (check) {
      return report.add('missing', subject,
        'does not exist — the routing policy binds the caller, and an orchestrator ' +
        'table only fires if something invokes the orchestrator')
    }
    writeText(dest, `Agent routing policy for this repository.\n\n${block}`)
    return report.add('created', subject, `routing policy installed from ${show(path.relative(SUITE_ROOT, source))}`)
  }

  const start = existing.indexOf(ROUTING_START)
  const end = existing.indexOf(ROUTING_END)

  if (start === -1 || end === -1 || end < start) {
    // The file is the adopter's. Append under the marker; never rewrite it.
    if (check) {
      return report.add('missing', subject,
        `exists but carries no ${ROUTING_START} block — the routing policy is not installed`)
    }
    const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
    writeText(dest, `${existing}${sep}${block}`)
    return report.add('appended', subject, 'routing policy appended under its marker; the rest of the file untouched')
  }

  const current = existing.slice(start, end + ROUTING_END.length)
  if (current.trimEnd() === block.trimEnd()) {
    return report.add('exists', subject, 'routing policy present and current')
  }
  if (check) {
    // A warning, not a failure. A one-version-behind routing policy still binds
    // the caller; a missing memory root loses every write. Different severities.
    return report.add('stale', subject, `routing block differs from ${show(path.relative(SUITE_ROOT, source))} — re-run init to refresh it`)
  }
  writeText(dest, existing.slice(0, start) + block.trimEnd() + '\n' + existing.slice(end + ROUTING_END.length).replace(/^\n/, ''))
  return report.add('updated', subject, 'routing block refreshed between its markers; everything outside untouched')
}

// --------------------------------------------------------------------------- //
// Step 4 — run state out of version control
// --------------------------------------------------------------------------- //

function stepRuns(report, { repo, check }) {
  // From _state.js rather than a second hardcoding of '.claude/runs'.
  const { RUNS_DIR_NAME } = require(path.join(SUITE_ROOT, 'workflows', '_state.js'))
  const rel = path.join(RUNS_DIR_NAME, '.gitignore')
  const subject = show(rel)
  const dest = path.resolve(repo, rel)
  const existing = readTextOr(dest, null)

  if (existing !== null) {
    return report.add('exists', subject, 'run state excluded from version control')
  }
  if (check) {
    return report.add('missing', subject,
      `absent — every run writes a transcript under ${show(RUNS_DIR_NAME)}/ and it would be committed`)
  }
  writeText(dest, RUNS_GITIGNORE)
  return report.add('created', subject, 'run state excluded from version control')
}

// --------------------------------------------------------------------------- //
// Step 5 — permissions (checked, never written)
// --------------------------------------------------------------------------- //

/**
 * A warning, never a failure.
 *
 * `USAGE.md` records that a call which would prompt interactively "fails or
 * stalls headless", and a stall in an unattended run is the worst outcome
 * available. But a missing allowlist entry is not something init can fix: the
 * right allowlist depends on what the repository's own build and test commands
 * are, and guessing one and writing it into somebody's settings would be a
 * silent widening of what agents may run here.
 *
 * The review's illustrative output also showed a per-entry coverage check
 * (`does not cover Bash(npm test *)`). That is deliberately NOT implemented:
 * it needs both the project's test command and Claude Code's permission-pattern
 * grammar, and neither was verified. Reporting presence and a count is what can
 * be said truthfully.
 */
function stepPermissions(report) {
  return function run({ repo }) {
    const candidates = ['settings.json', 'settings.local.json']
    const found = []
    let total = 0
    let broken = null

    for (const name of candidates) {
      const file = path.resolve(repo, '.claude', name)
      const raw = readTextOr(file, null)
      if (raw === null) continue
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (e) {
        broken = broken || `${show(path.join('.claude', name))} is not valid JSON — ${e.message}`
        continue
      }
      const allow = parsed && parsed.permissions && parsed.permissions.allow
      const n = Array.isArray(allow) ? allow.length : 0
      if (n > 0) found.push(`${show(path.join('.claude', name))} (${n})`)
      total += n
    }

    const subject = show(path.join('.claude', 'settings.json'))
    if (broken) {
      return report.add('warn', subject,
        `${broken} — an unattended run may stall on the first permission prompt`)
    }
    if (total === 0) {
      return report.add('warn', subject,
        'no permissions.allow entries found — every Bash or Write call that would ' +
        'prompt interactively fails or stalls headless. Run /fewer-permission-prompts ' +
        'to generate a starting allowlist.')
    }
    return report.add('checked', found.join(' + '), `permissions.allow present, ${total} entries`)
  }
}

// --------------------------------------------------------------------------- //
// CLI
// --------------------------------------------------------------------------- //

export function runInit({ repo = process.cwd(), project, check = false } = {}) {
  const report = new Report()
  const ctx = { repo, project, check }
  stepMemory(report, ctx)
  stepAutonomy(report, ctx)
  stepRouting(report, ctx)
  stepRuns(report, ctx)
  stepPermissions(report)(ctx)
  return report
}

function parseArgs(argv) {
  const out = { check: false, project: undefined, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') out.check = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--project') { out.project = argv[++i] }
    else if (a.startsWith('--project=')) { out.project = a.slice('--project='.length) }
    else return { error: `unknown argument ${JSON.stringify(a)}` }
  }
  return out
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.error) {
    process.stderr.write(`init: ${args.error}\n\n${USAGE}\n`)
    return 2
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const bad = validateProject(args.project)
  if (bad) {
    process.stderr.write(`init: ${bad}\n\n${USAGE}\n`)
    return 2
  }

  const report = runInit({ repo: process.cwd(), project: args.project, check: args.check })
  const mode = args.check ? 'check' : 'scaffold'
  process.stdout.write(`sdlc-suite init (${mode}) — project "${args.project}" in ${show(process.cwd())}\n`)
  process.stdout.write(`${report.render()}\n`)
  return report.ready ? 0 : 1
}

// `process.argv[1]` is the script path when invoked directly; the test imports
// this module instead and never reaches here.
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}

export { validateProject, ROUTING_START, ROUTING_END, SUITE_ROOT }
