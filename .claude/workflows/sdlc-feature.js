export const meta = {
  name: 'sdlc-feature',
  description: 'Run a feature end-to-end through the SDLC agent suite — plan expensive, execute cheap: plan, design, build, test, review, release readiness, each stage handing the next a file',
  whenToUse: 'A feature or change large enough to warrant the full lifecycle. Pass the initiative description as args. Produces recommendations only — never deploys.',
  phases: [
    { title: 'Plan', detail: 'plan tier (Fable/high): product-manager writes intent.md, product-analyst spec.md, solution-architect plan.md' },
    { title: 'Design', detail: 'design tier (Opus/xhigh): ux-designer spec + ui-engineer static mock — only when a frontend surface is touched' },
    { title: 'Build', detail: 'build tier (Sonnet/medium): software-engineer / ui-engineer / database-engineer execute plan.md; plan gaps escalate, never improvised' },
    { title: 'Test', detail: 'test tier (Sonnet) designs and interprets; qa-runner on the testLoop tier (Haiku) runs the loops' },
    { title: 'Review', detail: 'review tier (Opus/high) code review and performance, security tier (Fable) security — handed the test report' },
    { title: 'Cross-check', detail: 'every finding handed to a refuter before it is reported' },
    { title: 'Repair', detail: 'the builder fixes confirmed blocking findings in its own change — at most 2 rounds' },
    { title: 'Re-verify', detail: 'only the lenses that raised a blocking finding re-check the repair, then the refuter' },
    { title: 'Readiness', detail: 'release-manager recommends go/no-go for HUMAN approval; technical-writer drafts docs' },
    { title: 'Runtime', detail: 'bridge steps that reach the recorder, the policy loader and the brief builder' },
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

const WORKFLOW = 'sdlc-feature'
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
const [POLICY_STEP, LEARNING_STEP] = await parallel([loadPolicyStep, loadLearningsStep])
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

// ---------------------------------------------------------------------------
// The initiative under development. Pass a string or {initiative, paths} object.
// ---------------------------------------------------------------------------
const initiative =
  typeof args === 'string' ? args : args?.initiative ?? 'No initiative supplied — report this and stop.'

// ===========================================================================
// MODEL TIERS — "plan expensive, execute cheap".
//
// The most capable model is spent where a mistake is most expensive to undo:
// the plan every later stage executes against. Build and test run a cheaper
// tier against that plan; mechanical loops (command execution, bridge
// transcription) run the cheapest. Review returns to a strong tier, security
// to the strongest — the writer never reviews its own work, and a reviewer
// weaker than the writer is not much of an independent lens.
//
// WHY HERE AND NOT IN AGENT FRONTMATTER. generate_trees.py refuses any agent
// whose `model:` is not `inherit`: a pin is not portable, and Command Code
// offers no Claude models at all. A tier is a property of the STAGE an agent
// runs in, not of the agent — code-reviewer reviews on the review tier and
// refutes on the refute tier. So it is set here, per agent() call. The pi /
// Hermes runner reads the model from the agent file and ignores `opts.model`,
// and maps only low/medium/high efforts, so under those harnesses these pins
// fall back to the session model instead of failing.
//
// Override with `args.tiers`:
//   'inherit'                    — no pins: every stage follows the session
//   { plan: { model: 'fable' } } — partial per-stage override (e.g. a risky change)
// An unrecognised stage, model or effort is logged and IGNORED — the default
// stands. It is never passed through: an unknown model id fails the agent.
// ===========================================================================
// Opus plans, designs and reviews; Sonnet builds and tests; Haiku runs the
// mechanical steps. Fable is opt-in per stage, for changes where a planning or
// security mistake is expensive (auth, payments, destructive data changes,
// concurrency, a lasting architecture decision): on the live pilot it cost
// twice Opus and over-planned a trivial change, with no measured gain.
const DEFAULT_TIERS = {
  plan:       { model: 'opus',    effort: 'high' },
  design:     { model: 'opus',    effort: 'high' },
  build:      { model: 'sonnet',  effort: 'medium' },
  test:       { model: 'sonnet',  effort: 'medium' },
  testLoop:   { model: 'haiku',   effort: 'low' },
  review:     { model: 'opus',    effort: 'high' },
  security:   { model: 'opus',    effort: 'high' },
  refute:     { model: 'inherit', effort: 'low' },
  readiness:  { model: 'opus',    effort: 'high' },
  docs:       { model: 'sonnet',  effort: 'medium' },
  transcribe: { model: 'haiku',   effort: 'low' },
}
const TIER_MODELS = ['fable', 'opus', 'sonnet', 'haiku', 'inherit']
const TIER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function resolveTiers(v) {
  const out = {}
  for (const k of Object.keys(DEFAULT_TIERS)) out[k] = { ...DEFAULT_TIERS[k] }
  if (v === undefined || v === null) return out
  if (v === 'inherit') {
    // Exactly the pre-tier behaviour: no model pins and no effort pins, except
    // the refuter's low effort, which predates tiers.
    for (const k of Object.keys(out)) out[k] = { model: 'inherit', effort: k === 'refute' ? 'low' : null }
    return out
  }
  if (typeof v !== 'object' || Array.isArray(v)) {
    log(`args.tiers ignored — expected 'inherit' or an object keyed by stage, got ${JSON.stringify(v)}`)
    return out
  }
  for (const [k, t] of Object.entries(v)) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) {
      log(`args.tiers.${k} ignored — unknown stage (known: ${Object.keys(out).join(', ')})`)
      continue
    }
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      log(`args.tiers.${k} ignored — expected {model?, effort?}`)
      continue
    }
    if ('model' in t) {
      if (TIER_MODELS.includes(t.model)) out[k].model = t.model
      else log(`args.tiers.${k}.model ${JSON.stringify(t.model)} ignored — not one of ${TIER_MODELS.join(', ')}`)
    }
    if ('effort' in t) {
      if (t.effort === null || TIER_EFFORTS.includes(t.effort)) out[k].effort = t.effort
      else log(`args.tiers.${k}.effort ${JSON.stringify(t.effort)} ignored — not one of ${TIER_EFFORTS.join(', ')}`)
    }
  }
  return out
}

const TIERS = resolveTiers(typeof args === 'object' && args ? args.tiers : undefined)
log(`model tiers: ${Object.entries(TIERS).map(([k, t]) => `${k}=${t.model}${t.effort ? `/${t.effort}` : ''}`).join(', ')}`)

/** agent() opts for a stage: a pin only where one is set — 'inherit' is omitted. */
function tier(key) {
  const t = TIERS[key] || {}
  return {
    ...(t.model && t.model !== 'inherit' ? { model: t.model } : {}),
    ...(t.effort ? { effort: t.effort } : {}),
  }
}

// ===========================================================================
// FILE HANDOFFS — each stage hands the next a file.
//
// WHERE. By default <runDir>/handoff/. With `args.specDir` — a repository-
// relative directory such as "specs/features/HU-22" — they are durable, in the
// repository beside the change they describe: the layout the Hay Mesa loop
// uses, where a person (or the ClickUp ticket) writes intent.md and Plan adds
// spec.md and plan.md next to it. `args.intentPath` names an existing intent
// file without moving the rest.
//
// WHO WRITES. An agent that authors a document — intent.md, plan.md,
// design.md, mock.html — writes it ITSELF with its Write tool; a sealed bridge
// then confirms the file and records its SHA-256 in the phase artifact. Only
// if the author did not write it is it written from the returned text, and
// only when that text is short. Documents this workflow renders (spec.md,
// test-report.md) are written by a sealed bridge after every phase, replay
// included. Nothing long is transcribed as hex (code review S-E).
//
// TRUST. A path reaches a downstream prompt only for a file confirmed on disk.
// On a RESUME an authored file must still hash to what its phase recorded: a
// file edited or planted between attempts is not handed on (security F7, code
// review C-2) — so an intended human edit to plan.md means re-running, not
// resuming.
//
// STRICT. With `args.specDir`, or `args.strict: true`, a stage whose input
// file is not confirmed DOES NOT START: the run stops and names the file.
// Otherwise the stage gets the inline text instead — never a dangling path.
// ===========================================================================
// Directories a spec directory must never be inside: writing plan.md there
// would create a slash command, a CI workflow input or a git hook (N7).
const SPEC_DIR_DENY = new Set(['.git', '.claude', '.github', 'node_modules'])

function repoRelPath(v, what) {
  if (v === undefined || v === null || v === '') return { value: null }
  const p = typeof v === 'string' ? v.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^(\.\/)+/, '') : ''
  const bad = `args.${what} ${JSON.stringify(v)} is not a plain repository-relative path — it must be relative to the repository root, with no "..", ".", drive or leading slash`
  if (!p || /^\//.test(p) || /^[A-Za-z]:/.test(p) || p.split('/').some(seg => seg === '..' || seg === '.' || seg === '') ||
      !/^[A-Za-z0-9._\/-]+$/.test(p)) {
    return { error: bad }
  }
  // Any segment that starts with "." or is node_modules, in any case and at any
  // depth: .Git/hooks is the real .git/hooks on a case-insensitive filesystem,
  // and pkg/.claude/commands is still a command directory (security N7, QA D-4).
  const hidden = p.split('/').find(seg => seg.startsWith('.') || seg.toLowerCase() === 'node_modules')
  if (what === 'specDir' && hidden) {
    return { error: `args.specDir ${JSON.stringify(v)} goes through ${hidden}/ — documents written there would become commands, hooks or CI inputs. Use a directory such as specs/features/<HU>.` }
  }
  return { value: p }
}
const SPEC_DIR_ARG = repoRelPath(args && typeof args === 'object' ? args.specDir : null, 'specDir')
const INTENT_ARG = repoRelPath(args && typeof args === 'object' ? args.intentPath : null, 'intentPath')
const SPEC_DIR = SPEC_DIR_ARG.value
// The team's own QA case format, when the repository has one: the Test stage
// writes casos.md by it, and a tracker draft if it describes one (Jean's review
// of the HU 16 pilot: evidence in the shape the team already reviews in its
// tracker). Repository-relative; `args.qaTemplate` overrides the default.
const QA_TEMPLATE_ARG = repoRelPath(args && typeof args === 'object' ? args.qaTemplate : null, 'qaTemplate')
// A bad path stops the run like a bad specDir does (below): silently using
// another template would write the evidence in a format nobody asked for.
const QA_TEMPLATE = QA_TEMPLATE_ARG.value || 'specs/qa-case-template.md'
const STRICT = !!SPEC_DIR || (args && typeof args === 'object' && args.strict === true)
// Plan approval (code review M3). In spec mode the run pauses after Plan by
// default; approvedPlan adopts the person's committed spec.md and plan.md;
// replan overwrites uncommitted edits on purpose.
const APPROVED = !!(args && typeof args === 'object' && args.approvedPlan === true)
const REPLAN = !!(args && typeof args === 'object' && args.replan === true)
// Pausing hands the person durable files to approve, so it exists only in spec mode.
const PAUSE = !!SPEC_DIR && (args && typeof args === 'object' && typeof args.pauseAfterPlan === 'boolean' ? args.pauseAfterPlan : true)
// WHERE BUILDERS WORK. 'worktrees': one isolated worktree per builder, in
// parallel. 'checkout': one after another (data, backend, frontend) in the
// checkout the run started in — the default in spec mode. On the first live
// run the per-builder worktrees diverged (three versions of the same files,
// repairs landing in different trees), were never joined, and were created
// from the default branch rather than the HU branch; a person had to pick the
// right tree by hand. In the checkout there is one tree, on the HU branch.
const BUILD_TREE_ARG = args && typeof args === 'object' ? args.buildTree : undefined
const BUILD_TREE = (() => {
  if (BUILD_TREE_ARG !== undefined && BUILD_TREE_ARG !== 'checkout' && BUILD_TREE_ARG !== 'worktrees') {
    log(`args.buildTree ${JSON.stringify(BUILD_TREE_ARG)} ignored — expected 'checkout' or 'worktrees'`)
  }
  const want = BUILD_TREE_ARG === 'checkout' || BUILD_TREE_ARG === 'worktrees' ? BUILD_TREE_ARG : (SPEC_DIR ? 'checkout' : 'worktrees')
  if (want === 'checkout' && !SPEC_DIR) {
    log("args.buildTree 'checkout' needs args.specDir (its preflight finds the base commit) — building in worktrees")
    return 'worktrees'
  }
  return want
})()
let BUILD_BASE = null   // the commit a checkout build diffs against, from the spec preflight
// COMMIT PER STAGE (jeanbot's follow-up to the adversarial review: "commit base
// y commit por etapa, evidencia sobre el commit final"). In a checkout build the
// workflow itself commits after Build, after Test, after each Repair and at the
// end, on the branch the run started on — so every stage's output has a commit,
// the evidence names the commit it was produced on, and the run can show that
// what it delivers is what it verified. Builders still never commit; the
// workflow does. "commitStages": false keeps the change uncommitted, as before.
const STAGE_COMMITS = BUILD_TREE === 'checkout' && !(args && typeof args === 'object' && args.commitStages === false)
const verification = {
  stageCommits: STAGE_COMMITS,
  base: null,
  commits: [],               // [{stage, commit, tree, empty}]
  verifiedCommit: null,      // the commit the last verification stage ran on
  verifiedStage: null,
  finalCommit: null,
  deliveredMatchesVerified: null,
  changedAfterVerification: [],
  errors: [],
}
/** How a reader sees the WHOLE change — never cut from a lens brief. */
const changeRef = () => (BUILD_TREE === 'checkout' && BUILD_BASE
  ? (STAGE_COMMITS
    ? `The whole change is COMMITTED on the current branch, stage by stage, since ${BUILD_BASE}. List it with \`git diff ${BUILD_BASE} --stat\` and \`git log --oneline ${BUILD_BASE}..HEAD\`; read it with \`git diff ${BUILD_BASE}\`; \`git status --short\` shows anything a stage has not committed yet.`
    : `The whole change is UNCOMMITTED in the checkout this run started in. List it with \`git diff ${BUILD_BASE} --stat\` and \`git status --short\` (new files are untracked); read it with \`git diff ${BUILD_BASE}\`.`)
  : '')

/**
 * Commit everything the stage left in the checkout (outside .claude/, which
 * holds the run's own state) with a message naming the run and the stage, and
 * return {commit, tree, empty}. A stage that changed nothing is not committed;
 * its commit is HEAD. With `checkSince`, also report whether anything outside
 * the spec directory changed between that commit and the new HEAD — the
 * verified-equals-delivered check. Hooks run and signing follows the
 * repository's own configuration: a commit they refuse is recorded, the run
 * continues with the change uncommitted, and the evidence is reported unbound.
 */
