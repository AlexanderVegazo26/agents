// Integridad de datos reales y motor de cantidades paramétrico (iteración 3).
// Las pruebas de parámetros recalculan EN SITIO un conjunto de partidas existente (como hace la app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
for (const f of ['prices.js', 'calc.js', 'data.js']) {
  vm.runInContext(readFileSync(new URL('../public/js/' + f, import.meta.url), 'utf8'), ctx, { filename: f });
}
const { OBPrices: P, OBCalc: C, OBData: D } = ctx;

function project(over = {}) {
  const r = D.parseRequest(D.EXAMPLE_REQUEST);
  const fields = r.fields.map((x) => (x.key in over ? { ...x, value: over[x.key] } : x));
  D.refreshDerived(fields);
  const params = D.paramsFromFields(fields);
  return { r, fields, params, lines: D.generateLines(r.chapters, params) };
}
/** Cambia un parámetro como la app: el usuario lo fija (deja de ser derivado) y se recalcula en sitio. */
function setParam(pj, key, value) {
  const f = pj.fields.find((x) => x.key === key);
  f.value = value; f.status = 'confirmado'; f.derived = false;
  D.refreshDerived(pj.fields);
  pj.params = D.paramsFromFields(pj.fields);
  D.applyQuantities(pj.lines, pj.params);
}
const line = (pj, code) => pj.lines.find((l) => l.code === code);
const res = (l, key) => l.resources.find((r) => r.key === key);

// Proveedor y producto esperados de los ids con hash estable y de una muestra de skus (A7).
const EXPECTED = {
  hd43323b1a2: ['Industrias Cruz Hnos (Bogotá)', 'Góndola Tipo Enganche con 4 Niveles'],
  h323ee3677d: ['Lemor Productos y Diseños S.A.S', 'Góndola doble con cajón inferior'],
  h5189a10924: ['Industrias Cruz (industriascruzmr.com, Bogotá)', 'Mostrador Farmacia'],
  h2131b234ad: ['Masters Publicidad (Bogotá)', 'Aviso caja de luz para negocio en Bogotá - 300x90cm'],
  h0dbde08371: ['Diseños y Estructuras JH (Bogotá)', 'Puerta Ventana Corrediza en Aluminio y Vidrio — 2,00 x 2,10 m Serie 33'],
  876926: ['Homecenter', 'Piso Porcelánico Crystal Beige 60x60cm Caja 1.44 m2'],
  10001974: ['Vialambre (Bogotá)', 'Góndola Parmet De Pared 200*100*52 pintada'],
  CG120: ['Tecnoprocesos Colombia', 'Góndola de Pared para Farmacia 2150x1200x350 mm | 5 Niveles | Exhibición Abierta | Laterales Madecor'],
  3022989: ['Homecenter', 'Aire Acondicionado Panasonic 24.000 BTU Minisplit Inverter Cs-yu24akv-2 220 V Blanco']
};

