// Regresión (iteración 2): bajo contrato de construcción (IVA sobre la utilidad, art. 1.3.1.7.9 DUR 1625/2016)
// el IVA pagado en materiales NO es descontable (Oficio DIAN 1095/2022) y debe quedar como costo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../public/js/calc.js', import.meta.url), 'utf8'), ctx, { filename: 'calc.js' });
const C = ctx.OBCalc;

test('construcción + responsable: material con IVA incluido se costea con IVA (no se descuenta)', () => {
  const line = { chapter: '03', qtyInstalled: 1, price: { unitPrice: 1190, ivaIncluded: true } };
  assert.equal(C.lineCost(line, { regime: 'responsable', taxClass: 'construccion' }), 1190);
});

test('venta + responsable: el IVA de compra es descontable y se excluye del costo', () => {
  const line = { chapter: '07', qtyInstalled: 1, price: { unitPrice: 1190, ivaIncluded: true } };
  assert.equal(C.lineCost(line, { regime: 'responsable', taxClass: 'venta' }), 1000);
});
