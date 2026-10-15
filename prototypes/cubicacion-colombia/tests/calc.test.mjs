// Primitivas del motor de cálculo (migradas de la iteración 1).
// Retiradas por cambio deliberado de comportamiento (ver PROTOTYPE.md, «Cambios de la iteración 2»):
// ofertas ficticias de góndolas, opción fiscal única para todo el subtotal, piso con 8 % sin redondeo a cajas
// y el reparto proporcional por capítulos (la cotización ahora muestra el AIU desglosado).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../public/js/calc.js', import.meta.url), 'utf8'), ctx, { filename: 'calc.js' });
const C = ctx.OBCalc;

test('divRound: mitad hacia arriba y rechazo de entradas no enteras o negativas', () => {
  assert.equal(C.divRound(5, 2), 3);
  assert.equal(C.divRound(4, 3), 1);
  assert.throws(() => C.divRound(1.5, 2));
  assert.throws(() => C.divRound(-1, 2));
});

test('vigencia: publicado de hace 46 días vencido; de hace 17 días vigente; cotización vencida; sin precio pendiente', () => {
  assert.equal(C.priceStatus({ price: { type: 'publicado', date: '2026-08-30' } }, '2026-10-15'), 'vencido');
  assert.equal(C.priceStatus({ price: { type: 'publicado', date: '2026-09-28' } }, '2026-10-15'), 'publicado');
  assert.equal(C.priceStatus({ price: { type: 'cotizado', date: '2026-09-01', validUntil: '2026-10-05' } }, '2026-10-15'), 'vencido');
  assert.equal(C.priceStatus({ price: null }), 'pendiente');
});

test('IVA incluido con IVA descontable: base = precio / 1,19, una sola vez', () => {
  assert.equal(C.netUnit({ unitPrice: 4290000, ivaIncluded: true }), 3605042);
  assert.equal(C.costUnit({ unitPrice: 4290000, ivaIncluded: true }, true), 4290000);
});

test('constantes 2026 de la investigación: UVT, 3.500 UVT, 50 UVT', () => {
  assert.equal(C.UVT, 52374);
  assert.equal(C.UVT_3500, 183309000);
  assert.equal(C.UVT_50, 2618700);
});

test('N5: versión del motor y tarifa de IVA fijadas (cambiarlas exige actualizar esta prueba a propósito)', () => {
  assert.equal(C.ENGINE_VERSION, 'obrabase-calc i4 · UVT 2026 $52.374 · IVA 19 % · reglas research 2026-10-15');
  assert.equal(C.IVA_BP, 1900);
});

test('N1: estados distintos para la mano de obra del sistema, la estimación del emisor y el publicado registrado', () => {
  assert.equal(C.singleStatus({ type: 'estimado', date: '2026-10-15' }, '2026-10-15'), 'estimado');
  assert.equal(C.singleStatus({ type: 'estimado', manual: true, date: '2026-10-15' }, '2026-10-15'), 'emisor');
  assert.equal(C.singleStatus({ type: 'publicado', manual: true, date: '2026-10-10' }, '2026-10-15'), 'publicado_manual');
  assert.equal(C.singleStatus({ type: 'publicado', date: '2026-10-10' }, '2026-10-15'), 'publicado');
  const proxy = { resources: [{ kind: 'mano_obra', qty: 1, price: { type: 'estimado', unitPrice: 1 } }] };
  const lump = { resources: [{ kind: 'servicio', qty: 1, price: { type: 'estimado', manual: true, unitPrice: 1 } }] };
  const manualLabour = { resources: [{ kind: 'mano_obra', qty: 1, price: { type: 'estimado', manual: true, unitPrice: 1 } }] };
  assert.equal(C.hasLaborProxy(proxy), true);
  assert.equal(C.hasLaborProxy(lump), false);
  assert.equal(C.hasLaborProxy(manualLabour), false);
  assert.equal(C.priceStatus(lump), 'emisor');
});

test('N6/N7: el estado agregado no depende del orden de los recursos; el menos verificado manda', () => {
  const r = (price) => ({ kind: 'material', qty: 1, price });
  const pub = { type: 'publicado', date: '2026-10-15', unitPrice: 1 };
  const cot = { type: 'cotizado', manual: true, date: '2026-10-15', validUntil: '2026-11-30', unitPrice: 1 };
  const pubMan = { type: 'publicado', manual: true, date: '2026-10-15', unitPrice: 1 };
  const est = { type: 'estimado', date: '2026-10-15', unitPrice: 1 };
  const emi = { type: 'estimado', manual: true, date: '2026-10-15', unitPrice: 1 };
  const both = (a, b) => [C.priceStatus({ resources: [r(a), r(b)] }), C.priceStatus({ resources: [r(b), r(a)] })];
  assert.deepEqual(both(pub, cot), ['cotizacion_vigente', 'cotizacion_vigente']);
  assert.deepEqual(both(cot, pubMan), ['publicado_manual', 'publicado_manual']);
  assert.deepEqual(both(est, emi), ['estimado', 'estimado']);
});
