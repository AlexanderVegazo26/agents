/**
 * Node half of the sdlc Hermes plugin.
 *
 *   node runner.mjs agent     < {"anchor", "name", "task"}
 *   node runner.mjs workflow  < {"anchor", "scriptPath", "args"}
 *   node runner.mjs --selftest
 *
 * Reads one JSON request on stdin, writes one JSON reply on stdout, streams
 * progress lines on stderr. The Python half (__init__.py) is only the Hermes
 * tool registration around this.
 *
 * Everything that is not Hermes-specific — role resolution, the dispatch
 * retry/null contract, the node:vm workflow sandbox and its determinism
 * throwers, suite-path resolution — is imported from the pi extension's
 * lib.js rather than copied, so the two harnesses cannot drift on the parts
 * the workflow scripts were measured against. What lives here is the one
 * thing that differs: how a nested session is spawned.
 *
 * Hand-maintained: the tree generator never writes or removes anything under
 * .hermes/plugins/.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The suite's own repository: the only place role files and workflow
 * scripts are read from. Never the session's working directory — a cloned
 * repository that ships its own `sdlc-suite/workflows/*.js` or
 * `.claude/agents/*.md` must not get them run (the vm sandbox is not a
 * security boundary) or treated as role instructions. */
export const SUITE_ROOT = path.resolve(HERE, '../../..');
const PI_LIB = path.join(SUITE_ROOT, '.pi', 'extensions', 'sdlc', 'lib.js');
// pathToFileURL: a bare absolute path is not an import specifier on Windows.
const sdlc = await import(pathToFileURL(PI_LIB).href);

/** Nesting bound. A role that dispatches roles is normal (orchestrator →
 * specialist → qa-runner); deeper is a model looping, and every level is a
 * full process. Together with MAX_PARALLEL this caps a run at
 * MAX_PARALLEL ** MAX_DEPTH live sessions. */
export const MAX_DEPTH = 3;
const DEPTH_VAR = 'HERMES_SDLC_DEPTH';

/** Concurrent nested sessions per runner: $HERMES_SDLC_MAX_PARALLEL, default 4.
 * Workflow `parallel()`/`pipeline()` have no cap of their own. */
