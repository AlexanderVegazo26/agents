/**
 * Shared logic for the sdlc-suite pi extension (see ./index.js).
 *
 * What this file does
 * -------------------
 * Claude Code runs the suite's pipelines two ways this harness does not have
 * natively: `Agent(<name>)` sub-agent dispatch, and the `Workflow` tool, which
 * executes `sdlc-suite/workflows/*.js` inside a `node:vm` sandbox whose
 * globals are an explicit allowlist (agent, parallel, pipeline, workflow,
 * phase, log, args, budget, setTimeout, clearTimeout, console — no require,
 * process or fs; `Math.random()`, `Date.now()` and argless `new Date()`
 * replaced with throwers so resume stays deterministic).
 *
 * This module reproduces both for pi:
 *
 *  - `runAgent()` dispatches one sub-agent as a separate `pi -p` session.
 *    The role file's body is prepended to the brief; the session keeps pi's
 *    default system prompt (project context, skills, tools), which Claude
 *    Code's sub-agents also effectively have via the plugin. The agent
 *    frontmatter's `model:` is honored via `--model`; when that model is
 *    unavailable in the environment the run degrades to the default model
 *    and says so, rather than dying. `opts.effort` maps 1:1 onto pi's
 *    `--thinking` where the vocabularies overlap (low/medium/high).
 *
 *  - `runWorkflow()` loads a workflow script, extracts `export const meta`
 *    (a brace scan that respects string literals), wraps the remainder in an
 *    async IIFE — the scripts use top-level `await` and a top-level `return` —
 *    and runs it in a `node:vm` context carrying exactly the allowlisted
 *    globals, with the same throwers. `agent()` inside the sandbox is
 *    `runAgent()`, so every pipeline stage is a real, separate pi session.
 *
 *  - `resolveSuitePaths()` reproduces the command layer's `${CLAUDE_PLUGIN_ROOT}`
 *    expansion: the suite's relative `runtimeDir` / `policy` / `policyDefault`
 *    argument values are resolved against this repository before the script
 *    sees them. The scripts still validate shape (absolute only, no `..`),
 *    because that validation is what stops a consuming repo from pointing the
 *    runtime at a `_policy.js` the repo itself wrote.
 *
 * Degradation policy, everywhere: a failed dispatch returns `null` (the
 * scripts' own retry/breaker/reducer logic is built around exactly that),
 * never a plausible-looking substitute.
 *
 * Selftest
 * --------
 *     node .pi/extensions/sdlc/lib.js --selftest
 *
 * Runs under plain node (no pi, no network, no LLM): it imports ./index.js
 * (a load check for the whole extension), exercises the sandbox against a
 * synthetic workflow with a stubbed agent, and proves every check can fail.
 */

import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';

/**
 * stdio for nested `pi` runs. MUST be explicit pipes: Node >= 26 (observed on
 * v26.10.0) gives spawned children socketpair stdio — and it does so even
 * when `stdio: ['pipe','pipe','pipe']` (or `'pipe'`) is passed explicitly;
 * pi's print mode deadlocks on socket stdio (no model connection, no output,
 * 0% CPU) while the identical command with pipe stdio completes in seconds.
 * (Reproduced from python, node, and pi parents alike; pre-26 node and
 * python/bash parents default to pipes, which is why this only bit here.)
 *
 * On Node >= 26 the socket cannot be avoided through the `stdio` option, so
 * the nested pi is run under `script -qec` (util-linux): `script` allocates
 * a PTY for the child, and pi's print mode runs fine on a PTY. On older Node
 * we spawn directly with pipes. See the selftest for the pure helpers.
 */
const NESTED_STDIO = ['pipe', 'pipe', 'pipe'];
const commandCache = new Map();

/** Whether `cmd` is on PATH (cached; used once per process). */
export function commandExists(cmd) {
  if (commandCache.has(cmd)) return commandCache.get(cmd);
  let ok = false;
  try {
    const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    ok = r.status === 0;
  } catch { ok = false; }
  commandCache.set(cmd, ok);
  return ok;
}

/** True when this node runtime hands children socket stdio (needs the PTY route). */
export function nodeNeedsPtySpawn() {
  return parseInt(process.versions.node, 10) >= 26;
}

