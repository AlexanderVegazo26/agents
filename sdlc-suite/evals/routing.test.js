'use strict'

/**
 * Replay evals for the model-routing pins (MODEL-ROUTING.md "Changing a pin").
 *
 *   node sdlc-suite/evals/routing.test.js                 blocking: replay the recorded responses
 *   node sdlc-suite/evals/routing.test.js --live          opt-in: run each task on its pinned tier now
 *   node sdlc-suite/evals/routing.test.js --live --record same, and store the response as the new fixture
 *   --case <id>      one case only
 *   --tier <tier>    with --live: run on another tier than the agent's pin (try before moving it); never recorded
 *   --cases <file>   dataset (default: routing-cases.v1.json beside this file)
 *   --agents <dir>   agent definitions (default: sdlc-suite/agents)
 *
 * Each case is a representative task for one agent, a response recorded from
 * that agent's body run on its pinned `model:`/`effort:`, and deterministic
 * graders (regex must / must-not) for the property the pin is meant to buy:
 * qa-runner on haiku reports a failing exit status faithfully, code-reviewer on
 * opus catches a seeded authorization bug.
 *
 * The blocking run checks three things, with no model call, clock or randomness:
 *   1. the agent's current `model:`/`effort:` equals `recorded.tier`/`recorded.effort`,
 *      which only --record writes: moving a pin without re-recording (that is,
 *      without evidence the new tier passes the same task) fails here;
 *   2. the recorded response passes every grader;
 *   3. every `counterexamples` entry (the wrong answer the pin guards against)
 *      fails at least one grader, and every mustNot grader rejects at least one
 *      counterexample, so a grader that accepts anything is caught.
 * Live runs use the `claude` CLI and the caller's own login, the agent's body as
 * the system prompt and its frontmatter `tools:` (those the CLI has); a case's
 * `allowedTools` pre-approves what the task needs. --record keeps the old fixture
 * when the live response fails a grader. Never part of the blocking suite or CI.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const args = process.argv.slice(2)
const has = name => args.includes(name)
function opt(name, dflt) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const CASES = path.resolve(opt('--cases', path.join(__dirname, 'routing-cases.v1.json')))
const AGENTS = path.resolve(opt('--agents', path.join(__dirname, '..', 'agents')))
const ONLY = opt('--case', null)
const LIVE = has('--live')
const RECORD = has('--record')
const TIER = opt('--tier', null)
const TIERS = ['fable', 'opus', 'sonnet', 'haiku']
/** Claude Code built-ins a live run may get; suite-only tools (Artifact) are dropped. */
const CLI_TOOLS = new Set(['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Skill', 'WebFetch', 'WebSearch'])
const rel = p => path.relative(process.cwd(), p) || p

/** Frontmatter `model:`/`effort:`/`tools:` and the body of an agent definition. */
function readAgent(name) {
  const file = path.join(AGENTS, `${name}.md`)
  const text = fs.readFileSync(file, 'utf8')
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!m) throw new Error(`${rel(file)} has no frontmatter block`)
  const field = k => {
    const v = (new RegExp(`^${k}:[ \\t]*([^\\n#]*)`, 'm').exec(m[1]) || [])[1]
    return v === undefined ? undefined : v.trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  const tools = (field('tools') || '').split(',').map(t => t.trim()).filter(Boolean)
  return { file, model: field('model'), effort: field('effort'), tools, body: m[2] }
}

function validateDataset(data) {
  const errs = []
  if (!Array.isArray(data.cases) || !data.cases.length) return ['no "cases" array']
  const ids = new Set()
  for (const [i, c] of data.cases.entries()) {
    const at = `case[${i}] ${c.id || '(no id)'}`
    if (!c.id || ids.has(c.id)) errs.push(`${at}: missing or duplicate id`)
    ids.add(c.id)
    for (const k of ['agent', 'task']) if (typeof c[k] !== 'string' || !c[k]) errs.push(`${at}: "${k}" must be a non-empty string`)
    if (!Array.isArray(c.must) || !c.must.length) errs.push(`${at}: "must" needs at least one {what, pattern}`)
    if (!Array.isArray(c.mustNot)) errs.push(`${at}: "mustNot" must be an array`)
    if (!Array.isArray(c.counterexamples) || !c.counterexamples.length) errs.push(`${at}: "counterexamples" needs at least one wrong answer the graders must reject`)
    for (const g of [...(c.must || []), ...(c.mustNot || [])]) {
      try { new RegExp(g.pattern, g.flags ?? 'i') } catch (e) { errs.push(`${at}: grader "${g.what}" has a bad pattern: ${e.message}`) }
    }
    const r = c.recorded
    if (!LIVE && !(r && typeof r.response === 'string' && TIERS.includes(r.tier) && typeof r.effort === 'string')) {
      errs.push(`${at}: no recorded {tier, effort, response} (record one with --live --record)`)
    }
  }
  return errs
}

/** Grader failures for one response: [] means it passes. */
function gradeText(c, text) {
  const errs = []
  for (const g of c.must) {
    if (!new RegExp(g.pattern, g.flags ?? 'i').test(text)) errs.push(`must "${g.what}": /${g.pattern}/ not found`)
  }
  for (const g of c.mustNot) {
    const hit = new RegExp(g.pattern, g.flags ?? 'i').exec(text)
    if (hit) errs.push(`mustNot "${g.what}": /${g.pattern}/ matched ${JSON.stringify(hit[0])}`)
  }
  return errs
}

