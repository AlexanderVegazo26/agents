export const meta = {
  name: 'release-readiness',
  description: 'Collect every release gate in parallel from the agent that owns it, then have release-manager synthesize an evidence-classified go/no-go recommendation',
  whenToUse: 'Before a production release. Produces a RECOMMENDATION for human confirmation — it deliberately cannot deploy, and no gate result upgrades a claim to Confirmed on its own.',
  phases: [
    { title: 'Gates', detail: 'engineering, quality, security, operations, performance gates in parallel' },
    { title: 'Synthesize', detail: 'release-manager classifies each gate and recommends' },
    { title: 'Runtime', detail: 'bridge steps that reach the recorder and the policy loader' },
  ],
}

// ===========================================================================
// RUNTIME WIRING — CHG-16 (policy + blocked-gate reducer), CHG-18 (run
// directory + resume), CHG-19 (breaker), CHG-20 (handoff by reference),
// CHG-22 (outcome record).
//
// WHY THIS IS A BRIDGE AND NOT AN IMPORT
// -------------------------------------
// A Workflow-tool script runs inside a `node:vm` context whose globals are an
// explicit allowlist built on a null-prototype object: agent, parallel,
// pipeline, workflow, phase, log, args, budget, setTimeout, clearTimeout,
// console. There is no `require`, no `module`, no `process` and no `fs`, and
// `Math.random()`, `Date.now()` and argless `new Date()` are replaced with
// functions that throw so resume stays deterministic. Measured against the
// shipped Claude Code binary (2.1.258), not recalled.
//
// So none of `_policy.js`, `_state.js`, `_failure.js` or `_brief.js` can be
// called in this process — not just `_state.js`. They are reached through a
// BRIDGE AGENT: a mechanical, low-effort step that writes a fully-formed Node
// script — generated here, so the agent decides nothing — runs it, and returns
// its stdout verbatim.
//
// THE LIMITATION, STATED RATHER THAN PAPERED OVER
// -----------------------------------------------
// A language model sits on that wire. A bridge step can be skipped, garbled or
// refused, and nothing here can prove otherwise from inside the sandbox. So
// every caller degrades in the SAFE direction: the policy reads DEGRADED (every
// gate not pre-authorized), the verify brief falls back to the manifest itself
// and never to concatenated prose, a run that cannot be recorded says so rather
// than reporting a record it does not have, and a blocked-gate collection that
// could not run reports itself as a blocked gate instead of an empty array.
// ===========================================================================

const WORKFLOW = 'release-readiness'
// >>> RUNTIME BLOCK — generated from _runtime.block.js by tools/runtime_block.py; do not hand-edit >>>

const BRIDGE_SCHEMA = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    result: { type: 'string' },
    error: { type: 'string' },
  },
}

function parentDir(p) {
  const s = String(p)
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i < 0 ? null : s.slice(0, i)
}

// `${CLAUDE_PLUGIN_ROOT}` is expanded by the command layer before Workflow is
// invoked. If it arrives unexpanded it is a literal, nothing resolves, and the
// correct reading is "no policy" — not "open a file called ${CLAUDE_PLUGIN_ROOT}".
function resolvedPath(v) {
  return typeof v === 'string' && v && !v.includes('${') ? v : null
}

// The bridge writes and runs a script that requires modules out of this
// directory, so it is a code-execution input and not merely a path. It comes
// from the command layer, which is trusted — but validate the shape anyway, so
// a mistyped or traversing argument fails closed instead of sourcing the
// platform's runtime modules from somewhere unintended.
function runtimeDirOf(v) {
  const p = resolvedPath(v)
  if (!p || p.includes('..')) return null
  // Reject UNC and protocol-relative roots. Security review demonstrated that
  // a `\\host\share\workflows` or `//host/share/workflows` value passed the
  // `..`-and-tail check, and `path.join` preserves a UNC prefix intact — so on
  // Windows the bridge would `require` `_policy.js` over SMB, and the gate table
  // it returns is prefixed to every downstream agent prompt. The platform's own
  // modules never live on a share, so this rejects no legitimate value.
  //
  // This validates SHAPE only. A vm-sandboxed script has no `process`, no `fs`
  // and no plugin root, so it has no trusted anchor and cannot check LOCATION.
  // That limit is real: the durable fix is for the command layer to pass
  // `runtimeDir` explicitly instead of letting one argument select two things.
  // Any two leading separators, in any mix: `/\host\share` passed the old
  // `\\\\|//` test and `path.win32.join` still produced a UNC path from it.
  if (/^[\\/]{2}/.test(p)) return null
  // Absolute only — a drive root or `/`. A relative value resolves against the
  // CONSUMING repo's working directory, so `.claude/workflows` made the bridge
  // `require` a `_policy.js` the reviewed repository wrote, and hand back any
  // gate table it liked. The command layer always passes an absolute
  // `${CLAUDE_PLUGIN_ROOT}/workflows`, so this rejects no legitimate value.
  if (!/^([A-Za-z]:[\\/]|\/)/.test(p)) return null
  return /[\\/]workflows[\\/]?$/.test(p) ? p.replace(/[\\/]+$/, '') : null
}

// `resume` names a directory the recorder reads phase artifacts out of, and
// those artifacts are replayed into downstream prompts carrying the authority of
// "this is what your own earlier phases produced". Security review showed
// `../../../outside/planted` resolving to an attacker-authored run whose
// acceptance criteria were then adopted wholesale, and a manifest-supplied
// `artifact` path reading an arbitrary JSON file into agent context. A run id is
// a single path segment; anything else is rejected here, and `_state.js`
// enforces containment independently on its side.
function resumeIdOf(v) {
  const p = resolvedPath(v)
  if (!p) return null
  if (p.includes('..') || p.includes('/') || p.includes('\\')) return null
  return p
}

// Two policy arguments, because they mean two different things:
//   `policy`        — an EXPLICIT policy the invoker imposes. It is INTERSECTED
//                     with the repo's own file (a gate needs both), so an
//                     invoker can run stricter than the repo, never looser.
//   `policyDefault` — the plugin's shipped default, which every command passes.
//                     A FALLBACK: the repo's `.claude/autonomy.json` overrides it.
// Before the split, the commands passed the default as `policy`, so it beat the
// repo file and silently re-enabled every gate a repo had locked down.
const POLICY_PATH = resolvedPath(args?.policy)
const POLICY_DEFAULT_PATH = resolvedPath(args?.policyDefault)
const ANY_POLICY_PATH = POLICY_PATH || POLICY_DEFAULT_PATH
const RUNTIME_DIR =
  runtimeDirOf(args?.runtimeDir) ||
  (ANY_POLICY_PATH && parentDir(ANY_POLICY_PATH) ? runtimeDirOf(`${parentDir(ANY_POLICY_PATH)}/workflows`) : null)
const RESUME_ID = resumeIdOf(args?.resume)
const RECORDING = args?.record !== false

const REQUIRE_HEAD = `const path = require('path')\nconst DIR = ${JSON.stringify(RUNTIME_DIR)}\n`

// Declared before `bridge()` uses it: the policy step runs at module scope,
// before the run is opened, so a later `let` would put this in the temporal
// dead zone and the very first bridge call would throw.
let RUN = null            // { runId, dir, resumed: { phaseTitle: artifact } }
let bridgeCalls = 0

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-60)
}

/**
 * Run one module call out-of-process. Returns the module's own JSON result, or
 * null when the bridge could not run — never a plausible-looking substitute.
 *
 * The scratch script lives INSIDE the run directory, for two reasons. Two
 * workflows running in one repository would otherwise write and execute the
 * same `_bridge/<op>-<n>.js` and could each run the other's script; and a
 * shared `_bridge/` directory under `.claude/runs/` is itself a directory
 * there, so `listRuns()` would hand the distiller a run whose id is `_bridge`.
 *
 * Only the policy step runs before the run directory exists, and this sandbox
 * has no clock and no randomness to name it with, so that one is keyed on the
 * workflow and the policy path and written as a FILE directly under
 * `.claude/runs/` — a file, so `listRuns()` skips it. Two runs colliding there
 * are generating byte-identical scripts, which makes the collision harmless
 * rather than merely unlikely.
 *
 * `model` pins the transcriber's model. Omitted, a step runs on BRIDGE_MODEL
 * (Haiku, unless `args.tiers` is 'inherit'); 'inherit' follows the session.
 */
// RELAY SIZE. A transcriber relays a script in and its stdout out, and the
// host's Bash tool cuts output beyond ~30,000 characters. Sealed payloads are
// hex — two characters a byte — so every relay is bounded to RELAY_CHUNK bytes
// (24,000 hex characters) per step: a larger script is written in parts first,
// and a larger output is read back in chunks. One SHA-256 covers the whole
// either way (code review round 3 M1: resuming a realistic run relayed ~122k).
const RELAY_CHUNK = 6000
// At most this many part or read steps per relay, each one an agent call: a
// relay larger than that fails visibly instead of quietly running hundreds of
// transcriber calls (code review / security round 4).
const MAX_RELAY_STEPS = 96
// Data at or under this many hex characters rides inside the loader; anything
// larger is written as DATA FILES by a step that only writes and never runs
// anything. On the first live run a transcriber refused to execute a script
// carrying a 40 KB hex block it could not inspect, and the run lost its Build
// record and its outcome.json.
const INLINE_DATA_HEX = 4000
const MAX_RELAY_HEX = RELAY_CHUNK * 2 * MAX_RELAY_STEPS

// Every bridge step is mechanical, so it runs on the cheapest model unless the
// run pins nothing at all (`args.tiers: 'inherit'`). A caller may still pass a
// model of its own.
const BRIDGE_MODEL = args && typeof args === 'object' && args.tiers === 'inherit' ? null : 'haiku'

