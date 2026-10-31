'use strict'

/**
 * Replay evals for the workflow runtime. Run with `node sdlc-suite/evals/replay.test.js`.
 *
 *   --cases <file>   dataset (default: cases.v1.json beside this file)
 *   --src <dir>      workflow tree to evaluate (default: sdlc-suite/workflows)
 *   --case <id>      run one case only
 *
 * The agents in this suite are prompts; what code decides is how their output
 * becomes a run's result: which gates were hit (`_policy.collectBlockedGates`),
 * how a failed call is classified and retried (`_failure.classify`/`withRetry`),
 * and what a learning file may put into later prompts (`_learnings.parseLearning`).
 * Each case replays one model- or CLI-produced text through that code and checks
 * the decision with deterministic graders (exact, regex, rule). No model is
 * called, no clock or randomness is used, and the exit code is the result: the
 * blocking threshold is every case passing.
 *
 * No test framework, for the same reason as the module suites next door: this
 * repository has no package.json.
 */

const fs = require('fs')
const path = require('path')
const util = require('util')

const args = process.argv.slice(2)
function opt(name, dflt) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const CASES = path.resolve(opt('--cases', path.join(__dirname, 'cases.v1.json')))
const SRC = path.resolve(opt('--src', path.join(__dirname, '..', 'workflows')))
const ONLY = opt('--case', null)

const policy = require(path.join(SRC, '_policy.js'))
const failure = require(path.join(SRC, '_failure.js'))
const learnings = require(path.join(SRC, '_learnings.js'))

const show = v => util.inspect(v, { depth: 6, breakLength: Infinity })
const rel = p => path.relative(process.cwd(), p) || p

/** Dataset shape. Errors name the case, so a bad case is fixed where it is written. */
const KINDS = {
  'blocked-gates': c => Array.isArray(c.phaseOutputs) && Array.isArray(c.expect.gates),
  'failure-class': c => c.failure && typeof c.failure === 'object' && typeof c.expect.class === 'string',
  'retry': c => Array.isArray(c.attempts) && c.attempts.length > 0 && typeof c.expect.ok === 'boolean',
  'learning': c => typeof c.text === 'string',
}

function validateDataset(data) {
  const errors = []
  if (data.version !== 1) errors.push(`version: expected 1, actual ${show(data.version)}`)
  if (!Array.isArray(data.cases) || !data.cases.length) return errors.concat('cases: expected a non-empty array')
  const ids = new Set()
  data.cases.forEach((c, i) => {
    const where = `cases[${i}] (${c && c.id})`
    if (!c || typeof c.id !== 'string' || !/^[a-z0-9-]+$/.test(c.id)) errors.push(`${where}: id must be kebab-case`)
    else if (ids.has(c.id)) errors.push(`${where}: duplicate id`)
    else ids.add(c.id)
    if (!c || !KINDS[c.kind]) errors.push(`${where}: unknown kind ${show(c && c.kind)}, expected one of ${Object.keys(KINDS).join(', ')}`)
    else if (!c.expect || typeof c.expect !== 'object') errors.push(`${where}: missing expect`)
    else if (!KINDS[c.kind](c)) errors.push(`${where}: malformed ${c.kind} case`)
  })
  return errors
}

// --- graders: each returns a list of "what: expected X, actual Y" strings ---

function exact(what, expected, actual) {
  return util.isDeepStrictEqual(expected, actual) ? [] : [`${what}: expected ${show(expected)}, actual ${show(actual)}`]
}

function regex(what, pattern, actual) {
  return typeof actual === 'string' && new RegExp(pattern).test(actual)
    ? [] : [`${what}: expected to match /${pattern}/, actual ${show(actual)}`]
}

function notRegex(what, pattern, actual) {
  return typeof actual === 'string' && !new RegExp(pattern).test(actual)
    ? [] : [`${what}: expected NOT to match /${pattern}/, actual ${show(actual)}`]
}

// Rule: every BLOCKED marker line in the replayed text is accounted for. A gate
// may be deduplicated, never dropped, so the distinct (gate, action) pairs found
// must equal the distinct markers present. Catches a reducer change that loses
// entries even when a case's own `gates` list was written too permissively.
const MARKER = /^[ \t]*BLOCKED[ \t]*[—–-][ \t]*([\w.]+)[ \t]*$/gmi
function noGateVanishes(outputs, found) {
  const texts = []
  ;(function walk(v) {
    if (typeof v === 'string') texts.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  })(outputs)
  const markers = new Set()
  for (const t of texts) for (const m of t.matchAll(MARKER)) markers.add(m[1])
  const foundGates = new Set(found.map(f => f.gate))
  const lost = [...markers].filter(g => !foundGates.has(g))
  return lost.length ? [`rule no-gate-vanishes: markers for ${show(lost)} present in the output, absent from the result ${show([...foundGates])}`] : []
}