/**
 * Which transport a nested session must use — and whether spawning is
 * possible at all. Pure in its inputs (node major version, `script`
 * availability) so the selftest can exercise every branch on any runtime.
 *
 * Node >= 26 hands spawned children socketpair stdio even when an explicit
 * pipe is requested, and pi's print mode deadlocks on socket stdio (no
 * output, 0% CPU) — so there the PTY route is MANDATORY. Without `script`
 * (util-linux on Linux, built in on macOS) the direct route would not be a
 * fallback but a 15-minute hang per agent, so the route is refused with a
 * fixable message instead of silently burning the whole per-agent budget.
 */
export function resolveSpawnRoute(nodeMajor, hasScript) {
  if (nodeMajor < 26) return { route: 'direct' };
  if (hasScript) return { route: 'pty' };
  return {
    route: 'none',
    error:
      `node ${nodeMajor}+ hands spawned children socket stdio, which pi's print ` +
      `mode deadlocks on — the nested run needs the PTY route, which needs the ` +
      `"script" utility (util-linux on Linux) on PATH. Install it, or run pi ` +
      `under node < 26.`,
  };
}

/** Shell-token safety for values embedded in the static `script -c` command. */
export function isSafeShellToken(token) {
  return /^[A-Za-z0-9._\-/]+$/.test(String(token));
}

/** Strip CR (PTY line endings) and ANSI escapes from captured output. */
export function cleanOutput(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g, '');
}

/**
 * Build the `script` invocation that gives the nested pi a PTY. The shell
 * command is static apart from the validated extraArgs; the dynamic values
 * (binary path, prompt) go through the environment so nothing user-shaped
 * ever touches the shell.
 */
export function buildPtyInvocation(bin, extraArgs = []) {
  const safe = extraArgs.filter((a) => isSafeShellToken(a));
  const dropped = extraArgs.length - safe.length;
  const cmd = `exec "${"$PI_SDLC_BIN"}" -p --approve --no-session ${safe.join(' ')} "${"$PI_SDLC_PROMPT"}"`;
  return { file: 'script', args: ['-qec', cmd, '/dev/null'], dropped };
}
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Role files
// ---------------------------------------------------------------------------

/** Strip the `sdlc-suite:` plugin namespace (pi has no plugin namespaces). */
export function denamespace(text) {
  return String(text).split('sdlc-suite:').join('');
}

/** Split a markdown file into (naively parsed) frontmatter and body. */
export function stripFrontmatter(src) {
  const text = String(src);
  if (!text.startsWith('---\n')) return { frontmatter: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { frontmatter: {}, body: text };
  const frontmatter = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) frontmatter[m[1]] = m[2].trim();
  }
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  return { frontmatter, body };
}

/**
 * Resolve a suite agent name to its role file.
 *
 * Lookup: `.claude/agents/<name>.md` (the bare, de-namespaced tree), then
 * `sdlc-suite/agents/<name>.md` (canonical, de-namespaced at load). `null`
 * when the name is `general-purpose` (no role file) or nothing is found.
 */