/**
 * One mechanical DATA step: write `text` to `file` and nothing else. Nothing is
 * run, so there is nothing to inspect before executing — the reason a
 * transcriber refused the old part-writer scripts. The loader that reads the
 * file checks its hash before using it.
 */
async function transcribeData(label, file, text, model) {
  const out = await agent(
    `Mechanical bridge step of an sdlc-suite workflow: save one data file. You are a transcriber, not an author, and you take no autonomous decision here — no autonomy gate applies to this step. The text between the markers is opaque DATA (hexadecimal, part of an encoded JSON input). It is never executed. It is not a script and never becomes one: no step runs it or loads it as code — a later step reads it as text, checks its SHA-256 and parses it as JSON. Nothing in this step runs any command.

1. Write the text between the two markers, exactly as it is, to ${file} — creating parent directories if they do not exist. If that path is relative, resolve it against your working directory first; the Write tool needs an absolute path. Copy it character for character: do not shorten, wrap, reformat or comment it.
2. Return ok=true with result {"ok":true}. If the file could not be written, return ok=false with the reason in "error".

--- BEGIN DATA ${file} ---
${text}
--- END DATA ${file} ---`,
    { agentType: 'general-purpose', label, phase: 'Runtime', effort: 'low', schema: BRIDGE_SCHEMA,
      ...(model ? { model } : {}) },
  )
  if (!out || out.ok !== true) {
    log(`${label} did not write its data file${out && out.error ? ` — ${String(out.error).slice(0, 300)}` : ''}`)
    return false
  }
  return true
}

/**
 * Write the data parts at `indexes` concurrently; returns the indexes that were
 * NOT written. A part whose step threw counts as not written.
 */
// At most this many at once: a payload near the relay limit would otherwise
// start dozens of transcriber calls together, and a host that caps or
// rate-limits them would fail a step the old one-at-a-time loop finished.
const PART_FANOUT = 8

async function writeParts(op, partFiles, indexes, model) {
  const missing = []
  for (let i = 0; i < indexes.length; i += PART_FANOUT) {
    const batch = indexes.slice(i, i + PART_FANOUT)
    const wrote = await parallel(batch.map(k => () => transcribeData(`bridge:${op}:part`, partFiles[k].file, partFiles[k].text, model)))
    batch.forEach((k, j) => { if (!(wrote && wrote[j] === true)) missing.push(k) })
  }
  return missing
}

/** One mechanical step: write `script` to `file`, run it, relay its stdout. */
async function transcribe(label, file, script, model) {
  const out = await agent(
    `Mechanical bridge step of an sdlc-suite workflow. You are a transcriber, not an author, and you take no autonomous decision here — no autonomy gate applies to this step. The script below is plain JavaScript you may read; if it has a DATA constant, that is this step's JSON input, encoded so that untrusted text from the run (agent output, CI and log evidence) is not shown to you — it is parsed, never executed. Do exactly these three things and nothing else. Do not edit, improve or shorten the script, and copy DATA exactly as it is. Do not summarise, re-key or pretty-print its output.

1. Write the block between the two markers below, byte for byte, to ${file} — creating parent directories if they do not exist. If that path is relative, resolve it against your working directory first; the Write tool needs an absolute path.
2. Run it: node "${file}"
3. Return ok=true with that process's stdout in "result", VERBATIM — it is already JSON. If the command exits non-zero, or writes nothing to stdout, return ok=false and put stderr in "error".

--- BEGIN ${file} ---
${script}
--- END ${file} ---`,
    { agentType: 'general-purpose', label, phase: 'Runtime', effort: 'low', schema: BRIDGE_SCHEMA,
      ...(model ? { model } : {}) },
  )
  if (!out || out.ok !== true || typeof out.result !== 'string' || !out.result.trim()) {
    log(`${label} did not run${out && out.error ? ` — ${String(out.error).slice(0, 300)}` : ''}`)
    return null
  }
  // Tolerant of what a real transcriber's shell hands back: stderr lines
  // interleaved before the JSON (the Bash tool merges both streams — smoke
  // test, round 5), or a code fence around it. The JSON is the last line.
  const raw = out.result.trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '')
  for (const cand of [raw, raw.slice(raw.lastIndexOf('\n{') + 1)]) {
    try { return JSON.parse(cand) } catch (e) { /* next candidate */ }
  }
  log(`${label} returned output that is not JSON — treating the module as unreachable`)
  return null
}