async function commitStage(stage, checkSince = null) {
  if (!STAGE_COMMITS || !RUN) return null
  const r = await sealedBridge('stage-commit', null, `const CFG = ${JSON.stringify({
    root: repoRoot(), specDir: SPEC_DIR, since: checkSince,
    message: `sdlc-feature(${RUN.runId}): ${stage}${initiative ? ` — ${String(initiative).replace(/\s+/g, ' ').slice(0, 72)}` : ''}`,
  })}
const { execFileSync } = require('child_process')
const run = (...a) => execFileSync('git', a, { cwd: CFG.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const errText = e => String((e && e.stderr) || (e && e.message) || e).slice(0, 600)
try { run('add', '-A', '--', '.', ':(exclude).claude') } catch (e) { return { error: 'git add failed: ' + errText(e) } }
let empty = false
try { run('diff', '--cached', '--quiet'); empty = true } catch (e) { if (e.status !== 1) return { error: 'git diff --cached failed: ' + errText(e) } }
if (!empty) {
  try { run('commit', '-q', '-m', CFG.message) } catch (e) { return { error: 'git commit was refused: ' + errText(e) } }
}
const commit = run('rev-parse', 'HEAD')
const tree = run('rev-parse', 'HEAD^{tree}')
let matches = null
let changed = []
if (CFG.since) {
  const scope = ['--', '.', ':(exclude).claude'].concat(CFG.specDir ? [':(exclude)' + CFG.specDir] : [])
  try {
    changed = run.apply(null, ['diff', '--name-only', CFG.since, commit].concat(scope)).split('\\n').filter(Boolean)
    matches = changed.length === 0
  } catch (e) { matches = null }
}
return { commit, tree, empty, matches, changed: changed.slice(0, 50) }`, TIERS.transcribe.model)
  if (!r || typeof r !== 'object') {
    verification.errors.push(`${stage}: the commit step did not run`)
    log(`stage commit after ${stage} did not run — the change stays uncommitted`)
    return null
  }
  if (r.error) {
    verification.errors.push(`${stage}: ${r.error}`)
    log(`stage commit after ${stage} failed — ${r.error}`)
    return null
  }
  const rec = { stage, commit: r.commit, tree: r.tree, empty: r.empty === true }
  verification.commits.push(rec)
  if (checkSince) {
    verification.deliveredMatchesVerified = r.matches === true ? true : r.matches === false ? false : null
    verification.changedAfterVerification = Array.isArray(r.changed) ? r.changed : []
  }
  log(`stage commit after ${stage}: ${r.empty ? 'nothing to commit' : 'committed'} — ${String(r.commit).slice(0, 12)}`)
  return rec
}
// Who wrote a handed-on file, for the sentence a downstream agent reads.
const HANDOFF_ORIGIN = {}
const RENDER_CAP = 64 * 1024          // a rendered document is cut to this before it is written (16 KB cut a real 22 KB spec.md, HU 16 pilot)
const FALLBACK_WRITE_MAX = 16 * 1024  // returned text longer than this is never transcribed to a file

const HANDOFF_FILES = {}   // name -> absolute path, ONLY for files confirmed on disk
const HANDOFF_NAME_RE = /^[a-z0-9-]+\.(md|html)$/

/** The repository root, derived from the run directory `<root>/.claude/runs/<id>`. */
function repoRoot() {
  const m = RUN && RUN.dir ? /^(.*)[\\/]\.claude[\\/]runs[\\/][^\\/]+$/.exec(String(RUN.dir)) : null
  return m ? m[1] : null
}

function handoffDir() {
  if (!RUN || !RUN.dir) return null
  if (!SPEC_DIR) return `${RUN.dir}/handoff`
  const root = repoRoot()
  return root ? `${root}/${SPEC_DIR}` : null
}

function handoffPath(name) {
  const d = handoffDir()
  return d && HANDOFF_NAME_RE.test(name) ? `${d}/${name}` : null
}

// WHERE A DECISION IS RECORDED. In spec mode the HU's documents live in the
// spec directory, which the team versions and reviews. The HU 16 pilot's
// architect followed its project-memory skill and wrote the ADR to
// .claude/memory/decisions/ — local, unversioned, seen by no one else — and a
// person had to move it by hand. The agents that make design decisions are told
// where the record goes instead. dispatch() (runtime block) appends this.
const DECIDING_AGENTS = new Set([
  'solution-architect', 'ux-designer',
  'software-engineer', 'ui-engineer', 'database-engineer',
])
function extraInstructionFor(agentType) {
  if (!SPEC_DIR || !DECIDING_AGENTS.has(agentType)) return ''
  const p = handoffPath('decisiones.md')
  if (!p) return ''
  return `DECISION RECORDS. This change's documents live in ${SPEC_DIR}/, which the team versions and reviews. Any decision record you write for it — an ADR, a design, data or interface decision, a trade-off you settled — goes in ${p}: add a section headed with the decision and your role, and create the file if it is absent. Do NOT write it under .claude/memory/: that directory is local and unversioned, so a decision recorded there is one the team never sees. For this run, this replaces your project-memory instruction to use .claude/memory/decisions/.`
}

/** Where intent.md is read from when a person wrote it; null when product-manager writes it. */
function externalIntentPath() {
  const root = repoRoot()
  if (INTENT_ARG.value) return root ? `${root}/${INTENT_ARG.value}` : null
  if (SPEC_DIR) return handoffPath('intent.md')
  return null
}

function asText(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  return '```json\n' + JSON.stringify(v, null, 2) + '\n```\n'
}

function capText(s, n) {
  return s.length <= n ? s : `${s.slice(0, n)}\n\n…[truncated at ${n} characters — the full content is in the run's return value]\n`
}

/** The sentence an authoring agent is given: write the file yourself. */
function writeInstruction(name) {
  const p = handoffPath(name)
  return p
    ? `\n\nHANDOFF FILE: write the complete document to ${p} with your Write tool (create the directory if needed) — the next stage reads that file, not your reply. Then return the same document as your result.`
    : ''
}

/**
 * Confirm files on disk and return {name: sha256|null}. `fallback` maps a name
 * to text to write first when the file is absent — only when short.
 */
/**
 * Confirm authored files on disk and return {name: sha256|null}.
 *
 * A file is THIS run's only if it changed during the phase (its hash differs
 * from `before`, taken in the preflight) or it equals the text its author
 * returned. Anything else is what an earlier run — or someone — left at that
 * path (security N5, code review M2): it is replaced from the returned text
 * when that is short enough, and otherwise not handed on at all.
 */
async function confirmFiles(paths, fallback = {}, before = {}) {
  const entries = Object.entries(paths).filter(([n, p]) => p && HANDOFF_NAME_RE.test(n))
  if (!entries.length) return {}
  const write = {}
  const expect = {}
  const prior = {}
  for (const [n] of entries) {
    const t = fallback[n]
    if (typeof t === 'string' && t.trim()) {
      expect[n] = sha256Hex(utf8Bytes(t))
      if (t.length <= FALLBACK_WRITE_MAX) write[n] = t
    }
    if (typeof before[n] === 'string') prior[n] = before[n]
  }
  const r = await sealedBridge('handoff', { write }, `// Where this step writes, in the clear; only the documents' text is in the encoded input.
const FILES = ${JSON.stringify(Object.fromEntries(entries))}
const PRIOR = ${JSON.stringify(prior)}
const EXPECT = ${JSON.stringify(expect)}
const ROOT = ${JSON.stringify(SPEC_DIR ? repoRoot() : null)}
const fs = require('fs')
const confinedForWrite = (root, p) => {
  if (!root) return true
  const R = path.resolve(root)
  const rel = path.relative(R, path.resolve(p))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  let cur = R
  for (const seg of path.dirname(rel).split(path.sep).filter(x => x && x !== '.')) {
    cur = path.join(cur, seg)
    try { if (fs.lstatSync(cur).isSymbolicLink()) return false } catch (e) { break }
  }
  // The file itself: writeFileSync follows a link, so a document swapped for
  // a link after the preflight would carry the write out (code review round 5).
  try { if (fs.lstatSync(path.resolve(p)).isSymbolicLink()) return false } catch (e) { /* absent: fine */ }
  // Fail closed (Alexander's review of PR #6): a path that cannot be resolved
  // is not confined. Before the first write the target's directory may not
  // exist yet, so the deepest directory that does exist is resolved instead.
  try {
    const realRoot = fs.realpathSync(R)
    let dir = path.dirname(path.resolve(p))
    while (!fs.existsSync(dir)) {
      const up = path.dirname(dir)
      if (up === dir) return false
      dir = up
    }
    const realDir = fs.realpathSync(dir)
    return realDir === realRoot || realDir.startsWith(realRoot + path.sep)
  } catch (e) { return false }
}
const out = {}
const shaOf = p => { try { const b = fs.readFileSync(p); return b.length ? crypto.createHash('sha256').update(b).digest('hex') : null } catch (e) { return null } }
for (const n of Object.keys(FILES)) {
  const p = FILES[n]
  let sha = shaOf(p)
  const ours = sha && (PRIOR[n] === undefined || sha !== PRIOR[n] || sha === EXPECT[n])
  if (!ours) {
    if (typeof input.write[n] === 'string') {
      // Confined BEFORE any directory is created, and again at the moment of
      // writing (round 6).
      if (!confinedForWrite(ROOT, p)) { out[n] = { sha: null, stale: false, escaped: true }; continue }
      fs.mkdirSync(path.dirname(p), { recursive: true })
      // Re-checked at the moment of writing: a link swapped in after the
      // preflight must not carry the write out of the repository (N6).
      if (!confinedForWrite(ROOT, p)) { out[n] = { sha: null, stale: false, escaped: true }; continue }
      // Written to a temporary file and renamed over the target: a rename
      // replaces the directory entry, so it never follows a link swapped in
      // after the check and never writes through a hardlink (round 6).
      const tmp = p + '.tmp-' + process.pid
      fs.writeFileSync(tmp, input.write[n], 'utf8')
      fs.renameSync(tmp, p)
      sha = shaOf(p)
      out[n] = { sha, stale: false }
    } else {
      out[n] = { sha: null, stale: !!sha }
    }
  } else {
    out[n] = { sha, stale: false }
  }
}
return out`, TIERS.transcribe.model)
  const shas = {}
  for (const [n, p] of entries) {
    const x = r && r[n]
    const sha = x && typeof x.sha === 'string' && /^[0-9a-f]{64}$/.test(x.sha) ? x.sha : null
    shas[n] = sha
    // The path is OURS, never the bridge's: the sealed result decides only
    // whether the file exists and what it hashes to.
    if (sha) HANDOFF_FILES[n] = p
    else {
      delete HANDOFF_FILES[n]
      log(`handoff ${n} ${x && x.stale ? 'is the one an earlier run left there, and this run wrote no new one' : 'not on disk'} — ${STRICT ? 'a stage that needs it will not start' : 'downstream stages get the inline text'}`)
    }
  }
  return shas
}

/**
 * Spec-directory preflight. Confines the spec directory and the intent path
 * by REALPATH, refusing any link on the way (security N6); records each
 * document's hash and git state (committed / modified / untracked / absent);
 * and, for approvedPlan, reads the committed spec.md back.
 */
async function specPreflight(approvedCheck) {
  return sealedBridge('spec-preflight', null, `// What this step inspects, in the clear.
const CFG = ${JSON.stringify({
    root: repoRoot(), specDir: SPEC_DIR, intentRel: INTENT_ARG.value,
    names: ['spec.md', 'plan.md', 'design.md', 'mock.html', 'test-report.md'], approved: approvedCheck,
  })}
const fs = require('fs')
const { execFileSync } = require('child_process')
const errors = []
let root
try { root = fs.realpathSync(CFG.root) } catch (e) { return { errors: ['the repository root could not be resolved'], files: {}, intent: null, specText: null } }
const inside = p => p === root || p.startsWith(root + path.sep)
function confine(rel, what) {
  let cur = root
  for (const seg of rel.split('/')) {
    cur = path.join(cur, seg)
    let st = null
    try { st = fs.lstatSync(cur) } catch (e) { st = null }
    if (!st) break
    if (st.isSymbolicLink()) { errors.push(what + ' "' + rel + '" passes through a link (' + seg + ') — refused: its files must stay inside the repository.'); return null }
    let real = cur
    try { real = fs.realpathSync(cur) } catch (e) { real = cur }
    if (!inside(real)) { errors.push(what + ' "' + rel + '" resolves outside the repository — refused.'); return null }
  }
  return path.join(root, ...rel.split('/'))
}
const dir = CFG.specDir ? confine(CFG.specDir, 'specDir') : null
const intentAbs = CFG.intentRel ? confine(CFG.intentRel, 'intentPath') : (dir ? path.join(dir, 'intent.md') : null)
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function state(abs) {
  let buf = null
  try { buf = fs.readFileSync(abs) } catch (e) { buf = null }
  if (!buf || !buf.length) return { state: 'absent', sha: null }
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  const rel = path.relative(root, abs).split(path.sep).join('/')
  let st = 'unknown'
  try {
    let atHead = null
    try { atHead = git('rev-parse', '--verify', '--quiet', 'HEAD:./' + rel) } catch (e) { atHead = null }
    if (atHead === null) st = 'untracked'
    else {
      // The blob id computed HERE from the bytes on disk — not by git
      // hash-object, whose clean/ident filters can map edited bytes back onto
      // the committed blob (security R4-1). CRLF-on-disk of an LF blob still
      // counts as committed (an autocrlf checkout).
      const algo = atHead.length === 64 ? 'sha256' : 'sha1'
      const blob = b => crypto.createHash(algo).update('blob ' + b.length + '\\0').update(b).digest('hex')
      const lf = Buffer.from(buf.toString('latin1').replace(/\\r\\n/g, '\\n'), 'latin1')
      st = (blob(buf) === atHead || blob(lf) === atHead) ? 'committed' : 'modified'
    }
  } catch (e) { st = 'unknown' }
  return { state: st, sha }
}
const files = {}
// Each document's own path too, leaf included: a link planted as plan.md or
// test-report.md is refused here, before anything is planned (round 5).
if (dir && !errors.length) for (const n of CFG.names) { if (confine(CFG.specDir + '/' + n, n) !== null) files[n] = state(path.join(dir, n)) }
const intent = intentAbs && !errors.length ? state(intentAbs) : null
let specText = null
if (CFG.approved && dir && !errors.length) {
  for (const n of ['spec.md', 'plan.md']) {
    if (!files[n] || files[n].state !== 'committed') errors.push('approvedPlan: ' + n + ' in ' + CFG.specDir + ' must be committed and unchanged since (it is ' + (files[n] ? files[n].state : 'absent') + ').')
  }
  if (!errors.length) specText = fs.readFileSync(path.join(dir, 'spec.md'), 'utf8').slice(0, 200000)
}
// The commit a checkout build diffs against, and what is uncommitted OUTSIDE
// the spec directory and .claude/ — a checkout build refuses to mix with it.
let head = null
try { head = git('rev-parse', 'HEAD') } catch (e) { head = null }
let dirty = []
try {
  // -z: paths are never quoted, and a rename or copy carries BOTH paths — the
  // destination, then the source — so moving a file out of the spec directory
  // still counts as a change outside it (code review round 7, N2).
  const st = execFileSync('git', ['status', '--porcelain=v1', '-uall', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const spec = CFG.specDir ? CFG.specDir.replace(/\\/+$/, '') + '/' : null
  const tok = st.split('\\0')
  const paths = []
  for (let i = 0; i < tok.length; i++) {
    if (!tok[i]) continue
    const xy = tok[i].slice(0, 2)
    paths.push(tok[i].slice(3))
    if (/[RC]/.test(xy) && tok[i + 1]) paths.push(tok[++i])
  }
  dirty = paths.filter(x => !(spec && x.startsWith(spec)) && !x.startsWith('.claude/'))
} catch (e) { dirty = null }
// The branch stage commits land on; null when HEAD is detached.
let branch = null
try { branch = git('symbolic-ref', '--quiet', '--short', 'HEAD') || null } catch (e) { branch = null }
return { errors, files, intent, specText, head, dirty, branch }`, TIERS.transcribe.model)
}