async function grade(c) {
  const e = c.expect
  if (c.kind === 'blocked-gates') {
    const found = policy.collectBlockedGates(c.phaseOutputs)
    const errs = exact('gates', e.gates, found.map(f => f.gate))
    for (const [gate, fields] of Object.entries(e.fields || {})) {
      const entry = found.find(f => f.gate === gate)
      if (!entry) { errs.push(`fields of ${gate}: expected an entry, actual none`); continue }
      for (const [k, pat] of Object.entries(fields)) errs.push(...regex(`${gate}.${k}`, pat, entry[k]))
    }
    return errs.concat(noGateVanishes(c.phaseOutputs, found))
  }

  if (c.kind === 'failure-class') {
    const cls = failure.classify(c.failure)
    const errs = exact('class', e.class, cls)
    const pol = failure.policyFor(cls)
    for (const k of ['maxAttempts', 'onExhausted', 'rewritePrompt']) {
      if (k in e) errs.push(...exact(`policy.${k}`, e[k], pol[k]))
    }
    return errs
  }

  if (c.kind === 'retry') {
    let calls = 0
    const seen = []
    const fn = async ({ previousFailure }) => {
      const step = c.attempts[Math.min(calls, c.attempts.length - 1)]
      calls++
      seen.push(previousFailure)
      if (step.throw) throw Object.assign(new Error(step.throw.message || ''), step.throw)
      return step.value
    }
    const res = await failure.withRetry(fn, {
      label: c.id, phase: 'eval', sleep: async () => {}, rand: () => 0,
    })
    const errs = []
    for (const k of ['ok', 'attempts', 'escalate', 'stop']) if (k in e) errs.push(...exact(k, e[k], res[k] === undefined ? null : res[k]))
    if ('calls' in e) errs.push(...exact('calls', e.calls, calls))
    if (e.secondSeesPrevious) errs.push(...exact('attempt 2 previousFailure.class', e.secondSeesPrevious, seen[1] && seen[1].class))
    return errs
  }

  if (c.kind === 'learning') {
    const l = learnings.parseLearning(c.text)
    if (e.null) return l === null ? [] : [`parseLearning: expected null, actual ${show(l)}`]
    if (!l) return [`parseLearning: expected a learning, actual null`]
    const errs = []
    if ('id' in e) errs.push(...exact('id', e.id, l.id))
    if ('appliesTo' in e) errs.push(...exact('appliesTo', e.appliesTo, l.appliesTo))
    for (const k of ['title', 'check']) if (k in e) errs.push(...regex(k, e[k], l[k]))
    for (const [k, pat] of Object.entries(e.notMatch || {})) errs.push(...notRegex(k, pat, l[k]))
    return errs
  }
  return [`unknown kind ${c.kind}`]
}

async function main() {
  const data = JSON.parse(fs.readFileSync(CASES, 'utf8'))
  const problems = validateDataset(data)
  if (problems.length) {
    console.error(`  FAIL  dataset ${rel(CASES)} is malformed`)
    for (const p of problems) console.error(`        ${p}`)
    process.exitCode = 1
    return
  }
  const cases = data.cases.filter(c => !ONLY || c.id === ONLY)
  if (ONLY && !cases.length) {
    console.error(`  FAIL  no case with id ${ONLY} in ${rel(CASES)}`)
    process.exitCode = 1
    return
  }

  console.log(`replay evals: ${rel(CASES)} v${data.version} against ${rel(SRC)}`)
  const score = {}
  let failed = 0
  for (const c of cases) {
    let errs
    try { errs = await grade(c) } catch (err) { errs = [`threw: ${err && err.stack || err}`] }
    score[c.kind] = score[c.kind] || { pass: 0, total: 0 }
    score[c.kind].total++
    if (!errs.length) {
      score[c.kind].pass++
      console.log(`  pass  ${c.id}`)
    } else {
      failed++
      console.error(`  FAIL  ${c.id} (${c.kind})${c.note ? ` — ${c.note}` : ''}`)
      for (const e of errs) console.error(`        ${e}`)
      console.error(`        rerun: node ${rel(__filename)} --case ${c.id}`)
    }
  }
  for (const [kind, s] of Object.entries(score)) console.log(`score ${kind}: ${s.pass}/${s.total}`)
  console.log(`${cases.length - failed} of ${cases.length} cases passed (threshold: all)`)
  if (failed) process.exitCode = 1
}

main().catch(err => { console.error(`  FAIL  replay evals crashed: ${err && err.stack || err}`); process.exitCode = 1 })