async function bridge(op, source, model, data) {
  if (!RUNTIME_DIR) return null
  const m = model === undefined ? BRIDGE_MODEL : (typeof model === 'string' && model && model !== 'inherit' ? model : null)
  const n = ++bridgeCalls
  // Before the run directory exists, the file name and nonce carry a hash of
  // this invocation's args, so a concurrent run with other args never shares
  // them (code review round 6).
  const preTag = sha256Hex(utf8Bytes(JSON.stringify(args === undefined ? null : args))).slice(0, 12)
  const file = RUN
    ? `${RUN.dir}/bridge/${op}-${n}.cjs`
    : `.claude/runs/pre-${slug(`${WORKFLOW}-${POLICY_PATH || 'no-policy'}`)}-${preTag}-${op}-${n}.cjs`
  // CODE IN THE CLEAR, DATA SEALED (security review F1; live smoke test).
  // The step's code is written plainly, so the transcriber, a permission
  // classifier and any person can read exactly what will run — no eval, no
  // encoded program. An earlier version encoded the whole script and ran it
  // with new Function; the auto-mode classifier refused it as "undermining
  // oversight" and the transcriber refused to run what it could not inspect,
  // both rightly. Only the step's DATA — artifacts, agent output, evidence that
  // may quote untrusted text — is XORed with a SHA-256 keystream of the nonce
  // and hex-encoded: parsed as JSON, never executed, and inspectable with
  // BRIDGE_PRINT_INPUT=1. Scrambled data also copies reliably: Haiku copied
  // random hex exactly but autocompleted hex that encoded English.
  const nonce = `${RUN && RUN.runId ? RUN.runId : `pre-${WORKFLOW}-${preTag}`}:${op}:${n}`
  const PART = RELAY_CHUNK * 2
  let dataBlock = 'const input = null'
  // Data files and their hashes, for the parts check in the loader below.
  let partFiles = []
  if (data !== undefined) {
    const dataBytes = utf8Bytes(JSON.stringify(data))
    // Compressed, then scrambled: scrambled bytes do not compress.
    const dataHex = hexOf(xorStream(lzwPack(dataBytes), 'in', nonce))
    if (dataHex.length > PART * MAX_RELAY_STEPS) {
      log(`bridge:${op} input is ${dataHex.length / 2} bytes compressed — over the ${MAX_RELAY_STEPS}-step relay limit; not sent`)
      return null
    }
    let dataExpr = `'${dataHex}'`
    if (dataHex.length > INLINE_DATA_HEX) {
      for (let i = 0, k = 0; i < dataHex.length; i += PART, k++) {
        const text = dataHex.slice(i, i + PART)
        // Named as data, not after the script: on a measured run a transcriber
        // refused a part written as `<step>.cjs.in1`, reading it as "an opaque
        // blob meant to become a .cjs script" it could not verify.
        partFiles.push({ file: `${file.replace(/\.cjs$/, '')}.data-${k}.hex`, sha: sha256Hex(utf8Bytes(text)), text })
      }
      // All at once: each part is its own file with its own hash, so nothing
      // orders them, and one after another they were the largest share of a
      // run's bridge time (36 of 60 transcriber calls in a measured toy run).
      const missing = await writeParts(op, partFiles, partFiles.map((_, k) => k), m)
      if (missing.length) {
        log(`bridge:${op} data part(s) ${missing.map(k => k + 1).join(', ')}/${partFiles.length} were not written — discarded`)
        return null
      }
      dataExpr = 'PARTS.map(p => fs.readFileSync(p.file, \'utf8\').trim()).join(\'\')'
    }
    dataBlock = `${partFiles.length ? `// DATA FILES: this step's input, written by separate data-only steps. Each
// is checked against its hash before anything runs; a damaged one is named
// and written again — this step never runs on altered input.
const PARTS = ${JSON.stringify(partFiles.map(x => ({ file: x.file, sha: x.sha })))}
const damaged = PARTS.map((p, i) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p.file, 'utf8').trim()).digest('hex') === p.sha ? -1 : i } catch (e) { return i }
}).filter(i => i >= 0)
if (damaged.length) { realWrite(JSON.stringify({ rewrite: damaged })); process.exit(0) }
` : ''}// DATA: this step's JSON input, LZW-compressed, XOR-scrambled with a SHA-256
// keystream of NONCE and hex-encoded. Parsed, never executed. To read it, run
// this file with the environment variable BRIDGE_PRINT_INPUT=1.
const DATA = ${dataExpr}
const plain = Buffer.from(lzwUnpack(xs(Buffer.from(DATA, 'hex'), 'in')))
if (crypto.createHash('sha256').update(plain).digest('hex') !== '${sha256Hex(dataBytes)}') {
  process.stderr.write('bridge input was altered in transcription; refusing to run')
  process.exit(3)
}
const input = JSON.parse(plain.toString('utf8'))
if (process.env.BRIDGE_PRINT_INPUT) { realWrite(JSON.stringify(input, null, 2) + '\\n'); process.exit(0) }`
  }
  const loader = `'use strict'
// Bridge step "${op}" of the ${WORKFLOW} workflow (sdlc-suite). The code in this
// file is plain and is exactly what runs. Its output is captured and handed
// back XOR-scrambled and hex-encoded, with sha256(NONCE + output) to detect a
// damaged copy; the plain output is kept beside this file as .out/.sha.
const fs = require('fs')
const crypto = require('crypto')
const NONCE = ${JSON.stringify(nonce)}
const xs = (buf, tag) => {
  const out = Buffer.alloc(buf.length)
  for (let i = 0, o = 0; o < buf.length; i++, o += 32) {
    const k = crypto.createHash('sha256').update(tag + ':' + NONCE + ':' + i, 'utf8').digest()
    for (let j = 0; j < 32 && o + j < buf.length; j++) out[o + j] = buf[o + j] ^ k[j]
  }
  return out
}
${lzwPack.toString()}
${lzwUnpack.toString()}
const realWrite = process.stdout.write.bind(process.stdout)
const realErr = process.stderr.write.bind(process.stderr)
// Output an earlier run (or an earlier attempt of a resumed run) left at this
// path is removed first: only what THIS run of the step writes can be read back.
for (const f of ${JSON.stringify([`${file}.out`, `${file}.sha`, `${file}.err`, `${file}.log`])}) { try { fs.unlinkSync(f) } catch (e) { /* absent */ } }
${dataBlock}
let captured = ''
let errlog = ''
let failed = null
process.stdout.write = (chunk) => { captured += String(chunk); return true }
// A module's own stderr (e.g. "[run] ...") goes to a file: the transcriber's
// shell would otherwise splice it into the relayed JSON.
process.stderr.write = (chunk) => { errlog += String(chunk); return true }
try {
  ;(function () {
// ---- the step itself -------------------------------------------------------
${source}
// ----------------------------------------------------------------------------
  })()
} catch (e) {
  failed = e
} finally {
  process.stdout.write = realWrite
  process.stderr.write = realErr
}
if (errlog) fs.writeFileSync(${JSON.stringify(`${file}.log`)}, errlog)
if (failed) {
  // An error can quote the step's data, so it is not printed where the
  // transcriber relays it: it goes to a file beside this script.
  fs.writeFileSync(${JSON.stringify(`${file}.err`)}, String((failed && failed.stack) || failed))
  realErr('bridge step failed; the error is in ' + ${JSON.stringify(`${file}.err`)})
  process.exit(1)
}
const OUT = Buffer.from(captured, 'utf8')
const HEXOUT = xs(Buffer.from(lzwPack(OUT)), 'out').toString('hex')
const SHA = crypto.createHash('sha256').update(NONCE, 'utf8').update(OUT).digest('hex')
// Kept on disk, so a relay that came back damaged can be read again without
// running this step a second time (some steps are not idempotent).
fs.writeFileSync(${JSON.stringify(`${file}.out`)}, HEXOUT)
fs.writeFileSync(${JSON.stringify(`${file}.sha`)}, SHA)
realWrite(JSON.stringify({ sealed: HEXOUT.slice(0, ${PART}), total: HEXOUT.length, sha256: SHA }))`
  let env = await transcribe(`bridge:${op}`, file, loader, m)
  // A damaged data file is written again, once, and the loader re-run: it
  // stopped before the step itself, so nothing ran twice.
  if (env && Array.isArray(env.rewrite) && partFiles.length) {
    const again = env.rewrite.filter(i => Number.isInteger(i) && i >= 0 && i < partFiles.length)
    log(`bridge:${op} data part(s) ${again.map(i => i + 1).join(', ')} arrived damaged — written again once`)
    if ((await writeParts(op, partFiles, again, m)).length) return null
    env = await transcribe(`bridge:${op}`, file, loader, m)
    if (env && Array.isArray(env.rewrite)) {
      log(`bridge:${op} data still damaged after one rewrite — discarded, never used`)
      return null
    }
  }

  // Reassemble from the first relay; on any damage, read the kept output again
  // from the start — once. The loader is never run twice.
  const isHex = x => typeof x === 'string' && x.length % 2 === 0 && /^[0-9a-f]*$/.test(x)
  const decode = (hex, sha) => {
    let plain
    try { plain = lzwUnpack(xorStream(bytesOfHex(hex), 'out', nonce)) } catch (e) { return undefined }
    const nb = utf8Bytes(nonce)
    const both = new Uint8Array(nb.length + plain.length)
    both.set(nb)
    both.set(plain, nb.length)
    if (sha256Hex(both) !== sha) return undefined
    try { return JSON.parse(utf8Text(plain)) } catch (e) { return undefined }
  }
  const readFrom = async (hex, total) => {
    while (hex.length < total) {
      const off = hex.length
      if (off / PART >= MAX_RELAY_STEPS) return null
      const c = await transcribe(`bridge:${op}:read`, `${file}.r${off}.cjs`,
        `process.stdout.write(JSON.stringify({ chunk: require('fs').readFileSync(${JSON.stringify(`${file}.out`)}, 'utf8').slice(${off}, ${off + PART}) }))`, m)
      if (!c || !isHex(c.chunk) || !c.chunk.length) return null
      hex += c.chunk
    }
    return hex.length === total ? hex : null
  }
  let value
  if (env && isHex(env.sealed) && typeof env.sha256 === 'string' &&
      Number.isInteger(env.total) && env.total % 2 === 0 && env.total <= MAX_RELAY_HEX && env.total >= env.sealed.length) {
    const hex = await readFrom(env.sealed, env.total)
    if (hex !== null) value = decode(hex, env.sha256)
  } else if (env) {
    log(`bridge:${op} returned no sealed payload`)
  }
  // Re-read only when the first relay returned an envelope — proof that THIS
  // invocation's loader ran and wrote its output. Without one, the loader may
  // never have run, and a kept file would be another run's (code review round 6).
  const ranHere = !!(env && typeof env === 'object' && ('sealed' in env || 'sha256' in env || 'total' in env))
  if (value === undefined && !ranHere) {
    log(`bridge:${op} produced no output envelope — the step did not run or did not finish; nothing is read back`)
    return null
  }
  if (value === undefined) {
    // One re-read of the kept output, from disk. Not a re-run.
    const head = await transcribe(`bridge:${op}:reread`, `${file}.rr.cjs`, `const fs = require('fs')
const all = fs.readFileSync(${JSON.stringify(`${file}.out`)}, 'utf8')
process.stdout.write(JSON.stringify({ chunk: all.slice(0, ${PART}), total: all.length, sha256: fs.readFileSync(${JSON.stringify(`${file}.sha`)}, 'utf8') }))`, m)
    if (head && isHex(head.chunk) && Number.isInteger(head.total) && head.total <= MAX_RELAY_HEX && typeof head.sha256 === 'string') {
      const hex = await readFrom(head.chunk, head.total)
      if (hex !== null) value = decode(hex, head.sha256)
    }
    if (value === undefined) {
      log(`bridge:${op} output FAILED its integrity check, twice — discarded, never used`)
      return null
    }
    log(`bridge:${op} relay was damaged once and re-read from disk`)
  }
  return value
}

// --------------------------------------------------------------------------
// SEALING — what `bridge()` above relies on.
//
// `bridge()` asks a model to copy a script and relay its stdout. When either
// side carries externally-influenced text — CI titles, command output, log
// lines, another agent's prose quoting them — that model could be steered by
// it (security review F1), or could drop or paraphrase it (code review M2),
// and nothing would notice. So every bridge carries its script and its output
// as hex, which a transcriber cannot read as instructions.
//
// WHAT THE SEAL GUARANTEES, AND WHAT IT DOES NOT (code review S-D, security
// review N4). It is TAMPER-EVIDENCE: a mis-copied script refuses to run, and an
// output altered or replaced in transit fails sha256(nonce ‖ output). It is
// NOT authentication: the nonce is printed in the transcriber's own prompt, and
// with no run directory it is a constant, so a transcriber that was steered by
// something else could compute a valid seal. The protection against steering
// is that the transcriber never sees readable payload — the seal only makes an
// accident, or a reply composed before the run, visible.
//
// This sandbox has no `crypto`, `Buffer` or `TextEncoder`, so SHA-256 and
// UTF-8 are plain JS here (checked against node's in _seal.test.js).
// --------------------------------------------------------------------------
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function sha256Hex(bytes) {
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const l = bytes.length
  const total = (((l + 9) + 63) >> 6) << 6
  const m = new Uint8Array(total)
  m.set(bytes)
  m[l] = 0x80
  const hi = Math.floor(l / 0x20000000)
  const lo = (l * 8) >>> 0
  m[total - 8] = hi >>> 24; m[total - 7] = (hi >>> 16) & 255; m[total - 6] = (hi >>> 8) & 255; m[total - 5] = hi & 255
  m[total - 4] = lo >>> 24; m[total - 3] = (lo >>> 16) & 255; m[total - 2] = (lo >>> 8) & 255; m[total - 1] = lo & 255
  const w = new Uint32Array(64)
  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) {
      const j = i + t * 4
      w[t] = ((m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3]) >>> 0
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[t] + w[t]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  return H.map(x => x.toString(16).padStart(8, '0')).join('')
}

function utf8Bytes(str) {
  const out = []
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const n = s.charCodeAt(i + 1)
      if (n >= 0xdc00 && n <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (n - 0xdc00); i++ }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd   // lone surrogate: what Buffer.from(s, 'utf8') writes
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}

function utf8Text(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]
    let c, n
    if (b < 0x80) { c = b; n = 1 }
    else if (b >= 0xf0) { c = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); n = 4 }
    else if (b >= 0xe0) { c = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); n = 3 }
    else { c = ((b & 31) << 6) | (bytes[i + 1] & 63); n = 2 }
    s += String.fromCodePoint(c)
    i += n
  }
  return s
}