export function maxParallel(env = process.env) {
  const n = parseInt(env.HERMES_SDLC_MAX_PARALLEL || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

export function currentDepth(env = process.env) {
  const n = parseInt(env[DEPTH_VAR] || '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Locate hermes: $HERMES_BIN, the standard install, then PATH. */
export function findHermesBinary(env = process.env) {
  if (env.HERMES_BIN) return env.HERMES_BIN;
  const std = path.join(env.HOME || '', '.local', 'bin', 'hermes');
  return existsSync(std) ? std : 'hermes';
}

/**
 * Translate the pi CLI flags runAgent emits into hermes chat flags.
 *
 * `--model` is dropped: role files name Claude aliases (sonnet, opus, haiku)
 * that no Hermes provider resolves, and runAgent's model-unavailable retry
 * keys on the word "model" in the output, which a Hermes failure need not
 * contain — so passing it would turn a role with `model: sonnet` into a
 * failed dispatch instead of a run on the default model. `--thinking` maps to
 * `--reasoning` (both accept low/medium/high). Anything else is dropped.
 */
export function hermesArgs(extraArgs = []) {
  const out = [];
  const dropped = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const flag = extraArgs[i];
    const value = extraArgs[i + 1];
    if (flag === '--thinking' && value !== undefined) { out.push('--reasoning', value); i++; }
    else if (flag === '--model' && value !== undefined) { dropped.push(`--model ${value}`); i++; }
    else dropped.push(flag);
  }
  return { args: out, dropped };
}

/** Environment for a nested session. The parent's session and kanban-worker
 * identity are stripped: a nested `-Q` run that inherits HERMES_KANBAN_TASK
 * registers itself as that task's worker. */
export function nestedEnv(base = process.env, depth = 0) {
  const env = { ...base, [DEPTH_VAR]: String(depth + 1), NO_COLOR: '1' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('HERMES_SESSION') || key.startsWith('HERMES_KANBAN')) delete env[key];
  }
  return env;
}

/** Live nested sessions, so a cancelled or orphaned runner can take them
 * down: each is spawned detached (its own process group), so killing the
 * runner does not reach them. */
const LIVE = new Set();
/** Set once shutdown starts: runAgent's transport retry would otherwise
 * spawn a fresh session right after the old one was killed. */
let STOPPING = false;

function killGroup(child, sig) {
  try { process.kill(-child.pid, sig); }
  catch { try { child.kill(sig); } catch { /* already dead */ } }
}

export function killAll(sig) {
  for (const child of LIVE) killGroup(child, sig);
}

/**
 * Run one non-interactive `hermes chat` session. Same contract as pi's
 * spawnPi: resolves (never rejects) with
 * { exitCode, stdout, stderr, timedOut, spawnError }.
 *
 * The prompt travels on stdin (`--query-file -`), never argv: role files run
 * to 50 KB, and nothing in it is shell-interpreted. `-Q` leaves stdout as the
 * final response only; the session id goes to stderr.
 */
export function spawnHermes({ prompt, extraArgs = [], cwd, timeoutMs, log = () => {}, model = null, provider = null, toolsets = null }) {
  return new Promise((resolve) => {
    if (STOPPING) {
      resolve({ exitCode: 1, stdout: '', stderr: 'runner is shutting down', timedOut: false, spawnError: true });
      return;
    }
    const depth = currentDepth();
    if (depth >= MAX_DEPTH) {
      resolve({ exitCode: 1, stdout: '', stderr: `refusing to nest: already ${depth} sdlc sessions deep (limit ${MAX_DEPTH})`, timedOut: false, spawnError: true });
      return;
    }
    // `--model` from the role file is consumed by model routing (pickModel),
    // never passed through: it names a Claude alias no Hermes provider knows.
    const { args: mapped } = hermesArgs(extraArgs);
    const bin = findHermesBinary();
    const args = ['chat', '--query-file', '-', '-Q', ...mapped];
    if (model) args.push('-m', String(model));
    if (provider) args.push('--provider', String(provider));
    // An explicit list loads only the named toolsets (MCP servers included):
    // how a caller confines a role that reads untrusted input.
    if (toolsets) args.push('-t', String(toolsets));
    let child;
    try {
      child = spawn(bin, args, { cwd, env: nestedEnv(process.env, depth), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({ exitCode: -1, stdout: '', stderr: String(e), timedOut: false, spawnError: true });
      return;
    }
    LIVE.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      setTimeout(() => killGroup(child, 'SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => { /* child exited before reading; reported via close */ });
    child.on('error', (e) => {
      clearTimeout(timer);
      LIVE.delete(child);
      resolve({ exitCode: -1, stdout, stderr: stderr + String(e), timedOut: false, spawnError: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      LIVE.delete(child);
      if (code !== 0 && !timedOut) {
        // runAgent reports only the exit code; the reason is hermes's own.
        const last = sdlc.cleanOutput(stderr).trim().split('\n').filter((l) => !/^session_id:/.test(l)).pop();
        if (last) log(`hermes exited ${code}: ${last.slice(0, 300)}`);
      }
      resolve({ exitCode: code ?? -1, stdout: sdlc.cleanOutput(stdout), stderr: sdlc.cleanOutput(stderr), timedOut });
    });
    child.stdin.end(prompt);
  });
}

/** Roles whose single dispatch contains a whole run of other dispatches. */
export const ORCHESTRATING_ROLES = new Set(['orchestrator', 'journey-orchestrator']);

/**
 * Budget for one dispatch: $HERMES_SDLC_AGENT_TIMEOUT_MS (default pi's 15
 * minutes). An orchestrating role's one dispatch spans every specialist it
 * runs, so it gets $HERMES_SDLC_ORCHESTRATE_TIMEOUT_MS instead (default 2 h):
 * at 15 minutes the whole run would be killed and its findings lost.
 */
export function agentTimeoutMs(env = process.env, role = null) {
  const key = role && ORCHESTRATING_ROLES.has(sdlc.denamespace(role).trim())
    ? 'HERMES_SDLC_ORCHESTRATE_TIMEOUT_MS' : 'HERMES_SDLC_AGENT_TIMEOUT_MS';
  const v = Number(env[key]);
  if (Number.isFinite(v) && v > 0) return v;
  return key === 'HERMES_SDLC_AGENT_TIMEOUT_MS' ? sdlc.agentTimeoutMs({}) : 2 * 60 * 60 * 1000;
}

/** A counting semaphore around the spawner. */
export function limiter(max) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    if (active >= max) await new Promise((r) => waiting.push(r));
    active++;
    try { return await fn(); }
    finally { active--; const next = waiting.shift(); if (next) next(); }
  };
}

/**
 * Resolve a model-supplied scriptPath to a shipped workflow, or null.
 * Accepted: `sdlc-suite/workflows/<name>.js` (as the commands give it), a
 * bare `<name>.js`, or an absolute path — each only if its real path is a
 * runnable script directly inside this suite's `sdlc-suite/workflows/`
 * (no `_` shared modules, no tests). Symlinks are resolved before the check.
 */
export function resolveWorkflowScript(scriptPath, suiteRoot = SUITE_ROOT) {
  const raw = String(scriptPath || '').trim();
  if (!raw) return null;
  let dir;
  try { dir = realpathSync(path.join(suiteRoot, 'sdlc-suite', 'workflows')); } catch { return null; }
  const candidate = path.isAbsolute(raw)
    ? raw
    : (raw.includes('/') || raw.includes('\\') ? path.resolve(suiteRoot, raw) : path.join(dir, raw));
  let real;
  try { real = realpathSync(candidate); } catch { return null; }
  const base = path.basename(real);
  if (path.dirname(real) !== dir || !base.endsWith('.js') || base.startsWith('_') || base.endsWith('.test.js')) return null;
  return real;
}

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------

/**
 * Load the model catalog (see models.json). Returns { catalog } or
 * { error }; a missing path is not an error — routing is then off and every
 * session runs on the default model, as before routing existed.
 */
export function loadCatalog(file) {
  if (!file) return { catalog: null };
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { return { error: `model catalog ${file} is unreadable: ${e.message}` }; }
  const choices = raw && typeof raw.choices === 'object' && !Array.isArray(raw.choices) ? raw.choices : null;
  if (!choices || !Object.keys(choices).length) return { error: `model catalog ${file} has no "choices"` };
  for (const [name, c] of Object.entries(choices)) {
    if (!c || typeof c.model !== 'string' || !c.model) return { error: `model catalog ${file}: choice "${name}" has no "model"` };
    for (const fb of c.fallback || []) {
      if (!choices[fb]) return { error: `model catalog ${file}: choice "${name}" falls back to unknown "${fb}"` };
    }
    if (c.probe_key_env !== undefined && !(typeof c.probe_key_env === 'string' && PROBE_KEY_ENV_RE.test(c.probe_key_env))) {
      return { error: `model catalog ${file}: choice "${name}" has a probe_key_env that is not an environment variable name` };
    }
    if (c.probe_key_env !== undefined && c.probe && !isLoopbackUrl(c.probe)) {
      return { error: `model catalog ${file}: choice "${name}" sends a key (probe_key_env) to a probe that is not on loopback` };
    }
  }
  for (const [role, choice] of Object.entries(raw.roles || {})) {
    if (!choices[choice]) return { error: `model catalog ${file}: role "${role}" routes to unknown "${choice}"` };
  }
  for (const [alias, choice] of Object.entries(raw.role_model_aliases || {})) {
    if (!choices[choice]) return { error: `model catalog ${file}: alias "${alias}" routes to unknown "${choice}"` };
  }
  return { catalog: { choices, roles: raw.roles || {}, aliases: raw.role_model_aliases || {}, file } };
}

/** `probe_key_env` names an environment variable; the key itself never sits in the catalog. */
export const PROBE_KEY_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A keyed probe may only go to this machine: otherwise a JSON-only catalog
 * edit could send any environment variable (a bot or GitHub token) anywhere. */
export function isLoopbackUrl(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

/** Model ids a `/v1/models`-style reply lists: OpenAI `data[].id`,
 * llama.cpp/ollama `models[].name` / `.model`. */
export function listedModelIds(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const ids = new Set();
  for (const m of [...(Array.isArray(j?.data) ? j.data : []), ...(Array.isArray(j?.models) ? j.models : [])]) {
    for (const k of ['id', 'name', 'model']) if (typeof m?.[k] === 'string') ids.add(m[k]);
  }
  return ids;
}

/**
 * Is a choice's server up and serving its model? A choice without a `probe`
 * counts as available. `expect` must be an exact listed model id (a
 * non-JSON reply falls back to a substring match).
 *
 * Behind a proxy that loads on demand, such as LlamaStash, "listed" means
 * registered: the probe cannot tell whether the model will load. One that
 * is registered but fails to load still passes its probe, so its fallbacks
 * are not walked and the dispatch fails instead.
 *
 * `probe_key_env` sends `Authorization: Bearer $<that variable>` — for a
 * proxy such as LlamaStash, whose model list needs its API key. When the
 * variable is unset or empty the choice counts as down without a request:
 * the server would refuse it, and down is what routing has to act on.
 *
 * Only success is cached, and only for `ttlMs`: a single timeout on a busy
 * host must not mark a model down for the rest of an hour-long workflow,
 * and a server that went down must be noticed. In-flight probes are shared.
 */
export function makeProber(fetchFn = globalThis.fetch, timeoutMs = 2500, ttlMs = 60_000, now = () => performance.now(),
  env = process.env) {
  const ok = new Map();       // key -> time of last success
  const inflight = new Map(); // key -> Promise<boolean>
  const prober = (choice, { fresh = false } = {}) => {
    if (!choice.probe) return Promise.resolve(true);
    const key = `${choice.probe}\0${choice.expect || ''}\0${choice.probe_key_env || ''}`;
    if (!fresh && ok.has(key) && now() - ok.get(key) < ttlMs) return Promise.resolve(true);
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const init = { signal: AbortSignal.timeout(timeoutMs) };
      if (choice.probe_key_env) {
        const k = env[choice.probe_key_env];
        if (!k) return false;
        init.headers = { Authorization: `Bearer ${k}` };
      }
      try {
        const res = await fetchFn(choice.probe, init);
        if (!res.ok) return false;
        const text = await res.text();
        if (!choice.expect) return true;
        const ids = listedModelIds(text);
        return ids ? ids.has(choice.expect) : text.includes(choice.expect);
      } catch { return false; } // never log this error: a bad header value is echoed in it, key included
    })().then((up) => {
      inflight.delete(key);
      if (up) ok.set(key, now()); else ok.delete(key);
      return up;
    });
    inflight.set(key, p);
    return p;
  };
  return prober;
}

/**
 * Pick the model for one dispatch. Preference: the caller's explicit choice,
 * then the catalog's default for the role, then the role file's `model:`
 * alias (sonnet/opus/haiku) mapped through `role_model_aliases`, else the
 * session default. An unavailable choice walks its `fallback` list; if
 * nothing is up, the session default runs — and the route says why.
 *
 * Returns { choice, model, provider, why } — choice/model null = default.
 */
export async function pickModel({ catalog, explicit = null, role = null, roleModel = null, probe, fresh = false,
  catalogError = null }) {
  const none = (why) => ({ choice: null, model: null, provider: null, why });
  if (!catalog) return none(catalogError ? `model routing off — ${catalogError}` : 'no model catalog');
  // Workflows name roles `sdlc-suite:<role>`; the catalog keys are bare.
  role = role ? sdlc.denamespace(role).trim() : null;
  let start = null;
  let why = null;
  if (explicit) { start = explicit; why = 'chosen by caller'; }
  else if (role && catalog.roles[role]) { start = catalog.roles[role]; why = 'role default'; }
  else if (roleModel && catalog.aliases[roleModel]) { start = catalog.aliases[roleModel]; why = `role file model: ${roleModel}`; }
  if (!start) return none('no routing rule for this role');
  if (!catalog.choices[start]) return none(`catalog names unknown choice "${start}"`);
  const tried = [];
  for (const name of [start, ...(catalog.choices[start].fallback || [])]) {
    const c = catalog.choices[name];
    if (!c || tried.includes(name)) continue;
    tried.push(name);
    if (await probe(c, { fresh })) {
      const note = name === start ? why : `${why} was "${start}", unavailable — fell back`;
      return { choice: name, model: c.model, provider: c.provider || null, why: note };
    }
  }
  return none(`${tried.join(', ')} unavailable`);
}

/** Appended to every nested prompt, so a role running in a repository
 * without this suite's `.hermes.md` still knows how dispatch works here. */
export function harnessNote(catalog) {
  const lines = [
    '',
    'HARNESS NOTE (Hermes): to dispatch another suite role, call the `agent` tool (name, task, optional model).',
    'It may be deferred behind tool_search; call it through the tool_call bridge. Never write a dispatched',
    "role's answer yourself — a result counts only if it came back from an `agent` call.",
  ];
  if (catalog) {
    lines.push(`Model choices for \`model\`: ${Object.keys(catalog.choices).join(', ')} — see the tool description.`,
      'Omit `model` to use the role default; set it when the task is clearly harder or easier than the role usually is.');
  }
  return lines.join('\n');
}

/**
 * One sub-agent dispatch. Roles resolve from SUITE_ROOT (runAgent's anchor);
 * the nested session runs in the caller's working directory (`cwd`), which
 * is the project the work is about.
 */
function dispatcher(cwd, rawLog, { spawnFn = spawnHermes, gate = limiter(maxParallel()), catalog = null,
  probe = makeProber(), routes = [], catalogError = null, toolsets = null } = {}) {
  // runAgent's messages are pi's wording; the session here is hermes's, and
  // its "retrying on the default model" is not what happens here — the
  // retry re-routes through the catalog (below).
  const log = (l) => rawLog(String(l)
    .replace(/\bpi session\b/g, 'hermes session')
    .replace(/is unavailable in this environment — retrying on the default model/,
      'failed the run — retrying, with model availability re-checked'));
  return ({ prompt, opts }) => {
    const label = opts?.label || opts?.agentType || 'agent';
    // The route is decided on the first spawn. runAgent may spawn again (its
    // model retry, its transport retry); each retry re-probes without the
    // cache, so a server that died mid-run is replaced by its fallback
    // instead of being retried as-is.
    let route = null;
    let attempt = 0;
    let roleModel = null;
    return sdlc.runAgent({
      anchor: SUITE_ROOT,
      prompt: `${prompt}\n${harnessNote(catalog)}`,
      opts,
      log,
      timeoutMs: agentTimeoutMs(process.env, opts?.agentType || null),
      _spawn: async (req) => {
        attempt++;
        if (attempt === 1) {
          const ea = req.extraArgs || [];
          const i = ea.indexOf('--model');
          roleModel = i >= 0 ? ea[i + 1] : null;
        }
        const next = await pickModel({
          catalog, explicit: opts?.model || null, role: opts?.agentType || null, roleModel, probe,
          fresh: attempt > 1, catalogError,
        });
        if (!route || next.choice !== route.choice) {
          if (route) log(`${label}: re-routed on retry`);
          route = next;
          routes.push({ label, attempt, ...route });
          log(`${label}: model ${route.choice ? `${route.choice} (-m ${route.model})` : 'session default'} — ${route.why}`);
        }
        return gate(() => spawnFn({
          ...req, cwd, model: route.model, provider: route.provider, toolsets, log: (l) => log(`${label}: ${l}`),
        }));
      },
    });
  };
}

export async function handle(mode, req, log, deps = {}) {
  const cwd = path.resolve(String(req.anchor || process.cwd()));
  // spawn() reports a missing cwd as ENOENT on the *binary*, which misleads.
  if (!existsSync(cwd)) return { ok: false, error: `working directory does not exist: ${cwd}` };
  // An invalid catalog turns routing off — the Python half applies the same
  // rule and drops `model` from the schema — rather than failing every
  // dispatch. Every route then says why.
  const loaded = deps.catalog !== undefined ? { catalog: deps.catalog } : loadCatalog(req.catalog);
  if (loaded.error) log(`model routing off: ${loaded.error}`);
  const routes = [];
  deps = { ...deps, catalog: loaded.catalog || null, catalogError: loaded.error || null, routes };
  if (mode === 'agent') {
    const name = String(req.name || '').trim();
    const task = String(req.task || '');
    const model = req.model ? String(req.model).trim() : null;
    if (!name || !task.trim()) return { ok: false, error: '`name` and `task` are both required' };
    if (req.toolsets != null && !/^[a-z0-9_-]+(,[a-z0-9_-]+)*$/.test(String(req.toolsets))) {
      return { ok: false, error: `invalid toolsets "${req.toolsets}" (comma-separated toolset names)` };
    }
    if (req.toolsets) deps = { ...deps, toolsets: String(req.toolsets) };
    if (model && !(loaded.catalog && loaded.catalog.choices[model])) {
      const valid = loaded.catalog ? Object.keys(loaded.catalog.choices).join(', ') : 'none — no model catalog';
      return { ok: false, error: `unknown model choice "${model}" (valid: ${valid})` };
    }
    const value = await dispatcher(cwd, log, deps)({ prompt: task, opts: { label: name, agentType: name, model } });
    const route = routes[routes.length - 1] || null; // the route of the attempt that produced the result
    return value === null
      ? { ok: false, error: `agent "${name}" returned no result`, route }
      : { ok: true, result: value, route };
  }
  if (mode === 'workflow') {
    const script = resolveWorkflowScript(req.scriptPath);
    if (!script) {
      return { ok: false, error: `workflow script not found: ${req.scriptPath} — only the shipped scripts in ${path.join(SUITE_ROOT, 'sdlc-suite', 'workflows')} run` };
    }
    const out = await sdlc.runWorkflow({
      anchor: SUITE_ROOT, // relative runtimeDir/policy args are suite paths
      scriptPath: script,
      args: req.args ?? {},
      log,
      agent: dispatcher(cwd, log, deps),
    });
    return out.ok ? { ok: true, meta: out.meta, result: out.result, routes } : { ok: false, error: out.error, meta: out.meta, routes };
  }
  return { ok: false, error: `unknown mode "${mode}" (expected agent or workflow)` };
}

// ---------------------------------------------------------------------------
// Selftest — plain node, no hermes, no model
// ---------------------------------------------------------------------------

async function selftest() {
  const failures = [];
  const check = (name, cond, detail = '') => {
    if (cond) console.log(`ok   ${name}`);
    else { failures.push(name); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  };
  const os = await import('node:os');
  const fs = await import('node:fs');

  const m = hermesArgs(['--model', 'sonnet', '--thinking', 'high', '--approve']);
  check('hermesArgs maps --thinking to --reasoning', JSON.stringify(m.args) === '["--reasoning","high"]', JSON.stringify(m.args));
  check('hermesArgs drops --model and unknown flags', m.dropped.length === 2, JSON.stringify(m.dropped));

  check('depth defaults to 0', currentDepth({}) === 0);
  check('depth reads the env var', currentDepth({ [DEPTH_VAR]: '2' }) === 2);
  const saved = process.env[DEPTH_VAR];
  process.env[DEPTH_VAR] = String(MAX_DEPTH);
  const refused = await spawnHermes({ prompt: 'x', cwd: HERE, timeoutMs: 1000 });
  if (saved === undefined) delete process.env[DEPTH_VAR]; else process.env[DEPTH_VAR] = saved;
  check('spawnHermes refuses at the depth limit', refused.spawnError && /refusing to nest/.test(refused.stderr), refused.stderr);

  const env = nestedEnv({ HERMES_KANBAN_TASK: 't', HERMES_SESSION_KEY: 'k', KEEP: '1' }, 1);
  check('nestedEnv strips kanban/session identity and bumps depth',
    !('HERMES_KANBAN_TASK' in env) && !('HERMES_SESSION_KEY' in env) && env.KEEP === '1' && env[DEPTH_VAR] === '2');

  // The limiter never runs more than `max` at once.
  const gate = limiter(2);
  let live = 0; let peak = 0;
  await Promise.all([1, 2, 3, 4, 5].map(() => gate(async () => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 10));
    live--;
  })));
  check('limiter caps concurrency', peak === 2, `peak=${peak}`);

  // Workflow scripts: only shipped ones, never one from the session's repo.
  check('a shipped workflow resolves', Boolean(resolveWorkflowScript('sdlc-suite/workflows/release-readiness.js')));
  check('a bare workflow name resolves', Boolean(resolveWorkflowScript('release-readiness.js')));
  check('a shared module is refused', resolveWorkflowScript('sdlc-suite/workflows/_state.js') === null);
  check('a test file is refused', resolveWorkflowScript('sdlc-suite/workflows/_state.test.js') === null);
  check('traversal is refused', resolveWorkflowScript('sdlc-suite/workflows/../tools/init.mjs') === null);
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-foreign-'));
  fs.mkdirSync(path.join(foreign, 'sdlc-suite', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(foreign, '.claude', 'agents'), { recursive: true });
  const evil = path.join(foreign, 'sdlc-suite', 'workflows', 'release-readiness.js');
  fs.writeFileSync(evil, "export const meta = { name: 'evil' }\nreturn 'EVIL-RAN'\n");
  check('an absolute path into another repo is refused', resolveWorkflowScript(evil) === null);
  const wf = await handle('workflow', { anchor: foreign, scriptPath: 'sdlc-suite/workflows/evil-only.js' }, () => {});
  check('a script only the session repo has is refused', wf.ok === false && /not found/.test(wf.error), wf.error);

  // Roles: from the suite, even when the session's repo carries its own.
  fs.writeFileSync(path.join(foreign, '.claude', 'agents', 'code-reviewer.md'), '---\nname: code-reviewer\n---\nFOREIGN-ROLE-MARKER\n');
  let seen = null;
  const stub = async (req) => { seen = req; return { exitCode: 0, stdout: 'done', stderr: '', timedOut: false }; };
  const r = await handle('agent', { anchor: foreign, name: 'code-reviewer', task: 'TASK-MARKER' }, () => {}, { spawnFn: stub });
  check('a role dispatch succeeds', r.ok === true && r.result === 'done', JSON.stringify(r));
  check('the role body is the suite\'s, not the session repo\'s',
    Boolean(seen && seen.prompt.includes('ROLE — code-reviewer') && !seen.prompt.includes('FOREIGN-ROLE-MARKER')));
  check('the nested prompt carries the task', Boolean(seen && seen.prompt.includes('TASK-MARKER')));
  check('the nested session runs in the session\'s directory', Boolean(seen && path.resolve(seen.cwd) === path.resolve(foreign)), seen && seen.cwd);
  fs.rmSync(foreign, { recursive: true, force: true });

  const unknown = await handle('agent', { anchor: SUITE_ROOT, name: 'no-such-role', task: 'x' }, () => {}, { spawnFn: stub });
  check('an unknown role is a failure, not a guess', unknown.ok === false);

  // Model routing.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-cat-'));
  let tmpN = 0;
  const writeTmp = (obj) => { const f = path.join(tmpDir, `c${tmpN++}.json`); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
  const shipped = loadCatalog(path.join(HERE, 'models.json'));
  check('the shipped models.json loads', Boolean(shipped.catalog), shipped.error);
  const agentsDir = path.join(SUITE_ROOT, 'sdlc-suite', 'agents');
  const unknownRoles = Object.keys(shipped.catalog?.roles || {}).filter((r) => !existsSync(path.join(agentsDir, `${r}.md`)));
  check('every routed role exists', unknownRoles.length === 0, unknownRoles.join(','));
  const badRefs = Object.values(shipped.catalog?.roles || {}).filter((c) => !shipped.catalog.choices[c]);
  check('every role routes to a defined choice', badRefs.length === 0, badRefs.join(','));
  check('a catalog without choices is an error', Boolean(loadCatalog(path.join(HERE, 'plugin.yaml')).error));
  const cat = { choices: { fast: { model: 'f', fallback: ['deep'] }, deep: { model: 'd', provider: 'p', fallback: ['fast'] } },
    roles: { 'qa-runner': 'fast' }, aliases: { opus: 'deep' } };
  const up = (set) => async (c) => set.includes(c.model);
  let r1 = await pickModel({ catalog: cat, role: 'qa-runner', probe: up(['f', 'd']) });
  check('role default wins with no explicit choice', r1.choice === 'fast' && r1.why === 'role default', JSON.stringify(r1));
  r1 = await pickModel({ catalog: cat, explicit: 'deep', role: 'qa-runner', probe: up(['f', 'd']) });
  check('an explicit choice beats the role default', r1.choice === 'deep' && r1.provider === 'p', JSON.stringify(r1));
  r1 = await pickModel({ catalog: cat, role: 'other', roleModel: 'opus', probe: up(['f', 'd']) });
  check('the role file alias is the next rule', r1.choice === 'deep', JSON.stringify(r1));
  r1 = await pickModel({ catalog: cat, role: 'qa-runner', probe: up(['d']) });
  check('an unavailable choice falls back, and says so', r1.choice === 'deep' && /fell back/.test(r1.why), JSON.stringify(r1));
  r1 = await pickModel({ catalog: cat, role: 'qa-runner', probe: up([]) });
  check('nothing up means the session default', r1.choice === null && r1.model === null, JSON.stringify(r1));
  r1 = await pickModel({ catalog: null, role: 'qa-runner', probe: up([]) });
  check('no catalog means the session default', r1.choice === null);
  let probed = 0;
  const prober = makeProber(async () => { probed++; return { ok: true, text: async () => 'has-id' }; });
  const c1 = { probe: 'http://x/v1/models', expect: 'has-id' };
  check('the prober accepts a server that lists the model', await prober(c1));
  await prober(c1);
  check('probes are cached per runner', probed === 1, `probed=${probed}`);
  check('the prober rejects a server that does not list it', !(await makeProber(async () => ({ ok: true, text: async () => 'other' }))(c1)));
  check('the prober rejects an unreachable server', !(await makeProber(async () => { throw new Error('down'); })(c1)));

  r1 = await pickModel({ catalog: cat, role: 'sdlc-suite:qa-runner', probe: up(['f', 'd']) });
  check('a namespaced role (as workflows pass it) gets its role default', r1.choice === 'fast' && r1.why === 'role default', JSON.stringify(r1));
  check('a fallback to an unknown choice is a catalog error',
    /falls back to unknown/.test(loadCatalog(writeTmp({ choices: { a: { model: 'x', fallback: ['zz'] } } })).error || ''));
  check('a role routed to an unknown choice is a catalog error',
    /routes to unknown/.test(loadCatalog(writeTmp({ choices: { a: { model: 'x' } }, roles: { r: 'zz' } })).error || ''));
  check('orchestrating roles get the run-length budget',
    agentTimeoutMs({}, 'sdlc-suite:orchestrator') === 2 * 60 * 60 * 1000 && agentTimeoutMs({}, 'qa-runner') === 15 * 60 * 1000);
  check('exact model ids are matched, not substrings', (listedModelIds('{"data":[{"id":"mainline"}]}')?.has('main')) === false);
  // Failures are never cached; successes expire.
  let t = 0; let calls = 0; let upNow = false;
  const ttlProbe = makeProber(async () => { calls++; return { ok: true, text: async () => (upNow ? '{"data":[{"id":"m"}]}' : '{"data":[]}') }; }, 100, 1000, () => t);
  const pc = { probe: 'http://p', expect: 'm' };
  check('a down probe reports down', !(await ttlProbe(pc)));
  upNow = true;
  check('a failure is not cached (the next call probes again)', (await ttlProbe(pc)) && calls === 2, `calls=${calls}`);
  await ttlProbe(pc);
  check('a success is cached within its TTL', calls === 2, `calls=${calls}`);
  t = 2000; upNow = false;
  check('a cached success expires', !(await ttlProbe(pc)));
  // probe_key_env: the key travels as a Bearer header, read from the environment at probe time.
  const seenInit = [];
  const keyFetch = async (url, init) => { seenInit.push(init); return { ok: !!init.headers, text: async () => '{"data":[{"id":"m"}]}' }; };
  const kc = { probe: 'http://k/v1/models', expect: 'm', probe_key_env: 'SDLC_TEST_KEY' };
  check('a keyed probe sends the key as a Bearer header',
    (await makeProber(keyFetch, 100, 1000, () => 0, { SDLC_TEST_KEY: 's3cret' })(kc))
      && seenInit[0]?.headers?.Authorization === 'Bearer s3cret', JSON.stringify(seenInit[0]?.headers));
  seenInit.length = 0;
  check('a keyed probe with the variable unset is down and sends nothing',
    !(await makeProber(keyFetch, 100, 1000, () => 0, {})(kc)) && seenInit.length === 0, `requests=${seenInit.length}`);
  check('an unkeyed probe sends no Authorization header',
    (await makeProber(async (u, init) => ({ ok: !init.headers, text: async () => 'm' }), 100, 1000, () => 0, { SDLC_TEST_KEY: 'x' })(pc)));
  const keyed = makeProber(keyFetch, 100, 1000, () => 0, { SDLC_TEST_KEY: 'k' });
  await keyed(kc);
  check('a keyed success is not reused for the same probe under another key variable',
    !(await keyed({ probe: kc.probe, expect: 'm', probe_key_env: 'SDLC_UNSET_KEY' })));
  check('a probe_key_env that is not a variable name is a catalog error',
    /probe_key_env/.test(loadCatalog(writeTmp({ choices: { a: { model: 'x', probe_key_env: '$(cat /etc/passwd)' } } })).error || ''));
  check('a valid probe_key_env loads', !loadCatalog(writeTmp({ choices: { a: { model: 'x', probe_key_env: 'LLAMASTASH_API_KEY' } } })).error);
  check('a key is never sent to a probe off loopback',
    /not on loopback/.test(loadCatalog(writeTmp({ choices: { a: { model: 'x', probe: 'https://evil.example/v1/models', probe_key_env: 'GITHUB_TOKEN' } } })).error || ''));
  check('a loopback-looking subdomain is not loopback',
    /not on loopback/.test(loadCatalog(writeTmp({ choices: { a: { model: 'x', probe: 'http://127.0.0.1.evil.example/v1', probe_key_env: 'K' } } })).error || ''));
  check('keyed probes on 127.0.0.1, localhost and [::1] load', ['http://127.0.0.1:11435/v1/models', 'http://localhost:1/v1', 'http://[::1]:2/v1']
    .every((probe) => !loadCatalog(writeTmp({ choices: { a: { model: 'x', probe, probe_key_env: 'K' } } })).error));
  // A retry re-routes when the first choice died between attempts.
  let alive = ['f', 'd'];
  const seenModels = [];
  const flaky = async (req) => { seenModels.push(req.model); alive = ['d']; return seenModels.length === 1
    ? { exitCode: 1, stdout: '', stderr: 'boom', timedOut: false } : { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }; };
  const rr = await handle('agent', { anchor: SUITE_ROOT, name: 'qa-runner', task: 'T' }, () => {},
    { spawnFn: flaky, catalog: cat, probe: async (c) => alive.includes(c.model) });
  check('a retry re-routes to the fallback when the first model died',
    rr.ok && seenModels.join(',') === 'f,d' && rr.route?.choice === 'deep', `${seenModels} ${JSON.stringify(rr.route)}`);
  const offRes = await handle('agent', { anchor: SUITE_ROOT, name: 'qa-runner', task: 'T', catalog: writeTmp({ nope: 1 }) }, () => {},
    { spawnFn: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }) });
  check('an invalid catalog turns routing off instead of failing the dispatch',
    offRes.ok && offRes.route?.choice === null && /routing off/.test(offRes.route?.why || ''), JSON.stringify(offRes));

  // End to end through handle(): the explicit choice reaches the spawn as -m.
  let spawned = null;
  const spy = async (req) => { spawned = req; return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }; };
  const res = await handle('agent', { anchor: SUITE_ROOT, name: 'qa-runner', task: 'T', model: 'deep' }, () => {},
    { spawnFn: spy, catalog: cat, probe: up(['f', 'd']) });
  check('handle routes an explicit model to the spawn', res.ok && spawned?.model === 'd' && spawned?.provider === 'p' && res.route?.choice === 'deep', JSON.stringify(res));
  check('the nested prompt carries the harness note', Boolean(spawned?.prompt.includes('HARNESS NOTE (Hermes)')));
  const bogus = await handle('agent', { anchor: SUITE_ROOT, name: 'qa-runner', task: 'T', model: 'gpt-9' }, () => {},
    { spawnFn: spy, catalog: cat });
  check('an unknown model choice is refused before dispatch', bogus.ok === false && /unknown model choice/.test(bogus.error), bogus.error);

  console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall ok');
  process.exitCode = failures.length ? 1 : 0;
}

/** Stop every nested session, then exit: on SIGTERM/SIGINT/SIGHUP from the
 * plugin, and when the parent process disappears (re-parenting), since a
 * runner nobody will read must not keep dispatching sessions. */
function installShutdown() {
  const shutdown = (code) => {
    if (STOPPING) return;
    STOPPING = true;
    killAll('SIGTERM');
    setTimeout(() => { killAll('SIGKILL'); process.exit(code); }, 3000).unref();
    if (LIVE.size === 0) process.exit(code);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(143));
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) shutdown(1); }, 2000).unref();
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--selftest') return selftest();
  installShutdown();
  const raw = readFileSync(0, 'utf8');
  let req;
  try { req = JSON.parse(raw || '{}'); }
  catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: `bad request JSON: ${e.message}` })); return; }
  const log = (line) => { try { process.stderr.write(`${line}\n`); } catch { /* best effort */ } };
  let reply;
  try { reply = await handle(mode, req, log); }
  catch (e) { reply = { ok: false, error: `runner crashed: ${e && e.stack ? e.stack : e}` }; }
  process.stdout.write(JSON.stringify(reply, (k, v) => (typeof v === 'function' ? undefined : v)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
