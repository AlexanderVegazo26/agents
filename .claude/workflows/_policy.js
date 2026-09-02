'use strict'

/**
 * Autonomy policy: parsed in code, injected into prompts, and reduced from output.
 *
 * Before this module, `autonomy.json` was read by nobody. Resolution was delegated
 * to the model in prose, and `blockedGates` in the workflow return was a *string
 * instructing the reader to go and collect the entries themselves*:
 *
 *     blockedGates: 'Collect every "BLOCKED — <gate>" entry from the phase outputs above.'
 *
 * Two silent failures followed from that, both in the direction of doing less than
 * authorized:
 *
 *   1. A typo. `preAuthorized.act.deploi` is treated as absent, and absent means
 *      not authorized. On the eight `act` gates that fails safe. On the five
 *      `decide` gates that are meant to be ON it silently reverts the run to
 *      blocking decisions it was authorized to make — and nothing can tell a typo
 *      from a deliberate lockdown. `validate()` below rejects unknown keys.
 *
 *   2. A blocked gate vanishing. If the relaying model does not carry the entries
 *      up, a blocked deploy disappears from a run whose recommendation reads Go.
 *      The autonomy-policy skill names that exact outcome as forbidden and then
 *      relies on the model to prevent it. `collectBlockedGates()` is a reducer
 *      over the phase artifacts instead.
 *
 * Resolution order matches the skill's documented order, so an agent invoked
 * directly and a workflow-driven agent resolve the same file.
 */

const fs = require('fs')
const path = require('path')

/** Gate names, mirroring autonomy.schema.json. Unknown keys are errors. */
const GATES = {
  decide: [
    'roadmapCommit',
    'prioritizationDecision',
    'initiativeRejection',
    'architectureDirectionChange',
    'goNoGoClassification',
    'defectFiling',
  ],
  act: [
    'deploy',
    'destructiveMigration',
    'productionConfigChange',
    'incidentFailover',
    'loadTestAgainstSharedEnv',
    'externalDataSend',
    'grantAccess',
    'sharedComponentModification',
  ],
}

const MODES = ['unattended', 'interactive']
const ON_BLOCKED = ['record-and-continue', 'halt']
const CHANNELS = ['return', 'file', 'both']

/**
 * Validate a parsed policy object. Returns an array of error strings; empty means valid.
 *
 * Written by hand rather than with a JSON Schema library because this repository
 * has no `package.json` and therefore no dependency floor — adding one to validate
 * a 30-line config would be a new runtime dependency for the whole platform.
 * `autonomy.schema.json` remains the published contract and
 * `tools/validate-autonomy.py` checks against it; this mirrors it.
 */
function validate(policy) {
  const errors = []
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    return ['policy is not a JSON object']
  }

  const allowedTop = ['$comment', 'mode', 'preAuthorized', 'onBlocked', 'escalation']
  for (const k of Object.keys(policy)) {
    if (!allowedTop.includes(k)) errors.push(`unknown top-level property: ${k}`)
  }
  for (const k of ['mode', 'preAuthorized', 'onBlocked', 'escalation']) {
    if (!(k in policy)) errors.push(`missing required property: ${k}`)
  }

  if ('mode' in policy && !MODES.includes(policy.mode)) {
    errors.push(`mode must be one of ${MODES.join(' | ')}, got ${JSON.stringify(policy.mode)}`)
  }
  if ('onBlocked' in policy && !ON_BLOCKED.includes(policy.onBlocked)) {
    errors.push(`onBlocked must be one of ${ON_BLOCKED.join(' | ')}, got ${JSON.stringify(policy.onBlocked)}`)
  }

  const pa = policy.preAuthorized
  if (pa && typeof pa === 'object' && !Array.isArray(pa)) {
    for (const k of Object.keys(pa)) {
      if (!['decide', 'act'].includes(k)) errors.push(`unknown preAuthorized class: ${k}`)
    }
    for (const cls of ['decide', 'act']) {
      if (!(cls in pa)) { errors.push(`missing preAuthorized.${cls}`); continue }
      const obj = pa[cls]
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        errors.push(`preAuthorized.${cls} is not an object`); continue
      }
      for (const [k, v] of Object.entries(obj)) {
        if (k === '$comment') continue
        if (!GATES[cls].includes(k)) {
          // The whole point of the schema. A near-miss is the likely case, so say so.
          const near = GATES[cls].find(g => g.toLowerCase().startsWith(k.slice(0, 4).toLowerCase()))
          errors.push(
            `unknown gate preAuthorized.${cls}.${k}` + (near ? ` — did you mean ${near}?` : '')
          )
        } else if (typeof v !== 'boolean') {
          errors.push(`preAuthorized.${cls}.${k} must be a boolean, got ${typeof v}`)
        }
      }
    }
  } else if ('preAuthorized' in policy) {
    errors.push('preAuthorized is not an object')
  }

  const esc = policy.escalation
  if (esc && typeof esc === 'object' && !Array.isArray(esc)) {
    for (const k of Object.keys(esc)) {
      if (!['$comment', 'channel'].includes(k)) errors.push(`unknown escalation property: ${k}`)
    }
    if ('channel' in esc && !CHANNELS.includes(esc.channel)) {
      errors.push(`escalation.channel must be one of ${CHANNELS.join(' | ')}, got ${JSON.stringify(esc.channel)}`)
    }
  } else if ('escalation' in policy) {
    errors.push('escalation is not an object')
  }

  return errors
}