const HEX = '0123456789abcdef'
function hexOf(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15]
  return s
}

function bytesOfHex(h) {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16)
  return out
}

/**
 * XOR `bytes` with a SHA-256 keystream: block i is sha256(`${tag}:${nonce}:${i}`).
 * Its own inverse. Matches the loader's `xs()` byte for byte (_seal.test.js).
 */
function xorStream(bytes, tag, nonce) {
  const out = new Uint8Array(bytes.length)
  for (let i = 0, o = 0; o < bytes.length; i++, o += 32) {
    const k = bytesOfHex(sha256Hex(utf8Bytes(`${tag}:${nonce}:${i}`)))
    for (let j = 0; j < 32 && o + j < bytes.length; j++) out[o + j] = bytes[o + j] ^ k[j]
  }
  return out
}

/**
 * LZW over bytes: 16-bit codes, the dictionary restarting from the 256 single
 * bytes once it holds 65536 entries. Bridge data is compressed before it is
 * scrambled, because every byte of it is copied by a transcriber: the first
 * live run relayed ~250 KB of JSON as ~500 KB of hex, and a transcriber
 * refused a 40 KB block outright. JSON repeats its keys, so it shrinks several
 * times. Plain code on Uint8Array — no Buffer, no zlib — because the same
 * source runs in the sandbox (which has neither) and, via toString(), inside
 * every loader, where a person or a classifier can read exactly what decodes.
 */
function lzwPack(bytes) {
  const dict = new Map()
  let next = 256
  const codes = []
  let w = -1
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (w < 0) { w = b; continue }
    const key = w * 256 + b
    const c = dict.get(key)
    if (c !== undefined) { w = c; continue }
    codes.push(w)
    if (next < 65536) dict.set(key, next++)
    else { dict.clear(); next = 256 }
    w = b
  }
  if (w >= 0) codes.push(w)
  const out = new Uint8Array(codes.length * 2)
  for (let i = 0; i < codes.length; i++) { out[2 * i] = codes[i] >> 8; out[2 * i + 1] = codes[i] & 255 }
  return out
}

function lzwUnpack(packed) {
  if (packed.length % 2) throw new Error('lzw: odd length')
  let dict = []
  let next = 256
  const out = []
  let prev = null
  for (let i = 0; i < packed.length; i += 2) {
    const c = packed[i] * 256 + packed[i + 1]
    let e
    if (prev === null || next === 65536) {
      // The first code, and the first after the dictionary restarts, is always
      // a single byte: the packer had nothing longer to match.
      if (c >= 256) throw new Error('lzw: a multi-byte code where a single byte must stand')
      if (prev !== null) { dict = []; next = 256 }
      e = [c]
    } else {
      if (c < 256) e = [c]
      else if (dict[c]) e = dict[c]
      else if (c === next) e = prev.concat([prev[0]])
      else throw new Error('lzw: unknown code')
      dict[next++] = prev.concat([e[0]])
    }
    for (let j = 0; j < e.length; j++) out.push(e[j])
    prev = e
  }
  return Uint8Array.from(out)
}

/**
 * Run `body` — the inside of `function (input) { ... }`, returning a JSON-able
 * value — out-of-process with `input`. `path`, `DIR` and `crypto` are in scope.
 * Sealed like every bridge; returns the body's value, or null.
 */
async function sealedBridge(op, input, body, model) {
  return bridge(op, `${REQUIRE_HEAD}const crypto = require('crypto')
const output = (function (input) {
${body}
})(input)
process.stdout.write(JSON.stringify(output === undefined ? null : output))`, model, input === undefined ? null : input)
}

// --------------------------------------------------------------------------
// CHG-16 — the resolved gate table, injected as explicit text.
// --------------------------------------------------------------------------
const DEGRADED_TABLE = [
  'AUTONOMY POLICY — DEGRADED.',
  'Reason: this workflow could not reach the policy loader to resolve a policy file.',
  'Treat EVERY gate as NOT pre-authorized, including all decide.* gates.',
  'State this degraded status at the top of your result. Do not present it as a',
  'deliberate lockdown — it is an unresolved policy, and the difference matters.',
].join('\n')

async function loadPolicyStep() {
  const r = await bridge('policy', `${REQUIRE_HEAD}const p = require(path.join(DIR, '_policy.js'))
const r = p.loadPolicy({ explicitPath: ${JSON.stringify(POLICY_PATH)}, defaultPath: ${JSON.stringify(POLICY_DEFAULT_PATH)} })
const actGranted = Object.keys(r.gates.act).filter(k => r.gates.act[k] === true)
process.stdout.write(JSON.stringify({ gateTable: p.gateTableForPrompt(r), source: r.source, degraded: r.degraded, errors: r.errors, actGranted: actGranted }))`)
  return r && typeof r.gateTable === 'string' && r.gateTable ? r : null
}

// Learnings travel on their OWN bridge step, never on the policy one. The
// policy bridge's output is the gate table every later agent is handed; carrying
// repository-authored free text through the same ungated transcriber, in the
// same JSON, would let a learning's text reach the one agent that controls it.
// A learnings failure therefore cannot touch the policy, and vice versa.
async function loadLearningsStep() {
  const r = await bridge('learnings', `${REQUIRE_HEAD}const l = require(path.join(DIR, '_learnings.js'))
const got = l.loadLearnings({ dirs: l.defaultDirs({ cwd: process.cwd(), runtimeDir: DIR }), cwd: process.cwd() })
// Repo-local lessons: signals recurring in THIS repo's recent runs, unratified,
// handed back on the next run with no human gate because they never leave it.
const repo = ${JSON.stringify(args?.repoLessons !== false)} ? l.loadRepoLessons({ cwd: process.cwd() }) : { entries: [], runsRead: 0 }
const all = got.entries.concat(repo.entries)
process.stdout.write(JSON.stringify({ byAgent: l.promptBlocksByAgent(all), sources: got.sources, skipped: got.skipped, repoRunsRead: repo.runsRead, repoLessons: repo.entries.length }))`)
  return r && r.byAgent && typeof r.byAgent === 'object' ? { ...r, error: null } : null
}

// Two separate steps, sent together: neither reads the other, so the run waits
// for one transcriber round instead of two. A step that failed or threw reads
// as not run — the policy then degrades to every gate denied.
// Written `await (async () => ...)()`, the form the rest of this block uses at
// top level: syncheck.mjs compiles this file on its own as a plain script,
// where `await (` still parses and `await parallel(` does not.
const [POLICY_STEP, LEARNING_STEP] = await (async () => parallel([loadPolicyStep, loadLearningsStep]))()
const POLICY = POLICY_STEP ||
  { gateTable: DEGRADED_TABLE, source: null, degraded: true, errors: ['the policy bridge did not run'], actGranted: [] }
const LEARNING_SET = LEARNING_STEP || {
  byAgent: {}, sources: [], skipped: [],
  error: RUNTIME_DIR ? 'the learnings bridge did not run' : 'the runtime modules are unreachable',
}

if (POLICY.degraded) {
  log(`AUTONOMY POLICY DEGRADED — ${POLICY.errors.join('; ') || 'no policy file resolved'}. Every gate reads not-authorized.`)
} else {
  log(`autonomy policy resolved from ${POLICY.source}`)
}
if (Array.isArray(POLICY.actGranted) && POLICY.actGranted.length) {
  log(`act.* gates GRANTED by ${POLICY.source}: ${POLICY.actGranted.join(', ')}`)
}


/**
 * Prefix the resolved gate table to an agent prompt.
 *
 * The agent is TOLD the answer rather than sent to find a file. The
 * autonomy-policy skill warns that `${CLAUDE_PLUGIN_ROOT}` does not expand in
 * skill text, so an agent asked to locate the policy itself may simply fail to
 * — and then, correctly per the skill, treat every gate as denied.
 */
function withPolicy(prompt) {
  return `${POLICY.gateTable}\n\n---\n\n${prompt}`
}

// --------------------------------------------------------------------------
// Learnings in, retries out — the two halves of "learn from the last run" and
// "heal this one", at the one call site every specialist agent goes through.
// --------------------------------------------------------------------------
const LEARNINGS = LEARNING_SET.byAgent || {}
const LEARNINGS_LOADED = []   // [{label, agentType, ids}] — lands in outcome.json
const RETRIES = []            // [{label, phase, agentType, attempts, recovered}]
const AGENT_TYPES = {}        // label -> agentType, so failure records can name the agent
const NULL_RESULTS = []       // labels of dispatches that ended with no result, in order
const REQUIRED_MISSING = []   // required deliverables that came back null
const RETRY_ENABLED = args?.retry !== false

if (LEARNING_SET.error) {
  log(`learnings could not be loaded — ${LEARNING_SET.error}. Agents run without prior-run lessons.`)
} else if (Object.keys(LEARNINGS).length) {
  log(`learnings loaded for: ${Object.keys(LEARNINGS).join(', ')}`)
}
if (LEARNING_SET.repoLessons) {
  log(`${LEARNING_SET.repoLessons} unratified repo-local lesson(s) from the last ${LEARNING_SET.repoRunsRead} run(s) of this repository`)
}
// A malformed or untracked learning that was refused is named, never silently
// absent — "it did not load" and "there was nothing to load" must differ.
for (const s of LEARNING_SET.skipped || []) log(`learning SKIPPED — ${s}`)

function learningsBlockFor(agentType) {
  const name = String(agentType || '').replace(/^.*:/, '')
  return (name && LEARNINGS[name]) || LEARNINGS['*'] || null
}