export function resolveRole(anchor, name) {
  const bare = denamespace(name).trim();
  if (!bare || bare.includes('/') || bare.includes('..') || bare === 'general-purpose') return null;
  const candidates = [
    path.join(anchor, '.claude', 'agents', `${bare}.md`),
    path.join(anchor, 'sdlc-suite', 'agents', `${bare}.md`),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const { frontmatter, body } = stripFrontmatter(denamespace(readFileSync(p, 'utf8')));
    const model = frontmatter.model && frontmatter.model !== 'inherit' ? frontmatter.model : null;
    return { name: bare, systemPrompt: body, model, sourcePath: p };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Nested pi sessions
// ---------------------------------------------------------------------------

/** Locate the pi binary: $PI_BIN, the standard install, this process, PATH. */
export function findPiBinary() {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  const home = process.env.PI_HOME || path.join(os.homedir(), '.pi', 'agent');
  const std = path.join(home, 'bin', 'pi');
  if (existsSync(std)) return std;
  if (process.argv[1] && path.basename(process.argv[1]) === 'pi' && existsSync(process.argv[1])) {
    return process.argv[1];
  }
  return 'pi';
}

/** Default per-agent budget: 15 minutes. Override with $PI_SDLC_AGENT_TIMEOUT_MS. */
export function agentTimeoutMs(env = process.env) {
  const v = Number(env.PI_SDLC_AGENT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 15 * 60 * 1000;
}

/**
 * Run one print-mode pi session. Resolves (never rejects) with
 * { exitCode, stdout, stderr, timedOut, spawnError }.
 */
/** Debug logging, off unless $PI_SDLC_DEBUG is set. */
function dbg(...parts) {
  if (!process.env.PI_SDLC_DEBUG) return;
  try {
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
    try {
      import('node:fs').then((fs) => fs.appendFileSync('/tmp/sdlc-ext-debug.log', line)).catch(() => {});
    } catch { /* best effort */ }
  } catch { /* best effort */ }
}

/**
 * Environment for a nested session: the spawner's own session markers are
 * stripped so the child cannot attach to the parent's live session file
 * (it runs `--no-session`; the two are contradictory). Model/provider
 * markers are kept on purpose: they are how `model: inherit` stays
 * deterministic across the nesting.
 */
export function nestedSessionEnv(base = process.env) {
  const env = { ...base };
  const stripped = [];
  for (const key of Object.keys(env)) {
    if (key.startsWith('PI_SESSION') || key === 'PI_CODING_AGENT') {
      delete env[key];
      stripped.push(key);
    }
  }
  if (stripped.length) dbg('nestedSessionEnv', `stripped session markers: ${stripped.join(',')}`);
  return env;
}

export function spawnPi({ prompt, extraArgs = [], cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const bin = findPiBinary();
    const rt = resolveSpawnRoute(parseInt(process.versions.node, 10), commandExists('script'));
    if (rt.error) {
      dbg('spawnPi', `route=none — refusing to spawn: ${rt.error}`);
      resolve({ exitCode: 1, stdout: '', stderr: rt.error, timedOut: false, spawnError: true });
      return;
    }
    const usePty = rt.route === 'pty';
    let file;
    let args;
    let env;
    let droppedArgs = 0;
    if (usePty) {
      const inv = buildPtyInvocation(bin, extraArgs);
      droppedArgs = inv.dropped;
      file = inv.file;
      args = inv.args;
      env = { ...nestedSessionEnv(), PI_SDLC_BIN: bin, PI_SDLC_PROMPT: prompt, NO_COLOR: '1' };
    } else {
      file = bin;
      args = ['-p', '--approve', '--no-session', ...extraArgs, prompt];
      env = nestedSessionEnv();
    }
    let child;
    try {
      // detached: on the PTY route the child is a script+pi group we kill as
      // a whole on timeout; on the direct route it is a harmless no-op.
      child = spawn(file, args, { cwd, env, stdio: usePty ? ['ignore', 'pipe', 'pipe'] : NESTED_STDIO, detached: true });
    } catch (e) {
      resolve({ exitCode: -1, stdout: '', stderr: String(e), timedOut: false, spawnError: true });
      return;
    }
    const killTree = (sig) => {
      try { process.kill(-child.pid, sig); }
      catch { try { child.kill(sig); } catch { /* already dead */ } }
    };
    dbg('spawn', `route=${usePty ? 'pty' : 'direct'} file=${file} pid=${child.pid} cwd=${cwd} promptLen=${prompt.length} extra=${JSON.stringify(extraArgs)} dropped=${droppedArgs}`);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let firstByte = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (!firstByte) { firstByte = true; dbg('first-stdout', `pid=${child.pid} after=${Date.now() - t0}ms len=${d.length}`); }
      stdout += d;
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      dbg('child-error', `pid=${child.pid} ${e.message}`);
      resolve({ exitCode: -1, stdout, stderr: stderr + String(e), timedOut: false, spawnError: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // PTY output arrives CRLF-terminated and possibly ANSI-colored; the
      // direct pipe route is left untouched.
      const out = usePty ? cleanOutput(stdout) : stdout;
      const err = usePty ? cleanOutput(stderr) : stderr;
      dbg('close', `pid=${child.pid} code=${code} after=${Date.now() - t0}ms stdoutLen=${out.length} stderrTail=${JSON.stringify(err.slice(-200))}`);
      resolve({ exitCode: code ?? -1, stdout: out, stderr: err, timedOut });
    });
  });
}

/** Parse a JSON object out of agent output (tolerating prose around it). */
export function parseJsonObject(text) {
  const t = String(text).trim();
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch { return null; }
  };
  const direct = tryParse(t);
  if (direct) return direct;
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return tryParse(t.slice(start, end + 1));
}

/**
 * Dispatch one sub-agent. Returns the result (string, or object when
 * `opts.schema` is set and the output parses), or `null` — the scripts'
 * retry/breaker logic is built around exactly that.
 *
 * `_spawn` is injectable so the selftest runs without pi or a model.
 */
export async function runAgent({ anchor, prompt, opts = {}, log = () => {}, timeoutMs = agentTimeoutMs(), _spawn = spawnPi }) {
  const label = String(opts.label || 'agent');
  const agentType = String(opts.agentType || 'general-purpose');
  const role = agentType === 'general-purpose' ? null : resolveRole(anchor, agentType);
  if (agentType !== 'general-purpose' && !role) {
    log(`${label}: unknown agent type "${agentType}" — no role file under .claude/agents/ or sdlc-suite/agents/; no result`);
    return null;
  }
  let full = prompt;
  if (role) {
    full = `ROLE — ${role.name} (from ${role.sourcePath}). You are this agent for this session; follow the role file exactly, including any output contract it states.\n--- ROLE FILE ---\n${role.systemPrompt}\n--- END ROLE FILE ---\n\nTASK:\n${prompt}`;
  }
  if (opts.schema) {
    full += `\n\nOUTPUT CONTRACT: Respond with ONLY a valid JSON object — no prose before or after, no markdown fences — that conforms exactly to this JSON schema:\n${JSON.stringify(opts.schema)}`;
  }
  const extra = [];
  if (role?.model) extra.push('--model', role.model);
  if (opts.effort && ['low', 'medium', 'high'].includes(opts.effort)) extra.push('--thinking', opts.effort);

  let run = await _spawn({ prompt: full, extraArgs: extra, cwd: anchor, timeoutMs });
  if (run.exitCode !== 0 && role?.model && /model/i.test(`${run.stderr}\n${run.stdout}`)) {
    log(`${label}: model "${role.model}" (from the agent file) is unavailable in this environment — retrying on the default model`);
    const i = extra.indexOf('--model');
    if (i >= 0) extra.splice(i, 2);
    run = await _spawn({ prompt: full, extraArgs: extra, cwd: anchor, timeoutMs });
  }
  if (run.spawnError) {
    log(`${label}: could not start a pi session — ${String(run.stderr).split('\n')[0]}`);
    return null;
  }
  if (run.timedOut) {
    log(`${label}: timed out after ${timeoutMs} ms — no result`);
    return null;
  }
  if (run.exitCode !== 0) {
    // Transport retry: the host runtime owns it. One identical retry — a
    // second different request is the scripts' job, not the host's.
    log(`${label}: pi session exited ${run.exitCode} — one transport retry`);
    await new Promise((r) => setTimeout(r, 2000));
    run = await _spawn({ prompt: full, extraArgs: extra, cwd: anchor, timeoutMs });
    if (run.timedOut) { log(`${label}: transport retry timed out — no result`); return null; }
    if (run.exitCode !== 0) {
      log(`${label}: pi session failed again (exit ${run.exitCode}) — no result`);
      return null;
    }
  }
  const text = String(run.stdout || '').trim();
  if (!text) {
    log(`${label}: empty output — no result`);
    return null;
  }
  if (!opts.schema) return text;
  const parsed = parseJsonObject(text);
  if (!parsed) {
    log(`${label}: output is not a JSON object — no result`);
    return null;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Workflow sandbox
// ---------------------------------------------------------------------------

/**
 * Extract `export const meta = { ... }` from the top of a workflow script.
 * Returns { metaExpr, rest } or null when the script does not begin with a
 * meta export (in which case it is not a suite workflow script, and the
 * caller says so rather than guessing).
 */
export function extractMeta(source) {
  const text = String(source);
  const m = text.match(/^\s*export\s+const\s+meta\s*=\s*/);
  if (!m) return null;
  const start = m[0].length;
  if (text[start] !== '{') return null;
  let depth = 0;
  let inStr = null;
  let i = start;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  return { metaExpr: text.slice(start, i + 1), rest: text.slice(i + 1) };
}

/**
 * Resolve the suite's relative path arguments against this repository —
 * pi's replacement for the command layer's `${CLAUDE_PLUGIN_ROOT}` expansion.
 * Only the three path-carrying keys, only values that are relative, free of
 * `${`, free of `..` and not protocol-relative. Everything else passes
 * through untouched; the scripts re-validate shape on their side.
 */
export function resolveSuitePaths(anchor, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out = { ...args };
  for (const key of ['runtimeDir', 'policyDefault', 'policy']) {
    const v = out[key];
    if (typeof v === 'string' && v && !path.isAbsolute(v) && !v.includes('${')
        && !v.includes('..') && !/^[\\/]{2}/.test(v)) {
      out[key] = path.resolve(anchor, v);
    }
  }
  return out;
}

/**
 * Build the sandbox context: exactly the allowlisted globals. `agent` is
 * supplied by the caller (bound to `runAgent`); `log`/`onUpdate` stream
 * progress to the parent session.
 */
export function makeSandbox({ args, log = () => {}, agent, onUpdate = null }) {
  const RealDate = Date;
  const sandboxMath = Object.create(Math);
  sandboxMath.random = () => {
    throw new Error('Math.random() is unavailable in the workflow sandbox — resume must stay deterministic');
  };
  const SandboxDate = class extends RealDate {
    constructor(...a) {
      if (a.length === 0) {
        throw new Error('argless new Date() is unavailable in the workflow sandbox — resume must stay deterministic');
      }
      super(...a);
    }
    static now() {
      throw new Error('Date.now() is unavailable in the workflow sandbox — resume must stay deterministic');
    }
  };
  let currentPhase = null;
  const emit = (line) => {
    try { if (typeof onUpdate === 'function') onUpdate({ content: [{ type: 'text', text: line }] }); } catch { /* best effort */ }
  };
  const sandboxLog = (msg) => {
    const line = `[${currentPhase || 'run'}] ${msg}`;
    log(line);
    emit(line);
  };
  return vm.createContext({
    agent: (prompt, opts) => agent({ prompt, opts }),
    parallel: async (items) => {
      if (!Array.isArray(items)) throw new Error('parallel() expects an array of thunks or promises');
      return Promise.all(items.map((t) => (typeof t === 'function' ? t() : t)));
    },
    // Streaming pipeline: each item flows through the stages on its own, no
    // barrier between stages, so a slow item never gates a fast one.
    pipeline: async (items, transform, cross) => {
      if (!Array.isArray(items)) throw new Error('pipeline() expects an array of items');
      return Promise.all(items.map(async (item, i) => {
        let r = typeof transform === 'function' ? await transform(item, i) : transform;
        if (typeof cross === 'function') r = await cross(r, item);
        return r;
      }));
    },
    workflow: {}, // present for allowlist parity; no shipped script uses it
    phase: (title) => { currentPhase = String(title); sandboxLog(`phase: ${title}`); },
    log: sandboxLog,
    args,
    budget: {}, // present for allowlist parity; no shipped script uses it
    setTimeout,
    clearTimeout,
    console: { log: sandboxLog, info: sandboxLog, warn: sandboxLog, error: sandboxLog, debug: () => {} },
    Date: SandboxDate,
    Math: sandboxMath,
  });
}

/**
 * Run one workflow script in the sandbox.
 *
 * Returns { ok: true, meta, result } or { ok: false, error, meta? }.
 * `agent` is `({ prompt, opts }) => Promise<value|null>`.
 */
export async function runWorkflow({ anchor, scriptPath, args, log = () => {}, agent, onUpdate = null }) {
  const abs = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(anchor, scriptPath);
  if (!existsSync(abs)) return { ok: false, error: `workflow script not found: ${scriptPath}` };
  const source = readFileSync(abs, 'utf8');
  const metaInfo = extractMeta(source);
  if (!metaInfo) {
    return { ok: false, error: `no "export const meta = {" at the top of ${scriptPath} — not a suite workflow script` };
  }
  let meta;
  try {
    meta = vm.runInNewContext(`(${metaInfo.metaExpr})`, {});
  } catch (e) {
    return { ok: false, error: `could not evaluate the meta export of ${scriptPath}: ${e.message}` };
  }
  const sandboxArgs = resolveSuitePaths(anchor, args);
  if (JSON.stringify(sandboxArgs) !== JSON.stringify(args ?? null)) {
    log(`resolved suite paths against ${anchor}: ${JSON.stringify(sandboxArgs)}`);
  }
  const context = makeSandbox({ args: sandboxArgs, log, agent, onUpdate });
  const wrapped = `(async () => {\n${metaInfo.rest}\n})()`;
  let script;
  try {
    script = new vm.Script(wrapped, { filename: scriptPath });
  } catch (e) {
    return { ok: false, meta, error: `syntax error in ${scriptPath}: ${e.message}` };
  }
  let promise;
  try {
    promise = script.runInContext(context);
  } catch (e) {
    return { ok: false, meta, error: `workflow crashed before its first await: ${e.message}` };
  }
  // Duck-typed: the promise is created in the vm realm, so a cross-realm
  // `instanceof Promise` against the host's Promise would be false.
  if (!promise || typeof promise.then !== 'function') {
    return { ok: false, meta, error: 'workflow script did not yield a promise' };
  }
  try {
    const result = await promise;
    return { ok: true, meta, result };
  } catch (e) {
    return { ok: false, meta, error: `workflow threw: ${e && e.message ? e.message : e}` };
  }
}

// ---------------------------------------------------------------------------
// Selftest — plain node, no pi, no network, no LLM
// ---------------------------------------------------------------------------

async function selftest() {
  const failures = [];
  const check = (name, cond, detail = '') => {
    if (cond) { console.log(`ok   ${name}`); }
    else { failures.push(name); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  };

  // 1. The whole extension loads under plain node (index.js imports lib.js).
  let indexOk = false;
  try {
    const mod = await import('./index.js');
    indexOk = typeof mod.default === 'function';
  } catch (e) {
    console.log(`     index.js import failed: ${e.message}`);
  }
  check('index.js imports and exports a factory', indexOk);

  // 2. extractMeta on a real workflow script.
  const real = path.resolve(HERE, '../../../sdlc-suite/workflows/release-readiness.js');
  const info = extractMeta(readFileSync(real, 'utf8'));
  check('extractMeta finds meta in release-readiness.js', Boolean(info && info.metaExpr.startsWith('{')));
  let realMeta = null;
  try { realMeta = vm.runInNewContext(`(${info.metaExpr})`, {}); } catch { /* reported below */ }
  check('meta evaluates to the right name', realMeta && realMeta.name === 'release-readiness');
  check('rest keeps the body', Boolean(info.rest.includes('finishRun')));

  // 3. extractMeta fails on a non-workflow (proven capable of failing).
  check('extractMeta rejects a script without meta', extractMeta('const x = 1\nreturn x') === null);
  check('extractMeta rejects a meta whose object never closes', extractMeta('export const meta = { name: \'x\'\nreturn 1') === null);

  // 4. Sandbox semantics against a synthetic workflow with a stubbed agent.
  const os2 = await import('node:os');
  const fs2 = await import('node:fs');
  const dir = fs2.mkdtempSync(path.join(os2.tmpdir(), 'sdlc-selftest-'));
  const scriptPath = path.join(dir, 'selftest-workflow.js');
  const scriptSrc = `export const meta = { name: 'selftest', description: 'd', whenToUse: 'w', phases: [{ title: 'P1', detail: 'x' }] }
const WORKFLOW = 'selftest'
const seq = []
const r1 = await agent('one', { label: 'a1', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } })
const par = await parallel(['x', 'y'].map(s => () => agent('two-' + s, { label: 'a-' + s })))
const pip = await pipeline([1, 2, 3],
  async (n) => { const v = await agent('pipe-' + n, { label: 'p' + n }); seq.push('t' + n); return v; },
  async (v, n) => { seq.push('c' + n); return v + n; })
let threwDate = false, threwRandom = false
try { Date.now() } catch (e) { threwDate = true }
try { Math.random() } catch (e) { threwRandom = true }
seq.push('max:' + Math.max(1, 2))
phase('Done')
log('selftest-log')
return { r1, par, pip, seq, threwDate, threwRandom, args: args, workflowIsObj: typeof workflow === 'object', budgetIsObj: typeof budget === 'object' }
`;
  fs2.writeFileSync(scriptPath, scriptSrc);
  const logs = [];
  const stubAgent = async ({ prompt, opts }) => {
    if (prompt.includes('fail')) return null;
    return opts && opts.schema ? { ok: true } : 'text-result';
  };
  const out = await runWorkflow({
    anchor: dir,
    scriptPath,
    args: { release: 'selftest', runtimeDir: 'sdlc-suite/workflows' },
    log: (l) => logs.push(l),
    agent: stubAgent,
  });
  check('synthetic workflow completes', out.ok, out.error || '');
  if (out.ok) {
    const r = out.result;
    check('schema agent returns the parsed object', r.r1 && r.r1.ok === true);
    check('parallel runs every thunk', Array.isArray(r.par) && r.par.length === 2 && r.par.every((v) => v === 'text-result'));
    check('pipeline returns per-item results', Array.isArray(r.pip) && r.pip.length === 3 && r.pip[0] === 'text-result1');
    check('pipeline has no barrier between stages', r.seq.indexOf('t2') > -1 && r.seq.indexOf('t2') < r.seq.indexOf('c1'), JSON.stringify(r.seq));
    check('Date.now() throws in the sandbox', r.threwDate === true);
    check('Math.random() throws in the sandbox', r.threwRandom === true);
    check('real Math survives (Math.max)', r.seq.includes('max:2'));
    check('phase() and log() stream to the parent', logs.some((l) => l.includes('phase: Done')) && logs.some((l) => l.includes('selftest-log')));
    check('meta came through', out.meta && out.meta.name === 'selftest' && Array.isArray(out.meta.phases));
    check('relative runtimeDir resolved against the anchor', r.args && typeof r.args.runtimeDir === 'string' && r.args.runtimeDir.endsWith('sdlc-suite/workflows') && (r.args.runtimeDir.startsWith('/') || /^[A-Za-z]:/.test(r.args.runtimeDir)), JSON.stringify(r.args));
    check('workflow and budget globals exist for parity', r.workflowIsObj === true && r.budgetIsObj === true);
  }

  // 5. A script that throws fails the run (proven capable of failing).
  const badPath = path.join(dir, 'bad.js');
  fs2.writeFileSync(badPath, 'export const meta = { name: "bad" }\nthrow new Error("boom")\n');
  const bad = await runWorkflow({ anchor: dir, scriptPath: badPath, args: {}, agent: stubAgent });
  check('a throwing script fails the run', bad.ok === false && /boom/.test(bad.error), bad.error || '');

  // 6. A missing script fails the run.
  const missing = await runWorkflow({ anchor: dir, scriptPath: 'nope.js', args: {}, agent: stubAgent });
  check('a missing script fails the run', missing.ok === false);

  // 7. runAgent: schema parse, empty output, transport retry, model fallback.
  const spawnCalls = [];
  const fakeSpawn = async ({ extraArgs = [] }) => {
    spawnCalls.push([...extraArgs]); // copy: runAgent may mutate its array on the model fallback
    if (spawnCalls.length === 1) return { exitCode: 1, stdout: '', stderr: 'no model matches pattern "sonnet"', timedOut: false };
    if (spawnCalls.length === 2) return { exitCode: 0, stdout: 'noise\n{"ok": true, "n": 3}\nnoise', timedOut: false };
    return { exitCode: 0, stdout: 'plain text', timedOut: false };
  };
  const v1 = await runAgent({
    anchor: dir, prompt: 'do it', opts: { label: 't1', agentType: 'x', schema: { type: 'object' } },
    log: () => {}, _spawn: fakeSpawn,
  });
  check('unknown agent type yields null', v1 === null);
  const roleDir = path.join(dir, 'sdlc-suite', 'agents');
  fs2.mkdirSync(roleDir, { recursive: true });
  fs2.writeFileSync(path.join(roleDir, 'tester.md'), '---\nname: tester\ndescription: t\nmodel: sonnet\n---\nbe a tester\n');
  spawnCalls.length = 0;
  const v2 = await runAgent({
    anchor: dir, prompt: 'do it', opts: { label: 't2', agentType: 'sdlc-suite:tester', schema: { type: 'object' } },
    log: () => {}, _spawn: fakeSpawn,
  });
  check('model fallback: first attempt uses --model sonnet', spawnCalls[0] && spawnCalls[0].includes('sonnet'));
  check('model fallback: retry drops --model', spawnCalls[1] && !spawnCalls[1].includes('sonnet'));
  check('schema output parses through prose', v2 && v2.ok === true && v2.n === 3);
  const v3 = await runAgent({
    anchor: dir, prompt: 'quiet', opts: { label: 't3', agentType: 'general-purpose' },
    log: () => {}, _spawn: async () => ({ exitCode: 0, stdout: '   \n', timedOut: false }),
  });
  check('empty output yields null', v3 === null);
  const v4 = await runAgent({
    anchor: dir, prompt: 'say hi', opts: { label: 't4', agentType: 'general-purpose' },
    log: () => {}, _spawn: async () => ({ exitCode: 0, stdout: 'hi', timedOut: false }),
  });
  check('plain output returns text', v4 === 'hi');

  // 8. resolveRole: bare tree preferred, canonical fallback, denamespace.
  const rr = resolveRole(dir, 'sdlc-suite:tester');
  check('resolveRole finds the canonical role', Boolean(rr && rr.model === 'sonnet' && rr.systemPrompt.includes('be a tester')));
  check('resolveRole strips the namespace', Boolean(rr && rr.name === 'tester'));
  const bareDir = path.join(dir, '.claude', 'agents');
  fs2.mkdirSync(bareDir, { recursive: true });
  fs2.writeFileSync(path.join(bareDir, 'tester.md'), '---\nname: tester\nmodel: inherit\n---\nbare body\n');
  const rr2 = resolveRole(dir, 'tester');
  check('resolveRole prefers the bare tree', Boolean(rr2 && rr2.systemPrompt.includes('bare body') && rr2.model === null));
  check('resolveRole returns null for general-purpose', resolveRole(dir, 'general-purpose') === null);
  check('resolveRole returns null for a missing agent', resolveRole(dir, 'no-such-agent') === null);
  check('resolveRole rejects traversal names', resolveRole(dir, '../etc/passwd') === null);

  // 9. denamespace and parseJsonObject basics.
  check('denamespace strips the plugin prefix', denamespace('use sdlc-suite:qa-runner now') === 'use qa-runner now');
  check('parseJsonObject handles prose around JSON', parseJsonObject('a\n{"a": 1}\nb') && parseJsonObject('a\n{"a": 1}\nb').a === 1);
  check('parseJsonObject rejects non-objects', parseJsonObject('[1,2]') === null && parseJsonObject('no json') === null);

  // 10. Nested-spawn helpers (Node >= 26 socket-stdio workaround).
  const envBase = { PI_SESSION_FILE: '/x/s.jsonl', PI_SESSION_ID: 'abc', PI_CODING_AGENT: 'true', PI_MODEL: 'qwen', PATH: '/bin' };
  const env1 = nestedSessionEnv(envBase);
  check('nestedSessionEnv strips session markers', env1.PI_SESSION_FILE === undefined && env1.PI_SESSION_ID === undefined && env1.PI_CODING_AGENT === undefined);
  check('nestedSessionEnv keeps model markers and PATH', env1.PI_MODEL === 'qwen' && env1.PATH === '/bin');
  check('isSafeShellToken accepts flag and value tokens', isSafeShellToken('--model') && isSafeShellToken('sonnet') && isSafeShellToken('qwen3.8-27b') && isSafeShellToken('high'));
  check('isSafeShellToken rejects shell metacharacters', !isSafeShellToken('a b') && !isSafeShellToken('$(rm -rf /)') && !isSafeShellToken('a;b') && !isSafeShellToken('a\n') && !isSafeShellToken(''));
  check('cleanOutput strips CRLF and ANSI', cleanOutput('PTY-OK\r\n') === 'PTY-OK\n' && cleanOutput('\x1b[31mred\x1b[0m line\r') === 'red line\n');
  const inv = buildPtyInvocation('/opt/pi/bin/pi', ['--model', 'sonnet', '--thinking', 'high']);
  check('buildPtyInvocation uses script with a static command', inv.file === 'script' && inv.args[0] === '-qec' && inv.args[2] === '/dev/null');
  check('buildPtyInvocation passes dynamic values via env', inv.args[1].includes('$PI_SDLC_BIN') && inv.args[1].includes('$PI_SDLC_PROMPT') && inv.args[1].includes('--model sonnet --thinking high'));
  const inv2 = buildPtyInvocation('/opt/pi/bin/pi', ['--model', 'a b; rm']);
  check('buildPtyInvocation drops unsafe tokens', inv2.dropped === 1 && !inv2.args[1].includes('rm') && !inv2.args[1].includes('a b'));
  check('nodeNeedsPtySpawn is a boolean', typeof nodeNeedsPtySpawn() === 'boolean');

  // Spawn-route decision: pure, so every branch is testable on any runtime.
  check('route: node < 26 is always direct', resolveSpawnRoute(20, true).route === 'direct' && resolveSpawnRoute(25, false).route === 'direct');
  check('route: node >= 26 with script is pty', resolveSpawnRoute(26, true).route === 'pty' && resolveSpawnRoute(99, true).route === 'pty');
  const noScript = resolveSpawnRoute(26, false);
  check('route: node >= 26 without script is refused', noScript.route === 'none' && typeof noScript.error === 'string');
  check('route: the refusal says what to fix', /script/.test(noScript.error) && /util-linux|node < 26/.test(noScript.error));

  fs2.rmSync(dir, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\n${failures.length} selftest failure(s): ${failures.join(', ')}`);
    return 1;
  }
  console.log('\nall sdlc extension selftest checks passed');
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    selftest().then((code) => process.exit(code)).catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
  } else {
    console.error('usage: node .pi/extensions/sdlc/lib.js --selftest');
    process.exit(2);
  }
}
