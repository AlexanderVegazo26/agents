// Motor fiscal: oráculo externo = ejemplo numérico de research/colombia-adecuacion.md §1.7
// (CD $100.000.000; A/I/U 8/5/10 % sobre CD). Los demás casos están calculados a mano.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../public/js/calc.js', import.meta.url), 'utf8'), ctx, { filename: 'calc.js' });
const C = ctx.OBCalc;
const policy = { adminBp: 800, contBp: 500, utilBp: 1000, method: 'aiu' };
// Fixture: un costo final exacto. Con IVA como costo (construcción) el precio ya debe traerlo (ivaIncluded true);
// con IVA descontable (venta/reparación) el precio se da sin IVA (ivaIncluded false). Así CD = cost en ambos casos.
const oneLine = (chapter, cost, ivaCost = true) => [{ chapter, qtyInstalled: 1, price: { unitPrice: cost, ivaIncluded: ivaCost } }];
const fiscal = (o = {}) => ({ regime: 'responsable', classes: {}, client: {}, city: 'Bogotá D. C.', ...o });

test('§1.7 construcción con utilidad pactada: IVA 1.900.000, total 124.900.000, retención 2 % 2.460.000, neto 122.440.000', () => {
  const t = C.totals(oneLine('03', 100000000), policy, fiscal({ classes: { '03': 'construccion' }, client: { renta: true } }));
  assert.equal(t.cd, 100000000);
  assert.equal(t.admin, 8000000);
  assert.equal(t.cont, 5000000);
  assert.equal(t.util, 10000000);
  assert.equal(t.subtotal, 123000000);
  assert.equal(t.iva, 1900000);
  assert.equal(t.total, 124900000);
  assert.equal(t.retenciones[0].amount, 2460000);
  assert.equal(t.neto, 122440000);
});

test('§1.7 reparación/suministro (base total): IVA 23.370.000, total 146.370.000', () => {
  const t = C.totals(oneLine('07', 100000000, false), policy, fiscal({ classes: { '07': 'venta' } }));
  assert.equal(t.iva, 23370000);
  assert.equal(t.total, 146370000);
  const r = C.totals(oneLine('03', 100000000, false), policy, fiscal({ classes: { '03': 'reparacion' } }));
  assert.equal(r.iva, 23370000);
});

test('presupuesto mixto: IVA por base y por capítulo, no una sola tarifa sobre todo', () => {
  const lines = [...oneLine('03', 10000000), ...oneLine('07', 5000000, false)];
  const t = C.totals(lines, policy, fiscal({ classes: { '03': 'construccion', '07': 'venta' } }));
  // 03: U = 1.000.000 → IVA 190.000. 07: subtotal 6.150.000 → IVA 1.168.500
  assert.equal(t.iva, 190000 + 1168500);
  assert.equal(t.ivaGroups.length, 2);
  assert.equal(t.total, 12300000 + 6150000 + 1358500);
});

test('no responsable: no factura IVA y el IVA de compras es costo', () => {
  const line = [{ chapter: '07', qtyInstalled: 1, price: { unitPrice: 1190, ivaIncluded: true } }];
  const t = C.totals(line, policy, fiscal({ regime: 'no_responsable', classes: { '07': 'venta' } }));
  assert.equal(t.cd, 1190);
  assert.equal(t.iva, 0);
});

test('precio «+IVA» bajo construcción: se le suma el IVA porque no es descontable', () => {
  const line = { chapter: '10', qtyInstalled: 1, price: { unitPrice: 950000, ivaIncluded: false } };
  assert.equal(C.lineCost(line, { regime: 'responsable', taxClass: 'construccion' }), 1130500);
  assert.equal(C.lineCost(line, { regime: 'responsable', taxClass: 'venta' }), 950000);
});

test('umbral 3.500 UVT ($183.309.000) para no responsables', () => {
  assert.equal(C.UVT_3500, 183309000);
  const below = C.totals(oneLine('03', 149000000), policy, fiscal({ regime: 'no_responsable', classes: { '03': 'construccion' } }));
  assert.equal(below.overNoRespThreshold, false); // 149M × 1,23 = 183.270.000
  const above = C.totals(oneLine('03', 149100000), policy, fiscal({ regime: 'no_responsable', classes: { '03': 'construccion' } }));
  assert.equal(above.overNoRespThreshold, true); // 183.393.000
  const resp = C.totals(oneLine('03', 200000000), policy, fiscal({ classes: { '03': 'construccion' } }));
  assert.equal(resp.overNoRespThreshold, false);
});