/**
 * Dispatch a specialist agent: prefix the ratified learnings that name it, and
 * re-dispatch ONCE when it returns nothing.
 *
 * WHY ONE RETRY, AND WHY IT IS REWRITTEN
 * `agent()` returns null with no stderr, no exit code and no message — after the
 * host has already applied its own transport retries. So this cannot classify
 * the failure, and does not pretend to. What it can do is the one thing the
 * host's retry cannot: change the request. The retry names the previous empty
 * result and restates the output contract, which is `_failure.js`'s BAD_INPUT
 * strategy (retry with the conformance failure named) — the only class whose
 * second attempt is designed to differ from the first. A second identical
 * request is what the taxonomy calls not self-healing, so there is no third.
 *
 * The retry is deterministic (no clock, no randomness), so resume stays exact.
 * `args.retry === false` turns it off for a run that must not spend twice, and
 * `retry: false` in a call's opts turns it off for that call — used for agents
 * that MUTATE (builders, repairs): a null from one of those may follow a partial
 * edit, and a second attempt on top of it is not a clean retry. A user who
 * deliberately skips an agent also produces a null; that cannot be told apart
 * from a failure here, so a skipped read-only agent is asked once more.
 *
 * LEARNINGS GO AFTER THE GATE TABLE, NEVER BEFORE IT. The autonomy-policy skill
 * tells an agent that a prompt BEGINNING `AUTONOMY POLICY —` is authoritative;
 * prefixing learnings ahead of it broke that rule and — security review showed —
 * let a learning's text forge a second policy block that sat in front of the
 * real one. The table stays first; learnings follow it as fenced data.
 */
async function dispatch(prompt, opts) {
  const { retry: retryThisCall = true, ...o } = opts || {}
  const label = String(o.label || '')
  AGENT_TYPES[label] = o.agentType || null
  const lb = learningsBlockFor(o.agentType)
  let full = prompt
  if (lb && lb.text) {
    const head = `${POLICY.gateTable}\n\n---\n\n`
    full = prompt.startsWith(head)
      ? `${head}${lb.text}\n\n---\n\n${prompt.slice(head.length)}`
      : `${prompt}\n\n---\n\n${lb.text}`
    if (lb.ids && lb.ids.length && !LEARNINGS_LOADED.some(x => x.label === label)) {
      LEARNINGS_LOADED.push({ label, agentType: o.agentType || null, ids: lb.ids })
    }
  }
  // A workflow may define extraInstructionFor(agentType) to append a standing
  // instruction for some agent types; one that does not is unaffected.
  const extra = typeof extraInstructionFor === 'function' ? extraInstructionFor(o.agentType) : ''
  if (extra) full = `${full}\n\n---\n\n${extra}`
  const first = await agent(full, o)
  if (first !== null && first !== undefined) return first
  if (!RETRY_ENABLED || !retryThisCall) {
    RETRIES.push({ label, phase: o.phase || null, agentType: o.agentType || null, attempts: 1, recovered: false })
    NULL_RESULTS.push(label)
    return first
  }
  log(`${label} returned no result — re-dispatching once with the output contract restated`)
  const second = await agent(`${full}

---
A previous attempt at this exact task returned NO result — nothing reached the workflow. That is the failure being corrected. Complete the task and return the required output${o.schema ? ', conforming exactly to the schema you were given' : ''}. If you genuinely cannot, return that as your result and say why — an explained refusal is usable, silence is not.`,
  { ...o, label: `${label} (retry)` })
  const recovered = second !== null && second !== undefined
  RETRIES.push({ label, phase: o.phase || null, agentType: o.agentType || null, attempts: 2, recovered })
  if (recovered) log(`${label} recovered on retry`)
  else NULL_RESULTS.push(label)
  return second
}

/**
 * Mark a result the workflow cannot honestly finish without — the readiness
 * recommendation, the merged review, the report. A run whose terminal agent
 * returned nothing used to report `completed` with the deliverable null; it is
 * now `incomplete`, with a gate naming what is missing.
 */
function requireResult(label, value) {
  if (value === null || value === undefined) REQUIRED_MISSING.push(label)
  return value
}

function repoLessonsLoaded() {
  return LEARNINGS_LOADED
    .map(x => ({ label: x.label, ids: (x.ids || []).filter(id => /^REPO-/.test(id)) }))
    .filter(x => x.ids.length)
}

function attemptsFor(label) {
  const r = RETRIES.filter(x => x.label === label).pop()
  return r ? r.attempts : 1
}

// --------------------------------------------------------------------------
// CHG-18 / CHG-19 / CHG-22 — run directory, resume, breaker, outcome record.
// --------------------------------------------------------------------------
const REPLAYED = []       // phase titles actually served from the resume cache
const OUTPUTS = []        // every agent result, for the CHG-16 reducer
const BREAKER_ENTRIES = []

/** Remember an agent result so the blocked-gate reducer can scan it later. */
function keep(v) {
  OUTPUTS.push(v)
  return v
}

async function openRun(firstPhase, knownPhases) {
  if (!RECORDING || !RUNTIME_DIR) {
    if (RESUME_ID) {
      return { fatal: `resume "${RESUME_ID}" was requested but the runtime modules are not reachable — args carried no usable policy or runtimeDir path. Refusing to start a fresh run in its place.` }
    }
    log('run recording is off — this run produces no run directory and no outcome record')
    return null
  }
  const r = await bridge('open', `${REQUIRE_HEAD}const s = require(path.join(DIR, '_state.js'))
const run = s.openRun({ workflow: ${JSON.stringify(WORKFLOW)}, args: input.args, cwd: process.cwd(), resumeFrom: ${JSON.stringify(RESUME_ID)} })
// A run recorded under a phase layout this workflow no longer has is refused
// HERE, before beginAttempt() or startPhase() rewrite its record (QA round 3:
// a refusal used to bump the attempt and wipe the old breaker trip).
const known = ${JSON.stringify(knownPhases || null)}
if (${JSON.stringify(RESUME_ID)} && known) {
  const re = new RegExp(known)
  const stale = run.manifest.phases.map(p => p.title).filter(t => !re.test(t))
  if (stale.length) {
    process.stdout.write(JSON.stringify({ refused: stale, runId: run.runId }))
    return
  }
}
// A genuine resume is a new attempt, so the breaker below folds only this
// attempt's failures and a fixed-then-resumed run does not re-trip on old ones.
if (${JSON.stringify(RESUME_ID)}) run.beginAttempt()
const resumed = {}
for (const t of run.resumedPhases) resumed[t] = run.resumed(t)
run.startPhase(${JSON.stringify(firstPhase)})
process.stdout.write(JSON.stringify({ runId: run.runId, dir: run.dir, resumed: resumed }))`, undefined, { args: args ?? null })
  if (r && Array.isArray(r.refused)) {
    return { fatal: `refusing to resume ${RESUME_ID}: it was recorded by an older ${WORKFLOW} (phases: ${r.refused.join(', ')}). Replaying part of it would mix two phase layouts — one build checked against another run's plan. Start a fresh run instead; the old record is left untouched.` }
  }
  if (!r || !r.runId) {
    // A failed READ during resume must never degrade into a fresh run — that is
    // how three phases get lost twice, the second time unwatched. A failed OPEN
    // on a fresh run costs only the record, so that one continues.
    if (RESUME_ID) {
      return { fatal: `cannot resume "${RESUME_ID}": the state bridge returned no run. Refusing to start a fresh run in its place — re-run without resume if that is what you want.` }
    }
    log('run recording unavailable — continuing without a run directory')
    return null
  }
  RUN = r
  log(`run ${r.runId} -> ${r.dir}`)
  return r
}

/**
 * Close out a phase: write its artifact, append any failures, re-fold the
 * breaker over the run's whole failure log, and mark the next phase as the one
 * to resume from.
 *
 * WHERE THE BREAKER STATE LIVES, AND WHY.
 * `sdlc-suite/workflows/` has no shared runner module, so CHG-19's "breaker
 * check at each phase boundary" has nothing in-process to hold state. It lives
 * in the RUN DIRECTORY — `failures.jsonl` — and is re-folded through
 * `_failure.js`'s `Breaker` at every boundary. Deliberately not in this script:
 * an in-memory counter dies with the process, so a resumed run would walk
 * straight back into the same environmental fact the breaker exists to stop.
 *
 * The classifier has exactly one input here. `agent()` hands this script `null`
 * with no stderr, exit code or message, and the host already retried, so
 * `classify({})` is called with nothing and every failure lands on its
 * conservative fallback class. The breaker is therefore "N null returns in one
 * phase" — that is all it can be from inside the sandbox, and it is not dressed
 * up as more. Each record does name the agent and how many attempts
 * `dispatch()` made, so the distiller can address a recurring failure to the
 * agent that produced it rather than to a generic orchestrator.
 *
 * A TRIPPED PHASE IS FAILED, NOT COMPLETE. Marking it complete first meant a
 * resume replayed it from cache — one lens of four — and reported `completed`.
 * It is now `failPhase`d, so a resume re-executes it; and the breaker folds only
 * the current attempt's failures, so a resume after the cause is fixed does not
 * re-trip on the attempt it already recovered from.
 */
