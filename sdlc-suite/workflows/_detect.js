'use strict'

/**
 * Stage 6 — Maintain: the DETECTOR. A script, not a model.
 *
 *     node sdlc-suite/workflows/_detect.js [--cwd <dir>] [--config <file>] [--incident "<text>"] [--trust-head]
 *
 * Exit codes — the exit code IS the result, so a cron job or CI gate can read it:
 *   0  every configured source was checked and none signalled
 *   1  at least one signal (JSON on stdout)
 *   2  the config could not be read, or is malformed — this outranks a
 *      signal: a cron job reading 2 must fix the config (and a manual
 *      --incident with a broken config therefore also exits 2)
 *   3  no signal, BUT at least one source could not be checked — not healthy.
 *      "Could not look" must never read as "looked and found nothing".
 *
 * WHY A SCRIPT. Detection runs constantly and almost always finds nothing; a
 * model spent on "is CI still green?" is the most expensive possible way to
 * learn "yes". `/sdlc-maintain` spends a strong model only once this has found
 * something.
 *
 * FOUR SOURCES, each optional:
 *   ci      — the latest completed run of each GitHub Actions workflow on a
 *             branch (`gh run list`), counting ONLY push, schedule,
 *             workflow_dispatch and merge_group events whose head branch is
 *             that branch. An allowlist, not a blocklist: pull_request,
 *             issue_comment and workflow_run runs can be started or titled by
 *             outsiders, and must not be able to turn the branch red.
 *   health  — commands from the repo's config; non-zero exit or timeout = signal.
 *   logs    — files inside the repo, tail only, scanned for regex patterns.
 *   manual  — `--incident "<text>"`: a human report, always a signal.
 *
 * CONFIG: `.claude/maintain.json` (or `--config`, which must also resolve
 * inside the repository). With no config file, only `ci` runs, with defaults.
 *   { "ci":     { "enabled": true, "branch": "main", "limit": 20 },
 *     "health": [ { "name": "unit tests", "command": "npm test", "timeoutSec": 90 } ],
 *     "logs":   [ { "path": "logs/app.log", "patterns": ["ERROR"], "tailLines": 2000, "maxMatches": 20 } ] }
 *
 * TRUST — health commands are executed through a shell, so the config that
 * names them is an EXECUTION input (security review F2):
 *   - they run only when the config file's BYTES equal its committed blob at
 *     HEAD AND its blob on the repository's default branch, read from
 *     `refs/remotes/origin/HEAD` — a reference the config cannot choose (QA +
 *     security round 3: anchoring on the config's own `ci.branch` let a PR
 *     point it at itself). Bytes, not `git diff`: assume-unchanged and
 *     skip-worktree hide an edit from git status but not from this. With no
 *     origin/HEAD (a single-branch CI clone, a repo with no remote) nothing is
 *     armed unless the caller opts in with `--trust-head` / `trustHead: true`,
 *     which trusts the committed HEAD alone — for a CI job on the default
 *     branch, where HEAD already IS the reviewed version.
 *   - what a command RUNS is not checked: a committed `npm test` executes
 *     whatever package.json and the test files hold in the working tree.
 *     Treat arming a health command like adding a CI step.
 *   - they run with secret-shaped environment variables removed (see
 *     SECRET_ENV: tokens, secrets, passwords, keys, credentials, auth, DSNs,
 *     cookies, database URLs, webhooks, kube/ssh/docker auth). It is a name
 *     pattern list — a secret under an innocent name still passes. A check that
 *     needs one should not be a health check here.
 *   - they still run as the invoking user, with that user's filesystem
 *     access. That is wider than a CI step, and it is the price of running
 *     locally; prefer running this CLI inside CI for anything substantial.
 * Log paths and `--config` are confined to the repository root: an absolute
 * path, a `..` escape, a UNC root or a link resolving outside it is refused.
 *
 * EVIDENCE IS DATA. Everything a signal carries is later handed to a model.
 * Every string field is redacted (`redact()`) and capped here, and the
 * workflow never shows it to its transcriber in readable form. Redaction is a
 * best-effort pattern list, not a guarantee. It runs line by line on lines cut
 * to LINE_CAP, with bounded quantifiers, so its cost is linear in the input
 * (security N2: the earlier patterns were quadratic — 6 s for one 80K line).
 *
 * KNOWN LIMIT: on Windows a timed-out health command's own child processes may
 * outlive it (the timeout kills the shell, not its descendants).
 */