/** Criteria, surfaces, assumptions and questions back out of a spec.md in renderSpec's layout. */
function parseSpec(text) {
  const errors = []
  const raw = String(text)
  if (/…\[truncated at \d+ characters/.test(raw)) {
    errors.push('spec.md still carries the "[truncated at N characters]" marker — it was cut when written; restore the missing criteria before approving it')
  }
  const sec = {}
  const KNOWN = new Set(['acceptance criteria', 'surfaces', 'assumptions', 'open questions', 'contradictions'])
  let cur = null
  let curLevel = 0
  let fenced = false
  for (const l of raw.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced
    if (!fenced && l.startsWith('#')) {
      // A heading: "## Acceptance criteria", "### Acceptance criteria (v2)" …
      const level = l.match(/^#+/)[0].length
      const title = l.replace(/^#+/, '').trim().toLowerCase()
      const known = /^acceptance criteria\b/.test(title) ? 'acceptance criteria'
        : /^surfaces\b/.test(title) ? 'surfaces'
          : /^assumptions\b/.test(title) ? 'assumptions'
            : /^open questions\b/.test(title) ? 'open questions'
              : /^contradictions\b/.test(title) ? 'contradictions' : null
      // "### Onboarding" under "## Acceptance criteria" groups criteria; it
      // must not end the section and drop every criterion below it (round 5).
      if (!known && KNOWN.has(cur) && level > curLevel) continue
      cur = known || title
      curLevel = level
      sec[cur] = sec[cur] || []
      continue
    }
    if (cur) sec[cur].push(l)
  }
  const items = name => (sec[name] || [])
    .map(l => /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(l)).filter(Boolean).map(m => m[1].trim()).filter(x => x && x !== '(none)')
  // One criterion per line: a bullet or number, an optional checkbox, a bold
  // id ("**AC-1**" or "**AC-1:**"), then a dash, en/em dash or colon and text.
  // An indented line continues the criterion above it. Anything else under the
  // heading is an error QUOTED back — never dropped (code review / QA round 4).
  const CRIT = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?\*\*\s*([A-Za-z][\w.-]*)\s*:?\s*\*\*\s*(?:[—–:-]\s*)?(.+)$/
  const criteria = []
  for (const l of sec['acceptance criteria'] || []) {
    if (!l.trim()) continue
    const m = CRIT.exec(l)
    if (m) { criteria.push({ id: m[1].trim(), text: m[2].trim() }); continue }
    if (/^\s{2,}\S/.test(l) && criteria.length) { criteria[criteria.length - 1].text += ` ${l.trim()}`; continue }
    errors.push(`spec.md: this line under "Acceptance criteria" is not a criterion: ${JSON.stringify(l.trim().slice(0, 160))} — write it as "- **AC-n** — text"`)
  }
  const seen = new Set()
  for (const c of criteria) {
    if (seen.has(c.id)) errors.push(`spec.md: criterion id ${c.id} appears more than once`)
    seen.add(c.id)
  }
  // Contradictions: one per bullet; an indented line continues the one above,
  // and any other text is QUOTED back as an error — a contradiction written as a
  // paragraph must not vanish on approval (code review round 8).
  const contradictions = []
  for (const l of sec['contradictions'] || []) {
    if (!l.trim()) continue
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(l)
    if (m) { if (m[1].trim() !== '(none)') contradictions.push(m[1].trim()); continue }
    if (/^\s{2,}\S/.test(l) && contradictions.length) { contradictions[contradictions.length - 1] += ` ${l.trim()}`; continue }
    if (l.trim() === '(none)') continue
    errors.push(`spec.md: this line under "Contradictions" is not a list item: ${JSON.stringify(l.trim().slice(0, 160))} — write each one as "- <both sides, quoted> — <resolution>"`)
  }
  const surfaces = ((sec['surfaces'] || []).join(' ').toLowerCase().match(/\b(backend|frontend|data)\b/g) || [])
    .filter((v, i, a) => a.indexOf(v) === i)
  return { criteria, assumptions: items('assumptions'), openQuestions: items('open questions'), contradictions, surfaces, errors }
}
/**
 * Adopt a phase's authored files. Fresh: the in-phase confirmation already
 * registered them. Replayed from a resume: each must still hash to what the
 * phase recorded, or it is not handed on.
 */
async function adoptFiles(title, recorded, always = false) {
  if (!recorded || (!always && !REPLAYED.includes(title))) return
  const paths = {}
  for (const n of Object.keys(recorded)) {
    const p = n === 'intent.md' && externalIntentPath() ? externalIntentPath() : handoffPath(n)
    if (p && recorded[n]) paths[n] = p
  }
  const now = await confirmFiles(paths)
  for (const n of Object.keys(paths)) {
    if (now[n] !== recorded[n]) {
      delete HANDOFF_FILES[n]
      log(`handoff ${n} CHANGED since phase "${title}" recorded it — not handed on. To build from an edited file, start a new run rather than resuming.`)
    }
  }
}

/** Write a document this workflow renders itself (spec.md, test-report.md). */
async function writeRendered(name, text) {
  const p = handoffPath(name)
  if (!p || typeof text !== 'string') return
  const body = capText(text, RENDER_CAP)
  const r = await sealedBridge('handoff', { body }, `// Where this step writes, in the clear; only the document's text is in the encoded input.
const P = ${JSON.stringify(p)}
const ROOT = ${JSON.stringify(SPEC_DIR ? repoRoot() : null)}
const fs = require('fs')
const confinedForWrite = (root, p) => {
  if (!root) return true
  const R = path.resolve(root)
  const rel = path.relative(R, path.resolve(p))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  let cur = R
  for (const seg of path.dirname(rel).split(path.sep).filter(x => x && x !== '.')) {
    cur = path.join(cur, seg)
    try { if (fs.lstatSync(cur).isSymbolicLink()) return false } catch (e) { break }
  }
  // The file itself: writeFileSync follows a link, so a document swapped for
  // a link after the preflight would carry the write out (code review round 5).
  try { if (fs.lstatSync(path.resolve(p)).isSymbolicLink()) return false } catch (e) { /* absent: fine */ }
  // Fail closed (Alexander's review of PR #6): a path that cannot be resolved
  // is not confined. Before the first write the target's directory may not
  // exist yet, so the deepest directory that does exist is resolved instead.
  try {
    const realRoot = fs.realpathSync(R)
    let dir = path.dirname(path.resolve(p))
    while (!fs.existsSync(dir)) {
      const up = path.dirname(dir)
      if (up === dir) return false
      dir = up
    }
    const realDir = fs.realpathSync(dir)
    return realDir === realRoot || realDir.startsWith(realRoot + path.sep)
  } catch (e) { return false }
}
// Confined before any directory is created and again before writing; written
// to a temporary file and renamed over the target, so neither a link swapped
// in after the check nor a hardlink carries the write out (round 6).
if (!confinedForWrite(ROOT, P)) return { sha256: null, escaped: true }
fs.mkdirSync(path.dirname(P), { recursive: true })
if (!confinedForWrite(ROOT, P)) return { sha256: null, escaped: true }
const TMP = P + '.tmp-' + process.pid
fs.writeFileSync(TMP, input.body, 'utf8')
fs.renameSync(TMP, P)
return { sha256: crypto.createHash('sha256').update(fs.readFileSync(P)).digest('hex') }`, TIERS.transcribe.model)
  if (r && r.sha256 === sha256Hex(utf8Bytes(body))) HANDOFF_FILES[name] = p
  else { delete HANDOFF_FILES[name]; log(`handoff ${name} not confirmed on disk — downstream stages get the inline text`) }
}

/** A downstream prompt section: the file when one is confirmed, the inline text otherwise. */
function handoffRef(name, title, inline) {
  const p = HANDOFF_FILES[name]
  if (p && HANDOFF_ORIGIN[name] === 'person') return `${title}: read ${p} — written or approved by a person and committed to the repository; it is the authoritative copy. Read it before you start.`
  if (p) return `${title}: read ${p} — the stage before you wrote it, and it is the authoritative copy. Read it before you start.`
  return `${title}:\n${inline ?? '(none produced)'}`
}

/** STRICT: the stop result for a stage whose input file is not confirmed, else null. */
function missingInputs(stage, names) {
  if (!STRICT) return null
  const miss = names.filter(n => !HANDOFF_FILES[n])
  if (!miss.length) return null
  status = 'stopped'
  return {
    status: 'stopped',
    reason: `${stage} has no input file: ${miss.join(', ')} is not confirmed in ${handoffDir() || '(no handoff directory — a run directory is required)'}. In strict mode${SPEC_DIR ? ' (args.specDir)' : ''} a stage without its input file does not start.`,
  }
}

function criteriaTextOf(reqs) {
  return reqs.criteria.map(c => `${c.id}: ${c.text}`).join('\n')
}

function renderSpec(reqs) {
  const list = (xs) => (xs && xs.length ? xs.map(x => `- ${String(x).replace(/\s+/g, ' ').trim()}`) : ['(none)'])
  return [
    '# spec.md', '',
    `Initiative: ${initiative}`, '',
    '## Acceptance criteria', '',
    ...reqs.criteria.map(c => `- **${c.id}** — ${c.text}`), '',
    '## Surfaces', '',
    reqs.surfaces.join(', ') || '(none classified)', '',
    '## Assumptions', '', ...list(reqs.assumptions), '',
    '## Open questions', '', ...list(reqs.openQuestions), '',
    '## Contradictions', '', ...list(reqs.contradictions), '',
  ].join('\n')
}

/** One line of traceability numbers, shared by the report and the readiness prompt. */
function traceability(raw, criteria) {
  const cases = raw && Array.isArray(raw.cases) ? raw.cases.filter(c => c && typeof c === 'object') : []
  const ids = (criteria || []).map(c => c.id)
  const by = id => cases.filter(c => c.criterion === id)
  // An allow-list, and a test that is named: a "Manual", a missing type or a
  // mutation run is not a proof of a criterion (code review round 8).
  const auto = c => AUTOMATED_TYPES.includes(c.type) && String(c.test || '').trim().length > 0
  const proven = ids.filter(id => by(id).some(c => auto(c) && c.result === 'pass') && !by(id).some(c => c.result === 'fail'))
  const failing = ids.filter(id => by(id).some(c => c.result === 'fail'))
  const pending = ids.filter(id => !proven.includes(id) && !failing.includes(id))
  const known = new Set(ids)
  const unknown = cases.filter(c => !known.has(c.criterion))
  const seen = new Set()
  const duplicates = [...new Set(cases.map(c => c.id).filter(id => (seen.has(id) ? true : (seen.add(id), false))))]
  // Proven by an automated case, but with a manual check still open — on the
  // second live smoke an accessibility criterion passed against a stubbed DOM
  // while its real-browser case waited for a person. Say both.
  const manualOpen = proven.filter(id => by(id).some(c => c.type === 'manual' && c.result !== 'pass'))
  return { cases, ids, by, proven, failing, pending, unknown, duplicates, manualOpen }
}

function traceabilityLine(raw, criteria) {
  const t = traceability(raw, criteria)
  const m = raw && raw.mutation
  return `${t.proven.length} of ${t.ids.length} criteria proven by a passing automated case` +
    (t.failing.length ? `; FAILING: ${t.failing.join(', ')}` : '') +
    (t.pending.length ? `; pending human QA (no passing automated case): ${t.pending.join(', ')}` : '') +
    (t.manualOpen.length ? `; proven, but a manual check is still open: ${t.manualOpen.join(', ')}` : '') +
    (t.unknown.length ? `; ${t.unknown.length} case(s) name no known criterion and prove nothing` : '') +
    (t.duplicates.length ? `; duplicate case id(s): ${t.duplicates.join(', ')}` : '') +
    (m && typeof m.score === 'number' ? `; mutation score ${m.score}%${m.tool ? ` (${m.tool}` : ''}${m.scope ? `${m.tool ? ', ' : ' ('}${m.scope}` : ''}${m.tool || m.scope ? ')' : ''}` : '; no mutation testing reported')
}

function renderTestReport(raw, findings, criteria) {
  const lines = ['# test-report.md', '']
  lines.push(`Verdict (qa-engineer): ${raw && raw.verdict ? raw.verdict : '(qa-engineer returned no verdict — the test stage produced no evidence)'}`, '')
  const t = traceability(raw, criteria)
  const cell = v => String(v ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—'
  lines.push('## Traceability — one case per criterion', '')
  lines.push(traceabilityLine(raw, criteria), '')
  if (t.cases.length) {
    lines.push('| Criterion | Case | Type | Test | Result | Evidence |', '| --- | --- | --- | --- | --- | --- |')
    const known = new Set(t.ids)
    const ordered = [...t.ids.flatMap(id => t.by(id)), ...t.cases.filter(c => !known.has(c.criterion))]
    for (const c of ordered) {
      lines.push(`| ${cell(c.criterion)} | ${cell(c.id)} — ${cell(c.title)} | ${cell(c.type)} | ${cell(c.test)} | ${cell(c.result)} | ${cell(c.evidence)} |`)
    }
    lines.push('')
  } else {
    lines.push('(the test stage reported no cases — every criterion is pending human QA)', '')
  }
  const uncovered = t.ids.filter(id => !t.by(id).length)
  if (uncovered.length) lines.push(`Criteria with no case at all: ${uncovered.join(', ')}`, '')
  lines.push('## Findings, after independent cross-check', '')
  if (!findings.length) lines.push('(none)')
  for (const f of findings) {
    const state = f.refuted ? 'REFUTED' : f.unverified ? 'UNVERIFIED' : 'confirmed'
    lines.push(`- [${state}] (${f.severity}) ${f.summary}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : ''}`)
    lines.push(`  evidence: ${f.evidence}`)
  }
  return lines.join('\n') + '\n'
}

const CRITERIA_SCHEMA = {
  type: 'object',
  required: ['criteria', 'assumptions', 'openQuestions', 'contradictions', 'surfaces'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text'],
        properties: { id: { type: 'string' }, text: { type: 'string' } },
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    // Where the intent, the repository's specs and docs, and its code disagree.
    // The HU 16 pilot's planner met one (the ticket put zones in onboarding, an
    // existing spec had ruled them out) — found by a person reading by hand.
    contradictions: {
      type: 'array', items: { type: 'string' },
      description: 'Each: side A quoted with its source; side B quoted with its source; which wins under the intent, or that a person must decide. [] after looking and finding none.',
    },
    // Which implementation surfaces the change actually touches. Drives Build fan-out.
    surfaces: {
      type: 'array',
      items: { type: 'string', enum: ['backend', 'frontend', 'data'] },
    },
  },
}

// CHG-20 — builders return a MANIFEST, not prose. This literal is a verbatim
// copy of `BUILD_MANIFEST_SCHEMA` in `_brief.js`, because a workflow script
// cannot require it. `_wiring.test.js` deep-equals the two, so the copy cannot
// drift from the module without a test failure.
const BUILD_MANIFEST_SCHEMA = {
  type: 'object',
  required: ['summary', 'filesChanged', 'criteriaAddressed'],
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string', maxLength: 2000,
      description: 'What you did and why, in at most 2000 characters. Not a diff — the reviewer can read the diff.',
    },
    filesChanged: {
      type: 'array',
      items: {
        type: 'object', required: ['path', 'role'], additionalProperties: false,
        properties: {
          path: { type: 'string' },
          role: { enum: ['implementation', 'test', 'config', 'docs', 'generated'] },
        },
      },
    },
    diffRef: {
      type: 'string',
      description: 'How a reader reaches the change: a git range such as HEAD~1..HEAD, or a worktree path.',
    },
    criteriaAddressed: {
      type: 'array', items: { type: 'string' },
      description: 'Acceptance criterion ids this work satisfies, e.g. AC-1.',
    },
    notAddressed: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'why'], additionalProperties: false,
        properties: { id: { type: 'string' }, why: { type: 'string' } },
      },
      description: 'Criteria deliberately NOT addressed, and why. Making the gap explicit is what stops it being discovered as a defect later.',
    },
    planGaps: {
      type: 'array', items: { type: 'string' },
      description: 'Decisions the plan left open that you needed and did NOT make yourself — an interface, a data shape, a behavior. Escalated back to planning rather than improvised at build tier.',
    },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings', 'verdict'],
  properties: {
    verdict: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'summary', 'evidence'],
        properties: {
          severity: { type: 'string' },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          needsExecution: { type: 'boolean' },
        },
      },
    },
  },
}