async function recordPhase(title, artifact, nextPhase, failedLabels, carried) {
  if (!RUN) return { tripped: false, entry: null }
  const failed = (failedLabels || []).map(label => ({
    label, agentType: AGENT_TYPES[label] || null, attempts: attemptsFor(label),
  }))
  const r = await bridge('phase', `${REQUIRE_HEAD}const s = require(path.join(DIR, '_state.js'))
const f = require(path.join(DIR, '_failure.js'))
const run = s.openRun({ workflow: ${JSON.stringify(WORKFLOW)}, cwd: process.cwd(), resumeFrom: ${JSON.stringify(RUN.runId)} })
const done = run.manifest.phases.filter(p => p.status === 'complete')
// A fresh process starts its own clock at zero, so the recorder would time the
// bridge subprocess instead of the phase. The real boundary is already on disk.
const prevIso = done.length ? (run._cache.get(done[done.length - 1].title) || {}).completedAt : run.manifest.startedAt
run._phaseStartMs = Date.parse(prevIso || run.manifest.startedAt)
const title = ${JSON.stringify(title)}
const cls = f.classify({})
for (const x of input.failed) {
  run.recordFailure({ label: x.label, agentType: x.agentType, phase: title, class: cls, attempt: x.attempts, of: x.attempts,
    detail: 'agent() returned no result - skipped, blocked, or gave up after the host runtime retried',
    strategyNext: x.attempts > 1 ? 'the workflow re-dispatched once with the output contract restated and it still returned nothing'
                                 : 'no further attempt was made by the workflow script; the host runtime owns transport retry' })
}
const breaker = new f.Breaker()
for (const rec of run.readFailures()) {
  if ((rec.epoch || 1) === run.attempt) breaker.record(rec.phase, rec.class || cls)
}
// Failures carried from an EARLIER phase count toward this phase's threshold
// but are NOT written again: they are already on failures.jsonl under the
// phase that produced them, and a second record would credit this phase's
// failures to an agent that never ran in it (code review S-A).
const carried = input.carried
const ownTripped = breaker.isTripped(title)
if (carried) for (const l of carried.labels) breaker.record(title, cls)
const tripped = breaker.isTripped(title)
if (tripped) {
  run.failPhase(title, 'breaker tripped: ' + JSON.stringify(breaker.trippedInfo(title)))
  // A trip that NEEDED the earlier phase's failures fails that phase too, so a
  // resume re-runs it — otherwise its dead agents are replayed as dead forever
  // (code review S-B). Not when this phase tripped on its own (round 3, C2).
  // Failed last, so the run resumes from the earlier phase.
  if (!ownTripped && carried && carried.labels.length && carried.from) {
    run.failPhase(carried.from, 'its failures counted toward the breaker trip in ' + title)
  }
} else {
  run.completePhase(title, input.artifact)
  if (${JSON.stringify(nextPhase)}) run.startPhase(${JSON.stringify(nextPhase)})
}
process.stdout.write(JSON.stringify({ tripped: tripped, info: breaker.trippedInfo(title), entry: breaker.asBlockedEntry(title) }))`, undefined, { artifact, failed, carried: carried || null })
  if (!r) {
    // The phase bridge was lost or its output discarded. The breaker must not
    // depend on it (QA round 3: a tampered phase output let a run with every
    // lens dead complete). Apply the threshold here, on what this script knows,
    // and say the phase is unrecorded either way.
    const count = failed.length + (carried && Array.isArray(carried.labels) ? carried.labels.length : 0)
    const BREAKER_THRESHOLD_LOCAL = 3   // mirrors _failure.js BREAKER_THRESHOLD
    const entry = {
      gate: count >= BREAKER_THRESHOLD_LOCAL ? 'breaker.unrecorded' : 'runtime.phaseUnrecorded',
      actionWithheld: count >= BREAKER_THRESHOLD_LOCAL
        ? `continuing past phase "${title}" after ${count} failed agent(s)`
        : `recording phase "${title}" (it is not resumable from the run directory)`,
      whyGated: `the phase record could not be written or its result was discarded, so ${count} failure(s) in "${title}" were counted in the workflow itself${count >= BREAKER_THRESHOLD_LOCAL ? ', which reaches the breaker threshold' : ''}`,
      prepared: 'the phase results are in this run\'s return value',
      unblocks: `re-run "${title}" once the cause is fixed — a resume cannot replay an unrecorded phase`,
      authorizeBy: 'not an authorization gate — a recording failure',
    }
    if (count >= BREAKER_THRESHOLD_LOCAL) log(`BREAKER TRIPPED in "${title}" (counted locally — the phase record was lost) — ${count} failure(s)`)
    return { tripped: count >= BREAKER_THRESHOLD_LOCAL, entry }
  }
  if (r.tripped && r.info) log(`BREAKER TRIPPED in "${title}" — ${r.info.count} x ${r.info.class}`)
  return r
}

function replayed(title) {
  if (!RUN || !RUN.resumed || !(title in RUN.resumed)) return null
  if (!REPLAYED.includes(title)) REPLAYED.push(title)
  return RUN.resumed[title]
}

/**
 * Run a phase, or replay it from the run cache when resuming.
 *
 * `fn` returns the phase artifact: `{ agents: [{label, result}], ... }`. That
 * shape is what `--resume` replays, so anything a later phase needs has to be
 * inside it.
 *
 * `uiTitle` is the `meta.phases` title shown to the user when it differs from
 * the recorded one — a repair loop records `Repair 1`, `Repair 2` so each round
 * resumes independently, while both display under the one declared `Repair`.
 */
async function runPhase(title, next, fn, uiTitle) {
  const cached = replayed(title)
  if (cached) {
    log(`phase "${title}" replayed from run ${RUN.runId} — no agent ran`)
    for (const a of cached.agents || []) keep(a.result)
    // The phase's learnings and retry ledger replay with it. Without this a
    // resumed run's outcome.json said the lens that got LRN-x in attempt 1 got
    // no learnings at all — the exposure record effectiveness is measured on.
    const led = cached._ledger || {}
    for (const x of led.learningsLoaded || []) {
      if (!LEARNINGS_LOADED.some(y => y.label === x.label)) LEARNINGS_LOADED.push(x)
    }
    for (const x of led.retries || []) RETRIES.push(x)
    return cached
  }
  phase(uiTitle || title)
  const ll0 = LEARNINGS_LOADED.length
  const rt0 = RETRIES.length
  const nl0 = NULL_RESULTS.length
  const artifact = await fn()
  artifact._ledger = { learningsLoaded: LEARNINGS_LOADED.slice(ll0), retries: RETRIES.slice(rt0) }
  for (const a of artifact.agents || []) keep(a.result)
  // Every dispatch in this phase that ended null — including refuters and
  // verifiers, whose null used to reach neither failures.jsonl nor the breaker,
  // so a run where cross-checking never happened looked healthy. A phase whose
  // agents feed a second pipeline stage may also report failures in
  // `artifact.failed`; those are merged, not double-counted.
  const nulls = NULL_RESULTS.slice(nl0)
  const declared = Array.isArray(artifact.failed)
    ? artifact.failed
    : (artifact.agents || []).filter(a => a.result === null || a.result === undefined).map(a => a.label)
  const failed = [...nulls, ...declared.filter(l => !nulls.includes(l))]
  const b = await recordPhase(title, artifact, next, failed, artifact.carried || null)
  if (b.entry) BREAKER_ENTRIES.push(b.entry)
  if (b.tripped) {
    // Stop the chain — do not merely log the trip. A breaker that records a
    // trip and then lets the next phase run has not opened the circuit: here
    // that meant release-manager producing a readiness recommendation from one
    // of four verify lenses, with nothing in its prompt saying three had died.
    //
    // Deliberately a plain sentinel object rather than an Error: the top-level
    // handler must be able to tell a decision this workflow made from a genuine
    // crash, and must not re-throw this one.
    throw { breakerStop: true, title, entry: b.entry }
  }
  return artifact
}

function agentResult(artifact, label) {
  const a = ((artifact && artifact.agents) || []).find(x => x && x.label === label)
  return a ? a.result : null
}

/**
 * CHG-16 — `blockedGates` is a REDUCER over the phase artifacts, not a string
 * telling the reader to go and collect the entries themselves.
 */
function blockedCandidates() {
  // Pure prefilter, not a reimplementation of the reducer: every entry the
  // regex can match contains the literal token BLOCKED, so dropping values that
  // do not cannot change the result. It only keeps the bridge payload small.
  return OUTPUTS.filter(v => {
    try { return JSON.stringify(v ?? '').includes('BLOCKED') } catch (e) { return true }
  })
}

// An empty array would read as "no gate was hit", which is the exact
// disappearance the reducer exists to prevent. A reducer that could not run is
// reported as this gate instead.
function uncollectedGate(count) {
  return {
    gate: 'reporting.blockedGatesUncollected',
    actionWithheld: 'collecting the BLOCKED entries this run produced',
    whyGated: `${count} phase output(s) contain a BLOCKED marker but the reducer could not be run, so they were not parsed`,
    prepared: 'the raw phase outputs are in the run directory when recording was available',
    unblocks: 'read the phase artifacts directly, or re-run with the runtime modules reachable',
    authorizeBy: 'not an authorization gate — a reporting failure',
  }
}

async function collectBlockedGates() {
  const candidates = blockedCandidates()
  if (!candidates.length) return { gates: [], complete: true }
  const r = await bridge('blocked-gates', `${REQUIRE_HEAD}const p = require(path.join(DIR, '_policy.js'))
process.stdout.write(JSON.stringify(p.collectBlockedGates(input.candidates)))`, undefined, { candidates })
  if (Array.isArray(r)) return { gates: r, complete: true }
  return { complete: false, gates: [uncollectedGate(candidates.length)] }
}

