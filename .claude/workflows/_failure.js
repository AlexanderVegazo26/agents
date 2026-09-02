'use strict'

/**
 * Failure taxonomy, per-class retry policy, and a per-phase circuit breaker.
 *
 * Before this, the Python runner collapsed non-zero exit, a timeout, a missing
 * binary and a bare exception into one `AgentResult(success=False, error=<str>)`,
 * so callers could test only `.success`. Retries existed on one platform and only
 * for schema-conformance failures. There was no breaker anywhere.
 *
 * The concrete failure that motivates it: the CLI binary is missing, so all twelve
 * agents in a `sdlc-feature` run fail identically, each after its own 3600-second
 * timeout where applicable, and the run reports twelve independent failures with
 * no indication that one environmental fact caused all of them.
 *
 * The design rule is that the classes must differ in **strategy**, not just in
 * label. Retrying an auth failure three times is the textbook example of what is
 * not self-healing: the second attempt cannot differ from the first.
 */

/** @enum {string} */
const Failure = {
  TRANSIENT: 'transient',   // network, 429, 5xx           -> retry with backoff
  TOOL: 'tool',             // CLI missing, non-zero exit   -> retry once, then stop the phase
  AUTH: 'auth',             // 401/403, unauthenticated MCP -> NEVER retry; escalate now
  BAD_INPUT: 'bad_input',   // schema mismatch, unparseable -> retry with a rewritten prompt
  LOGIC: 'logic',           // self-contradiction, empty required field -> record and continue
  ENV_DRIFT: 'env_drift',   // cwd not a repo, missing scaffold, version mismatch -> stop the run
}

/**
 * Per-class policy.
 *
 * `maxAttempts` counts the FIRST attempt. `maxAttempts: 1` therefore means "never
 * retried" — that is the assertion that matters for AUTH, and the reason the test
 * asserts exactly 1 rather than "retries are bounded", which passes trivially
 * against code that retries three times.
 */
const POLICY = {
  [Failure.TRANSIENT]: {
    maxAttempts: 3, backoff: true, rewritePrompt: false,
    onExhausted: 'continue',
    strategyNext: 'wait and retry the identical request; the fault is on the other side',
  },
  [Failure.TOOL]: {
    maxAttempts: 2, backoff: false, rewritePrompt: false,
    onExhausted: 'stop-phase',
    strategyNext: 'retry once in case the binary or file appeared; then stop the phase',
  },
  [Failure.AUTH]: {
    maxAttempts: 1, backoff: false, rewritePrompt: false,
    onExhausted: 'escalate',
    strategyNext: 'do not retry — a second identical request cannot succeed; escalate',
  },
  [Failure.BAD_INPUT]: {
    maxAttempts: 3, backoff: false, rewritePrompt: true,
    onExhausted: 'continue',
    strategyNext: 'retry with the specific conformance failure named in the prompt',
  },
  [Failure.LOGIC]: {
    maxAttempts: 1, backoff: false, rewritePrompt: false,
    onExhausted: 'continue',
    strategyNext: 'no retry — the agent answered, the answer is unusable; record and continue',
  },
  [Failure.ENV_DRIFT]: {
    maxAttempts: 1, backoff: false, rewritePrompt: false,
    onExhausted: 'stop-run',
    strategyNext: 'no retry — the environment is wrong; stop the run and name what is missing',
  },
}

/** Three of the SAME class within one phase stops that phase. */
const BREAKER_THRESHOLD = 3

// Ordered most-specific first. AUTH before TRANSIENT deliberately: a 401 arriving
// over HTTP would otherwise be swallowed by a generic network pattern and retried
// three times, which is the exact behaviour the taxonomy exists to prevent.
const PATTERNS = [
  [Failure.AUTH, /\b(401|403)\b|unauthor[iz]|unauthenticated|forbidden|invalid[_ -]?api[_ -]?key|permission denied|not logged in|auth(?:entication)? (?:failed|required)|token (?:expired|invalid)/i],
  [Failure.ENV_DRIFT, /not a git repository|no such file or directory:\s*\.claude|missing scaffold|version mismatch|requires .* version|ENOTDIR|cwd .* does not exist/i],
  [Failure.BAD_INPUT, /schema|not valid json|unexpected token|json ?parse|failed to parse|did not conform|validation (?:failed|error)|missing required (?:field|property)/i],
  [Failure.TRANSIENT, /\b(429|5\d\d)\b|rate ?limit|too many requests|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|temporarily unavailable|overloaded|timed? ?out/i],
  [Failure.TOOL, /ENOENT|command not found|is not recognized|no such file or directory|exited? with (?:code )?(?:[1-9]|\d\d+)|cannot find module|permission denied \(publickey\)/i],
]

/**
 * Classify a failure from whatever the boundary produced.
 *
 * @param {{message?: string, stderr?: string, stdout?: string, code?: number,
 *          signal?: string, timedOut?: boolean}} info
 * @returns {string} one of Failure.*
 *
 * The fallback is TOOL, not TRANSIENT. Classification by string-matching CLI
 * output is brittle and will misclassify; when it does, retrying **once** is
 * safer than retrying three times, so the default is the conservative class.
 */
function classify(info = {}) {
  if (info.timedOut) return Failure.TRANSIENT

  const text = [info.message, info.stderr, info.stdout]
    .filter(v => typeof v === 'string' && v)
    .join('\n')

  for (const [cls, re] of PATTERNS) {
    if (re.test(text)) return cls
  }

  // 127 is "command not found" on POSIX shells and is unambiguous.
  if (info.code === 127) return Failure.TOOL
  return Failure.TOOL
}