const fs = require('fs')
const path = require('path')
const { spawnSync, execFileSync } = require('child_process')
const crypto = require('crypto')

const CONFIG_REL = path.join('.claude', 'maintain.json')
const EVIDENCE_CAP = 4000
const FIELD_CAP = 300
const LOG_TAIL_BYTES = 4 * 1024 * 1024
const DEFAULTS = {
  ci: { enabled: true, branch: 'main', limit: 20 },
  // Short by default: under /sdlc-maintain the detector runs inside a bridge
  // agent's shell call, which has its own (~2 minute) ceiling. A long suite
  // belongs in CI, running this file's CLI there; set timeoutSec explicitly.
  healthTimeoutSec: 90,
  tailLines: 2000,
  maxMatches: 20,
}
// `action_required` is NOT a failure: it is a run waiting for a maintainer to
// approve it — on a public repo, typically a first-time contributor's PR.
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure'])
// A run that did not finish its work says nothing about the branch: the
// workflow's latest CONCLUSIVE run is the one that counts (QA round 3).
const INCONCLUSIVE = new Set(['cancelled', 'skipped', 'neutral', 'stale', 'action_required'])
const TRUSTED_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch', 'merge_group'])
// `PAT` and `KEY` only as whole underscore-separated words, so PATH and
// KEYBOARD_* survive.
const SECRET_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|(^|_)PASS($|_)|PGPASS|(^|_)PWD$|CREDENTIAL|(^|_)PAT($|_)|(^|_)KEY($|_)|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SESSION_?KEY|SIGNING|ENCRYPTION|CLIENT_?KEY|(^|_)AUTH|DSN|COOKIE|(^|_)JWT($|_)|WEBHOOK|DATABASE_UR[LI]|CONNECTION_?STRING|_URI$|(^|_)(REDIS|MONGO|MONGODB|AMQP|POSTGRES|PG|MYSQL)_UR[LI]$|NETRC|SERVICE_ROLE|KUBECONFIG|SSH_AUTH_SOCK|AWS_PROFILE|DOCKER_?CONFIG|DOCKER_AUTH/i
// Names the pattern above would catch that carry no secret.
const ENV_KEEP = new Set(['PWD', 'OLDPWD', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE'])
const KNOWN_KEYS = new Set(['ci', 'health', 'logs'])
const LINE_CAP = 2000

// ---------------------------------------------------------------------------
// Redaction. Order matters: the specific token shapes and the scheme-bearing
// header forms run BEFORE the generic key=value rule, which would otherwise
// consume the word "Bearer" and leave the token itself behind (QA + security
// review, verified: `Authorization: Bearer <opaque>` leaked).
// ---------------------------------------------------------------------------
// Bounded quantifiers everywhere: an unbounded `[A-Za-z0-9_.-]*` on both sides
// of the key made a long run of word characters quadratic (security N2).
const KEYISH = '[A-Za-z0-9_.-]{0,40}(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth|signing[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]{0,40}'
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,20000}?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/^[A-Za-z0-9+/=]{60,}$/gm, '[REDACTED BASE64 BLOCK]'],
  // The whole value of an Authorization header, whatever its scheme.
  [/\b(authorization\s*:\s*)[^\r\n]{1,4096}/gi, '$1[REDACTED]'],
  // A scheme-prefixed credential elsewhere. The value must contain a digit, so
  // prose like "Basic setup" or "token format" is not mistaken for one.
  [/\b([Bb]earer|[Bb]asic|[Dd]igest)\s*:?\s+(?=[A-Za-z._~+/=-]{0,4096}\d)[A-Za-z0-9._~+/=-]{8,4096}/g, '$1 [REDACTED]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g, '[REDACTED]'],
  [/\bglpat-[A-Za-z0-9_-]{20,255}\b/g, '[REDACTED]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED]'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,255}\b/g, '[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{20,255}\b/g, '[REDACTED]'],
  [/\bSG\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{16,64}\b/g, '[REDACTED]'],
  [/\bhf_[A-Za-z0-9]{30,64}\b/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/g, '[REDACTED]'],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{1,255}/g, '[REDACTED SLACK WEBHOOK]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\b/g, '[REDACTED]'],
  // URL userinfo, empty user and an `@` inside the password included:
  // scheme://[user]:password@host — up to the LAST @ before the path.
  [/\b([a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{0,128}:)[^\s/]{1,256}@/gi, '$1[REDACTED]@'],
  // Cookies: every name=value pair after the header.
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]{1,4096}/gi, '$1[REDACTED]'],
  // Azure-style connection strings and SAS signatures
  [/\b(AccountKey|SharedAccessKey|Password|Pwd)=([^;\s]{1,1024})/gi, '$1=[REDACTED]'],
  [/([?&]sig=)[^&\s]{1,1024}/gi, '$1[REDACTED]'],
  // CLI forms: curl -u user:pass, mysql -pPASS, --password value, --token=value
  [/(\s-u\s+)[^\s:]{1,128}:\S{1,256}/g, '$1[REDACTED]'],
  [/(\bmysql\b[^\n]{0,200}?\s-p)(\S{1,256})/g, '$1[REDACTED]'],
  [new RegExp(`(--?${KEYISH})(=|\\s+)("[^"\\n]{0,1024}"|'[^'\\n]{0,1024}'|\\S{1,1024})`, 'gi'), '$1$2[REDACTED]'],
  // key: value / key=value — the key optionally quoted (JSON) or escape-quoted
  // (JSON inside a JSON string), the value optionally quoted
  [new RegExp(`((?:\\\\?["'])?${KEYISH}(?:\\\\?["'])?\\s{0,8}[:=]\\s{0,8})(\\\\?"[^"\\n]{0,1024}?\\\\?"|'[^'\\n]{0,1024}'|[^\\s,;}&]{1,1024})`, 'gi'), '$1[REDACTED]'],
  [/\b(secret_key_base\s+)\S{1,1024}/gi, '$1[REDACTED]'],
]