// The test lens also returns ONE CASE PER ACCEPTANCE CRITERION, with its test
// type, result and the path of the evidence it saved. On the HU 16 pilot the
// test report carried a verdict and findings and nothing else: a reviewer could
// not see what had been proven, and human QA could not see where to start.
const CASE_TYPES = ['unit', 'component', 'integration', 'e2e', 'visual', 'mutation', 'manual']
// The types whose passing case proves a criterion. A mutation run measures the
// tests; it does not prove the behaviour, and a manual case was not executed.
const AUTOMATED_TYPES = ['unit', 'component', 'integration', 'e2e', 'visual']
// TWO READINESS VERDICTS (Alexander's review, 4.2). Whether the code is ready
// and whether the change does what the HU asks are decided by different people
// on different evidence; one Go/No-Go let a clean build hide an unanswered
// product question, and the other way round.
const READINESS_VERDICT = {
  type: 'object',
  required: ['verdict', 'reasons'],
  properties: {
    verdict: { enum: ['go', 'no-go', 'conditional'] },
    reasons: { type: 'array', items: { type: 'string' }, description: 'the gates behind the verdict, each with its classification' },
  },
}
const READINESS_SCHEMA = {
  type: 'object',
  required: ['technical', 'product', 'report'],
  properties: {
    technical: { ...READINESS_VERDICT, description: 'Is the CODE ready? Tests and their evidence, mutation, confirmed findings, the security and performance lenses, the commit the evidence is bound to. Decided by engineering.' },
    product: { ...READINESS_VERDICT, description: 'Does the change do what the HU asks? Each acceptance criterion proven or pending human QA, open questions and contradictions for the product owner, plan gaps. Decided by the product owner.' },
    report: { type: 'string', description: 'The full gate-by-gate assessment, with every BLOCKED entry reproduced verbatim.' },
  },
}
const VERDICTS = ['go', 'no-go', 'conditional']
/** The two verdicts, or null for one that is missing or malformed — never a guess. */
function readinessVerdicts(r) {
  const one = v => (v && typeof v === 'object' && VERDICTS.includes(v.verdict)
    ? { verdict: v.verdict, reasons: Array.isArray(v.reasons) ? v.reasons.map(String) : [] }
    : null)
  return { technical: one(r && r.technical), product: one(r && r.product) }
}

const QA_SCHEMA = {
  type: 'object',
  required: ['findings', 'verdict', 'cases'],
  properties: {
    ...FINDINGS_SCHEMA.properties,
    cases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'criterion', 'title', 'type', 'result'],
        properties: {
          id: { type: 'string', description: 'CP-01, CP-02, ... — stable within this run' },
          criterion: { type: 'string', description: 'the acceptance criterion id this case proves' },
          title: { type: 'string', description: 'what the case checks, as an action: "Rechazar un precio negativo"' },
          type: { enum: CASE_TYPES },
          test: { type: 'string', description: 'file › test name, or the exact command run' },
          result: { enum: ['pass', 'fail', 'not-run'] },
          evidence: { type: 'string', description: 'path of the evidence saved for this case (output, JSON, screenshot, video)' },
        },
      },
    },
    mutation: {
      type: 'object',
      description: 'Mutation testing on the changed files, when the repository has it set up.',
      properties: { tool: { type: 'string' }, score: { type: 'number', description: 'mutation score, 0-100' }, survived: { type: 'number' }, scope: { type: 'string' } },
    },
  },
}

// Per-lens brief budgets live in `_brief.js`'s LENS_BUDGETS, keyed by these
// same lens keys. They are deliberately NOT duplicated here: a second copy of a
// budget table is a second thing to drift.
const LENSES = [
  {
    key: 'review',
    agentType: 'code-reviewer',
    tier: 'review',
    stage: 'Review',
    brief: 'Review by reading. Form your independent expectation from the criteria BEFORE reading the diff (your §4 contamination guard), then state if it changed. Never inherit the implementer\'s self-report.',
  },
  {
    key: 'qa',
    agentType: 'qa-engineer',
    tier: 'test',
    stage: 'Test',
    schema: QA_SCHEMA,
    brief: 'Verify by executing. Re-run any claimed verification yourself — a "tests pass" report is a hypothesis until you run it this session. Label every claim Verified / Falsified / Unverified / Untestable, and include the "what was NOT tested" section.',
  },
  {
    key: 'security',
    agentType: 'security-engineer',
    tier: 'security',
    stage: 'Review',
    brief: 'Review mode — findings and direction, no rewrites. Classify Critical/High/Medium/Low/Informational. No finding without a plausible attack path; no security theater.',
  },
  {
    key: 'performance',
    agentType: 'performance-engineer',
    tier: 'review',
    stage: 'Review',
    brief: 'Trace the target BEFORE measuring current behavior (your §3). If no target exists, say so and propose one labeled proposed-not-confirmed. No claim without a number.',
  },
]

/**
 * CHG-20 — one budgeted brief per lens, built from the build manifests.
 *
 * The fallback when the bridge cannot run is the manifest itself, NOT the old
 * concatenation of every builder's full output. Losing the budget is a
 * degradation; going back to re-sending three builders' prose into four lenses
 * would be a regression to the defect this change removes.
 */
// QA INDEPENDENCE (Alexander's review, 3.3). The test stage gets the criteria
// and the change — which files, and how to read the diff — but none of the
// builders' conclusions: no summary of what they did, no claim of which
// criteria they met, no list of what they left out. It forms its own view by
// executing; a builder's "AC-3 done" read first is an expectation to confirm.
// Review lenses still get the whole manifest: they judge the reasoning too.
const INDEPENDENT_LENSES = new Set(['qa'])
const WITHHELD = '(The builders\' own account of this work is withheld from the test stage. Judge the change against the acceptance criteria by reading and running it.)'
// In a checkout build the builders record their decisions in
// <specDir>/decisiones.md, so `git diff <base>` would hand the test stage their
// rationale back. Its route to the change leaves that one file out
// (independent review of this change). Repository-relative, for a pathspec.
const decisionsRecord = () => (SPEC_DIR && BUILD_TREE === 'checkout' && BUILD_BASE ? `${SPEC_DIR}/decisiones.md` : null)
const qaRoute = () => `git diff ${BUILD_BASE} -- . ':(exclude)${decisionsRecord()}'`
/** changeRef() for the test stage: the same change, minus the decision record. */
const changeRefForQa = () => (decisionsRecord()
  ? `The whole change is ${STAGE_COMMITS ? 'COMMITTED on the current branch, stage by stage,' : 'UNCOMMITTED in the checkout this run started in,'} since ${BUILD_BASE}. Read it with \`${qaRoute()}\` (add --stat for the list of files); \`git status --short\` shows new files${STAGE_COMMITS ? ' and anything a stage has not committed yet' : ''}.`
  : changeRef())
/**
 * A manifest with the facts only — which files, and how to read the diff.
 * `disputes` keeps a builder's `notAddressed` for re-verification: a lens that
 * re-checks a finding the builder disputes with evidence must see that
 * evidence, or a false positive comes back every round (independent review).
 */
function factsOnly(ms, { disputes = false } = {}) {
  const dec = decisionsRecord()
  const isRecord = p => !!dec && String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').endsWith(dec)
  return (ms || []).map(m => ({
    label: m && m.label,
    summary: WITHHELD,
    filesChanged: ((m && m.filesChanged) || []).filter(f => !isRecord(f && f.path)),
    ...(dec ? { diffRef: `${qaRoute()}, plus the new untracked files: git status --short` }
      : m && m.diffRef ? { diffRef: m.diffRef } : {}),
    ...(disputes && m && Array.isArray(m.notAddressed) && m.notAddressed.length ? { disputes: m.notAddressed } : {}),
  }))
}

async function buildBriefs(manifests, criteria, lensKeys) {
  const facts = factsOnly(manifests)
  const fallbackFor = (ms, route) =>
    `## Acceptance criteria\n${criteria}\n\n${route ? `## The whole change\n${route}\n\n` : ''}## Implementation (build manifest — budget not applied)\n${JSON.stringify(ms, null, 2)}`
  const fallback = () => {
    const out = {}
    for (const k of lensKeys) {
      const fallbackText = INDEPENDENT_LENSES.has(k) ? fallbackFor(facts, changeRefForQa()) : fallbackFor(manifests, changeRef())
      out[k] = {
        text: fallbackText, chars: fallbackText.length, truncated: false, omittedFiles: [],
        handoff: {
          chars: fallbackText.length, truncated: false, omittedFiles: [],
          files: manifests.flatMap(m => ((m && m.filesChanged) || []).map(f => f.path)),
          diffRefs: manifests.map(m => m && m.diffRef).filter(Boolean),
        },
        briefSource: 'manifest-unbudgeted',
      }
    }
    return out
  }

  const r = await bridge('brief', `${REQUIRE_HEAD}const b = require(path.join(DIR, '_brief.js'))
const criteria = input.criteria
// The test stage's lenses get the facts-only manifests (no builder conclusions).
const independent = ${JSON.stringify([...INDEPENDENT_LENSES])}
const out = {}
for (const lens of ${JSON.stringify(lensKeys)}) {
  const manifests = independent.includes(lens) ? input.facts : input.manifests
  const changeRef = independent.includes(lens) ? input.changeRefForQa : input.changeRef
  const br = b.buildBrief({ manifests: manifests, lens: lens, criteria: criteria, changeRef: changeRef })
  out[lens] = { text: br.text, chars: br.chars, truncated: br.truncated, omittedFiles: br.omittedFiles,
                handoff: b.handoffRecord(br, manifests), briefSource: 'buildBrief' }
}
process.stdout.write(JSON.stringify(out))`, undefined, { manifests, facts, criteria, changeRef: changeRef(), changeRefForQa: changeRefForQa() })

  if (!r) {
    log('brief bridge unavailable — each lens receives the build manifest itself, unbudgeted')
    return fallback()
  }
  for (const k of lensKeys) {
    if (!r[k] || typeof r[k].text !== 'string') {
      log('brief bridge returned an incomplete result — falling back to the unbudgeted manifest')
      return fallback()
    }
  }
  return r
}

/**
 * Hand every finding a lens raised to an independent refuter.
 *
 * Shared by Verify and by each repair round's re-verification, so a finding
 * raised after a fix is held to exactly the standard the original was.
 */
function refuteFindings(result, lensKey, criteriaText, phaseLabel = 'Cross-check') {
  if (!result?.findings?.length) return []
  return parallel(
    result.findings.map(f => () =>
      dispatch(
        withPolicy(`Try to REFUTE this finding. Default to refuted=true if you cannot substantiate it from actual evidence.

FINDING (${f.severity}): ${f.summary}
EVIDENCE CLAIMED: ${f.evidence}

Criteria for context:\n${criteriaText}`),
        {
          agentType: 'code-reviewer',
          label: `refute:${lensKey}`,
          phase: phaseLabel,
          ...tier('refute'),
          schema: {
            type: 'object',
            required: ['refuted', 'reasoning'],
            properties: { refuted: { type: 'boolean' }, reasoning: { type: 'string' } },
          },
        },
      // A refuter that returned nothing has NOT refuted the finding. This used
      // to read `v?.refuted !== false`, so a dead refuter deleted every finding
      // it was handed: four null refuters -> zero confirmed and zero failure
      // records. independent-review already did the opposite; now both keep
      // the finding, flagged.
      ).then(v => (v === null || v === undefined
        ? { ...f, lens: lensKey, refuted: false, unverified: true, why: null }
        : { ...f, lens: lensKey, refuted: v.refuted === true, why: v.reasoning })),
    ),
  )
}

// ---------------------------------------------------------------------------
// The repair loop — detect, repair, independently re-verify, record.
// ---------------------------------------------------------------------------
// The single most repeated human process in this repository's history was
// "act on review, then re-review" (6a746ad, 10ad72f, 652f983, 8951c41), and no
// workflow did it. A confirmed Must-Fix finding went straight to readiness as
// a No-Go and waited for a person to re-run the whole lifecycle.
//
// Bounded at MAX_REPAIR_ROUNDS. The builder that wrote the change fixes it, in
// the change's own location; ONLY the lenses that raised a surviving blocking
// finding re-verify, and their new findings go through the same refuter. The
// builder never certifies its own repair — ROUTING.md's rule, enforced here by
// construction. An exhausted loop becomes a blocked gate, not a silent No-Go.
const MAX_REPAIR_ROUNDS = 2
const BLOCKING_RE = /must[\s-]?fix|critical|blocker|\bhigh\b/i

// An UNVERIFIED finding (its refuter returned nothing) is kept, never dropped —
// but it is not sent to a builder under the words "independent reviewers
// confirmed", because nobody did. It goes to readiness in its own section.
function isBlocking(f) {
  return !!f && !f.refuted && !f.unverified && BLOCKING_RE.test(String(f.severity || ''))
}

// Findings are compared by content, not object identity: a replayed phase
// hands back fresh objects, and a repair round must still recognise the
// finding it was sent to fix.
function findingKey(f) {
  return JSON.stringify([f.lens, f.severity, f.summary, f.file || null, f.line || null])
}

// ===========================================================================
// The workflow itself. Wrapped so that every exit — a stop, a crash, or a
// clean finish — still reaches the outcome record. Deliberately NOT a
// `finally { return }`: returning from a finally swallows the thrown error and
// a crashed run would report success.
// ===========================================================================
let status = 'crashed'
let findingCounts = { confirmed: 0, refuted: 0, byLens: {} }
let refutations = []
let repairRounds = null
let planGaps = []

