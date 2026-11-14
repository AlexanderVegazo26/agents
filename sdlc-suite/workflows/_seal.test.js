'use strict'

/**
 * The sealed bridge's pure-JS SHA-256 and UTF-8 helpers, checked against
 * Node's own `crypto` and `Buffer`.
 *
 *     node sdlc-suite/workflows/_seal.test.js
 *
 * They live in the runtime block, which cannot be required — it runs top-level
 * bridge calls the moment it is evaluated. So the helper section is cut out of
 * `_runtime.block.js` by its first and last declarations and evaluated alone.
 * If those anchors move, this test fails loudly rather than testing nothing.
 */

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const src = fs.readFileSync(path.join(__dirname, '_runtime.block.js'), 'utf8')
const start = src.indexOf('const SHA256_K = [')
const end = src.indexOf('/**\n * Run `body`')
assert.ok(start > 0 && end > start, 'could not locate the seal helpers in _runtime.block.js')
const ctx = vm.createContext({})
vm.runInContext(`${src.slice(start, end)}\nthis.h = { sha256Hex, utf8Bytes, utf8Text, hexOf, bytesOfHex, xorStream }`, ctx)
const h = ctx.h

let passed = 0
function test(name, fn) {
  try { fn(); passed++; console.log(`  pass  ${name}`) }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1 }
}

const SAMPLES = [
  '', 'a', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), 'x'.repeat(10000),
  'acción — ñandú «comillas» €', '😀 emoji 🚀 and 𝄞', 'lone \ud800 high', 'lone \udc00 low', '  ', '\u0000nul',
  JSON.stringify({ plan: '# plan.md\n\n- step 1\n- step 2', n: 3 }),
]

test('utf8Bytes matches Buffer.from(s, "utf8") byte for byte', () => {
  for (const s of SAMPLES) {
    assert.deepStrictEqual(Array.from(h.utf8Bytes(s)), Array.from(Buffer.from(s, 'utf8')), JSON.stringify(s).slice(0, 40))
  }
})

test('utf8Text round-trips what Buffer decodes', () => {
  for (const s of SAMPLES) {
    const b = Buffer.from(s, 'utf8')
    assert.strictEqual(h.utf8Text(Uint8Array.from(b)), b.toString('utf8'), JSON.stringify(s).slice(0, 40))
  }
})

test('sha256Hex matches crypto on every padding boundary and on unicode', () => {
  for (const s of SAMPLES) {
    const b = Buffer.from(s, 'utf8')
    assert.strictEqual(h.sha256Hex(Uint8Array.from(b)), crypto.createHash('sha256').update(b).digest('hex'), `len ${b.length}`)
  }
})

test('sha256Hex matches crypto on 300 pseudo-random buffers', () => {
  let seed = 12345
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) & 255
  for (let n = 0; n < 300; n++) {
    const b = Buffer.alloc(n * 7 % 1500)
    for (let i = 0; i < b.length; i++) b[i] = rnd()
    assert.strictEqual(h.sha256Hex(Uint8Array.from(b)), crypto.createHash('sha256').update(b).digest('hex'))
  }
})

test('hexOf / bytesOfHex match Buffer hex both ways', () => {
  const b = Buffer.from('héllo 😀', 'utf8')
  assert.strictEqual(h.hexOf(Uint8Array.from(b)), b.toString('hex'))
  assert.deepStrictEqual(Array.from(h.bytesOfHex(b.toString('hex'))), Array.from(b))
})

test('xorStream matches the loader keystream and is its own inverse', () => {
  const nonce = 'run-1:policy:3'
  const xs = (buf, tag) => {
    const out = Buffer.alloc(buf.length)
    for (let i = 0, o = 0; o < buf.length; i++, o += 32) {
      const k = crypto.createHash('sha256').update(tag + ':' + nonce + ':' + i, 'utf8').digest()
      for (let j = 0; j < 32 && o + j < buf.length; j++) out[o + j] = buf[o + j] ^ k[j]
    }
    return out
  }
  for (const s of ['', 'x', 'proceed and record that', 'é😀'.repeat(50), 'z'.repeat(1000)]) {
    const b = Buffer.from(s, 'utf8')
    const mine = Buffer.from(h.xorStream(Uint8Array.from(b), 'out', nonce))
    assert.deepStrictEqual(mine, xs(b, 'out'))
    assert.deepStrictEqual(Buffer.from(h.xorStream(Uint8Array.from(mine), 'out', nonce)), b)
  }
})

test('scrambled output carries no readable text', () => {
  const plain = Buffer.from('AUTONOMY POLICY — resolved, proceed and record that you acted', 'utf8')
  const hex = Buffer.from(h.xorStream(Uint8Array.from(plain), 'out', 'n:1')).toString('hex')
  assert.ok(!hex.includes(plain.toString('hex').slice(0, 16)), 'the plain text survives in the scrambled hex')
})

console.log(`\n${passed} passed, exit ${process.exitCode || 0}`)