function redactLine(line) {
  let s = line.length > LINE_CAP ? `${line.slice(0, LINE_CAP)}…[line cut at ${LINE_CAP} chars]` : line
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep)
  return s
}

function redact(text) {
  const s = String(text ?? '')
  // A private key spans lines: redact multi-line PEM blocks first, then the
  // rest line by line under the per-line cap.
  const pem = s.replace(SECRET_PATTERNS[0][0], SECRET_PATTERNS[0][1])
  return pem.split('\n').map(redactLine).join('\n')
}

function cap(text, n = EVIDENCE_CAP) {
  const s = String(text ?? '')
  if (s.length <= n) return s
  // Keep the TAIL: the end of a failing run is where the error is.
  return `…[${s.length - n} chars elided]\n` + s.slice(s.length - n)
}

// Cut to a bounded tail at a line boundary BEFORE redacting: redaction is
// linear, but over 16 MB of health output it is still seconds (security N2).
const PRE_REDACT = 64 * 1024
function preCut(text) {
  const s = String(text ?? '')
  if (s.length <= PRE_REDACT) return s
  const t = s.slice(s.length - PRE_REDACT)
  const nl = t.indexOf('\n')
  return nl >= 0 ? t.slice(nl + 1) : t
}
const evidence = text => cap(redact(preCut(text)))
const field = text => cap(redact(preCut(text)), FIELD_CAP)

