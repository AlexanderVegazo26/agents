'use strict'
/**
 * Shared runner for commandcode-suite workflows.
 *
 * Drives the Command Code CLI headlessly (cmdc -p) one phase at a time:
 *  - resolves the real cmdc entry point (npm package bin via node, native exe, or CMDC_BIN)
 *  - inlines an agent definition from ../agents/<name>.md into the prompt
 *  - enforces a JSON output contract per phase (fail-closed: unparseable -> null)
 *  - provides parallel / pipeline / phase / log helpers mirroring the original suite
 *
 * The prompt is passed as a single argv element to a real executable (node/cli.js),
 * so multi-line prompts with embedded quotes need no shell escaping.
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const SUITE_ROOT = path.resolve(__dirname, '..')
const AGENTS_DIR = path.join(SUITE_ROOT, 'agents')

const DEFAULT_TIMEOUT_MS = Number(process.env.CMDC_AGENT_TIMEOUT_MS || 3600 * 1000)

// ---------------------------------------------------------------------------
// Logging — progress on stderr, report on stdout.
//
// The workflows print a machine-readable JSON report to stdout, and the
// commands/*.md launchers tell the consumer to parse it. Progress lines
// therefore must NOT share that stream: piping a workflow's stdout to a JSON
// parser failed, because the report was preceded by the [workflow] and
// === PHASE: === lines. Every progress write in this file goes to stderr;
// there should be no console.log here at all. See USAGE.md, 'Output streams'.
// ---------------------------------------------------------------------------
function log(msg) {
  console.error(`[workflow] ${msg}`)
}

function phase(name) {
  console.error(`\n=== PHASE: ${name} ===`)
}

// ---------------------------------------------------------------------------
// cmdc resolution — never rely on PATH shims that need a shell
// ---------------------------------------------------------------------------
let _cmdc = null

function resolveCmdc() {
  if (_cmdc) return _cmdc
  if (process.env.CMDC_BIN) {
    _cmdc = { cmd: process.env.CMDC_BIN, prefix: [] }
    return _cmdc
  }
  // Preferred: the installed command-code npm package -> node dist/bin path.
  const candidates = []
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'command-code'))
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'npm', 'node_modules', 'command-code'))
  candidates.push(path.resolve(SUITE_ROOT, '..', 'node_modules', 'command-code'))
  for (const dir of candidates) {
    const pkgPath = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgPath)) continue
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && (pkg.bin.cmdc || pkg.bin['command-code'])
      if (bin) {
        _cmdc = { cmd: process.execPath, prefix: [path.join(dir, bin)] }
        return _cmdc
      }
    } catch {
      /* try next candidate */
    }
  }
  // Fallback: plain cmdc on PATH (works when it is a native .exe).
  _cmdc = { cmd: 'cmdc', prefix: [] }
  return _cmdc
}

