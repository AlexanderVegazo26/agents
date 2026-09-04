#!/usr/bin/env node
// Syntax check for Workflow-tool scripts, via the host's own compile path.
//
//     node sdlc-suite/tools/syncheck.mjs <file-or-dir>...
//     node sdlc-suite/tools/syncheck.mjs --selftest
//
// Why this exists rather than `node --check`
// ------------------------------------------
// `node --check <file>.js` **exits 0 on a definitively broken workflow script**.
// Measured on Node v26.1.0 against the real `sdlc-feature.js`:
//
//     pristine (control, expect 0) ......... exit 0
//     last closing brace removed ........... exit 0   <-- broken, reported clean
//     top-level await appended ............. exit 0   <-- broken, reported clean
//     blatant garbage appended ............. exit 0   <-- broken, reported clean
//     unterminated string literal .......... exit 0   <-- broken, reported clean
//     unterminated block comment ........... exit 0   <-- broken, reported clean
//
// The mechanism, isolated against a known positive so the tool is not merely
// assumed broken:
//
//     [garbage only]      .js  -> exit 1   SyntaxError   (the tool does work)
//     [export + garbage]  .js  -> exit 0                 (ESM detection defers it)
//     [import + garbage]  .js  -> exit 0
//     [.mjs export + garbage]  -> exit 1   SyntaxError
//
// Every workflow script begins `export const meta = {`, so the ESM-detection
// path is taken for all of them and the check is inert for the entire set it was
// pointed at. It was wired into CI as the only syntax gate covering two trees.
//
// What this does instead
// ----------------------
// It reproduces what the Workflow tool actually does with the source: strips the
// `export` keyword from `export const meta`, wraps the body in an async IIFE, and
// compiles it with `new vm.Script`. That is the same transformation the host
// applies, so a file that compiles here is one the host can load — and a dropped
// brace fails, because it must.
//
// This checks SYNTAX only. Behaviour is `sdlc-suite/workflows/_wiring.test.js`,
// which executes each script inside a `node:vm` replica of the host sandbox.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import vm from 'node:vm'

/** The host's transformation, as observed in the shipped runtime. */
function hostForm(source) {
  const body = source.replace(/^\s*export\s+(const\s+meta\s*=)/m, '$1')
  return `(async () => {'use strict';\n${body}\n})()`
}

/**
 * Two dialects live under `workflows/`, and they need different checks:
 *
 *   - **Workflow-tool scripts** (`sdlc-suite/`, `.claude/`) begin
 *     `export const meta = {`, run under the host's `vm` context, and may use
 *     top-level `await` and a bare `return`. `node --check` is inert on these.
 *   - **CommonJS Node scripts** (`commandcode-suite/`) begin with a shebang and
 *     `'use strict'`, and are run directly with `node`. `node --check` DOES work
 *     on these — verified capable of failing — and the async-IIFE wrapper does
 *     not, because a shebang is not valid mid-source.
 *
 * Detecting rather than taking a flag means a file cannot be checked in the
 * wrong dialect by a caller who passed the wrong directory.
 */
function isWorkflowToolScript(source) {
  return /^\s*export\s+const\s+meta\s*=/m.test(source)
}

function checkSource(source, label) {
  const workflowTool = isWorkflowToolScript(source)
  // Strip a shebang before compiling: valid at byte 0 to the OS and to Node's
  // loader, but not to `vm.Script`.
  const src = source.replace(/^#![^\n]*\n/, '\n')
  try {
    new vm.Script(workflowTool ? hostForm(src) : src, { filename: label })
    return null
  } catch (e) {
    return `${e.name}: ${e.message}${workflowTool ? '' : '  [commonjs]'}`
  }
}

function collect(target) {
  const st = statSync(target)
  if (!st.isDirectory()) return [target]
  return readdirSync(target)
    .filter(n => extname(n) === '.js' && !n.endsWith('.test.js'))
    .sort()
    .map(n => join(target, n))
}

function selftest() {
  // The check must be shown capable of failing before any green result from it
  // is worth anything — and `node --check` is the cautionary example.
  const good = `export const meta = { name: 'x', description: 'y' }\nconst a = 1\nreturn { a }`
  const cases = [
    ['valid workflow (control, expect PASS)', good, false],
    ['dropped closing brace', `export const meta = { name: 'x'\nconst a = 1`, true],
    ['unterminated string', `export const meta = { name: 'x', description: 'y }`, true],
    ['unterminated block comment', `${good}\n/* never closed`, true],
    ['blatant garbage', `${good}\nfunction () { }`, true],
    ['stray closing paren', `${good}\n)`, true],
    // The CommonJS dialect must be covered too, and in ITS shape — a shebang
    // plus `require`, which the async-IIFE wrapper would reject as a false
    // positive if the dialect were not detected.
    ['valid commonjs with shebang (control, expect PASS)',
      "#!/usr/bin/env node\n'use strict'\nconst x = require('./_runner')\n", false],
    ['broken commonjs', "#!/usr/bin/env node\n'use strict'\nfunction () { }\n", true],
  ]
  let bad = 0
  for (const [name, src, shouldFail] of cases) {
    const err = checkSource(src, 'selftest.js')
    const ok = shouldFail ? err !== null : err === null
    if (!ok) bad++
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${err && !shouldFail ? ` — ${err}` : ''}`)
  }
  if (bad) {
    console.error(`\nFAIL: ${bad} selftest case(s) wrong — this checker cannot be trusted`)
    return 1
  }
  console.log(`\nOK: ${cases.length} selftest cases, the checker is capable of failing`)
  return 0
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest()

  const targets = argv.filter(a => !a.startsWith('--'))
  if (!targets.length) {
    console.error('usage: syncheck.mjs <file-or-dir>... | --selftest')
    return 2
  }

  const files = targets.flatMap(collect)
  if (!files.length) {
    // Zero files scanned looks identical to a clean run. It is not one.
    console.error(`FAIL: no .js files found under ${targets.join(', ')} — ` +
                  `the check has stopped checking anything`)
    return 2
  }

  let bad = 0
  for (const f of files) {
    const err = checkSource(readFileSync(f, 'utf8'), basename(f))
    if (err) {
      bad++
      console.error(`FAIL ${f}\n  ${err}`)
    }
  }
  if (bad) {
    console.error(`\nFAIL: ${bad} of ${files.length} workflow script(s) do not compile`)
    return 1
  }
  console.log(`OK: ${files.length} workflow script(s) compile via the host's own path`)
  return 0
}

process.exit(main(process.argv.slice(2)))