/** Every gate false — the state a run must assume when no policy resolves. */
function allDenied() {
  const gates = { decide: {}, act: {} }
  for (const cls of ['decide', 'act']) for (const g of GATES[cls]) gates[cls][g] = false
  return gates
}

/**
 * Resolve, load and validate the policy.
 *
 * @param {{explicitPath?: string, cwd?: string}} opts
 * @returns {{gates: object, source: string|null, degraded: boolean, mode: string,
 *            onBlocked: string, channel: string, errors: string[]}}
 *
 * `degraded: true` means no policy resolved OR the one that resolved is invalid.
 * In both cases every gate reads not-authorized. It is reported at the top of the
 * result rather than inferred, because "no policy file" and "a policy that denies
 * everything" are indistinguishable from the outside and the difference matters.
 */
function loadPolicy({ explicitPath, cwd = process.cwd() } = {}) {
  const candidates = [
    explicitPath,
    path.join(cwd, '.claude', 'autonomy.json'),
  ].filter(Boolean)

  for (const p of candidates) {
    let raw
    try {
      raw = fs.readFileSync(p, 'utf8')
    } catch {
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      return {
        ...allDeniedResult(p),
        errors: [`${p}: not valid JSON — ${e.message}`],
      }
    }
    const errors = validate(parsed)
    if (errors.length) return { ...allDeniedResult(p), errors }

    const gates = { decide: {}, act: {} }
    for (const cls of ['decide', 'act']) {
      for (const g of GATES[cls]) gates[cls][g] = parsed.preAuthorized[cls][g] === true
    }
    return {
      gates,
      source: p,
      degraded: false,
      mode: parsed.mode,
      onBlocked: parsed.onBlocked,
      channel: (parsed.escalation && parsed.escalation.channel) || 'return',
      errors: [],
    }
  }

  return { ...allDeniedResult(null), errors: [] }
}

function allDeniedResult(source) {
  return {
    gates: allDenied(),
    source,
    degraded: true,
    mode: 'unattended',
    onBlocked: 'record-and-continue',
    channel: 'return',
  }
}

/**
 * Render the resolved gate table as prompt text.
 *
 * The agent is told the answer rather than asked to go and find a file. The skill
 * warns that `${CLAUDE_PLUGIN_ROOT}` does not expand in skill text, so an agent
 * asked to locate the policy itself may simply fail to and then — correctly, per
 * the skill — treat every gate as denied.
 */
function gateTableForPrompt(resolved) {
  if (resolved.degraded) {
    const why = resolved.errors.length
      ? `the policy at ${resolved.source} is invalid: ${resolved.errors.join('; ')}`
      : 'no autonomy policy file resolved'
    return [
      'AUTONOMY POLICY — DEGRADED.',
      `Reason: ${why}.`,
      'Treat EVERY gate as NOT pre-authorized, including all decide.* gates.',
      'State this degraded status at the top of your result. Do not present it as a',
      'deliberate lockdown — it is an unresolved policy, and the difference matters.',
    ].join('\n')
  }

  const on = []
  const off = []
  for (const cls of ['decide', 'act']) {
    for (const [g, v] of Object.entries(resolved.gates[cls])) {
      (v ? on : off).push(`${cls}.${g}`)
    }
  }
  return [
    `AUTONOMY POLICY — resolved from ${resolved.source} (mode: ${resolved.mode}).`,
    on.length
      ? `Pre-authorized, proceed and record that you acted under standing authorization: ${on.join(', ')}.`
      : 'Pre-authorized: nothing.',
    `NOT pre-authorized: ${off.join(', ')}.`,
    `On hitting a gate that is not pre-authorized: ${resolved.onBlocked}. Emit a`,
    'BLOCKED entry in the documented format and continue with everything that does',
    'not depend on it. A gate absent from this list is an unanswered question,',
    'never an implied yes.',
  ].join('\n')
}