function runLive(c, agent, tier, effort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `routing-${c.id}-`))
  try {
    for (const [name, content] of Object.entries(c.fixtures || {})) fs.writeFileSync(path.join(dir, name), content)
    const tools = agent.tools.filter(t => CLI_TOOLS.has(t)).join(',')
    const cli = ['-p', c.task, '--model', tier, '--effort', effort, '--system-prompt', agent.body,
      '--tools', tools, '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config',
      '--setting-sources', '', '--permission-mode', 'default']
    if (c.allowedTools && c.allowedTools.length) cli.push('--allowedTools', ...c.allowedTools)
    const r = spawnSync('claude', cli, { cwd: dir, encoding: 'utf8', timeout: 600_000, maxBuffer: 32 << 20 })
    if (r.error || r.status !== 0) throw new Error(`claude exited ${r.status}: ${r.error || r.stderr.slice(-800)}`)
    const out = JSON.parse(r.stdout)
    if (out.is_error) throw new Error(`claude reported an error: ${String(out.result).slice(0, 400)}`)
    return { response: String(out.result), models: Object.keys(out.modelUsage || {}), tools: tools ? tools.split(',') : [] }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function main() {
  const data = JSON.parse(fs.readFileSync(CASES, 'utf8'))
  const bad = validateDataset(data)
  if (bad.length) {
    console.error(`  FAIL  dataset ${rel(CASES)} is malformed`)
    for (const e of bad) console.error(`        ${e}`)
    process.exitCode = 1
    return
  }
  const cases = data.cases.filter(c => !ONLY || c.id === ONLY)
  if (!cases.length) { console.error(`  FAIL  no case with id ${ONLY} in ${rel(CASES)}`); process.exitCode = 1; return }
  if (TIER && !TIERS.includes(TIER)) { console.error(`  FAIL  --tier ${TIER} is not one of ${TIERS.join('/')}`); process.exitCode = 1; return }
  if ((TIER || RECORD) && !LIVE) { console.error('  FAIL  --tier and --record need --live; without it nothing is run'); process.exitCode = 1; return }
  if (TIER && RECORD) { console.error('  FAIL  --record only stores responses from the pinned tier; drop --tier'); process.exitCode = 1; return }

  let failed = 0
  for (const c of cases) {
    const errs = []
    let agent
    try { agent = readAgent(c.agent) } catch (e) { errs.push(`agent ${c.agent}: ${e.message}`) }
    const rec = c.recorded || {}
    if (agent && !LIVE && (agent.model !== rec.tier || agent.effort !== rec.effort)) {
      errs.push(`pin moved: ${rel(agent.file)} is ${agent.model}/${agent.effort} but this case was recorded on ${rec.tier}/${rec.effort}. ` +
        `Re-record it on the new pin (--live --record --case ${c.id}) so the move has evidence (MODEL-ROUTING.md "Changing a pin").`)
    }
    for (const [i, wrong] of c.counterexamples.entries()) {
      if (!gradeText(c, wrong).length) errs.push(`grader too weak: counterexamples[${i}] (${JSON.stringify(wrong.slice(0, 80))}...) passes every grader`)
    }
    for (const g of c.mustNot) {
      const re = new RegExp(g.pattern, g.flags ?? 'i')
      if (!c.counterexamples.some(w => re.test(w))) errs.push(`grader unexercised: mustNot "${g.what}" rejects no counterexample; add the wrong answer it exists for`)
    }
    let text = rec.response
    let source = 'recorded'
    let pin = agent ? `${agent.model}/${agent.effort}` : '?'
    if (LIVE && agent) {
      const tier = TIER || agent.model
      pin = `${tier}/${agent.effort}`
      try {
        const r = runLive(c, agent, tier, agent.effort)
        text = r.response
        source = `live ${pin} (${r.models.join(', ') || 'model unknown'})`
        if (RECORD) {
          const bad = gradeText(c, r.response)
          if (bad.length) errs.push(`not recorded: the live response fails ${bad.length} grader(s); the old fixture is kept`)
          else c.recorded = { tier, effort: agent.effort, models: r.models, tools: r.tools, date: new Date().toISOString().slice(0, 10), response: r.response }
        }
      } catch (e) { errs.push(`live run failed: ${e.message}`); text = null }
    }
    if (typeof text === 'string') for (const e of gradeText(c, text)) errs.push(`${source} response: ${e}`)
    if (errs.length) {
      failed++
      console.error(`  FAIL  ${c.id} (${c.agent} on ${pin})${c.note ? ` — ${c.note}` : ''}`)
      for (const e of errs) console.error(`        ${e}`)
      if (typeof text === 'string') console.error(`        rerun: node ${rel(__filename)} --case ${c.id}${LIVE ? ' --live' : ''}`)
    } else {
      console.log(`  ok    ${c.id} (${c.agent} on ${pin}, ${source})`)
    }
  }
  if (RECORD && !TIER) fs.writeFileSync(CASES, JSON.stringify(data, null, 2) + '\n')
  console.log(`${cases.length - failed}/${cases.length} routing cases pass`)
  if (failed) process.exitCode = 1
}

main()
