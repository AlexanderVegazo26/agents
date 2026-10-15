// Exportación CSV: inyección de fórmulas y comillas (revisión de seguridad F1/F2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../public/js/csv.js', import.meta.url), 'utf8'), ctx, { filename: 'csv.js' });
const { OBCsv } = ctx;
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const LEADERS = ['=', '+', '-', '@'];

/** Un lector que use cualquier separador no debe encontrar ningún segmento que empiece por un iniciador de fórmula. */
function assertSafe(out) {
  const inner = out.startsWith('"') ? out.slice(1, -1).split('""').join('"') : out;
  const segments = inner.split(new RegExp('[,;' + TAB + CR + LF + ']'));
  for (const seg of segments) {
    let i = 0;
    // Un lector con otro delimitador puede consumir la comilla de apertura: también se salta.
    while (i < seg.length && (seg.charCodeAt(i) <= 32 || seg.charAt(i) === '"')) i++;
    assert.ok(!LEADERS.includes(seg.charAt(i)), 'segmento peligroso en ' + JSON.stringify(out) + ': ' + JSON.stringify(seg));
  }
}

test('«Cot 12,=1+1»: se cita y el segmento tras la coma queda neutralizado', () => {
  const out = OBCsv.cell('Cot 12,=1+1');
  assert.equal(out, '"Cot 12,\'=1+1"');
  assertSafe(out);
});

test('«TAB=1»: una celda que empieza por TAB se neutraliza y se cita', () => {
  const out = OBCsv.cell(TAB + '=1');
  assert.ok(out.startsWith('"\''), out);
  assertSafe(out);
});

test('«a CR =1+1»: el retorno de carro separa un segmento que también se neutraliza', () => {
  const out = OBCsv.cell('a' + CR + '=1+1');
  assert.equal(out, '"a' + CR + '\'=1+1"');
  assertSafe(out);
});

test('iniciadores tras espacios y comillas dobles', () => {
  for (const s of ['=SUM(A1)', '  +1', '@cmd', '-2+3', 'Fuente ; =HYPERLINK("x")', 'x,"=1+1"', '"@a', 'b;" -1']) assertSafe(OBCsv.cell(s));
  assert.equal(OBCsv.cell('dice "hola"'), '"dice ""hola"""');
  assert.equal(OBCsv.cell('texto normal'), 'texto normal');
});

test('los números se escriben sin alterar y la fila usa punto y coma', () => {
  assert.equal(OBCsv.cell(1234567), '1234567');
  assert.equal(OBCsv.row(['a', 1, '=x']), "a;1;'=x");
  const doc = OBCsv.document([['a'], ['b']]);
  assert.equal(doc.charCodeAt(0), 0xFEFF);
  assert.ok(doc.endsWith(CR + LF));
});
