'use strict'

/**
 * Run recorder: a directory per run, resume from the last complete phase, and an
 * outcome record written even when the run dies.
 *
 * Before this, no workflow in any tree wrote a file. A `sdlc-feature` run spawns
 * roughly twelve agents across five phases, and a failure in Verify discarded
 * Requirements, Design and Build — including the numbered acceptance criteria
 * every downstream agent traces against, and everything three builders wrote.
 * There was no way to resume, to inspect what an agent actually returned, or to
 * explain afterwards why a run produced what it did.
 *
 *     .claude/runs/20260902T141500Z-sdlc-feature-a3f1/
 *     ├── manifest.json                 phases, status, resumableFrom, agentVersions
 *     ├── phase-1-requirements.json
 *     ├── phase-2-design.json
 *     ├── failures.jsonl                append-only, one record per failed attempt
 *     └── outcome.json                  written at close
 *
 * Usage:
 *
 *     const { openRun } = require('./_state.js')
 *     const run = openRun({ workflow: 'sdlc-feature', args, resumeFrom: opts.resume })
 *     try {
 *       const reqs = run.resumed('Requirements') ?? await agent(...)
 *       run.completePhase('Requirements', { agents: [{ label: 'requirements', result: reqs }] })
 *       ...
 *     } finally {
 *       run.close({ findings, refutations, blockedGates })
 *     }
 *
 * Two failure directions, deliberately different
 * ----------------------------------------------
 * A failed **write** is logged and the run continues. Losing a run to a full disk
 * is worse than losing its record.
 *
 * A failed **read during resume** refuses to resume. A resume that quietly becomes
 * a fresh run is how someone loses three phases twice — and the second time they
 * are not watching, because the first one "worked".
 */

const fs = require('fs')
const path = require('path')

const RUNS_DIR_NAME = path.join('.claude', 'runs')

/** 20260902T141500Z — sortable, filesystem-safe, no separators to quote. */
function stamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** Four hex chars. Enough to disambiguate runs inside one second. */
function shortId() {
  return Math.random().toString(16).slice(2, 6).padEnd(4, '0')
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}