// `BLOCKED — <gate>` followed by its indented field block, up to the next
// unindented line. The em-dash is what the skill's format specifies; a hyphen is
// accepted too, because an agent that gets the dash wrong should not cause the
// entry to vanish — which is the exact failure this reducer exists to prevent.
// Case-insensitive (`i`). The module already accepts a hyphen or en-dash in
// place of the em dash "because an agent that gets the dash wrong should not
// cause the entry to vanish". Security review pointed out the identical
// reasoning was not applied to casing: `Blocked — act.deploy` yielded zero
// entries. A gate must not disappear over a capital letter either.
//
// The trailing lookahead must also match END OF INPUT, spelled `(?![\s\S])`.
// JavaScript has no `\Z` — writing one matches a literal `Z`, so a BLOCKED entry
// that is the last thing in a phase output is never terminated and never
// captured. That is precisely the disappearing-gate failure this reducer exists
// to prevent, and it was caught by the fault injection rather than by review.
const BLOCKED_RE = /^[ \t]*BLOCKED[ \t]*[—–-][ \t]*([\w.]+)[ \t]*$([\s\S]*?)(?=^\S|(?![\s\S]))/gmi

const FIELD_MAP = {
  'action withheld': 'actionWithheld',
  'why gated': 'whyGated',
  'prepared': 'prepared',
  'unblocks': 'unblocks',
  'authorize by': 'authorizeBy',
}

function parseFields(block) {
  const out = {}
  let current = null
  for (const line of String(block).split('\n')) {
    const m = line.match(/^[ \t]+([A-Za-z ]+?):[ \t]*(.*)$/)
    if (m && FIELD_MAP[m[1].trim().toLowerCase()]) {
      current = FIELD_MAP[m[1].trim().toLowerCase()]
      out[current] = m[2].trim()
    } else if (current && line.trim()) {
      out[current] = `${out[current]} ${line.trim()}`.trim()
    }
  }
  return out
}

/**
 * Collect every blocked-gate entry from a set of phase outputs.
 *
 * @param {Array<unknown>} phaseOutputs  agent results, in any shape
 * @returns {Array<{gate: string, actionWithheld?: string, whyGated?: string,
 *                  prepared?: string, unblocks?: string, authorizeBy?: string}>}
 *
 * An empty array means no gate was hit. It does NOT mean gates were skipped —
 * that distinction is why this returns a value rather than an instruction.
 */
/**
 * Every string reachable inside a value, as separate texts.
 *
 * NOT `JSON.stringify`: that escapes a real newline to the two characters `\` and
 * `n`, so a multiline BLOCKED block inside an object field stops matching and the
 * gate vanishes. Agents in these workflows return schema-validated objects far
 * more often than raw strings, so stringifying would have silently disabled the
 * reducer for the common case.
 */
function stringsIn(value, out = [], depth = 0) {
  if (depth > 12 || value == null) return out
  if (typeof value === 'string') { out.push(value); return out }
  if (Array.isArray(value)) { for (const v of value) stringsIn(v, out, depth + 1); return out }
  if (typeof value === 'object') { for (const v of Object.values(value)) stringsIn(v, out, depth + 1) }
  return out
}

function collectBlockedGates(phaseOutputs) {
  const found = []
  const seen = new Set()
  const texts = []
  for (const output of phaseOutputs || []) stringsIn(output, texts)
  for (const text of texts) {
    BLOCKED_RE.lastIndex = 0
    let m
    while ((m = BLOCKED_RE.exec(text)) !== null) {
      const entry = { gate: m[1], ...parseFields(m[2]) }
      // Same gate blocked in two phases is one gate, but keep both if the
      // withheld action differs — two distinct deploys are two distinct gates hit.
      const key = `${entry.gate} ${entry.actionWithheld || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push(entry)
    }
  }
  return found
}

module.exports = {
  GATES,
  validate,
  loadPolicy,
  gateTableForPrompt,
  collectBlockedGates,
  parseFields,
}