// Reopen the run in a fresh process, as it was. Shared by both close steps.
const closeHead = () => `${REQUIRE_HEAD}const s = require(path.join(DIR, '_state.js'))
const run = s.openRun({ workflow: ${JSON.stringify(WORKFLOW)}, cwd: process.cwd(), resumeFrom: ${JSON.stringify(RUN.runId)} })
// A fresh process makes the recorder's own clock start now; the run's real
// start is already in the manifest.
run._startMs = Date.parse(run.manifest.startedAt)
// Reopening marks every completed phase as resumed. Only the phases this run
// actually replayed from cache were — reporting the rest would be a false claim
// inside the record whose whole job is to be trustworthy afterwards.
run.resumedPhases = new Set(${JSON.stringify(REPLAYED)})
`

/** Write outcome.json with `summary` as given — the fallback close step. */
async function closeRun(summary) {
  if (!RUN) return null
  return bridge('close', `${closeHead()}// Only an acknowledgement crosses back: outcome.json is on disk, and echoing
// the whole outcome made this the largest relay of a run (round 3, M1).
const outcome = run.close(input.summary)
process.stdout.write(JSON.stringify({ ok: true, status: outcome && outcome.status }))`, undefined, { summary })
}

// The learning preview (distil.py, dry run), as the body of a function in the
// end-of-run step. It runs after outcome.json is written, so it reads this run.
const DISTIL_PREVIEW = `const { spawnSync } = require('child_process')
const tool = path.join(DIR, '..', 'tools', 'distil.py')
if (!fs.existsSync(tool)) {
  return { ok: false, text: 'distil.py not found at ' + tool + ' (this runtime directory ships no tools/)' }
}
// Each interpreter in turn: a missing one, the Windows Store alias (exit
// 9009) or one that prints nothing is not an answer — try the next. Run from
// the tool's own directory, never the repository's: a bare "python" would
// otherwise resolve a python.exe committed at the repository root. -B: no
// __pycache__ written beside the tool.
const tries = process.platform === 'win32'
  ? [['python', ['-B']], ['python3', ['-B']], ['py', ['-3', '-B']]]
  : [['python3', ['-B']], ['python', ['-B']]]
// One 60-second budget for all the tries together: this shares a transcriber
// call with the close, and three full timeouts would outlast its shell.
const until = Date.now() + 60000
for (const [py, flags] of tries) {
  const left = until - Date.now()
  if (left < 1000) return { ok: false, text: 'distil.py did not answer within 60 s' }
  const r = spawnSync(py, [...flags, tool, '--root', process.cwd()], { cwd: path.dirname(tool), encoding: 'utf8', timeout: left })
  if (r.error || r.status === 9009 || !String(r.stdout || '').trim()) continue
  // distil.py: 0 = done; 1 = something quarantined; 2 = something dropped.
  // All three are a real dry run. Anything else is a failure, not a preview.
  return [0, 1, 2].includes(r.status)
    ? { ok: true, text: String(r.stdout).slice(-4000) }
    : { ok: false, text: ('distil.py exited ' + r.status + ': ' + String(r.stderr || r.stdout || '')).slice(-1500) }
}
return { ok: false, text: 'no Python interpreter answered (tried ' + tries.map(t => t[0]).join(', ') + ')' }`

/**
 * The end of a recorded run as ONE bridge step: reduce the blocked gates, write
 * outcome.json with them, and — when asked — preview the learning candidates.
 * These were three transcriber calls, one after another, at the end of every
 * run. Returns { gates, gatesComplete, status, preview }, or null when the step
 * did not run; the caller then falls back to the separate steps.
 */
async function finishRecord(summary, wantPreview) {
  if (!RUN) return null
  const candidates = blockedCandidates()
  const r = await bridge('close', `${closeHead()}const fs = require('fs')
const p = require(path.join(DIR, '_policy.js'))
// The gates first, because the outcome records them. A reducer that throws is
// reported as the uncollected gate, never as [].
let gates = []
let gatesComplete = true
if (input.candidates.length) {
  try { gates = p.collectBlockedGates(input.candidates) } catch (e) { gates = null }
  if (!Array.isArray(gates)) { gates = [input.uncollected]; gatesComplete = false }
}
input.summary.blockedGates = gates.concat(input.summary.blockedGates)
const outcome = run.close(input.summary)
// Optional, so it can never cost the run its record (code review round 9).
let preview = null
${wantPreview ? `try {
  preview = (function () {
${DISTIL_PREVIEW}
  })()
} catch (e) {
  preview = { ok: false, text: 'the learning preview crashed: ' + String((e && e.message) || e).slice(0, 500) }
}` : '// No learning preview for this run.'}
// Only an acknowledgement, the gates and the preview cross back: outcome.json
// is on disk, and echoing it made this the largest relay of a run (round 3, M1).
process.stdout.write(JSON.stringify({ ok: true, status: outcome && outcome.status, gates: gates, gatesComplete: gatesComplete, preview: preview }))`,
  undefined, { summary, candidates, uncollected: uncollectedGate(candidates.length) })
  return r && r.ok === true && Array.isArray(r.gates) && typeof r.gatesComplete === 'boolean' ? r : null
}

/**
 * The self-improvement loop's own failure, as a gate that cannot vanish.
 *
 * A run whose runtime was unreachable completed its phases and recorded nothing
 * — no outcome, no failures, no learnings in or out. Before this it returned
 * `status: 'completed'` with `outcomeRecorded: false` buried in the payload, and
 * four of six commands produced exactly that on every invocation because they
 * passed `args` as a bare string. Measured: zero run directories, ever.
 */
function runtimeGates(outcome) {
  const out = []
  if (!RUNTIME_DIR) {
    out.push({
      gate: 'runtime.unreachable',
      actionWithheld: 'recording this run, loading learnings from prior runs, and the cross-phase breaker',
      whyGated: 'args carried no usable runtimeDir or policy path (a bare-string args, or an unexpanded ${CLAUDE_PLUGIN_ROOT}), so the runtime modules could not be reached — this run can neither learn nor be learned from',
      prepared: 'the phases themselves ran, with every autonomy gate read as NOT pre-authorized',
      unblocks: 'invoke the workflow with args as an OBJECT carrying runtimeDir: "<plugin root>/workflows"',
      authorizeBy: 'not an authorization gate — a wiring failure',
    })
  } else if (RECORDING && !outcome) {
    out.push({
      gate: 'runtime.outcomeUnrecorded',
      actionWithheld: 'writing outcome.json for this run',
      whyGated: RUN ? 'the close bridge step did not run, so the run directory has no outcome' : 'the run directory could not be opened',
      prepared: 'the phase results are in this return value',
      unblocks: 'check that node runs in this environment and .claude/runs/ is writable, then re-run',
      authorizeBy: 'not an authorization gate — a recording failure',
    })
  }
  return out
}

/**
 * Run the workflow body and ALWAYS reach the outcome record — on a stop, a
 * crash, or a clean finish. Shared, because six hand-kept copies of this tail
 * had already drifted apart in the fields they recorded.
 *
 * Deliberately NOT a `finally { return }`: returning from a finally swallows the
 * thrown error and a crashed run would report success.
 *
 * Reads and writes the host workflow's `status`; `extras()` supplies the
 * workflow's own findings, refutations and repair record at close time.
 */