test('retenciones: SIMPLE no sufre retención en renta; reteIVA 15 % del IVA; base mínima', () => {
  const simple = C.totals(oneLine('03', 100000000), policy, fiscal({ regime: 'simple', classes: { '03': 'construccion' }, client: { renta: true, iva: true } }));
  assert.equal(simple.retenciones.length, 1);
  assert.equal(simple.retenciones[0].amount, 285000); // 15 % de 1.900.000
  assert.equal(simple.total, 124900000, 'las retenciones no cambian el total');
  const small = C.totals(oneLine('03', 400000), policy, fiscal({ classes: { '03': 'construccion' }, client: { renta: true } }));
  assert.equal(small.retenciones[0].amount, 0); // subtotal 492.000 < 10 UVT 523.740
});

test('reteICA solo en Bogotá y solo si el cliente es agente', () => {
  const b = C.totals(oneLine('03', 100000000), policy, fiscal({ classes: { '03': 'construccion' }, client: { ica: true } }));
  assert.equal(b.retenciones[0].amount, 934800); // 7,60 ‰ de 123.000.000
  const m = C.totals(oneLine('03', 100000000), policy, fiscal({ classes: { '03': 'construccion' }, client: { ica: true }, city: 'Medellín' }));
  assert.equal(m.retenciones.length, 0);
});

test('AIU sobre CD frente a margen sobre venta (100 al 20 %: 120 vs 125)', () => {
  assert.equal(C.priceFromCost(100, 2000, 'aiu'), 120);
  assert.equal(C.priceFromCost(100, 2000, 'margen'), 125);
  const m = C.totals(oneLine('07', 1000, false), { ...policy, method: 'margen' }, fiscal({ classes: { '07': 'venta' } }));
  assert.equal(m.subtotal, 1256); // base CD+A+I = 1130; 1130 / 0,9 = 1255,56 → 1256
  assert.equal(m.util, 126);
});

test('APU con recursos: un recurso sin precio deja la partida pendiente', () => {
  const line = { chapter: '02', resources: [{ qty: 2, price: { unitPrice: 2800, ivaIncluded: true } }, { qty: 1, price: null }] };
  assert.equal(C.lineCost(line, { regime: 'responsable', taxClass: 'construccion' }), null);
  assert.equal(C.priceStatus(line), 'pendiente');
  line.resources[1].price = { unitPrice: 500000, ivaIncluded: true, type: 'estimado' };
  assert.equal(C.lineCost(line, { regime: 'responsable', taxClass: 'construccion' }), 505600);
  assert.equal(C.priceStatus(line), 'estimado');
});

test('umbral 3.500 UVT: un contrato exactamente igual al tope ya exige inscripción («igual o superior»)', () => {
  const zero = { adminBp: 0, contBp: 0, utilBp: 0, method: 'aiu' };
  const eq = C.totals(oneLine('03', 183309000), zero, fiscal({ regime: 'no_responsable', classes: { '03': 'construccion' } }));
  assert.equal(eq.total, 183309000);
  assert.equal(eq.overNoRespThreshold, true);
  const below = C.totals(oneLine('03', 183308999), zero, fiscal({ regime: 'no_responsable', classes: { '03': 'construccion' } }));
  assert.equal(below.overNoRespThreshold, false);
});

test('A6: un capítulo sin clase fiscal no se suma ni rompe el cálculo: se reporta', () => {
  const t = C.totals(oneLine('99', 1000000), policy, fiscal({ classes: {} }));
  assert.deepEqual([...t.unclassified], ['99']);
  assert.equal(t.cd, 0);
  assert.equal(C.taxClassOf({ classes: { '03': 'inventada' } }, '03'), null);
  assert.equal(C.taxClassOf({ classes: { '03': 'construccion' } }, '03'), 'construccion');
});

test('no responsable con partidas sin precio: «podría superar» el tope, sin afirmar que lo supera', () => {
  const lines = [...oneLine('03', 1000000), { chapter: '03', qtyInstalled: 1, price: null }];
  const t = C.totals(lines, policy, fiscal({ regime: 'no_responsable', classes: { '03': 'construccion' } }));
  assert.equal(t.overNoRespThreshold, false);
  assert.equal(t.noRespMayExceed, true);
});