class Run {
  constructor(opts) {
    const {
      workflow,
      args = null,
      cwd = process.cwd(),
      platformVersion = null,
      workflowVersion = null,
      resumeFrom = null,
      now = new Date(),
      logger = console.error,
    } = opts

    this.workflow = workflow
    this.cwd = cwd
    this.log = logger
    this.runsRoot = path.join(cwd, RUNS_DIR_NAME)
    /** Write failures are recorded, not thrown. Surfaced in the outcome. */
    this.recordingErrors = []
    this.resumedPhases = new Set()
    this._cache = new Map()
    this._closed = false
    this._startMs = Date.now()

    if (resumeFrom) {
      // Fail closed. If the prior run cannot be read, we must NOT silently start
      // a fresh one — the caller asked to resume and is entitled to an error.
      const dir = path.isAbsolute(resumeFrom) ? resumeFrom : path.join(this.runsRoot, resumeFrom)
      let manifest
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
      } catch (e) {
        throw new Error(
          `cannot resume ${resumeFrom}: ${e.message}\n` +
          `Refusing to start a fresh run instead — re-run without --resume if that is what you want.`
        )
      }
      if (manifest.workflow !== workflow) {
        throw new Error(
          `cannot resume ${resumeFrom}: it is a "${manifest.workflow}" run, not "${workflow}"`
        )
      }
      this.dir = dir
      this.runId = manifest.runId
      this.manifest = manifest
      this.manifest.resumedAt = new Date().toISOString()
      for (const ph of manifest.phases || []) {
        if (ph.status !== 'complete' || !ph.artifact) continue
        let artifact
        try {
          artifact = JSON.parse(fs.readFileSync(path.join(dir, ph.artifact), 'utf8'))
        } catch (e) {
          // A manifest claiming a phase is complete while its artifact is
          // unreadable is exactly the case that must not degrade into a rerun.
          throw new Error(
            `cannot resume ${this.runId}: phase "${ph.title}" is marked complete but ` +
            `${ph.artifact} could not be read — ${e.message}`
          )
        }
        this._cache.set(ph.title, artifact)
        this.resumedPhases.add(ph.title)
      }
      this.log(
        `[run] resuming ${this.runId} — ${this.resumedPhases.size} phase(s) replayed from cache` +
        (manifest.resumableFrom ? `, re-executing from "${manifest.resumableFrom}"` : '')
      )
    } else {
      this.runId = `${stamp(now)}-${slug(workflow)}-${shortId()}`
      this.dir = path.join(this.runsRoot, this.runId)
      this.manifest = {
        runId: this.runId,
        workflow,
        workflowVersion,
        platformVersion,
        args: typeof args === 'string' ? args : args == null ? null : JSON.stringify(args),
        startedAt: now.toISOString(),
        phases: [],
        resumableFrom: null,
        agentVersions: {},
        status: 'running',
      }
      this._safeMkdir()
      this._writeManifest()
      this.log(`[run] ${this.runId} -> ${path.relative(cwd, this.dir)}`)
    }
  }

  // ----------------------------------------------------------------- writes

  _safeMkdir() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      return true
    } catch (e) {
      this._recordingFailed('mkdir', e)
      return false
    }
  }

  _recordingFailed(what, e) {
    const msg = `${what}: ${e.message}`
    this.recordingErrors.push(msg)
    // Loud, once per distinct failure — but never fatal.
    this.log(`[run] WARNING recording failed (${msg}); the run continues without a record`)
  }

  _writeJson(name, value) {
    try {
      fs.writeFileSync(path.join(this.dir, name), JSON.stringify(value, null, 2) + '\n', 'utf8')
      return true
    } catch (e) {
      this._recordingFailed(`write ${name}`, e)
      return false
    }
  }

  _writeManifest() {
    return this._writeJson('manifest.json', this.manifest)
  }

  // ------------------------------------------------------------------ phases

  /**
   * The cached artifact for a phase when resuming, else undefined.
   * Callers use `run.resumed(title) ?? await agent(...)`.
   */
  resumed(title) {
    return this._cache.get(title)
  }

  /** True when this phase came from cache rather than being executed. */
  wasResumed(title) {
    return this.resumedPhases.has(title)
  }

  /**
   * Record a completed phase and its artifact.
   * @param {string} title
   * @param {{agents?: Array<object>, [k: string]: unknown}} artifact
   */
  completePhase(title, artifact) {
    if (this.resumedPhases.has(title)) return artifact
    const index = this.manifest.phases.length + 1
    const file = `phase-${index}-${slug(title)}.json`
    const payload = {
      phase: title,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - (this._phaseStartMs || this._startMs),
      ...artifact,
    }
    this._writeJson(file, payload)
    this.manifest.phases.push({ title, status: 'complete', artifact: file })
    this.manifest.resumableFrom = null
    this._writeManifest()
    this._cache.set(title, payload)
    this._phaseStartMs = Date.now()
    return payload
  }

  /**
   * Mark a phase as started. On a crash, the manifest already names it as the
   * phase to resume from — which is the whole point of `resumableFrom`.
   */
  startPhase(title) {
    this._phaseStartMs = Date.now()
    if (this.resumedPhases.has(title)) return
    if (!this.manifest.phases.some(p => p.title === title)) {
      this.manifest.resumableFrom = title
      this._writeManifest()
    }
  }

  /** Record a phase that failed. Its title becomes `resumableFrom`. */
  failPhase(title, reason) {
    const existing = this.manifest.phases.find(p => p.title === title)
    if (existing) existing.status = 'failed'
    else this.manifest.phases.push({ title, status: 'failed', artifact: null, reason: String(reason) })
    this.manifest.resumableFrom = title
    this._writeManifest()
  }

  /** Append one failure record. `failures.jsonl` is append-only by design. */
  recordFailure(record) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n'
    try {
      fs.appendFileSync(path.join(this.dir, 'failures.jsonl'), line, 'utf8')
    } catch (e) {
      this._recordingFailed('append failures.jsonl', e)
    }
  }

  /** Read back every failure record. Used by `close()` to summarise by class. */
  readFailures() {
    try {
      return fs.readFileSync(path.join(this.dir, 'failures.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } })
        .filter(Boolean)
    } catch {
      return []
    }
  }

  noteAgentVersion(agent, version) {
    if (agent && version) this.manifest.agentVersions[agent] = version
  }

  // ------------------------------------------------------------------ close

  /**
   * Write `outcome.json` and finalise the manifest. Call from a `finally`.
   *
   * `status` distinguishes `completed`, `stopped` and `crashed`. A crashed run's
   * outcome is MORE informative than a successful one's, not less — so it is
   * written unconditionally, and with empty arrays rather than skipped when a run
   * produced no findings. "This lens found nothing on this kind of change" is a
   * signal the distiller reads.
   *
   * The file holds no free text from the target repository — only the agents' own
   * findings and reasoning. That is what keeps the redaction surface small.
   */
  close(summary = {}) {
    if (this._closed) return this.outcome
    this._closed = true

    const { status = 'completed', findings = null, refutations = [],
            blockedGates = [], error = null } = summary

    const failures = this.readFailures()
    const byClass = {}
    for (const f of failures) byClass[f.class || 'unknown'] = (byClass[f.class || 'unknown'] || 0) + 1

    const durationsMs = {}
    for (const ph of this.manifest.phases) {
      const a = this._cache.get(ph.title)
      if (a && typeof a.durationMs === 'number') durationsMs[ph.title] = a.durationMs
    }

    this.outcome = {
      runId: this.runId,
      workflow: this.workflow,
      status,
      startedAt: this.manifest.startedAt,
      endedAt: new Date().toISOString(),
      totalMs: Date.now() - this._startMs,
      phasesCompleted: this.manifest.phases.filter(p => p.status === 'complete').map(p => p.title),
      resumableFrom: this.manifest.resumableFrom,
      resumedPhases: [...this.resumedPhases],
      findings: findings || { confirmed: 0, refuted: 0, byLens: {} },
      refutations,
      blockedGates,
      failures: Object.entries(byClass).map(([cls, count]) => ({ class: cls, count })),
      durationsMs,
      // If the recorder itself could not write, say so in the record rather than
      // leaving a plausible-looking file that is quietly incomplete.
      recordingErrors: this.recordingErrors,
      error: error ? String(error && error.message ? error.message : error) : null,
    }

    this.manifest.status = status
    this.manifest.endedAt = this.outcome.endedAt
    this._writeManifest()
    this._writeJson('outcome.json', this.outcome)
    this.log(`[run] ${this.runId} ${status} — ${path.relative(this.cwd, this.dir)}`)
    return this.outcome
  }
}

function openRun(opts) {
  return new Run(opts)
}

/** List run directories, newest first. Used by `--prune-runs` and by the distiller. */
function listRuns(cwd = process.cwd()) {
  const root = path.join(cwd, RUNS_DIR_NAME)
  try {
    return fs.readdirSync(root)
      .filter(n => fs.statSync(path.join(root, n)).isDirectory())
      .sort().reverse()
      .map(n => ({ runId: n, dir: path.join(root, n) }))
  } catch {
    return []
  }
}

/**
 * Delete run directories older than `days`.
 *
 * Explicitly a command, never an automatic sweep: nothing should delete evidence
 * on its own, least of all the thing whose job is to preserve it.
 */
function pruneRuns(days, cwd = process.cwd()) {
  const cutoff = Date.now() - days * 86400_000
  const removed = []
  for (const { runId, dir } of listRuns(cwd)) {
    let started
    try {
      started = Date.parse(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).startedAt)
    } catch {
      continue   // unreadable manifest: leave it alone rather than guess its age
    }
    if (started < cutoff) {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(runId)
    }
  }
  return removed
}

module.exports = { openRun, listRuns, pruneRuns, RUNS_DIR_NAME }