async function finishRun(body, extras = () => ({})) {
  let result = null
  let thrown = null
  try {
    result = await body()
  } catch (e) {
    // A tripped breaker is a decision this workflow made, not a crash: it stops
    // the phases that depend on the failing one and records why. Anything else
    // is a genuine error, and is re-thrown once the outcome record is written.
    if (e && e.breakerStop === true) {
      status = 'stopped'
      result = {
        status: 'stopped',
        reason: `Breaker tripped in phase "${e.title}": ${e.entry.whyGated} Phases depending on it were not run.`,
      }
    } else {
      thrown = e
    }
  }

  // `completed` is a claim about the run, so it is withheld when the run cannot
  // back it. A run that could not reach its runtime recorded nothing and learned
  // nothing; a run whose terminal agent returned nothing has no deliverable.
  // Both used to read `completed`, and an orchestrator reading `status` saw a
  // clean run. They are `incomplete`, each with a gate saying why.
  const requiredGates = REQUIRED_MISSING.map(label => ({
    gate: 'run.deliverableMissing',
    actionWithheld: `reporting this run as completed`,
    whyGated: `the required result "${label}" came back empty, after one retry`,
    prepared: 'every earlier phase result is in this return value and the run directory',
    // A RE-RUN, not a resume: one null is below the breaker threshold, so the
    // phase was recorded complete with the empty result, and a resume would
    // replay that emptiness from cache (code review N2).
    unblocks: `re-run the workflow — a resume would replay the completed phase, empty deliverable included`,
    authorizeBy: 'not an authorization gate — a missing deliverable',
  }))
  if (status === 'completed' && (!RUNTIME_DIR || REQUIRED_MISSING.length)) status = 'incomplete'

  let blocked = { gates: [], complete: false }
  let outcome = null
  let x = {}
  try { x = extras() || {} } catch (e) { log(`could not collect the run's own record: ${(e && e.message) || e}`) }
  // Learning per ticket (review of the HU 16 pilot). Lessons from this
  // repository's recent runs already reach the next run unreviewed
  // (repoLessons); a SHARED lesson needs a person. So a completed feature run
  // previews what `distil.py` would propose — a dry run that writes nothing —
  // and hands it to that person. `"distil": false` turns it off.
  const wantPreview = WORKFLOW === 'sdlc-feature' && status === 'completed' && !(args && typeof args === 'object' && args.distil === false)
  let preview = null
  try {
    const summary = {
      status,
      findings: x.findings || { confirmed: 0, refuted: 0, byLens: {} },
      refutations: x.refutations || [],
      blockedGates: [...BREAKER_ENTRIES, ...requiredGates, ...runtimeGates(true)],
      error: thrown ? String((thrown && thrown.message) || thrown) : null,
      learningsLoaded: LEARNINGS_LOADED,
      repoLessonsLoaded: repoLessonsLoaded(),
      learningsSkipped: LEARNING_SET.skipped || [],
      learningsError: LEARNING_SET.error || null,
      policyDegraded: POLICY.degraded === true,
      actGranted: POLICY.actGranted || [],
      retries: RETRIES,
      repairRounds: x.repairRounds || null,
    }
    // A step that threw (a host transport error) is a step that did not run:
    // it takes the same fallback as one that returned nothing (code review).
    let done = null
    try { done = await finishRecord(summary, wantPreview) } catch (e) {
      log(`the end-of-run step failed: ${String((e && e.message) || e).slice(0, 300)}`)
    }
    if (done) {
      blocked = { gates: done.gates, complete: done.gatesComplete }
      outcome = done
      preview = done.preview
    } else {
      // The one step did not run, or there is no run directory: the separate
      // steps, as before — costlier, and only on this path. No preview here.
      if (RUN) log('the end-of-run step did not run — collecting the blocked gates and writing the outcome separately')
      blocked = await collectBlockedGates()
      outcome = await closeRun({ ...summary, blockedGates: [...blocked.gates, ...summary.blockedGates] })
      if (outcome && wantPreview) log('the learning preview (distil.py, dry run) did not run — the end-of-run step that carries it failed')
    }
  } catch (e) {
    // Never let a failure to WRITE the record replace the failure that caused it.
    log(`could not complete the outcome record: ${(e && e.message) || e}`)
    // Gates that were never collected are said to be uncollected, never [].
    if (!blocked.complete && !blocked.gates.length) {
      const n = blockedCandidates().length
      if (n) blocked = { gates: [uncollectedGate(n)], complete: false }
    }
  }

  if (thrown) throw thrown

  let learningCandidates = null
  if (preview && preview.ok === true && typeof preview.text === 'string') learningCandidates = preview.text
  else if (preview) log(`the learning preview (distil.py, dry run) did not run${typeof preview.text === 'string' ? ` — ${preview.text.slice(0, 300)}` : ''}`)

  const allGates =[...blocked.gates, ...BREAKER_ENTRIES, ...requiredGates, ...runtimeGates(outcome)]
  return {
    ...(result || {}),
    status,
    // Stated first-class, not buried: any act.* gate the resolved policy
    // grants, and the file that granted it. A repo's own .claude/autonomy.json
    // can grant these, so a reader must be able to see that it did.
    actGranted: POLICY.actGranted || [],
    selfHealDisabled: !RUNTIME_DIR,
    runId: RUN ? RUN.runId : null,
    runDir: RUN ? RUN.dir : null,
    outcomeRecorded: !!outcome,
    resumedPhases: [...REPLAYED],
    // Unattended runs defer gates rather than halting (see the autonomy-policy
    // skill). Every BLOCKED entry any agent emitted survives to this top level
    // as a parsed ARRAY — a blocked gate that vanishes because the rest of the
    // run looked clean is a reporting failure.
    blockedGates: allGates,
    blockedGatesComplete: blocked.complete,
    // Only real trips: a phase that merely went unrecorded is a gate, not a trip.
    breakerTripped: BREAKER_ENTRIES.some(e => /^breaker\./.test(String(e.gate))) ? BREAKER_ENTRIES.filter(e => /^breaker\./.test(String(e.gate))) : null,
    learningsLoaded: LEARNINGS_LOADED,
    // First-class, like actGranted: which agents were steered by UNRATIFIED
    // repo-local lessons no human reviewed (security review).
    repoLessonsLoaded: repoLessonsLoaded(),
    learningsSkipped: LEARNING_SET.skipped || [],
    learningsError: LEARNING_SET.error || null,
    // What distil.py would propose from this repository's runs (dry run).
    // Keeping a candidate is a person's call: distil.py --emit, then a PR.
    learningCandidates,
    retries: RETRIES,
    ...(x.repairRounds ? { repairRounds: x.repairRounds } : {}),
    policySource: POLICY.source,
    degraded: POLICY.degraded,
  }
}
// <<< RUNTIME BLOCK <<<

const release = typeof args === 'string' ? args : args?.release ?? 'the pending release on the current branch'

const GATE_SCHEMA = {
  type: 'object',
  required: ['gate', 'status', 'evidence'],
  properties: {
    gate: { type: 'string' },
    // Mirrors release-manager's own vocabulary so nothing needs translating.
    status: { type: 'string', enum: ['Confirmed', 'Claimed-not-verified', 'Missing', 'N/A'] },
    evidence: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

// Each gate is answered by the agent that actually owns it. None of them can
// declare the release ready — they report evidence; release-manager classifies.
const GATES = [
  {
    key: 'engineering',
    agentType: 'solution-architect',
    brief:
      'Architectural sign-off for this release. Was a Tier 2+ structural decision in play, and does the implementation follow the intended design? Scope this to architectural alignment only — code review is code-reviewer\'s, not yours to redo.',
  },
  {
    key: 'quality',
    agentType: 'qa-engineer',
    brief:
      'Quality gate. Report what you have actually Verified this session versus what is Unverified or Untestable. Do not let "the implementer said tests pass" become Confirmed — that is Claimed-not-verified unless you ran it. Include what was not tested and the risk that leaves.',
  },
  {
    key: 'security',
    agentType: 'security-engineer',
    brief:
      'Security gate. Map findings to blocking vs non-blocking per your §4: Critical/High block, Medium is Should-Fix, Low/Informational do not block alone. Give a clear blocking read, not a raw finding list. You document risk acceptance; you never accept it on anyone\'s behalf.',
  },
  {
    key: 'operations',
    agentType: 'site-reliability',
    brief:
      'Operations readiness. Monitoring exists, dashboards exist, alerts exist AND are owned, rollback signals defined. Report as Confirmed/Missing per item, not a vague impression. Include current error-budget state — a service that has already burned its budget for the period is evidence for slowing velocity.',
  },
  {
    key: 'rollback',
    agentType: 'database-engineer',
    brief:
      'Data-layer reversibility. Is there a real path back — for schema, data, and config? A rollback plan that has not been rehearsed is Claimed-not-verified, not Confirmed. Say plainly which it is; qa-engineer executes the rehearsal, not you.',
  },
]

// ===========================================================================
// The workflow itself. Wrapped so that every exit — a stop, a crash, or a clean
// finish — still reaches the outcome record. Deliberately NOT a
// `finally { return }`: returning from a finally swallows the thrown error and
// a crashed run would report success.
// ===========================================================================
let status = 'crashed'

async function runWorkflow() {
  const opened = await openRun('Gates')
  if (opened && opened.fatal) {
    status = 'stopped'
    return { status: 'stopped', reason: opened.fatal }
  }

  const gatesArtifact = await runPhase('Gates', 'Synthesize', async () => {
    const gates = await parallel(
      GATES.map(g => () =>
        dispatch(withPolicy(`Assess your gate for: ${release}\n\n${g.brief}`), {
          agentType: g.agentType,
          label: `gate:${g.key}`,
          phase: 'Gates',
          schema: GATE_SCHEMA,
        }).then(r => (r ? { ...r, key: g.key, owner: g.agentType } : { key: g.key, owner: g.agentType, gate: g.key, status: 'Missing', evidence: 'Gate agent produced no result — treated as Missing, never as passing.' })),
      ),
    )
    return { agents: GATES.map((g, i) => ({ label: `gate:${g.key}`, result: gates[i] })) }
  })

  const gates = (gatesArtifact.agents || []).map(a => a.result).filter(Boolean)
  const blocking = gates.filter(g => g.status === 'Missing' || (g.blockers ?? []).length)
  const unverified = gates.filter(g => g.status === 'Claimed-not-verified')
  log(`${gates.filter(g => g.status === 'Confirmed').length}/${gates.length} gates Confirmed; ${unverified.length} claimed-not-verified; ${blocking.length} blocking`)

  const synthArtifact = await runPhase('Synthesize', null, async () => {
    const recommendation = await dispatch(
      withPolicy(`Produce a release readiness recommendation for: ${release}

GATE RESULTS:
${JSON.stringify(gates, null, 2)}

Rules you already hold, restated because this run is automated and nobody is watching each step:
- A gate with no result is Missing, never "probably fine".
- Claimed-not-verified is not Confirmed. Do not upgrade it because the claim sounds plausible or the release is wanted.
- Name explicitly what evidence is absent and what risk shipping without it accepts.
- Produce a RECOMMENDATION for a human to confirm. You do not hold deploy authority, and neither does this workflow.
- The autonomy policy in force is stated at the top of this prompt; you do not need to go and find it. Reproduce every BLOCKED gate entry from the evidence verbatim rather than dropping it because the recommendation is otherwise a Go.`),
      { agentType: 'release-manager', label: 'recommendation', phase: 'Synthesize' },
    )
    return { agents: [{ label: 'recommendation', result: recommendation }] }
  })

  status = 'completed'
  return {
    release,
    gates,
    gatesConfirmed: gates.filter(g => g.status === 'Confirmed').map(g => g.key),
    gatesBlocking: blocking.map(g => g.key),
    gatesClaimedNotVerified: unverified.map(g => g.key),
    recommendation: requireResult('recommendation', agentResult(synthArtifact, 'recommendation')),
    authority:
      'RECOMMENDATION ONLY. This workflow has no deploy authority and cannot grant it. A human confirms go/no-go.',
  }
}

// Every exit — stop, crash or clean finish — reaches the outcome record,
// the retry and learnings ledger, and the blocked-gate reducer. See
// finishRun() in the runtime block.
return await finishRun(runWorkflow)