test('cada opción referenciada existe con el proveedor y producto esperados; Imcolmedica excluido; solo https', () => {
  const src = readFileSync(new URL('../public/js/data.js', import.meta.url), 'utf8');
  const pj = project({ refrigeracion: 'si' });
  const ids = new Set(pj.lines.flatMap((l) => l.resources.flatMap((r) => r.options)));
  ids.add(D.LABOR_ID);
  for (const id of ids) assert.ok(P[id], 'falta el id ' + id);
  for (const id of Object.keys(D.OPT)) assert.ok(P[id], 'OPT referencia un id inexistente: ' + id);
  for (const [id, [prov, prod]] of Object.entries(EXPECTED)) {
    assert.ok(ids.has(String(id)), 'id esperado no referenciado: ' + id);
    assert.equal(P[id].proveedor, prov, id);
    assert.equal(P[id].producto, prod, id);
  }
  assert.ok(!/#\d+'/.test(src), 'no deben quedar ids posicionales item#fila');
  assert.ok(!Object.values(P).some((r) => /imcolmedica/i.test(r.proveedor) || /imcolmedica/i.test(r.url)));
  for (const r of Object.values(P)) {
    assert.ok(r.url === '' || r.url.startsWith('https://'), r.id);
    assert.ok(r.precio === null || Number.isInteger(r.precio), r.id);
  }
});

test('sin precios inventados: 01.01, 11.01, 11.02, volqueta y nevera quedan Pendiente', () => {
  const pj = project({ refrigeracion: 'si' });
  for (const code of ['01.01', '02.02', '11.01', '11.02', '08.01']) assert.equal(C.priceStatus(line(pj, code)), 'pendiente', code);
  for (const l of pj.lines) for (const r of l.resources) {
    if (r.price && r.price.type === 'publicado') assert.equal(r.price.unitPrice, P[r.chosen].precio, l.code + ' ' + r.key);
  }
});

test('mano de obra estimada: sin SKU ni URL comprables, rotulada como estimación interna (A8)', () => {
  const pj = project();
  const mo = res(line(pj, '03.05'), 'mo');
  assert.equal(mo.price.type, 'estimado');
  assert.equal(mo.price.sku, '');
  assert.equal(mo.price.url, '');
  assert.match(mo.price.source, /^Estimación interna \(referencia: Homecenter 310473/);
});

test('03.02 porcelanato a mano: 62 cajas = 89,28 m²; costo 6.516.836 (construcción, IVA como costo)', () => {
  const pj = project();
  const l = line(pj, '03.02');
  const porc = res(l, 'porcelanato');
  assert.equal(porc.chosen, '876926');
  assert.equal(porc.auto, true);
  assert.equal(porc.qty, 89.28);
  assert.match(porc.formula, /62 cajas/);
  assert.equal(C.lineCost(l, { regime: 'responsable', taxClass: 'construccion' }), 6516836);
});

test('A1: la opción automática se recalcula en sitio; la elección del usuario se conserva', () => {
  const pj = project();
  const l = line(pj, '03.02');
  assert.deepEqual(Object.keys(l.choices), [], 'la opción automática no se guarda como elección del usuario');
  setParam(pj, 'acabado', 'premium');
  assert.equal(res(l, 'porcelanato').chosen, '726543');
  setParam(pj, 'acabado', 'estandar');
  assert.equal(res(l, 'porcelanato').chosen, '876926');
  l.choices.porcelanato = '1358818';
  setParam(pj, 'acabado', 'premium');
  assert.equal(res(l, 'porcelanato').chosen, '1358818');
  assert.equal(res(l, 'porcelanato').auto, false);
});

test('A2: el área mueve en sitio las cantidades, los supuestos derivados, las góndolas y los recursos', () => {
  const pj = project();
  const before = Object.fromEntries(pj.lines.map((l) => [l.code, l.qtyInstalled]));
  const porcBefore = res(line(pj, '03.02'), 'porcelanato').qty;
  assert.equal(pj.params.mlEstanteria, 18);
  assert.equal(line(pj, '07.01').qtyInstalled, 15);
  setParam(pj, 'areaM2', 100);
  assert.equal(pj.params.mlEstanteria, 23); // 2 × (100 ÷ 8) − 2
  assert.equal(line(pj, '07.01').qtyInstalled, 19); // ⌊23 ÷ 1,2⌋ con el módulo de menor costo
  for (const code of ['02.01', '03.01', '03.02', '03.03', '03.04', '03.05', '04.02', '04.03', '07.01', '11.01']) {
    assert.ok(line(pj, code).qtyInstalled > before[code], code + ': ' + before[code] + ' → ' + line(pj, code).qtyInstalled);
  }
  assert.ok(res(line(pj, '03.02'), 'porcelanato').qty > porcBefore);
  // Un supuesto fijado por el usuario deja de derivarse.
  setParam(pj, 'mlEstanteria', 10);
  setParam(pj, 'areaM2', 300);
  assert.equal(pj.params.mlEstanteria, 10);
});

test('A2: tableros y aire acondicionado escalan con el área (700 m² → 31 circuitos, 3 tableros, 9 equipos)', () => {
  const pj = project();
  setParam(pj, 'areaM2', 700);
  const t = line(pj, '04.01');
  assert.equal(t.qtyInstalled, 3);
  assert.equal(res(t, 'tablero').qty, 3);
  assert.equal(res(t, 'breaker').qty, 22); // ⌈72÷8⌉ + ⌈117÷10⌉ + 1
  assert.equal(res(t, 'breaker_aa').qty, 9);
  assert.equal(line(pj, '05.01').qtyInstalled, 9);
  // N5: góndolas centrales derivadas del área: máx(1, ⌊700 ÷ 40⌋) = 17
  assert.equal(pj.params.gondolasCentrales, 17);
  assert.equal(line(pj, '07.02').qtyInstalled, 17);
  assert.equal(res(line(pj, '05.01'), 'instalacion').qty, 9);
});

test('A2: vanos y puertas son parámetros Supuesto editables que mueven pintura y guardaescoba', () => {
  const pj = project();
  assert.equal(pj.fields.find((x) => x.key === 'aberturasM2').status, 'supuesto');
  const paint = line(pj, '03.04').qtyInstalled, zoc = line(pj, '03.03').qtyInstalled;
  setParam(pj, 'aberturasM2', 20);
  setParam(pj, 'anchoAberturasM', 6);
  assert.equal(line(pj, '03.04').qtyInstalled, paint - 8);
  assert.equal(line(pj, '03.03').qtyInstalled, zoc - 2);
});

test('opciones que no cumplen o sin existencias nunca quedan elegidas por defecto', () => {
  const pj = project();
  for (const l of pj.lines) for (const r of l.resources) if (r.chosen) assert.ok(D.selectable(r.chosen), l.code + ' ' + r.key);
  for (const id of ['673481', '782461', 'h5189a10924', '775139']) assert.equal(D.selectable(id), false, id);
});

test('góndolas: el ancho del módulo elegido cambia la cantidad', () => {
  const pj = project();
  const g = line(pj, '07.01');
  g.choices.gondola = '10001974';
  D.applyQuantities([g], pj.params);
  assert.equal(g.qtyInstalled, 18);
  g.choices.gondola = 'CG120';
  D.applyQuantities([g], pj.params);
  assert.equal(g.qtyInstalled, 15);
});

test('porcelanato de Easy: la instalación pasa a estimación (514480 solo instala productos Homecenter)', () => {
  const pj = project();
  const l = line(pj, '03.02');
  l.choices.porcelanato = '1358818';
  D.applyQuantities([l], pj.params);
  assert.equal(res(l, 'instalacion').kind, 'mano_obra');
  assert.equal(res(l, 'instalacion').price.type, 'estimado');
});

test('A6: todo capítulo del catálogo tiene clase fiscal en cada estado del local', () => {
  for (const estado of Object.keys(D.ESTADOS)) {
    const classes = D.defaultTaxClasses(estado);
    for (const ch of Object.keys(D.CHAPTERS)) assert.ok(C.TAX_CLASSES[classes[ch]], estado + ' ' + ch);
  }
});

test('estado del local y acabado: parámetros que cambian partidas y productos', () => {
  const conAc = project({ estado: 'con_acabados' });
  assert.equal(line(conAc, '03.01').active, false);
  assert.ok(line(project({ estado: 'a_demoler' }), '02.03').active);
  assert.equal(D.defaultTaxClasses('con_acabados')['03'], 'reparacion');
  assert.equal(res(line(project({ acabado: 'premium' }), '03.02'), 'porcelanato').chosen, '726543');
});

test('intérprete: errores explicativos y evidencia', () => {
  assert.equal(D.parseRequest('hola').ok, false);
  assert.equal(D.parseRequest('Quiero abrir un negocio muy bonito en el centro de la ciudad').ok, false);
  const r = D.parseRequest(D.EXAMPLE_REQUEST);
  const area = r.fields.find((x) => x.key === 'areaM2');
  assert.equal(area.value, 80);
  assert.match(area.evidence, /80 m²/);
  assert.ok(r.exclusions[0].startsWith('Inventario inicial de medicamentos'));
});