/** Resolve a path, refusing anything outside the repository root. */
function confinedPath(cwd, rel) {
  if (typeof rel !== 'string' || !rel) return { error: 'empty path' }
  if (/^[\\/]{2}/.test(rel)) return { error: `${rel}: UNC and protocol-relative paths are refused` }
  if (path.isAbsolute(rel) || /^[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel)) {
    return { error: `${rel}: absolute paths are refused — use a path inside the repository` }
  }
  let root
  try { root = fs.realpathSync(cwd) } catch (e) { return { error: `cannot resolve the repository root ${cwd}: ${e.message}` } }
  const inside = p => p === root || p.startsWith(root + path.sep)
  const abs = path.resolve(root, rel)
  if (!inside(abs)) return { error: `${rel}: resolves outside the repository` }
  let real
  try { real = fs.realpathSync(abs) } catch (e) { return { missing: true, abs } }
  if (!inside(real)) return { error: `${rel}: is a link to a location outside the repository` }
  return { abs: real }
}

/**
 * Read and validate the config. Returns {config, source, errors, path}. A
 * missing DEFAULT file is not an error — it means "CI only, defaults". An
 * unreadable or malformed one IS: silently falling back to defaults would
 * report "healthy" for a repo whose health checks never ran.
 */
function loadConfig({ cwd, configPath } = {}) {
  const rel = configPath || CONFIG_REL
  const c0 = confinedPath(cwd, rel)
  if (c0.error) return { config: null, source: rel, errors: [`config: ${c0.error}`] }
  if (c0.missing) {
    if (!configPath) return { config: { ci: { ...DEFAULTS.ci }, health: [], logs: [] }, source: null, errors: [], path: null }
    return { config: null, source: rel, errors: [`config: cannot read ${rel}: not found`] }
  }
  let raw
  try {
    raw = fs.readFileSync(c0.abs, 'utf8')
  } catch (e) {
    return { config: null, source: rel, errors: [`config: cannot read ${rel}: ${e.code || e.message}`] }
  }
  let c
  try {
    c = JSON.parse(raw)
  } catch (e) {
    // The parser's message quotes the offending input; the file may hold a
    // secret, so only its position is kept.
    const at = /position (\d+)/.exec(String(e.message))
    return { config: null, source: rel, errors: [`config: ${rel} is not valid JSON${at ? ` (at position ${at[1]})` : ''}`] }
  }
  const errors = []
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { config: null, source: rel, errors: [`config: ${rel} must be a JSON object`] }
  // A section of the wrong type, or a key nobody reads, is a malformed config:
  // silently ignoring `"health": {...}` or `"healthchecks": [...]` reported a
  // repo whose checks never ran as healthy (QA, round 2, D1).
  const shape = []
  for (const k of Object.keys(c)) if (!KNOWN_KEYS.has(k)) shape.push(`unknown key ${field(JSON.stringify(k))}`)
  if ('ci' in c && (c.ci === null || typeof c.ci !== 'object' || Array.isArray(c.ci))) shape.push('"ci" must be an object')
  else if (c.ci && 'enabled' in c.ci && typeof c.ci.enabled !== 'boolean') shape.push('"ci.enabled" must be true or false')
  if ('health' in c && !Array.isArray(c.health)) shape.push('"health" must be an array')
  if ('logs' in c && !Array.isArray(c.logs)) shape.push('"logs" must be an array')
  if (shape.length) return { config: null, source: rel, errors: [`config: ${rel} is malformed — ${shape.join('; ')}`] }

  const ci = { ...DEFAULTS.ci, ...(c.ci && typeof c.ci === 'object' ? c.ci : {}) }
  ci.enabled = ci.enabled !== false
  if (ci.enabled && (typeof ci.branch !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(ci.branch) || ci.branch.startsWith('-'))) {
    errors.push(`ci: branch ${field(JSON.stringify(ci.branch))} is not a plain branch name — CI not checked`)
    ci.enabled = false
  }
  ci.limit = Number.isInteger(ci.limit) && ci.limit > 0 && ci.limit <= 100 ? ci.limit : DEFAULTS.ci.limit

  const health = []
  for (const [i, h] of (Array.isArray(c.health) ? c.health : []).entries()) {
    if (!h || typeof h.command !== 'string' || !h.command.trim()) { errors.push(`health[${i}]: no command — not checked`); continue }
    const t = Number(h.timeoutSec)
    health.push({
      name: typeof h.name === 'string' && h.name ? h.name : `health[${i}]`,
      command: h.command,
      timeoutSec: Number.isFinite(t) && t > 0 ? Math.min(t, 3600) : DEFAULTS.healthTimeoutSec,
    })
  }

  const logs = []
  for (const [i, l] of (Array.isArray(c.logs) ? c.logs : []).entries()) {
    if (!l || typeof l.path !== 'string' || !l.path) { errors.push(`logs[${i}]: no path — not checked`); continue }
    const pats = Array.isArray(l.patterns) && l.patterns.length ? l.patterns : ['ERROR', 'FATAL', 'Traceback', 'Unhandled']
    const regexes = []
    for (const pt of pats) {
      try { regexes.push(new RegExp(String(pt))) } catch (e) { errors.push(`logs[${i}]: pattern ${field(JSON.stringify(pt))} is not a valid regex`) }
    }
    if (!regexes.length) { errors.push(`logs[${i}] ${field(l.path)}: no valid pattern — not checked`); continue }
    logs.push({
      path: l.path,
      patterns: regexes,
      tailLines: Number.isInteger(l.tailLines) && l.tailLines > 0 ? Math.min(l.tailLines, 100000) : DEFAULTS.tailLines,
      maxMatches: Number.isInteger(l.maxMatches) && l.maxMatches > 0 ? Math.min(l.maxMatches, 200) : DEFAULTS.maxMatches,
    })
  }
  return { config: { ci, health, logs }, source: rel, errors, path: c0.abs }
}