async function runWorkflow() {
  // A run recorded under the older layout (Requirements, Verify) is refused by
  // openRun itself, before its record is touched (code review S-C, QA D2).
  const opened = await openRun('Plan', '^(Plan|Design|Build|Test|Review|Readiness|Repair \\d+|Re-verify \\d+)$')
  if (opened && opened.fatal) {
    status = 'stopped'
    return { status: 'stopped', reason: opened.fatal }
  }
  for (const a of [SPEC_DIR_ARG, INTENT_ARG, QA_TEMPLATE_ARG]) {
    if (a.error) {
      status = 'stopped'
      return { status: 'stopped', reason: a.error }
    }
  }
  if (APPROVED && !SPEC_DIR) {
    status = 'stopped'
    return { status: 'stopped', reason: 'args.approvedPlan needs args.specDir — the approved spec.md and plan.md are read from it.' }
  }
  // On a resume, the RECORDED Plan decides the mode — never the flags of the
  // new invocation (code review round 4 M1/M3, QA D-1). A paused run's Plan was
  // written by the planners; approving it means a fresh run that adopts the
  // committed files, so resuming it "as approved" is refused rather than
  // building the person's spec while tracing the planners' criteria.
  const planReplays = !!(RUN && RUN.resumed && Object.prototype.hasOwnProperty.call(RUN.resumed, 'Plan'))
  const recordedApproved = planReplays && !!(RUN.resumed.Plan && RUN.resumed.Plan.approved === true)
  if (planReplays && APPROVED && !recordedApproved) {
    status = 'stopped'
    return { status: 'stopped', reason: `run ${RUN.runId} recorded a Plan written by the planners, not an approved one. To build from the committed spec.md and plan.md, start a FRESH run with approvedPlan: true (no resume).` }
  }
  const MODE_APPROVED = planReplays ? recordedApproved : APPROVED
  if (SPEC_DIR || INTENT_ARG.value || STRICT) {
    if (!RUN || !repoRoot()) {
      status = 'stopped'
      return { status: 'stopped', reason: 'args.specDir, args.intentPath and args.strict need a run directory to place and confirm files — run recording is off or unreachable.' }
    }
  }

  // -------------------------------------------------------------------------
  // Spec-directory preflight, BEFORE anything is recorded: the directory and
  // the intent must resolve inside the repository with no link on the way
  // (security N6), the intent must exist (S3 — checked here, so a missing one
  // does not leave a "completed" Plan behind that a resume replays), and the
  // state of each document is taken so this run can tell its own output from a
  // file an earlier run left behind (N5/M2) and never silently overwrites a
  // person's uncommitted edit (M3).
  // -------------------------------------------------------------------------
  let pre = null
  if (SPEC_DIR || INTENT_ARG.value) {
    pre = await specPreflight(APPROVED && !planReplays)
    if (!pre) {
      status = 'stopped'
      return { status: 'stopped', reason: 'the spec-directory preflight did not run, so the spec directory could not be confirmed safe to write. Nothing was planned.' }
    }
    if (pre.errors.length) {
      status = 'stopped'
      return { status: 'stopped', reason: pre.errors.join(' ') }
    }
    if (BUILD_TREE === 'checkout') {
      // On a resume whose Build already ran, the recorded base wins (set after
      // Build replays): HEAD may have moved since, and a diff against the new
      // HEAD would show reviewers an empty change (code review round 7, S1).
      BUILD_BASE = pre.head || null
      // A plan-only run never builds, and a resume whose Build already ran
      // continues its own uncommitted work. Every other run that will build is
      // checked — including a resume that stopped BEFORE Build (S2).
      const buildRecorded = !!(RUN && RUN.resumed && Object.prototype.hasOwnProperty.call(RUN.resumed, 'Build'))
      const willBuild = (APPROVED || !PAUSE) && !buildRecorded
      if (willBuild && (pre.dirty === null || pre.dirty === undefined || !pre.head)) {
        // Without git there is nothing to check the tree against and nothing to
        // diff the change against: never build blind in a person's checkout (S3).
        status = 'stopped'
        return {
          status: 'stopped',
          reason: "a checkout build needs git: the base commit or the working-tree status could not be read. Run it in a git checkout, or with buildTree: 'worktrees'.",
        }
      }
      if (willBuild && STAGE_COMMITS && !pre.branch) {
        // A commit on a detached HEAD belongs to no branch: the next checkout
        // leaves it behind, and the stage commits with it.
        status = 'stopped'
        return {
          status: 'stopped',
          reason: 'HEAD is detached, and this run commits each stage on the current branch. Check out the HU branch first, or run with commitStages: false to leave the change uncommitted.',
        }
      }
      if (willBuild && Array.isArray(pre.dirty) && pre.dirty.length) {
        status = 'stopped'
        const shown = pre.dirty.slice(0, 8).join(', ') + (pre.dirty.length > 8 ? `, and ${pre.dirty.length - 8} more` : '')
        return {
          status: 'stopped',
          reason: `the checkout has uncommitted changes outside ${handoffDir()} (${shown}). Builders work in this checkout, so their change would mix with yours. Commit or stash them first, or run with buildTree: 'worktrees'.`,
        }
      }
    }
    if (!pre.intent || !pre.intent.sha) {
      status = 'stopped'
      return {
        status: 'stopped',
        reason: `no intent.md at ${externalIntentPath()}. In this mode a person writes the intent (or it comes from the ticket) — Plan does not start without it.`,
      }
    }
    // A resume replays Plan and never re-plans, so this guard is for fresh
    // runs; on a resume the recorded hashes guard the files instead. With
    // approvedPlan, spec.md and plan.md are the approval itself, but design.md
    // and mock.html are still overwritten by Design.
    if (!planReplays && !REPLAN) {
      const guarded = APPROVED ? ['design.md', 'mock.html'] : ['spec.md', 'plan.md', 'design.md', 'mock.html']
      const edited = guarded.filter(n => pre.files[n] && /^(modified|untracked)$/.test(pre.files[n].state))
      if (edited.length) {
        status = 'stopped'
        return {
          status: 'stopped',
          reason: `${edited.join(', ')} in ${handoffDir()} ${edited.length > 1 ? 'have' : 'has'} changes that are not committed, and this run would overwrite ${edited.length > 1 ? 'them' : 'it'}. ${APPROVED ? 'Commit or discard them first.' : 'To build from them: commit them and run with approvedPlan: true.'} To discard them on purpose: run with replan: true.`,
        }
      }
    }
  }
  // The approved spec is parsed BEFORE anything is recorded, so a line the
  // parser cannot read stops the run instead of silently losing a criterion.
  let approvedReqs = null
  if (APPROVED && !planReplays) {
    approvedReqs = parseSpec(pre.specText || '')
    if (approvedReqs.errors.length) {
      status = 'stopped'
      return { status: 'stopped', reason: `the approved spec.md cannot be read exactly: ${approvedReqs.errors.slice(0, 3).join(' | ')}${approvedReqs.errors.length > 3 ? ` (and ${approvedReqs.errors.length - 3} more)` : ''}` }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 1 — Plan, on the plan tier. intent.md -> spec.md -> plan.md, in that
  // order, because each is the next one's input. This is where the expensive
  // tokens go: everything downstream executes against these files, and a cheap
  // build tier is only safe when the plan leaves it nothing to design. When a
  // person wrote intent.md (args.specDir / args.intentPath), product-manager
  // does not run: the intent is theirs. With args.approvedPlan the plan is
  // ALSO theirs — the committed spec.md and plan.md are adopted, no planner runs.
  // -------------------------------------------------------------------------
  const humanIntent = externalIntentPath()
  if (humanIntent && pre && pre.intent && pre.intent.sha) { HANDOFF_FILES['intent.md'] = humanIntent; HANDOFF_ORIGIN['intent.md'] = 'person' }
  if (MODE_APPROVED) for (const n of ['spec.md', 'plan.md']) HANDOFF_ORIGIN[n] = 'person'
  if (APPROVED && !planReplays) {
    for (const n of ['spec.md', 'plan.md']) if (pre.files[n] && pre.files[n].sha) HANDOFF_FILES[n] = handoffPath(n)
  }
  const before = {}
  if (pre) for (const [n, f] of Object.entries(pre.files)) before[n] = f.sha || null
  const planArtifact = await runPhase('Plan', 'Design', async () => {
    const files = {}
    if (humanIntent) files['intent.md'] = pre.intent.sha
    if (APPROVED) {
      const { errors: _ignored, ...parsed } = approvedReqs
      files['spec.md'] = pre.files['spec.md'] ? pre.files['spec.md'].sha : null
      files['plan.md'] = pre.files['plan.md'] ? pre.files['plan.md'].sha : null
      return {
        agents: [
          { label: 'requirements', result: parsed },
          { label: 'architecture', result: `(approved plan — ${handoffPath('plan.md')}, committed at ${pre.files['plan.md'] ? pre.files['plan.md'].sha.slice(0, 12) : '?'})` },
        ],
        files,
        approved: true,
      }
    }
    let intent = null
    if (!humanIntent) {
      intent = await dispatch(
        withPolicy(`Frame this initiative as an INTENT — the one-page "why" that every later stage traces back to: ${initiative}

Write: the problem and who has it; the outcome that would mean this worked (a measurable signal if one was given — if none was, propose one and label it proposed-not-confirmed); what is explicitly out of scope; and the constraints and risks a planner must respect. Do not write requirements or a design — product-analyst and solution-architect follow you and own those. Return intent.md as markdown.${writeInstruction('intent.md')}`),
        { agentType: 'product-manager', label: 'intent', phase: 'Plan', ...tier('plan') },
      )
    }
    const intentSection = humanIntent
      ? `INTENT — written by a person: read ${humanIntent}. It is the source of truth for WHY; trace to it, and put anything in it you cannot turn into a testable criterion in openQuestions.`
      : `INTENT (from product-manager — trace to it, and put anything in it you cannot turn into a testable criterion in openQuestions):
${typeof intent === 'string' && intent.trim() ? intent : asText(intent) || '(product-manager produced no intent — work from the initiative alone and say so in openQuestions)'}`
    const reqs = await dispatch(
      withPolicy(`Convert this initiative into implementation-ready requirements: ${initiative}

${intentSection}

Produce numbered, stable acceptance-criterion IDs — every downstream agent in this workflow traces against them, so an unstable ID breaks the whole run. Record assumptions as numbered/traceable/risk-rated per your §4. Do not invent a success metric that wasn't given; label any proposal as proposed-not-confirmed.

Also classify which implementation surfaces this genuinely touches (backend / frontend / data) so the build phase only spawns the specialists actually needed.

CONTRADICTIONS. Before you write criteria, compare the intent (and any ticket text it quotes) with what the repository already says and does: its specs and as-built documents, and the code itself. Record every disagreement in contradictions — quote both sides and say where each comes from, then say which side the intent's scope makes win, or that a person must decide. Never settle one silently by picking a side. An empty list means you looked and found none.`),
      { agentType: 'product-analyst', label: 'requirements', phase: 'Plan', schema: CRITERIA_SCHEMA, ...tier('plan') },
    )
    const agents = [
      ...(humanIntent ? [] : [{ label: 'intent', result: intent }]),
      { label: 'requirements', result: reqs },
    ]
    // No criteria -> nothing for an architect to plan against. Not dispatched,
    // so not recorded as a failure either; the stop below says why.
    if (!reqs || !reqs.criteria?.length) return { agents, files, pauseRequired: PAUSE }
    const architecture = await dispatch(
      withPolicy(`Write the implementation PLAN for these requirements — plan.md, the document a cheaper build tier executes WITHOUT redesigning anything.

${humanIntent ? `INTENT: ${humanIntent}\n\n` : ''}ACCEPTANCE CRITERIA:\n${criteriaTextOf(reqs)}

SURFACES: ${reqs.surfaces.join(', ') || '(none classified)'}

Decide the tier per your §2 — a Tier 1 change gets a short plan, not a manufactured ADR. Then state, concretely enough that a builder never has to make a design decision: the files to create or change and what changes in each; interfaces, data shapes and error behaviour; the order of the steps; which test proves each criterion; and NFRs as measurable numbers, never "scalable" or "fast". Anything you cannot decide yet goes in an explicit "Open decisions" section — builders are told to escalate those back, not to guess. Flag anything that constrains the UX, so design reconciles it rather than the build. Return plan.md as markdown.${writeInstruction('plan.md')}`),
      { agentType: 'solution-architect', label: 'architecture', phase: 'Plan', ...tier('plan') },
    )
    agents.push({ label: 'architecture', result: architecture })
    Object.assign(files, await confirmFiles(
      { ...(humanIntent ? {} : { 'intent.md': handoffPath('intent.md') }), 'plan.md': handoffPath('plan.md') },
      { 'intent.md': asText(intent), 'plan.md': asText(architecture) },
      before,
    ))
    return { agents, files, pauseRequired: PAUSE }
  })
  await adoptFiles('Plan', planArtifact.files)
  if (MODE_APPROVED && planReplays) {
    // A resumed approved run builds only from the files it approved.
    const changed = ['spec.md', 'plan.md'].filter(n => planArtifact.files && planArtifact.files[n] && !HANDOFF_FILES[n])
    if (changed.length) {
      status = 'stopped'
      return { status: 'stopped', reason: `${changed.join(' and ')} changed since run ${RUN.runId} approved ${changed.length > 1 ? 'them' : 'it'}. A resume builds only what was approved — to build the new version, start a fresh run with approvedPlan: true.` }
    }
  }

  const intent = humanIntent ? null : agentResult(planArtifact, 'intent')
  const reqs = agentResult(planArtifact, 'requirements')

  // When the plan tier is pinned and the planners return nothing at all, the
  // likeliest cause is model access, not the initiative — say so, rather than
  // pointing the user at their requirements (code review S4).
  const tierHint = () => (!MODE_APPROVED && TIERS.plan.model !== 'inherit' && !intent && !reqs
    ? ` The planners returned nothing on the plan tier (${TIERS.plan.model}). If this account cannot use that model, re-run with args.tiers: 'inherit' (follow the session model) or another plan model, e.g. args.tiers: { plan: { model: 'sonnet' } }.`
    : '')

  if (!reqs || !reqs.criteria?.length) {
    status = 'stopped'
    return {
      status: 'stopped',
      reason: MODE_APPROVED
        ? `the approved spec.md in ${handoffDir()} has no acceptance criteria in the expected form — each criterion is a line "- **AC-1** — text" under "## Acceptance criteria".`
        : `product-analyst produced no acceptance criteria. Nothing downstream can trace against anything — this is a stop condition, not a reason to proceed on inference.${tierHint()}`,
      openQuestions: reqs?.openQuestions ?? [],
    }
  }

  const criteriaText = criteriaTextOf(reqs)
  const architecture = agentResult(planArtifact, 'architecture')
  // No plan -> stop. The build tier is cheap BECAUSE the plan leaves it nothing
  // to design; without one it would design everything, unreviewed (S3).
  if (architecture === null || architecture === undefined || (typeof architecture === 'string' && !architecture.trim()) ||
      (MODE_APPROVED && !HANDOFF_FILES['plan.md'])) {
    status = 'stopped'
    return {
      status: 'stopped',
      reason: MODE_APPROVED
        ? `the approved plan.md is not confirmed in ${handoffDir()} — commit it there and start a fresh run with approvedPlan: true.`
        : `solution-architect produced no plan. The build tier executes plan.md and is not allowed to design — running it without a plan would move every design decision to the cheapest tier, unreviewed.${TIERS.plan.model !== 'inherit' ? ` If this account cannot use ${TIERS.plan.model}, re-run with args.tiers: 'inherit'.` : ''}`,
      requirements: reqs,
    }
  }
  log(`${reqs.criteria.length} acceptance criteria; surfaces: ${reqs.surfaces.join(', ') || 'none classified'}`)
  if (MODE_APPROVED) {
    // The person's spec.md IS the spec: adopted, never re-rendered over. It was
    // registered from the preflight (fresh) or re-verified by adoptFiles (resume).
  } else {
    // Rendered by this workflow, so rewritten on every pass, replay included.
    await writeRendered('spec.md', renderSpec(reqs))
  }

  // -------------------------------------------------------------------------
  // Plan approval (M3). In spec mode the run stops here by default, so a
  // person reviews spec.md and plan.md, edits them if needed, commits them, and
  // runs again with approvedPlan: true — which starts at Design from exactly
  // what they committed. pauseAfterPlan: false runs straight through.
  // -------------------------------------------------------------------------
  // A resume of a run whose Plan still awaits approval must neither build the
  // unapproved plan nor pause a second time unnoticed: it is refused, and the
  // way forward is the approval itself (round-5 mutation check).
  // The record decides, not this invocation: a resume that drops specDir or
  // passes pauseAfterPlan: false must not build a plan that paused for a
  // person (code review round 5). Records from before the marker fall back
  // to this invocation's PAUSE.
  const recordedPause = planReplays && RUN.resumed.Plan && typeof RUN.resumed.Plan.pauseRequired === 'boolean'
    ? RUN.resumed.Plan.pauseRequired : PAUSE
  if (recordedPause && !MODE_APPROVED && planReplays) {
    status = 'stopped'
    return {
      status: 'stopped',
      reason: `run ${RUN.runId} is waiting for its plan to be approved — resuming would build a plan nobody approved. Review and commit spec.md and plan.md in ${handoffDir()}, then start a FRESH run with approvedPlan: true.`,
    }
  }
  if (PAUSE && !MODE_APPROVED && !planReplays) {
    // Never ask a person to approve files that are not this run's (security R4-2).
    const stop = missingInputs('Plan approval', ['spec.md', 'plan.md'])
    if (stop) return stop
    // The next invocation repeats THIS one's args, adding only approvedPlan —
    // intentPath, tiers and strict carry over (code review round 4).
    const nextArgs = {}
    for (const [k, v] of Object.entries(args && typeof args === 'object' ? args : {})) {
      if (!['resume', 'approvedPlan', 'pauseAfterPlan', 'replan', 'runtimeDir', 'policyDefault'].includes(k)) nextArgs[k] = v
    }
    nextArgs.approvedPlan = true
    status = 'awaiting-plan-approval'
    return {
      status: 'awaiting-plan-approval',
      initiative,
      requirements: reqs,
      plan: architecture,
      handoff: { dir: handoffDir(), files: { ...HANDOFF_FILES }, specDir: SPEC_DIR, strict: STRICT },
      next: `Review spec.md and plan.md in ${handoffDir()}. Edit them if needed (criteria stay one per line: "- **AC-n** — text"; under "## Contradictions" each line must end with its resolution — which side wins — or be deleted once settled), commit them, then start a FRESH run with ${JSON.stringify(nextArgs)} — it starts at Design from exactly the committed files.`,
      humanDecisionRequired: [
        `Approve the plan: review and commit spec.md and plan.md in ${handoffDir()}, then run with approvedPlan: true.`,
        ...(reqs.contradictions || []).map(c => `CONTRADICTION: ${c}`),
        ...reqs.openQuestions,
      ],
      tiers: TIERS,
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2 — Design, on the design tier. UX spec, then a static mock built
  // from it — sequential, because the mock is the spec made clickable. Only
  // when a frontend surface is touched; otherwise the phase is recorded empty,
  // so a resume sees the same phase sequence either way.
  // -------------------------------------------------------------------------
  const needsUx = reqs.surfaces.includes('frontend')
  if (!needsUx) log('no frontend surface — Design has nothing to do and is recorded empty')
  const mockPath = handoffPath('mock.html')
  if (needsUx) {
    const stop = missingInputs('Design', ['spec.md', 'plan.md'])
    if (stop) return stop
  }
  const designArtifact = await runPhase('Design', 'Build', async () => {
    if (!needsUx) return { agents: [] }
    const ux = await dispatch(
      withPolicy(`Produce the UX specification for these requirements:\n${criteriaText}

${handoffRef('plan.md', 'IMPLEMENTATION PLAN (solution-architect)', asText(architecture))}

Specify every interactive state — initial, loading, empty, success, error, permission-denied, degraded. State accessibility requirements as checkable targets (a WCAG level, a contrast ratio, a touch-target size), not aspirations; ui-engineer owns turning them into measured values. Flag any gap back rather than inventing behavior, and reconcile anything the plan constrains. Return the spec as markdown.${writeInstruction('design.md')}`),
      { agentType: 'ux-designer', label: 'ux-spec', phase: 'Design', ...tier('design') },
    )
    const agents = [{ label: 'ux-spec', result: ux }]
    if (!mockPath) {
      log('no run directory — the static mock has nowhere to live and is skipped; builders get the UX spec only')
    } else if (ux) {
      const mock = await dispatch(
        withPolicy(`Build a static, self-contained HTML MOCK of the UX specification below and write it to EXACTLY this absolute path: ${mockPath} (create the parent directory if needed). Write no other file and change nothing else in the repository — the mock is the only thing this step produces.

This is a design artifact, not production code: one file, inline CSS and JS, no build step, no package install, no network request. Every state the spec names must be reachable in the mock — a visible state switcher is fine. Do not invent a state the spec omits; list each gap. Return a short note: the path you wrote, which states the mock covers, and the spec gaps you found.

${handoffRef('design.md', 'UX SPEC', asText(ux))}`),
        // Outside spec mode, a worktree: ui-engineer has Write/Edit/Bash, and the
        // prompt alone is what limits it to one file. In a checkout build there is
        // no worktree — on both live runs the worktree mock never reached its
        // absolute path, and the worktree was left behind — so the prompt's
        // one-file rule is the boundary, as it is for the builders after it.
        { agentType: 'ui-engineer', label: 'mock', phase: 'Design', ...(BUILD_TREE === 'checkout' ? {} : { isolation: 'worktree' }), ...tier('design') },
      )
      agents.push({ label: 'mock', result: mock })
    }
    // design.md falls back to the returned text; mock.html is confirm-only —
    // it is a file by nature, and its hash pins it for a resume.
    const files = await confirmFiles(
      { 'design.md': handoffPath('design.md'), ...(mockPath && ux ? { 'mock.html': mockPath } : {}) },
      { 'design.md': asText(ux) },
      before,
    )
    return { agents, files }
  })
  await adoptFiles('Design', designArtifact.files)

  const uxSpec = needsUx ? agentResult(designArtifact, 'ux-spec') : null
  const mockNote = needsUx ? agentResult(designArtifact, 'mock') : null

  // -------------------------------------------------------------------------
  // Phase 3 — Build, on the build tier. One specialist per surface actually
  // touched, executing plan.md. Each returns a MANIFEST (CHG-20), so the verify
  // stages can hand off by reference. A decision the plan left open is
  // ESCALATED in planGaps, never improvised: a design choice made at the build
  // tier is exactly what the expensive plan tier exists to prevent.
  // -------------------------------------------------------------------------
  // Design-stage agents have Write: re-verify what Build will read against the
  // hashes recorded when each file was confirmed (security R4-3).
  await adoptFiles('Build', { ...(planArtifact.files || {}), ...(designArtifact.files || {}) }, true)
  {
    const stop = missingInputs('Build', ['plan.md', ...(needsUx ? ['design.md'] : [])])
    if (stop) return stop
  }
  const BUILDERS = {
    backend: {
      agentType: 'software-engineer',
      brief: 'Implement the backend/application changes. Stay inside scope — collect anything else you notice as "noticed but didn\'t touch".',
    },
    frontend: {
      agentType: 'ui-engineer',
      brief: `Implement the frontend against the UX specification, state-for-state. Do not invent a state the spec omitted — flag the gap.

${handoffRef('design.md', 'UX SPEC', asText(uxSpec))}${HANDOFF_FILES['mock.html'] ? `\n\nSTATIC MOCK: ${HANDOFF_FILES['mock.html']} — the agreed look of each state. Match it; where it and the spec disagree, the spec wins and you say so.` : ''}`,
    },
    data: {
      agentType: 'database-engineer',
      brief: 'Design and implement the schema/migration in Build mode. Rollback design is yours; rollback *rehearsal* is qa-engineer\'s to execute independently — hand it off as a hypothesis, not a confirmed result.',
    },
  }

  const surfaces = reqs.surfaces.filter(s => BUILDERS[s])
  const IN_CHECKOUT = BUILD_TREE === 'checkout'
  // In the checkout the builders take turns, data first and the frontend last,
  // each told what the earlier ones changed — one tree, no merge step.
  const buildOrder = IN_CHECKOUT ? ['data', 'backend', 'frontend'].filter(x => surfaces.includes(x)) : surfaces
  const checkoutRules = earlier => (IN_CHECKOUT
    ? `\n\nWHERE YOU BUILD: in the repository checkout this run started in, on its current branch — not a worktree. ${earlier.length
      ? `Earlier builders already changed this tree; build on their work and never revert it:\n${earlier.map(m => `- ${m.label}: ${(m.filesChanged || []).map(f => f.path).join(', ') || '(no files listed)'}`).join('\n')}\n`
      : ''}Do not commit, switch branches, stash, reset or clean — ${STAGE_COMMITS ? 'this workflow commits each stage itself, after you finish' : 'the change stays uncommitted for review'}.${BUILD_BASE ? ` For diffRef, write: git diff ${BUILD_BASE}, plus the new untracked files: git status --short` : ''}`
    : '')
  const buildOne = (surface, earlier) => dispatch(
    withPolicy(`${BUILDERS[surface].brief}

ACCEPTANCE CRITERIA (trace to these IDs):\n${criteriaText}

${handoffRef('plan.md', 'IMPLEMENTATION PLAN — execute it; do not redesign it', asText(architecture))}

When the plan does not settle something you need — an interface, a data shape, an error behaviour, anything listed under "Open decisions" — do NOT make the design decision yourself. Implement what the plan does settle and put each open decision in planGaps, worded so a planner can answer it. An escalated gap costs one planning round; an improvised design choice at build tier costs a review cycle and usually a rewrite.

Report a BUILD MANIFEST, not prose. The reviewers that follow you read the code themselves — your summary is at most 2000 characters and exists to tell them what to look at and why, never to reproduce the diff. List every file you changed with its role, give a diffRef a reader can reach the change through (a git range, or the worktree path you were given), and name the criteria you addressed. Any criterion you did not address goes in notAddressed with the reason — an omission that is written down is a decision; one that is not is a defect found later.${checkoutRules(earlier)}`),
    // retry: false — a builder mutates the tree; see dispatch().
    { agentType: BUILDERS[surface].agentType, label: `build:${surface}`, phase: 'Build', ...(IN_CHECKOUT ? {} : { isolation: 'worktree' }), schema: BUILD_MANIFEST_SCHEMA, retry: false, ...tier('build') },
  )
  const buildArtifact = await runPhase('Build', 'Test', async () => {
    if (IN_CHECKOUT) {
      const out = []
      for (const surface of buildOrder) {
        const earlier = out.filter(x => x.result).map(x => ({ label: x.label, ...x.result }))
        out.push({ label: `build:${surface}`, result: await buildOne(surface, earlier) })
      }
      // Recorded with the phase: a resume diffs against the commit the build
      // started from, not wherever HEAD is by then (code review round 7, S1).
      return { agents: out, base: BUILD_BASE }
    }
    const built = await parallel(surfaces.map(surface => () => buildOne(surface, [])))
    return { agents: surfaces.map((s, i) => ({ label: `build:${s}`, result: built[i] })) }
  })
  if (IN_CHECKOUT && buildArtifact && typeof buildArtifact.base === 'string' && buildArtifact.base) BUILD_BASE = buildArtifact.base

  const manifests = surfaces
    .map(s => {
      const m = agentResult(buildArtifact, `build:${s}`)
      return m ? { label: `build:${s}`, ...m } : null
    })
    .filter(Boolean)

  if (!manifests.length) {
    status = 'stopped'
    return { status: 'stopped', reason: 'No build surface produced an implementation manifest.', requirements: reqs }
  }
  // One tree, one route to it: a builder's own diffRef could name a range that
  // misses the others' uncommitted work.
  // `git diff` alone misses every NEW file — they are untracked (round 7, S5).
  if (IN_CHECKOUT && BUILD_BASE) for (const m of manifests) m.diffRef = `git diff ${BUILD_BASE}, plus the new untracked files: git status --short`
  verification.base = BUILD_BASE
  const buildCommit = await commitStage('Build')

  // Whitespace collapsed: a gap is one line of a BLOCKED entry, and a newline
  // inside it would end the entry early in the reducer (code review C1).
  const gapsOf = ms => ms.flatMap(m => (Array.isArray(m.planGaps) ? m.planGaps : [])
    .map(gap => ({ builder: m.label, gap: String(gap).replace(/\s+/g, ' ').trim() }))
    .filter(g => g.gap))
  planGaps = gapsOf(manifests)
  if (planGaps.length) log(`${planGaps.length} plan gap(s) escalated by the build tier — recorded as a blocked gate for re-planning`)

  // -------------------------------------------------------------------------
  // Phases 4 and 5 — Test, then Review. Independent evidentiary bases on the
  // same change, each handed a BUDGETED BRIEF built from the manifests rather
  // than the concatenated output of every builder. Sequential, because Review
  // is handed Test's report as evidence (each stage hands the next a file).
  // -------------------------------------------------------------------------
  const briefs = await buildBriefs(manifests, criteriaText, LENSES.map(l => l.key))
  const handoffs = []

  /**
   * `carried` — failures from an EARLIER verification stage. The breaker counts
   * per phase; before Verify was split into Test and Review, qa + review +
   * security dying was three failures in one phase and stopped the run. Split
   * 1 + 2 it tripped nothing, and readiness ran on one lens of four (code
   * review M1, reproduced by QA). Carried failures count toward this phase's
   * threshold without being written again (S-A), and a trip that counted them
   * also fails their phase so a resume re-runs it (S-B) — see recordPhase().
   */
  async function lensPhase(title, next, lenses, extra, carried = [], carriedFrom = null) {
    // A lens that produced nothing is invisible in the pipeline's OUTPUT — its
    // refute stage turns a null lens result into an empty findings array. The
    // breaker would then never see the failure that it exists to count.
    const lensFailures = []
    const raw = {}
    return runPhase(title, next, async () => {
      // Refuters that returned nothing are failures of this stage too (C-1):
      // they land in NULL_RESULTS, which runPhase merges for its own record —
      // so they are put on the artifact here, where a later stage can carry them.
      const nl0 = NULL_RESULTS.length
      const verified = await pipeline(
        lenses,
        lens => {
          const b = briefs[lens.key]
          const text = b.text
          // briefChars is measured on the text this script actually interpolated,
          // never on the bridge's self-report. A mismatch means the value changed
          // in transit, and that is worth knowing about explicitly.
          handoffs.push({
            label: `verify:${lens.key}`,
            briefChars: text.length,
            truncated: b.truncated === true,
            omittedFiles: b.omittedFiles || [],
            briefSource: b.briefSource,
            bridgeIntegrity: b.chars === text.length,
          })
          if (b.chars !== text.length) {
            log(`verify:${lens.key} brief size disagrees with the builder (${b.chars} vs ${text.length}) — the brief may have been altered in transit`)
          }
          if (b.truncated) {
            log(`verify:${lens.key} brief was TRUNCATED to its budget — the lens is told so in the brief`)
          }
          return dispatch(
            withPolicy(`${lens.brief}

${text}

The section above is a BRIEF, by reference. It is not the diff. Read the changed files yourself with Read / Grep / Glob before concluding, and if the brief says it was truncated, say so in your verdict.${extra ? `\n\n${extra(lens)}` : ''}`),
            { agentType: lens.agentType, label: `verify:${lens.key}`, phase: title, schema: lens.schema || FINDINGS_SCHEMA, ...tier(lens.tier) },
          ).then(r => {
            if (r === null || r === undefined) lensFailures.push(`verify:${lens.key}`)
            else {
              raw[lens.key] = { verdict: r.verdict }
              if (Array.isArray(r.cases)) raw[lens.key].cases = r.cases
              if (r.mutation && typeof r.mutation === 'object') raw[lens.key].mutation = r.mutation
            }
            return r
          })
        },
        // Adversarially verify each finding from a different lens than produced it.
        (result, lens) => refuteFindings(result, lens.key, criteriaText),
      )
      return {
        agents: lenses.map((l, i) => ({ label: `verify:${l.key}`, result: verified[i] })),
        raw,
        handoff: handoffs.filter(h => lenses.some(l => h.label === `verify:${l.key}`)),
        failed: [...lensFailures, ...NULL_RESULTS.slice(nl0).filter(l => !lensFailures.includes(l))],
        carried: carried.length && carriedFrom ? { from: carriedFrom, labels: carried } : null,
      }
    })
  }

  const loop = TIERS.testLoop
  const loopPin = [
    loop.model && loop.model !== 'inherit' ? `model "${loop.model}"` : null,
    loop.effort ? `effort "${loop.effort}"` : null,
  ].filter(Boolean).join(' and ')
  const evidenceDir = handoffDir() ? `${handoffDir()}/evidencia` : null
  const testArtifact = await lensPhase('Test', 'Review', LENSES.filter(l => l.stage === 'Test'), () =>
    `Execution loops are mechanical: delegate running suites, scripts and re-runs to qa-runner${loopPin ? `, and when your Agent tool accepts these parameters, dispatch it with ${loopPin}` : ''}. You design the cases and interpret the evidence; the runner only runs them and reports raw results.

EVIDENCE, ONE CASE PER CRITERION. A person reviews and approves this change from your evidence, so make it easy to check:
- In "cases", give EVERY acceptance criterion at least one case: an id (CP-01, CP-02, ...), the criterion id, a title that says what is checked, the type (${CASE_TYPES.join(', ')}), the test (file › test name, or the exact command), the result (pass, fail or not-run) and the evidence path.
- Choose the type the criterion needs: logic → unit; a UI component → component; several modules or the database together → integration; a user journey → e2e; how a screen looks → visual. A criterion you cannot check by execution here is type manual, result not-run: it is pending human QA, never "pass".
- ${evidenceDir ? `Save each case's evidence under ${evidenceDir}/<case id>/ — what the test or command returned (output as .txt, API responses as .json), and a screenshot or a short video when the case has a screen and a browser is available. Also write ${evidenceDir}/casos.md. If the repository has ${QA_TEMPLATE}, follow it exactly — its case titles, headings and naming — and, when it describes a tracker draft (a container and its cases), also write ${evidenceDir}/tracker-draft.md from it, ready to paste. Never publish anything to a tracker yourself. Without that file, write one section per case with its title, functional description, preconditions, steps, expected result and execution result (environment, commit, date), so it can be reviewed or copied into the team's tracker as it is.` : 'There is no handoff directory for this run: put the essential evidence inline in each case\'s "evidence" field.'}
${buildCommit ? `- The code under test is commit ${buildCommit.commit} on the current branch. Name it in every case's execution result: evidence is bound to the commit it was produced on.\n` : ''}- Evidence is committed with the spec: before saving any output, response or screenshot, redact tokens, credentials, secrets and personal data (names, phone numbers, emails) — or use test data that has none.
- If the repository has mutation testing set up (for example a Stryker configuration), run it on the changed files only and report it in "mutation". Each surviving mutant in changed code is a Should Fix finding: a test that does not fail when the code is broken does not protect it.
- A criterion with no automated test where one was possible is a finding, not a case to skip.`)

  const testFindings = (testArtifact.agents || []).flatMap(a => a.result || []).filter(Boolean)
  const testRaw = (testArtifact.raw || {}).qa || null
  const testDead = (testArtifact.failed || []).filter(l => /^verify:/.test(l))
  if (testDead.length) {
    keep([
      'BLOCKED — test.noEvidence',
      '  Action withheld: treating the change as tested',
      `  Why gated: the test stage produced no result (${testDead.join(', ')}), so no criterion was exercised at runtime`,
      '  Prepared: the review lenses ran, and their test report says the test stage produced nothing',
      '  Unblocks: re-running the workflow, or testing the change by hand',
      '  Authorize by: not an authorization gate — missing verification',
    ].join('\n'))
  }
  const testReport = renderTestReport(testRaw, testFindings, reqs.criteria)
  await writeRendered('test-report.md', testReport)
  // The tests the test stage added and its evidence, committed together: Review
  // reads this tree, so this is the commit the verification ran on.
  {
    const c = await commitStage('Test')
    if (c) { verification.verifiedCommit = c.commit; verification.verifiedStage = 'Test' }
  }
  {
    const stop = missingInputs('Review', ['test-report.md'])
    if (stop) return stop
  }

  const reviewArtifact = await lensPhase('Review', 'Readiness', LENSES.filter(l => l.stage === 'Review'), () =>
    `${handoffRef('test-report.md', 'TEST STAGE RESULT (qa-engineer, after cross-check) — evidence to weigh, not a verdict to adopt', testReport)}`,
    // Every Test failure, refuters included — a dead refuter means qa's
    // findings were never cross-checked (code review C-1).
    (testArtifact.failed || []).slice(), 'Test')

  // Lenses that died in Review below the breaker threshold leave a review
  // that LOOKS complete. Say which ones did not run (QA, round 2).
  const reviewDead = (reviewArtifact.failed || []).filter(l => /^verify:/.test(l))
  if (reviewDead.length) {
    keep([
      'BLOCKED — review.incomplete',
      '  Action withheld: treating the change as reviewed by every lens',
      `  Why gated: ${reviewDead.join(', ')} produced no result, so that lens never looked at the change`,
      '  Prepared: the lenses that did run, and their cross-checked findings',
      '  Unblocks: re-running the workflow, or that review done by hand',
      '  Authorize by: not an authorization gate — missing verification',
    ].join('\n'))
  }

  const allFindings = [testArtifact, reviewArtifact]
    .flatMap(art => (art.agents || []).flatMap(a => a.result || []))
    .filter(Boolean)
  let confirmed = allFindings.filter(f => !f.refuted)
  const refuted = allFindings.filter(f => f.refuted)
  log(`${confirmed.length} findings survived cross-check, ${refuted.length} refuted`)
  const verifyHandoff = [...(testArtifact.handoff || []), ...(reviewArtifact.handoff || [])]

  // CHG-22 — the refutation reasoning is the most informative thing the run
  // produces, and it is what used to be unrecoverable an hour later. Set before
  // the repair loop, which appends each re-verification's own.
  refutations = allFindings.map(f => ({
    lens: f.lens, severity: f.severity, summary: f.summary, refuted: f.refuted === true, why: f.why ?? null,
  }))

  // -------------------------------------------------------------------------
  // Phase 4b — Repair. Bounded; see MAX_REPAIR_ROUNDS above.
  // -------------------------------------------------------------------------
  repairRounds = { max: MAX_REPAIR_ROUNDS, rounds: [], outcome: 'not-needed' }
  const seenFindings = [...allFindings]   // every finding any lens raised, all rounds
  let open = confirmed.filter(isBlocking)
  if (open.length && args?.repair === false) repairRounds.outcome = 'disabled'
  for (let k = 1; open.length && args?.repair !== false && k <= MAX_REPAIR_ROUNDS; k++) {
    const target = open
    const lensKeys = [...new Set(target.map(f => f.lens))]
    // Each finding goes to the builder(s) whose manifest names its file — paths
    // normalised, since a lens may cite `./src/x.ts` or an absolute path for a
    // manifest's `src/x.ts` — and a finding no manifest owns goes to every
    // builder. Per finding, not per set: one matching finding must not route
    // another surface's finding to the wrong builder.
    const normPath = p => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '')
    const owns = (m, f) => !!f.file && (m.filesChanged || []).some(x => {
      const a = normPath(x.path)
      const b = normPath(f.file)
      // A suffix match only when the shorter path still names a directory: a
      // manifest's root-level `index.ts` must not own a finding in `ui/index.ts`.
      const [short, long] = a.length <= b.length ? [a, b] : [b, a]
      return a === b || (short.includes('/') && long.endsWith(`/${short}`))
    })
    const ownersOf = f => {
      const o = manifests.filter(m => owns(m, f))
      return o.length ? o : manifests
    }
    const fixers = manifests.filter(m => target.some(f => ownersOf(f).includes(m)))
    const findingsFor = m => target.filter(f => ownersOf(f).includes(m))
    const surfaceOf = m => String(m.label).replace(/^build:/, '')

    const repairArtifact = await runPhase(`Repair ${k}`, `Re-verify ${k}`, async () => {
      const fixOne = m =>
        dispatch(
          withPolicy(`REPAIR, round ${k} of ${MAX_REPAIR_ROUNDS}. Independent reviewers confirmed the blocking findings below against the change you built. Fix them.

Work on YOUR ORIGINAL CHANGE, where it already lives — ${m.diffRef ? `reach it through: ${m.diffRef}` : 'the worktree or branch you built it in'}. Do not start from a fresh checkout: the change is not there, and a fix applied to the wrong tree fixes nothing.${IN_CHECKOUT ? ` It is in the checkout this run started in${STAGE_COMMITS ? ', committed by this workflow after each stage' : ', uncommitted'}, together with the other builders' work: fix only what the findings name, never revert theirs, and do not commit, switch branches, stash, reset or clean${STAGE_COMMITS ? ' — this workflow commits your repair' : ''}.` : ''} Stay inside the findings' scope; anything else you notice goes in your summary as noticed-but-not-touched.

A finding you believe is wrong is not yours to dismiss — say so in notAddressed with the evidence, and the independent lens that raised it will re-check. You do not certify this repair; the lens re-verifies it after you.

FINDINGS TO FIX:
${JSON.stringify(findingsFor(m).map(f => ({ lens: f.lens, severity: f.severity, summary: f.summary, evidence: f.evidence, file: f.file, line: f.line })), null, 2)}

YOUR ORIGINAL BUILD MANIFEST:
${JSON.stringify(m, null, 2)}

ACCEPTANCE CRITERIA:
${criteriaText}

Report a BUILD MANIFEST of the repair, with the same rules as the build: every file you changed, a diffRef, and criteriaAddressed.`),
          // retry: false — a repair MUTATES the change. A null after a partial
          // edit is not something a second attempt on top of it can cleanly fix.
          { agentType: BUILDERS[surfaceOf(m)].agentType, label: `repair:${surfaceOf(m)}`, phase: 'Repair', schema: BUILD_MANIFEST_SCHEMA, retry: false, ...tier('build') },
        )
      // In the checkout the fixers share one tree, so they take turns.
      const fixed = IN_CHECKOUT
        ? await (async () => { const r = []; for (const m of fixers) r.push(await fixOne(m)); return r })()
        : await parallel(fixers.map(m => () => fixOne(m)))
      return { agents: fixers.map((m, i) => ({ label: `repair:${surfaceOf(m)}`, result: fixed[i] })) }
    }, 'Repair')

    const repairManifests = (repairArtifact.agents || []).filter(a => a.result).map(a => ({ label: a.label, ...a.result }))
    // A repair can hit a decision the plan left open just as the build can.
    for (const g of gapsOf(repairManifests)) {
      if (!planGaps.some(x => x.gap === g.gap)) planGaps.push(g)
    }
    if (!repairManifests.length) {
      repairRounds.rounds.push({ round: k, lenses: lensKeys, fixers: fixers.map(m => m.label), targeted: target.length, remaining: target.length, note: 'no builder produced a repair manifest' })
      break
    }
    // Re-verify reads the repaired tree: it is committed first, and becomes the
    // commit the verification ran on.
    {
      const c = await commitStage(`Repair ${k}`)
      if (c) { verification.verifiedCommit = c.commit; verification.verifiedStage = `Repair ${k}` }
    }

    const reverifyFailed = []
    const reArtifact = await runPhase(`Re-verify ${k}`, 'Readiness', async () => {
      const reLenses = LENSES.filter(l => lensKeys.includes(l.key))
      const out = await pipeline(
        reLenses,
        lens => dispatch(
          withPolicy(`${lens.brief}

RE-VERIFICATION, round ${k} of ${MAX_REPAIR_ROUNDS}. A builder has attempted to fix the blocking findings below, which your lens raised and an independent refuter confirmed. Decide INDEPENDENTLY whether each one is actually fixed: read the changed files yourself — the repair manifest is the builder's claim, not evidence. Report every finding that is still present, at its real severity, and any new defect the repair introduced. A finding you have shown to be fixed is not reported again; a finding you could not check is reported as still present, with why.

FINDINGS TO RE-CHECK:
${JSON.stringify(target.filter(f => f.lens === lens.key).map(f => ({ severity: f.severity, summary: f.summary, evidence: f.evidence, file: f.file, line: f.line })), null, 2)}

REPAIR MANIFEST(S):
${JSON.stringify(INDEPENDENT_LENSES.has(lens.key) ? factsOnly(repairManifests, { disputes: true }) : repairManifests, null, 2)}

ORIGINAL BUILD MANIFEST(S):
${JSON.stringify(INDEPENDENT_LENSES.has(lens.key) ? factsOnly(manifests) : manifests, null, 2)}

ACCEPTANCE CRITERIA:
${criteriaText}`),
          { agentType: lens.agentType, label: `reverify:${lens.key}`, phase: 'Re-verify', schema: FINDINGS_SCHEMA, ...tier(lens.tier) },
        ).then(r => {
          if (r === null || r === undefined) reverifyFailed.push(`reverify:${lens.key}`)
          return r
        }),
        (result, lens) => refuteFindings(result, lens.key, criteriaText, 'Re-verify'),
      )
      return {
        agents: reLenses.map((l, i) => ({ label: `reverify:${l.key}`, result: out[i] })),
        failed: reverifyFailed,
        deadLenses: reverifyFailed.map(x => x.replace(/^reverify:/, '')),
      }
    }, 'Re-verify')

    const reFindings = (reArtifact.agents || []).flatMap(a => a.result || []).filter(Boolean)
    // A re-verifier that returned nothing has certified nothing. Its lens's
    // findings stay open rather than reading as "fixed" by silence — the same
    // rule as the null refuter, one level up.
    const dead = new Set(reArtifact.deadLenses || [])
    const stillOpenUnchecked = target.filter(f => dead.has(f.lens))
    for (const f of stillOpenUnchecked) f.repairUnverified = true
    // Replace ONLY the findings this round targeted, and only for lenses that
    // actually re-checked them. Everything else the lens confirmed — its Should
    // Fix and Low findings, which the re-verifier was never shown — stays.
    // Dropping a re-verified lens's findings wholesale erased independently
    // confirmed findings on every successful repair (code review + QA, D1).
    const replaced = new Set(target.filter(f => !dead.has(f.lens)).map(findingKey))
    const kept = confirmed.filter(f => !replaced.has(findingKey(f)))
    const keptKeys = new Set(kept.map(findingKey))
    confirmed = kept.concat(reFindings.filter(f => !f.refuted && !keptKeys.has(findingKey(f))))
    seenFindings.push(...reFindings)
    for (const f of reFindings) {
      refutations.push({ lens: f.lens, severity: f.severity, summary: f.summary, refuted: f.refuted === true, why: f.why ?? null })
    }
    // In RE-verification a blocking finding stays open unless it was refuted —
    // even if its refuter died. The lens has positively said "still present";
    // a second agent's silence does not overrule that, and treating it as
    // unverified here let the loop report `closed` on a defect the re-verifier
    // had just re-confirmed (code review N1).
    open = [
      ...reFindings.filter(f => !f.refuted && BLOCKING_RE.test(String(f.severity || ''))),
      ...stillOpenUnchecked,
    ]
    repairRounds.rounds.push({
      round: k, lenses: lensKeys, fixers: fixers.map(m => m.label),
      targeted: target.length, remaining: open.length, deadReverifiers: [...dead],
      // Per lens, so a lens that closed while another exhausted is never
      // reported as churn (improve.py reads this).
      openLenses: [...new Set(open.map(f => f.lens))],
    })
    log(`repair round ${k}: ${target.length} blocking finding(s) targeted, ${open.length} still open`)
  }
  if (repairRounds.rounds.length) repairRounds.outcome = open.length ? 'exhausted' : 'closed'
  if (repairRounds.outcome === 'exhausted') {
    // Through the same reducer as every autonomy gate, so it cannot vanish from
    // a run whose other phases look clean.
    keep([
      'BLOCKED — repair.exhausted',
      `  Action withheld: declaring the change fixed after ${repairRounds.rounds.length} bounded repair round(s)`,
      `  Why gated: ${open.length} blocking finding(s) survived independent re-verification: ${open.map(f => `[${f.lens}] ${f.summary}`).join('; ').slice(0, 600)}`,
      '  Prepared: every round\'s repair manifest and re-verification is in the run directory',
      '  Unblocks: a human or a fresh sdlc-feature run addressing the named findings',
      '  Authorize by: not an authorization gate — the repair loop is bounded by design',
    ].join('\n'))
  }

  // Recorded here, after repair, so gaps a repair escalated are included. Through
  // the same reducer as every autonomy gate, so it cannot vanish from a run
  // whose verification otherwise looks clean.
  if (planGaps.length) {
    keep([
      'BLOCKED — plan.insufficient',
      `  Action withheld: deciding ${planGaps.length} design question(s) the plan left open, at build tier`,
      `  Why gated: ${planGaps.map(g => `[${g.builder}] ${g.gap}`).join('; ').slice(0, 600)}`,
      '  Prepared: the build implemented everything the plan did settle; the gaps are in every lens brief',
      '  Unblocks: answering the gaps in plan.md and re-running, or a human deciding them',
      '  Authorize by: not an authorization gate — the plan tier owns these decisions',
    ].join('\n'))
  }

  // After repair, and every count from the same final state: `confirmed` is
  // what survived the last re-verification; `refuted` and `byLens` include each
  // re-verification's findings, so the three numbers agree with one another.
  const verified = confirmed.filter(f => !f.unverified)
  const unverified = confirmed.filter(f => f.unverified)
  findingCounts = {
    confirmed: verified.length,
    unverified: unverified.length,
    refuted: seenFindings.filter(f => f.refuted).length,
    byLens: LENSES.reduce((acc, l) => {
      acc[l.key] = seenFindings.filter(f => f.lens === l.key).length
      return acc
    }, {}),
  }

  // Which lenses ran, stated positively. With only "lenses that did not run:
  // (none)" to go on, readiness on the first live run reported that security
  // never ran — it had run, raised findings, and every one was refuted, so none
  // reached the confirmed list readiness reads.
  const deadLenses = new Set([...testDead, ...reviewDead].map(l => l.replace(/^verify:/, '')))
  const coverageText = LENSES.map(l => {
    if (deadLenses.has(l.key)) return `- ${l.key} (${l.agentType.replace(/^/, '')}): DID NOT RUN — it returned nothing`
    const raised = seenFindings.filter(f => f.lens === l.key)
    const b = briefs[l.key] || {}
    const brief = b.truncated
      ? `its brief was PARTIAL${(b.omittedFiles || []).length ? ` (${b.omittedFiles.length} changed file(s) not listed in it)` : ''}`
      : 'its brief was complete'
    return `- ${l.key} (${l.agentType.replace(/^/, '')}): RAN — raised ${raised.length} finding(s): ${verified.filter(f => f.lens === l.key).length} confirmed, ${unverified.filter(f => f.lens === l.key).length} unverified, ${raised.filter(f => f.refuted).length} refuted; ${brief}`
  }).join('\n')

  // -------------------------------------------------------------------------
  // Phase 6 — Readiness, on the readiness tier. Recommendation only, for a
  // HUMAN to approve. No deploy authority here.
  // -------------------------------------------------------------------------
  const readinessArtifact = await runPhase('Readiness', null, async () => {
    const [readiness, docs] = await parallel([
      () =>
        dispatch(
          withPolicy(`Assess release readiness from this evidence. Classify each gate Confirmed / Claimed-not-verified / Missing / N-A — do not upgrade a claim to Confirmed because it sounds reasonable.

Produce a RECOMMENDATION for human confirmation. You do not hold deploy authority and this workflow cannot grant it.

Give TWO verdicts, not one — different people decide them, on different evidence (go, no-go or conditional, each with the gates behind it):
- "technical": is the CODE ready? Tests and their evidence, mutation, confirmed findings, the security and performance lenses, and whether the evidence is bound to the commit being delivered. Engineering decides.
- "product": does the change do what the HU asks? Each acceptance criterion proven or pending human QA, open questions and contradictions for the product owner, plan gaps. The product owner decides.
A clean technical verdict never answers an open product question, and the other way round. Put the full gate-by-gate assessment in "report".

The autonomy policy in force is stated at the top of this prompt — you do not need to go and find it. Reproduce every BLOCKED gate entry from the evidence below verbatim in your output, each with what was prepared so a human can execute it in one step. Do not drop a blocked gate because the recommendation is otherwise a Go.

VERIFICATION COVERAGE — every lens of this run and what it did. A lens marked RAN looked at the change even when none of its findings survived; never report it as missing or as not having run. A PARTIAL brief means that lens may have missed part of the change — say so where it matters:
${coverageText}

CONFIRMED FINDINGS (an independent refuter checked each; after the bounded repair loop):\n${JSON.stringify(verified, null, 2)}

UNVERIFIED FINDINGS — raised by a lens, but the refuter returned NOTHING, so no one has confirmed or dismissed them. Treat each as open and classify it Claimed-not-verified, never Confirmed:\n${JSON.stringify(unverified, null, 2)}

REPAIR LOOP RECORD — blocking findings the builder repaired and an independent lens re-verified:\n${JSON.stringify(repairRounds, null, 2)}

OPEN ASSUMPTIONS / QUESTIONS FROM REQUIREMENTS:\n${[...reqs.assumptions, ...reqs.openQuestions].join('\n') || '(none)'}

${MODE_APPROVED
    ? `CONTRADICTIONS IN THE APPROVED SPEC — a person reviewed and committed each with its stated resolution; treat those as settled. One that still says a person must decide keeps the criteria it touches from Confirmed`
    : `CONTRADICTIONS FOUND WHILE PLANNING (intent vs the repository's specs, docs or code) — a criterion one of them touches is not Confirmed until a person settles it`}:\n${(reqs.contradictions || []).join('\n') || '(none)'}

TRACEABILITY (test stage): ${repairRounds && repairRounds.rounds && repairRounds.rounds.length ? `MEASURED BEFORE THE REPAIR LOOP — ${repairRounds.rounds.length} repair round(s) changed the code after these cases ran, so a "proven" criterion is Claimed-not-verified and a "failing" one may since be fixed: ` : ''}${traceabilityLine(testRaw, reqs.criteria)}. A criterion pending human QA or failing is not Confirmed.

TEST STAGE: ${testDead.length ? `produced NO result (${testDead.join(', ')}) — nothing was exercised at runtime; no criterion may be classified Confirmed on test evidence.` : 'ran; its findings are among those above.'}

REVIEW LENSES THAT DID NOT RUN: ${reviewDead.length ? reviewDead.join(', ') : '(none)'}

CODE UNDER VERIFICATION: ${verification.verifiedCommit
    ? `commit ${verification.verifiedCommit} (${verification.verifiedStage}) on the current branch — the evidence above was produced on it.`
    : STAGE_COMMITS
      ? `NOT BOUND TO A COMMIT — the stage commit failed (${verification.errors.join('; ').slice(0, 300) || 'no reason recorded'}), so the evidence cannot be tied to what will be delivered: classify it Claimed-not-verified.`
      : 'the change is uncommitted (commitStages is off), so the evidence is not bound to a commit.'}

PLAN GAPS — design decisions the build tier escalated instead of making. Each stays open until the plan answers it; a criterion a plan gap touches is not Confirmed:\n${planGaps.length ? planGaps.map(g => `[${g.builder}] ${g.gap}`).join('\n') : '(none)'}`),
          { agentType: 'release-manager', label: 'readiness', phase: 'Readiness', schema: READINESS_SCHEMA, ...tier('readiness') },
        ),
      () =>
        dispatch(
          withPolicy(`Draft the user-facing documentation and release notes for this change. Verify every behavioral claim against the actual implementation, not the requirement text — label anything you could not verify as Unverified rather than asserting or omitting it.

CRITERIA:\n${criteriaText}

IMPLEMENTATION (build manifest — read the listed files rather than assuming their contents):\n${JSON.stringify(manifests, null, 2)}`),
          { agentType: 'technical-writer', label: 'docs', phase: 'Readiness', ...tier('docs') },
        ),
    ])
    return { agents: [{ label: 'readiness', result: readiness }, { label: 'docs', result: docs }] }
  })

  // The final commit, and the check that what is delivered is what was
  // verified: nothing outside the spec directory may change after the commit
  // the last verification stage ran on.
  if (STAGE_COMMITS) {
    const fin = await commitStage('Readiness', verification.verifiedCommit)
    verification.finalCommit = fin ? fin.commit : null
    if (verification.deliveredMatchesVerified === false) {
      keep([
        'BLOCKED — verification.drift',
        `  Action withheld: treating commit ${String(verification.finalCommit).slice(0, 12)} as verified`,
        `  Why gated: files changed after the last verification (${verification.verifiedStage}, ${String(verification.verifiedCommit).slice(0, 12)}): ${verification.changedAfterVerification.join(', ').slice(0, 500)}`,
        '  Prepared: every stage commit is listed in the outcome under verification.commits',
        '  Unblocks: re-running Test and Review on the final commit, or reverting the later change',
        '  Authorize by: not an authorization gate — what is delivered must be what was verified',
      ].join('\n'))
    }
  }

  const readinessResult = agentResult(readinessArtifact, 'readiness')
  const readiness = readinessVerdicts(readinessResult)
  const verdictLine = v => (v
    ? `release-manager recommends ${v.verdict.toUpperCase()}${v.reasons.length ? ` (${v.reasons.slice(0, 3).join('; ').slice(0, 300)})` : ''}`
    : 'release-manager gave no verdict for it — decide from the report')
  status = 'completed'
  return {
    initiative,
    intent,
    requirements: reqs,
    plan: architecture,
    design: { ux: uxSpec, mock: HANDOFF_FILES['mock.html'] || null, mockNote, architecture },
    surfacesBuilt: surfaces,
    buildManifests: manifests,
    planGaps,
    verifyHandoff,
    // Base, every stage commit, the commit verification ran on, the final one,
    // and whether they agree outside the spec directory.
    verification,
    // Which model and effort each stage ran on, as resolved — so a reader can
    // tell a Fable-planned run from one where args.tiers pinned nothing.
    tiers: TIERS,
    // The files each stage handed the next. Only files confirmed on disk are
    // listed; a stage whose file is absent was handed the inline text instead.
    handoff: { dir: handoffDir(), files: { ...HANDOFF_FILES }, specDir: SPEC_DIR, strict: STRICT, approvedPlan: MODE_APPROVED },
    // `confirmed` keeps every surviving finding, unverified ones flagged, so a
    // consumer that reads only this list still sees them; `unverified` names
    // the subset no refuter checked.
    findings: { confirmed, unverified, refutedCount: findingCounts.refuted },
    // Still the prose a caller relays verbatim, as before: the report when the
    // answer came in the two-verdict shape (independent review).
    readinessRecommendation: requireResult('readiness',
      readinessResult && typeof readinessResult === 'object' && typeof readinessResult.report === 'string' ? readinessResult.report : readinessResult),
    // Two verdicts, decided by different people (Alexander's review, 4.2).
    readiness,
    documentation: agentResult(readinessArtifact, 'docs'),
    humanDecisionRequired: [
      `Technical go/no-go (engineering) — ${verdictLine(readiness.technical)}; it never commits.`,
      `Product go/no-go (product owner) — ${verdictLine(readiness.product)}; it never commits.`,
      ...planGaps.map(g => `Plan gap escalated by ${g.builder}: ${g.gap}`),
      ...reqs.openQuestions,
    ],
  }
}

// Every exit — stop, crash or clean finish — reaches the outcome record,
// the retry and learnings ledger, and the blocked-gate reducer. See
// finishRun() in the runtime block.
return await finishRun(runWorkflow, () => ({ findings: findingCounts, refutations, repairRounds }))