// ---------------------------------------------------------------------------
// Subprocess
// ---------------------------------------------------------------------------
function runCmdc(args, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd } = {}) {
  const { cmd, prefix } = resolveCmdc()
  return new Promise(resolve => {
    const child = spawn(cmd, [...prefix, ...args], {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    child.stdout.on('data', d => {
      out += d.toString()
    })
    child.stderr.on('data', d => {
      err += d.toString()
    })
    child.on('error', e => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: `spawn failed: ${e.message}` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

// ---------------------------------------------------------------------------
// JSON extraction — fail-closed
// ---------------------------------------------------------------------------
function extractJson(text) {
  if (!text) return null
  // fenced block first
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) {
    try {
      return JSON.parse(fence[1].trim())
    } catch {
      /* fall through */
    }
  }
  // last balanced {...} spanning lines
  const start = text.lastIndexOf('{')
  if (start !== -1) {
    let depth = 0
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Agent loading
// ---------------------------------------------------------------------------
function loadAgent(name) {
  if (name === 'general') {
    return 'You are a rigorous, evidence-disciplined analyst. You never inflate findings, you default to skepticism, and every claim you make must cite evidence you actually saw.'
  }
  const file = path.join(AGENTS_DIR, `${name}.md`)
  if (!fs.existsSync(file)) throw new Error(`Agent file not found: ${file}`)
  let text = fs.readFileSync(file, 'utf8')
  const m = text.match(/^---\s*\n[\s\S]*?\n---\s*\n?/)
  if (m) text = text.slice(m[0].length)
  return text.trim()
}

// ---------------------------------------------------------------------------
// Core: run one agent as a headless cmdc -p session
// ---------------------------------------------------------------------------
async function runAgent({ name, task, schema, effort, timeoutMs, cwd, extra, retries = 3 }) {
  const agentBody = loadAgent(name)
  const buildPrompt = (retryNote) => {
    const parts = [
      'You are operating as the following agent definition. Follow its system prompt exactly; its procedures, evidence standards, and stop conditions bind you.',
      '',
      '===== AGENT DEFINITION =====',
      agentBody,
      '===== END AGENT DEFINITION =====',
      '',
      '===== TASK =====',
      task,
    ]
    if (schema) {
      parts.push(
        '',
        '===== OUTPUT CONTRACT =====',
        'Respond with a SINGLE JSON object and NOTHING ELSE — no prose, no markdown fences, no trailing commentary, no keys outside the schema.',
        'The JSON object is the TOP-LEVEL envelope described by the schema. If the schema has a `required` field like "criteria", that key must be present at the TOP LEVEL of your response and its value must be an ARRAY of items, not a single item.',
        'The complete schema:',
        JSON.stringify(schema, null, 2),
      )
    } else {
      parts.push('', 'Respond as the agent would, following its own reporting format.')
    }
    if (retryNote) parts.push('', retryNote)
    if (extra) parts.push('', extra)
    return parts.join('\n')
  }

  const args = ['-p', '', '--permission-mode', 'auto-accept', '--skip-onboarding', '--max-turns', '200']
  if (effort) args.push('--effort', effort)
  const model = process.env.CMDC_MODEL
  if (model) args.push('--model', model)

  let lastReason = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    args[1] = buildPrompt(attempt > 1 ? `Note: a previous attempt produced output that did not conform to the output contract (${lastReason}). Re-read the schema carefully and return the TOP-LEVEL envelope exactly as specified.` : null)
    const res = await runCmdc(args, { timeoutMs, cwd })
    if (res.code !== 0 && !res.out) {
      log(`agent '${name}' exited ${res.code} with no output${res.err ? ` — ${res.err.slice(0, 300)}` : ''}`)
      return null
    }
    if (!schema) return res.out.trim() || null
    const json = extractJson(res.out)
    if (!json) {
      lastReason = 'output was not parseable JSON'
      log(`agent '${name}' returned unparseable output (${res.out.length} chars) — treated as null (fail-closed)${attempt < retries ? ', retrying' : ''}`)
      continue
    }
    // Structural guard: every required key named in the schema must exist at the
    // top level. If a required key's schema type is 'array' but the value is not
    // an array (e.g. the agent emitted a single item instead of the envelope),
    // fail loudly rather than passing a wrong-shaped object downstream.
    const required = Array.isArray(schema?.required) ? schema.required : []
    let shapeOk = true
    for (const key of required) {
      if (!(key in json)) {
        lastReason = `missing required top-level key '${key}'`
        log(`agent '${name}' output missing required top-level key '${key}' — treated as null (fail-closed)${attempt < retries ? ', retrying' : ''}`)
        shapeOk = false
        break
      }
      const propSchema = schema?.properties?.[key]
      if (propSchema?.type === 'array' && !Array.isArray(json[key])) {
        lastReason = `key '${key}' is not an array`
        log(`agent '${name}' output key '${key}' is not an array (got ${typeof json[key]}) — treated as null (fail-closed)${attempt < retries ? ', retrying' : ''}`)
        shapeOk = false
        break
      }
    }
    if (shapeOk) return json
  }
  return null
}

// ---------------------------------------------------------------------------
// Orchestration helpers
// ---------------------------------------------------------------------------
async function parallel(thunks) {
  return Promise.all(thunks.map(t => t()))
}

// Mirror of the original pipeline: for each item, run the lens, then refute
// its output. Returns one entry per item (the refutation result).
async function pipeline(items, lensFn, refuteFn) {
  const results = []
  for (const item of items) {
    const result = await lensFn(item)
    results.push(result ? await refuteFn(result, item) : [])
  }
  return results
}

// ---------------------------------------------------------------------------
// git — a real git subprocess.
//
// Deliberately NOT runCmdc: runCmdc spawns the `cmdc` LLM CLI, so handing it
// git arguments can never succeed. That was the defect here — the repository
// probe always failed, every build fell through to the caller's shared working
// tree, and it said so with a plausible "not a git repository" that nobody
// investigated. Isolation was inert while reporting a benign reason.
// ---------------------------------------------------------------------------
function runGit(args, cwd) {
  return spawnSync('git', args, {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  })
}

// ---------------------------------------------------------------------------
// Git worktree isolation for build phases (mirrors the original 'worktree'
// isolation).
//
// Contract: `fn(dir, { isolated })`. The second argument tells the caller
// whether isolation was real, so a phase artifact can record it rather than
// asserting it. Outside a git repository the helper degrades to the shared
// tree and says so; inside one, a failed `worktree add` THROWS rather than
// degrading, because concurrent builders sharing one tree is exactly the
// failure this helper exists to prevent.
// ---------------------------------------------------------------------------
async function withWorktree(fn, { cwd = process.cwd(), label = 'build' } = {}) {
  const probe = runGit(['rev-parse', '--is-inside-work-tree'], cwd)
  const isGit = probe.status === 0 && String(probe.stdout || '').trim() === 'true'
  if (!isGit) {
    log(`worktree isolation unavailable for ${label}: not a git repository (${cwd})`)
    const result = await fn(cwd, { isolated: false })
    return { ...result, worktreeDir: null, isolated: false, note: 'not a git repo — build ran in the current working tree; review the diff before merging' }
  }

  // Created only once isolation is actually going to be attempted, so neither
  // the degraded path nor the throw path leaks a temp directory.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdcode-suite-'))
  const worktreeDir = path.join(tmp, 'wt')
  const add = runGit(['worktree', 'add', '--detach', worktreeDir, 'HEAD'], cwd)
  if (add.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true })
    const why = String(add.stderr || '').trim() || (add.error && add.error.message) || `git exited ${add.status}`
    throw new Error(`worktree add failed for ${label}: ${why}`)
  }

  try {
    const result = await fn(worktreeDir, { isolated: true })
    return { ...result, worktreeDir, isolated: true }
  } finally {
    // NOTE: this destroys the worktree, so anything the callback WROTE to disk
    // is gone once withWorktree returns — only its return value survives.
    runGit(['worktree', 'remove', '--force', worktreeDir], cwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

module.exports = {
  SUITE_ROOT,
  AGENTS_DIR,
  log,
  phase,
  runAgent,
  runCmdc,
  runGit,
  loadAgent,
  parallel,
  pipeline,
  withWorktree,
  extractJson,
}