/**
 * Is the config file tracked by git and identical to HEAD? Only then may it
 * arm shell commands. Returns null when it may, or the reason it may not.
 */
function configUntrustedReason(cwd, absPath, { trustHead = false, run = execFileSync } = {}) {
  if (!absPath) return { reason: 'no config file', fix: 'add .claude/maintain.json' }
  const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
  const git = (...a) => String(run('git', a, opts)).trim()
  let rel
  try {
    rel = path.relative(fs.realpathSync(cwd), absPath).split(path.sep).join('/')
  } catch (e) {
    return { reason: 'the config path could not be resolved', fix: 'check the repository path' }
  }
  let atHead
  try {
    atHead = git('rev-parse', '--verify', '--quiet', `HEAD:./${rel}`)
  } catch (e) {
    return { reason: 'the config file is not committed at HEAD', fix: 'commit it' }
  }
  // The blob id is computed HERE from the exact bytes on disk. `git
  // hash-object` would run the working tree's clean/ident filters first, and an
  // `ident` attribute folds "$Id: anything $" back onto the committed "$Id$"
  // (security round 4, R4-1). An autocrlf checkout of an LF blob still matches.
  let buf
  try { buf = fs.readFileSync(absPath) } catch (e) { return { reason: 'the config file could not be read', fix: 'check its permissions' } }
  const algo = atHead.length === 64 ? 'sha256' : 'sha1'
  const blob = b => crypto.createHash(algo).update(`blob ${b.length}\0`).update(b).digest('hex')
  const lf = Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
  const onDiskIds = [blob(buf), blob(lf)]
  if (!onDiskIds.includes(atHead)) return { reason: 'the config file differs from its committed version at HEAD', fix: 'commit or discard the edit' }
  const onDisk = atHead
  // The anchor is the repository's default branch as origin reports it — not
  // anything the config under test declares.
  let anchor = null
  try { anchor = git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD') } catch (e) { anchor = null }
  if (!anchor) {
    if (trustHead) return null
    return {
      reason: 'there is no refs/remotes/origin/HEAD to compare it with, so its review status is unknown',
      fix: 'run `git remote set-head origin --auto`, or pass --trust-head when this checkout IS the default branch (e.g. a CI job on main)',
    }
  }
  let there = null
  try { there = git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/HEAD:./${rel}`) } catch (e) { there = null }
  if (there !== onDisk) return { reason: 'the config file differs from its version on the default branch (origin/HEAD)', fix: 'merge it to the default branch' }
  return null
}

function scrubbedEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (ENV_KEEP.has(k) || !SECRET_ENV.test(k)) out[k] = v
  return out
}

function checkCi(cwd, ci, run = execFileSync) {
  if (!ci.enabled) return { signals: [], checked: [], errors: [] }
  let out
  try {
    out = run('gh', ['run', 'list', '--branch', ci.branch, '--limit', String(ci.limit),
      '--json', 'databaseId,workflowName,status,conclusion,headSha,headBranch,event,url,createdAt,displayTitle'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
  } catch (e) {
    // gh missing or unauthenticated is a DETECTOR gap, never "CI is green".
    return { signals: [], checked: [], errors: [`ci: gh run list failed — ${field(String((e && e.stderr) || (e && e.message) || e).trim())}`] }
  }
  let runs
  try { runs = JSON.parse(out) } catch (e) { return { signals: [], checked: [], errors: ['ci: gh returned output that is not JSON'] } }
  if (!Array.isArray(runs)) return { signals: [], checked: [], errors: ['ci: gh returned something other than a list of runs'] }
  // Newest first, per gh's ordering. Only allowlisted events (see the header)
  // whose head branch IS the branch asked for; a run without one is dropped.
  const latest = new Map()
  for (const r of runs) {
    if (!r || r.status !== 'completed') continue
    if (!TRUSTED_EVENTS.has(String(r.event || ''))) continue
    // merge_group runs carry the queue's branch, gh-readonly-queue/<branch>/…
    const onBranch = r.headBranch === ci.branch ||
      (r.event === 'merge_group' && typeof r.headBranch === 'string' && r.headBranch.startsWith(`gh-readonly-queue/${ci.branch}/`))
    if (!onBranch) continue
    if (INCONCLUSIVE.has(String(r.conclusion || ''))) continue
    if (!latest.has(r.workflowName)) latest.set(r.workflowName, r)
  }
  if (!latest.size) {
    // Zero runs is "could not look", not "green": a wrong default branch, a
    // repo without Actions, or a limit window full of PR runs all land here.
    return { signals: [], checked: [], errors: [`ci: no completed push, schedule, workflow_dispatch or merge_group run found on ${ci.branch} in the last ${ci.limit} runs — check ci.branch and ci.limit`] }
  }
  const signals = []
  for (const r of latest.values()) {
    if (FAILED_CONCLUSIONS.has(r.conclusion)) {
      signals.push({
        source: 'ci', name: field(r.workflowName),
        detail: `latest ${field(r.event || 'run')} run on ${ci.branch} concluded ${field(r.conclusion)}`,
        evidence: evidence(`${r.displayTitle || ''}\n${r.url || ''}\nsha ${r.headSha || '?'} at ${r.createdAt || '?'}`),
        ref: r.url ? field(r.url) : null,
      })
    }
  }
  return { signals, checked: [`ci:${ci.branch} (${latest.size} workflow(s))`], errors: [] }
}

function checkHealth(cwd, health, { run = spawnSync, untrusted = null, env = scrubbedEnv() } = {}) {
  if (!health.length) return { signals: [], checked: [], errors: [] }
  if (untrusted) {
    return {
      signals: [], checked: [],
      errors: [`health: ${health.length} command(s) NOT run — ${untrusted.reason}. To arm them: ${untrusted.fix}. Commands: ${health.map(h => field(h.command)).join(' | ')}`],
    }
  }
  const signals = []
  const checked = []
  for (const h of health) {
    const r = run(h.command, { cwd, shell: true, encoding: 'utf8', env, timeout: h.timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024 })
    checked.push(`health:${field(h.name)}`)
    const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM'
    if (timedOut || r.status !== 0) {
      signals.push({
        source: 'health', name: field(h.name),
        detail: timedOut ? `timed out after ${h.timeoutSec}s` : `exited ${r.status === null ? `on signal ${r.signal}` : r.status}`,
        evidence: evidence(`$ ${h.command}\n${r.stdout || ''}\n${r.stderr || ''}${r.error && !timedOut ? `\n${r.error.message}` : ''}`),
        ref: null,
      })
    }
  }
  return { signals, checked, errors: [] }
}

/** The last `maxBytes` of a file, without reading the whole of it. */
function readTail(abs, maxBytes = LOG_TAIL_BYTES) {
  const fd = fs.openSync(abs, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    let s = buf.toString('utf8')
    // Started mid-file: the first line is partial, drop it.
    if (size > len) s = s.slice(s.indexOf('\n') + 1)
    return s
  } finally {
    fs.closeSync(fd)
  }
}

function checkLogs(cwd, logs) {
  const signals = []
  const checked = []
  const errors = []
  for (const l of logs) {
    const c = confinedPath(cwd, l.path)
    if (c.error) { errors.push(`logs: ${field(c.error)}`); continue }
    // A configured log that does not exist is a gap, not a clean log: a typo
    // in the path would otherwise mean that log is silently never checked.
    if (c.missing) { errors.push(`logs: ${field(l.path)} does not exist — not checked`); continue }
    let text
    try { text = readTail(c.abs) } catch (e) { errors.push(`logs: cannot read ${field(l.path)}: ${e.code || e.message}`); continue }
    checked.push(`log:${field(l.path)}`)
    const lines = text.split(/\r?\n/)
    const tail = lines.slice(Math.max(0, lines.length - l.tailLines))
    const hits = tail.filter(line => l.patterns.some(re => re.test(line)))
    if (hits.length) {
      // The NEWEST matches: the end of a log is where the current error is.
      const kept = hits.slice(-l.maxMatches)
      signals.push({
        source: 'logs', name: field(l.path),
        detail: `${hits.length} matching line(s) in the last ${tail.length} lines${hits.length > kept.length ? `; the newest ${kept.length} kept` : ''}`,
        evidence: evidence(kept.join('\n')),
        ref: field(l.path),
      })
    }
  }
  return { signals, checked, errors }
}

/**
 * Run every configured check. Never throws for an individual check: a check
 * that could not run lands in `errors`, so "nothing found" and "could not
 * look" stay distinguishable.
 */
function detect({ cwd = process.cwd(), configPath = null, incident = null, trustHead = false, _exec = {} } = {}) {
  const loaded = loadConfig({ cwd, configPath })
  const out = { signals: [], checked: [], errors: [...loaded.errors], configSource: loaded.source }
  if (typeof incident === 'string' && incident.trim()) {
    out.signals.push({ source: 'manual', name: 'reported incident', detail: 'reported by a person', evidence: evidence(incident), ref: null })
    out.checked.push('manual')
  }
  if (!loaded.config) return out
  const untrusted = loaded.config.health.length
    ? configUntrustedReason(cwd, loaded.path, { trustHead, run: _exec.git || execFileSync })
    : null
  for (const r of [
    checkCi(cwd, loaded.config.ci, _exec.execFileSync),
    checkHealth(cwd, loaded.config.health, { run: _exec.spawnSync, untrusted }),
    checkLogs(cwd, loaded.config.logs),
  ]) {
    out.signals.push(...r.signals)
    out.checked.push(...r.checked)
    out.errors.push(...r.errors)
  }
  if (!out.checked.length && !out.signals.length && !out.errors.length) {
    out.errors.push('nothing was checked — CI is disabled and no health command or log is configured')
  }
  return out
}

/** The CLI's exit code for a detect() result. See the header. */
function exitCodeFor(r) {
  if (r.errors.some(e => e.startsWith('config:'))) return 2
  if (r.signals.length) return 1
  if (r.errors.length) return 3
  return 0
}

module.exports = {
  detect, loadConfig, redact, cap, confinedPath, configUntrustedReason, scrubbedEnv,
  checkCi, checkHealth, checkLogs, readTail, exitCodeFor, CONFIG_REL,
}

if (require.main === module) {
  const argv = process.argv.slice(2)
  const opt = name => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : null
  }
  const cwd = path.resolve(opt('--cwd') || process.cwd())
  const r = detect({ cwd, configPath: opt('--config'), incident: opt('--incident'), trustHead: argv.includes('--trust-head') })
  process.stdout.write(JSON.stringify(r, null, 2) + '\n')
  process.exitCode = exitCodeFor(r)
}