/** Exponential backoff with full jitter. Deterministic when `rand` is supplied. */
function backoffMs(attempt, { base = 1000, cap = 30000, rand = Math.random } = {}) {
  const ceiling = Math.min(cap, base * 2 ** (attempt - 1))
  return Math.floor(rand() * ceiling)
}

function policyFor(cls) {
  return POLICY[cls] || POLICY[Failure.TOOL]
}

function shouldRetry(cls, attempt) {
  return attempt < policyFor(cls).maxAttempts
}

/**
 * Per-phase breaker.
 *
 * The trigger is per-CLASS on purpose: three `bad_input` failures across three
 * different agents is a prompt problem, and three `auth` failures is one
 * environmental fact. Counting them together would conflate two different
 * diagnoses into one useless number.
 */
class Breaker {
  constructor(threshold = BREAKER_THRESHOLD) {
    this.threshold = threshold
    this.counts = new Map()      // phase -> Map(class -> count)
    this.tripped = new Map()     // phase -> {class, count}
  }

  record(phase, cls) {
    if (!this.counts.has(phase)) this.counts.set(phase, new Map())
    const m = this.counts.get(phase)
    const n = (m.get(cls) || 0) + 1
    m.set(cls, n)
    if (n >= this.threshold && !this.tripped.has(phase)) {
      this.tripped.set(phase, { class: cls, count: n })
    }
    return n
  }

  isTripped(phase) {
    return this.tripped.has(phase)
  }

  trippedInfo(phase) {
    return this.tripped.get(phase) || null
  }

  /**
   * A tripped breaker rendered as a blocked-gate entry, so it flows through the
   * same escalation channel as an autonomy gate and cannot vanish from a run
   * whose other phases succeeded.
   */
  asBlockedEntry(phase) {
    const t = this.tripped.get(phase)
    if (!t) return null
    return {
      gate: `breaker.${t.class}`,
      actionWithheld: `the remaining agents in phase "${phase}"`,
      whyGated: `${t.count} consecutive ${t.class} failures in this phase — ` +
        (t.class === Failure.AUTH || t.class === Failure.ENV_DRIFT
          ? 'one environmental fact, not bad luck'
          : 'a systematic problem, not per-agent noise'),
      prepared: `phases that do not depend on "${phase}" continued; see failures.jsonl`,
      unblocks: `re-run phase "${phase}" once the ${t.class} cause is fixed`,
      authorizeBy: 'fix the underlying cause; the breaker is not an authorization gate',
    }
  }
}

/**
 * Run `fn` under the class's retry policy.
 *
 * @param {() => Promise<any>} fn                 receives ({attempt, previousFailure})
 * @param {object} opts
 * @param {string} opts.label
 * @param {string} opts.phase
 * @param {Breaker} [opts.breaker]
 * @param {(rec: object) => void} [opts.onFailure] usually `run.recordFailure`
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{ok: boolean, value?: any, class?: string, attempts: number, escalate?: boolean, stop?: string}>}
 */
async function withRetry(fn, opts) {
  const {
    label, phase, breaker = null, onFailure = () => {},
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    rand = Math.random,
  } = opts

  if (breaker && breaker.isTripped(phase)) {
    const t = breaker.trippedInfo(phase)
    return { ok: false, class: t.class, attempts: 0, skipped: true, stop: 'phase',
             detail: `phase breaker already tripped (${t.count} × ${t.class})` }
  }

  let attempt = 0
  let last = null
  for (;;) {
    attempt++
    try {
      const value = await fn({ attempt, previousFailure: last })
      return { ok: true, value, attempts: attempt }
    } catch (err) {
      const cls = err && err.failureClass ? err.failureClass : classify({
        message: err && err.message, stderr: err && err.stderr,
        stdout: err && err.stdout, code: err && err.code,
        timedOut: err && (err.timedOut || err.killed),
      })
      const pol = policyFor(cls)
      last = { class: cls, message: err && err.message ? err.message : String(err) }

      const willRetry = shouldRetry(cls, attempt)

      // The breaker counts CALLS THAT GAVE UP, not individual attempts.
      //
      // Counting attempts makes the two settings contradict each other: BAD_INPUT
      // is defined to retry three times, so a single agent exhausting its own
      // designed policy would trip a threshold-of-three breaker every time, and
      // the breaker would fire on the first failing agent rather than on the
      // third. The review's intent is explicit — "three BAD_INPUT failures across
      // three different agents is a prompt problem" — which is three exhausted
      // calls, not one agent's three attempts.
      const count = (!willRetry && breaker) ? breaker.record(phase, cls) : 0

      onFailure({
        label, phase, class: cls, attempt, of: pol.maxAttempts,
        detail: last.message,
        strategyNext: willRetry ? pol.strategyNext : `no further attempts — ${pol.onExhausted}`,
        breakerCount: count || undefined,
      })

      if (!willRetry) {
        return {
          ok: false, class: cls, attempts: attempt, detail: last.message,
          escalate: pol.onExhausted === 'escalate',
          stop: pol.onExhausted === 'stop-run' ? 'run'
              : pol.onExhausted === 'stop-phase' ? 'phase'
              : (breaker && breaker.isTripped(phase)) ? 'phase' : null,
        }
      }
      if (pol.backoff) await sleep(backoffMs(attempt, { rand }))
    }
  }
}

/**
 * Append the specific conformance failure to a prompt for a BAD_INPUT retry.
 * Generalises what the Command Code runner already did correctly for schema
 * failures, rather than rewriting it.
 */
function rewritePrompt(original, previousFailure) {
  if (!previousFailure) return original
  return `${original}

---
Your previous attempt failed to conform: ${previousFailure.message}
Return only the required structure. Do not restate this instruction.`
}

module.exports = {
  Failure, POLICY, BREAKER_THRESHOLD,
  classify, policyFor, shouldRetry, backoffMs, withRetry, rewritePrompt, Breaker,
}
