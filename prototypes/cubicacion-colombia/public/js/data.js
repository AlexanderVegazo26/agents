// @ts-check
// Datos de dominio del prototipo (iteración 2): catálogo de partidas como APU paramétricos
// construidos con PRECIOS REALES (public/js/prices.js, generado desde research/precios.json),
// reglas de cantidad visibles, requisitos de droguería e intérprete SIMULADO de solicitudes.
// Nunca se inventa un precio: lo que no tiene fuente queda Pendiente; la mano de obra sin precio
// publicado se ESTIMA con una tarifa real × un rendimiento supuesto, y se rotula como Estimado.
(function (root) {
  'use strict';
  var P = root.OBPrices || {};

  var CHAPTERS = {
    '01': 'Estudios y diseño',
    '02': 'Preliminares',
    '03': 'Obra civil y acabados',
    '04': 'Electricidad e iluminación',
    '05': 'Climatización',
    '07': 'Mobiliario comercial',
    '08': 'Equipamiento de farmacia',
    '09': 'Punto de venta',
    '10': 'Imagen comercial',
    '11': 'Entrega y cierre',
    '12': 'Seguridad humana y requisitos sanitarios',
    '13': 'Carpintería y fachada'
  };
  var OBRA = ['02', '03', '04', '11'];

  /** Clase fiscal propuesta por capítulo (el contador la confirma; research §1.2 y §6.1). */
  function defaultTaxClasses(estado) {
    var obra = estado === 'con_acabados' ? 'reparacion' : 'construccion';
    return { '01': 'honorarios', '02': obra, '03': obra, '04': obra, '11': obra,
      '05': 'venta', '07': 'venta', '08': 'venta', '09': 'venta', '10': 'venta', '12': 'venta', '13': 'venta' };
  }

  // Tarifa real de mano de obra usada para estimar (research §4.2): Homecenter 310473.
  var LABOR_ID = '310473';
  var LABOR_HOURS = 4;

  /**
   * Especificación y metadatos por opción. ok:false = no cumple la especificación; stock:false = sin
   * existencias; verify = dato a verificar (no bloquea). Las cifras vienen de las notas de precios.json.
   */
  var OPT = {
    '323995': { per: 15, perUnit: 'm²' }, '3000124': { per: 12, perUnit: 'm²' },
    '335145': { kgm2mm: 1.6, bag: 25 }, '1326979': { kgm2mm: 1.9, bag: 25 },
    '876926': { box: 1.44 }, '891934': { box: 1.44 }, '726543': { box: 1.8, premium: true }, '1358818': { box: 1.44 }, '1441091': { box: 1.44 },
    '3080326': { bag: 25, verify: 'La página dice «rendimiento de 5 m²/kg» (dato dudoso): se usa un rendimiento supuesto.' }, '1426398': { bag: 25 },
    '674008': { bag: 28 }, '1447403': { bag: 30 },
    '3056134': { gal: 5 }, '1269267': { gal: 5 }, '3056133': { gal: 1 }, '1208': { gal: 1 },
    '51755': { bag: 28 }, '1068746': { bag: 28 },
    '1044583': { ok: false, why: 'La página no indica cable THHN/THWN' },
    '673481': { ok: false, why: 'Potencia nominal 20 W según la ficha; se exige 40 W' },
    '1210860': { ok: false, why: 'Panel de sobreponer; se exige de incrustar en cielo raso' },
    '1419530': { verify: 'Autonomía no indicada en la página' },
    '775139': { stock: false, why: 'Página: «Producto sin stock disponible»' },
    '782461': { ok: false, why: '18.000 BTU: inferior a la capacidad exigida (24.000 BTU, sujeta a cálculo de carga térmica)' },
    '783314': { ok: false, why: '18.000 BTU: inferior a la capacidad exigida (24.000 BTU, sujeta a cálculo de carga térmica)' },
    '8806097837992': { ok: false, why: '18.000 BTU: inferior a la capacidad exigida (24.000 BTU, sujeta a cálculo de carga térmica)' },
    '10001974': { module: 1.0, verify: 'Envío no incluido' }, 'CG120': { module: 1.2 },
    'hd43323b1a2': { module: 1.0, verify: 'Dimensiones inconsistentes en la página (100 cm según la descripción)' }, '691162': { module: 1.2 },
    '1GOESU01': { verify: 'La página no dice explícitamente «central/doble cara»' },
    'h323ee3677d': { verify: 'Sin dimensiones ni fecha de vigencia en el catálogo' },
    'h5189a10924': { ok: false, why: 'Precio NO VERIFICADO: la página publica un rango $880.000–$1.635.000 sin indicar la variante' },
    '415856': { stock: false, why: 'Página: «Producto sin stock disponible»' },
    'SNH0013 1A-8': { ok: false, why: 'Agotado y «no recomendado para uso profesional»: no apto para registros sanitarios' },
    'kit_001temp': { stock: false, why: 'Página: «Sin existencias»' },
    '689566': { verify: 'Extintor de 20 lb (mayor capacidad que el de 10 lb)' },
    '696665': { ok: false, why: 'Servicio de instalación exclusivo para equipos Mabe' }
  };
  function meta(id) { return OPT[id] || {}; }

  function selectable(id) {
    var r = P[id], m = meta(id);
    return !!r && r.precio !== null && r.precio !== undefined && m.ok !== false && m.stock !== false;
  }
  function priceOf(id) {
    var r = P[id];
    if (!r || r.precio === null || r.precio === undefined) return null;
    return {
      type: r.iva === null ? 'referencia' : 'publicado', unitPrice: r.precio, ivaIncluded: r.iva,
      source: r.proveedor + ' · ' + r.producto, supplier: r.proveedor, sku: r.sku, url: r.url, date: r.fecha,
      unit: r.unidad, notes: r.notas, confidence: 'Precio publicado al consumidor'
    };
  }
  function laborPrice() {
    var r = P[LABOR_ID];
    return {
      type: 'estimado', unitPrice: Math.round(r.precio / LABOR_HOURS), ivaIncluded: r.iva,
      source: 'Estimación interna (referencia: Homecenter ' + LABOR_ID + ', $' + r.precio.toLocaleString('es-CO') + ' / ' + LABOR_HOURS + ' h) × rendimiento supuesto',
      supplier: 'Estimación interna', sku: '', url: '', reference: 'Homecenter ' + LABOR_ID + ' (' + r.producto + ')', date: r.fecha, unit: 'h',
      notes: 'Tarifa al consumidor para trabajos simples, no tarifa de obra por contrato (research §4.2). Rendimiento SUPUESTO, NO VERIFICADO.',
      confidence: 'Baja'
    };
  }

  function r2(x) { return Math.round(x * 100) / 100; }
  function f(x) { return String(r2(x)).replace('.', ','); }
  function ceil(x) { return Math.ceil(x - 1e-9); }

  function geometry(p) {
    var fondo = p.areaM2 / p.frenteM;
    var per = 2 * (p.frenteM + fondo);
    return { fondo: fondo, per: per };
  }

  // ---- Constructores de recursos ----
  // opt: recurso con opciones reales. q(meta, price) → { qty, formula }.
  function opt(ctx, key, label, kind, ids, q, extra) {
    var user = ctx.choices[key];
    var chosen = null, auto = true;
    var cands = ids.filter(selectable);
    if (user && ids.indexOf(user) >= 0 && selectable(user)) { chosen = user; auto = false; }
    else {
      if (ctx.premium && extra && extra.premiumPick) chosen = cands.filter(function (i) { return meta(i).premium; })[0];
      if (!chosen) {
        chosen = cands.slice().sort(function (a, b) {
          return q(meta(a), P[a]).qty * P[a].precio - q(meta(b), P[b]).qty * P[b].precio;
        })[0];
      }
    }
    var override = ctx.overrides[key];
    var res = { key: key, label: label, kind: kind, options: ids, chosen: chosen || null, auto: auto, note: extra && extra.note ? extra.note : '' };
    if (override) {
      res.price = override; res.qty = (extra && extra.manualQty) || q(meta(chosen), P[chosen] || {}).qty; res.formula = 'Precio registrado manualmente';
      return res;
    }
    if (!chosen) {
      res.price = null; res.qty = 0; res.formula = 'Ninguna opción cumple la especificación';
      res.pendingReason = 'Ninguna opción con precio real cumple la especificación';
      return res;
    }
    var qq = q(meta(chosen), P[chosen]);
    res.qty = qq.qty; res.unit = P[chosen].unidad; res.formula = qq.formula; res.price = priceOf(chosen);
    return res;
  }
  function labor(ctx, key, label, hours, formula, note) {
    var o = ctx.overrides[key];
    return { key: key, label: label, kind: 'mano_obra', options: [], chosen: null, qty: r2(hours), unit: 'h',
      formula: formula, price: o || laborPrice(), note: note || '' };
  }
  function pending(ctx, key, label, qty, unit, reason) {
    var o = ctx.overrides[key];
    return { key: key, label: label, kind: 'servicio', options: [], chosen: null, qty: qty, unit: unit,
      formula: f(qty) + ' ' + unit, price: o || null, pendingReason: reason, note: '' };
  }

  /**
   * Catálogo de partidas. qty(p) → cantidad instalada (unidad de la partida).
   * res(p, ctx, n) → recursos del APU para n unidades instaladas.
   */
  var TEMPLATES = [
    { code: '01.01', chapter: '01', desc: 'Levantamiento, diseño de distribución, planos y coordinación técnica', unit: 'gl', mandatory: true,
      qty: function () { return 1; }, qtyFormula: function () { return 'Global = 1'; },
      res: function (p, c) { return [pending(c, 'honorarios', 'Honorarios de diseño', 1, 'gl', 'Sin precio real en ninguna fuente consultada (research §4.2)')]; } },

    { code: '02.01', chapter: '02', desc: 'Protección de pisos y áreas de trabajo', unit: 'm²', mandatory: true,
      qty: function (p) { return r2(p.areaM2); }, qtyFormula: function (p) { return 'Área medida = ' + f(p.areaM2) + ' m²'; },
      res: function (p, c) {
        return [opt(c, 'proteccion', 'Material de protección', 'material', ['323995', '3000124'], function (m) {
          var n = ceil(p.areaM2 / m.per); return { qty: n, formula: '⌈' + f(p.areaM2) + ' m² ÷ ' + m.per + ' m² por rollo⌉ = ' + n + ' rollos' };
        })];
      } },

    { code: '02.02', chapter: '02', desc: 'Retiro de escombros y disposición autorizada', unit: 'gl', mandatory: true,
      qty: function () { return 1; }, qtyFormula: function (p) { return 'Global; volumen según estado del local (' + ESTADOS[p.estado] + ')'; },
      res: function (p, c) {
        var factor = p.estado === 'a_demoler' ? 3 : 1;
        var viajes = ceil(p.areaM2 * factor / 80);
        return [
          opt(c, 'lonas', 'Lonas para escombro', 'material', ['02341'], function () {
            var n = ceil(p.areaM2 * factor / 4); return { qty: n, formula: '⌈' + f(p.areaM2) + ' m² × ' + factor + ' ÷ 4 m² por lona⌉ = ' + n + ' lonas (supuesto)' };
          }, { note: 'Un solo proveedor encontrado.' }),
          pending(c, 'volqueta', 'Transporte y disposición autorizada (volqueta)', viajes, 'viaje', 'NO VERIFICADO: no hay tarifa pública 2026 de volqueta o contenedor en Bogotá; cotizar con un transportador autorizado')
        ];
      } },

    { code: '02.03', chapter: '02', desc: 'Demolición y retiro de acabados existentes', unit: 'm²', mandatory: true, when: function (p) { return p.estado === 'a_demoler'; },
      qty: function (p) { return r2(p.areaM2); }, qtyFormula: function (p) { return 'Área medida = ' + f(p.areaM2) + ' m²'; },
      res: function (p, c) { return [labor(c, 'mo', 'Mano de obra de demolición', p.areaM2 * 0.4, f(p.areaM2) + ' m² × 0,4 h/m² (rendimiento supuesto)')]; } },

    { code: '03.01', chapter: '03', desc: 'Nivelación de piso con mortero autonivelante, 5 mm', unit: 'm²', mandatory: true, when: function (p) { return p.estado !== 'con_acabados'; },
      qty: function (p) { return r2(p.areaM2); }, qtyFormula: function (p) { return 'Área medida = ' + f(p.areaM2) + ' m²'; },
      res: function (p, c) {
        return [
          opt(c, 'mortero', 'Mortero autonivelante (bulto 25 kg)', 'material', ['335145', '1326979'], function (m) {
            var kg = p.areaM2 * 5 * m.kgm2mm, n = ceil(kg / m.bag);
            return { qty: n, formula: f(p.areaM2) + ' m² × 5 mm × ' + f(m.kgm2mm) + ' kg/m²/mm (ficha) = ' + f(kg) + ' kg ÷ ' + m.bag + ' kg = ' + n + ' bultos' };
          }),
          labor(c, 'mo', 'Mano de obra de nivelación', p.areaM2 * 0.15, f(p.areaM2) + ' m² × 0,15 h/m² (rendimiento supuesto)')
        ];
      } },

    { code: '03.02', chapter: '03', desc: 'Piso en porcelanato 60 × 60 (impermeable y lavable, Res. 1403/2007)', unit: 'm²', mandatory: true,
      qty: function (p) { return r2(p.areaM2); }, qtyFormula: function (p) { return 'Instalada = área medida = ' + f(p.areaM2) + ' m²'; },
      res: function (p, c) {
        var porc = opt(c, 'porcelanato', 'Porcelanato 60 × 60 (precio por m², se compra por caja)', 'material', ['876926', '891934', '726543', '1358818', '1441091'], function (m) {
          var boxes = ceil(p.areaM2 * 1.10 / m.box);
          return { qty: r2(boxes * m.box), formula: '⌈' + f(p.areaM2) + ' m² × (1 + 10 % desperdicio) ÷ ' + f(m.box) + ' m²/caja⌉ = ' + boxes + ' cajas × ' + f(m.box) + ' = ' + f(boxes * m.box) + ' m² de compra' };
        }, { premiumPick: true });
        var hc = porc.chosen && P[porc.chosen].proveedor.indexOf('Homecenter') === 0;
        var inst = hc
          ? opt(c, 'instalacion', 'Instalación de porcelanato (servicio)', 'servicio', ['514480'], function () {
            return { qty: r2(p.areaM2), formula: f(p.areaM2) + ' m² instalados' };
          }, { note: 'El servicio 514480 solo instala productos Homecenter; no incluye guardaescoba ni preparación de superficie.' })
          : labor(c, 'instalacion', 'Mano de obra de instalación', p.areaM2 * 0.5, f(p.areaM2) + ' m² × 0,5 h/m² (rendimiento supuesto)', 'El porcelanato elegido no es de Homecenter: el servicio 514480 no aplica y la instalación se estima.');
        return [
          porc,
          opt(c, 'pegante', 'Pegante para porcelanato (bulto 25 kg)', 'material', ['3080326', '1426398'], function (m) {
            var n = ceil(p.areaM2 * 5 / m.bag); return { qty: n, formula: f(p.areaM2) + ' m² × 5 kg/m² (supuesto) ÷ 25 kg = ' + n + ' bultos' };
          }),
          opt(c, 'boquilla', 'Boquilla (bolsa 5 kg)', 'material', ['132813'], function () {
            var n = ceil(p.areaM2 * 0.3 / 5); return { qty: n, formula: f(p.areaM2) + ' m² × 0,3 kg/m² (supuesto) ÷ 5 kg = ' + n + ' bolsas' };
          }),
          inst
        ];
      } },

    { code: '03.03', chapter: '03', desc: 'Guardaescoba cerámico', unit: 'ml', mandatory: true,
      qty: function (p) { return r2(geometry(p).per - p.anchoAberturasM); },
      qtyFormula: function (p) { var g = geometry(p); return 'Perímetro 2 × (' + f(p.frenteM) + ' + ' + f(g.fondo) + ') = ' + f(g.per) + ' m − puertas ' + f(p.anchoAberturasM) + ' m'; },
      res: function (p, c, n) {
        return [
          opt(c, 'guardaescoba', 'Guardaescoba cerámico 9 × 60 cm (pieza)', 'material', ['334856'], function () {
            var u = ceil(n * 1.10 / 0.601); return { qty: u, formula: '⌈' + f(n) + ' ml × 1,10 ÷ 0,601 m por pieza⌉ = ' + u + ' piezas' };
          }, { note: 'Un solo proveedor encontrado; no se halló guardaescoba en porcelanato.' }),
          labor(c, 'mo', 'Mano de obra de instalación', n * 0.1, f(n) + ' ml × 0,1 h/ml (supuesto)', 'El servicio de instalación de piso no incluye el guardaescoba (se cobra por ml).')
        ];
      } },

    { code: '03.04', chapter: '03', desc: 'Estuco y pintura lavable tipo 1 en muros (Res. 1403/2007)', unit: 'm²', mandatory: true,
      qty: function (p) { return r2(wallM2(p)); },
      qtyFormula: function (p) { var g = geometry(p); return 'Perímetro ' + f(g.per) + ' m × altura ' + f(p.alturaM) + ' m − vanos ' + f(p.aberturasM2) + ' m² + divisiones 2 caras × ' + f(p.mlDivisiones) + ' ml × ' + f(p.alturaM) + ' m'; },
      res: function (p, c, n) {
        var estucoM2 = p.estado === 'con_acabados' ? n * 0.3 : n;
        return [
          opt(c, 'estuco', 'Estuco plástico', 'material', ['674008', '1447403'], function (m) {
            var u = ceil(estucoM2 * 1.2 / m.bag); return { qty: u, formula: f(estucoM2) + ' m²' + (p.estado === 'con_acabados' ? ' (30 % del muro: resanes, supuesto)' : '') + ' × 1,2 kg/m² (ficha) ÷ ' + m.bag + ' kg = ' + u + ' unidades' };
          }),
          opt(c, 'pintura', 'Pintura lavable tipo 1 (cuñete 5 gal)', 'material', ['3056134', '1269267'], function () {
            var gal = ceil(n * 2 / 20), u = ceil(gal / 5);
            return { qty: u, formula: f(n) + ' m² × 2 manos ÷ 20 m²/gal (supuesto conservador) = ' + gal + ' gal → ' + u + ' cuñetes de 5 gal' };
          }),
          opt(c, 'mo_pintura', 'Servicio de pintura integral interior (hasta 80 m²)', 'servicio', ['3110588'], function () {
            var u = ceil(n / 80); return { qty: u, formula: '⌈' + f(n) + ' m² ÷ 80 m² por servicio⌉ = ' + u + ' servicios (supuesto: 80 m² de superficie pintada)' };
          }, { note: 'El servicio excluye materiales, estucado total y andamios para alturas > 2,50 m.' }),
          labor(c, 'mo_estuco', 'Mano de obra de estucado', estucoM2 * 0.15, f(estucoM2) + ' m² × 0,15 h/m² (supuesto; el servicio de pintura excluye el estucado total)')
        ];
      } },

    { code: '03.05', chapter: '03', desc: 'Cielo raso liso en drywall con pintura (Res. 1403/2007)', unit: 'm²', mandatory: true,
      qty: function (p) { return r2(p.areaM2); }, qtyFormula: function (p) { return 'Área medida = ' + f(p.areaM2) + ' m²'; },
      res: function (p, c) {
        var a = p.areaM2;
        return [
          opt(c, 'placa', 'Placa de yeso ½" 1,22 × 2,44 m', 'material', ['71096', '1071312'], function () {
            var u = ceil(a * 1.10 / 2.977); return { qty: u, formula: '⌈' + f(a) + ' m² × 1,10 ÷ 2,977 m²/placa⌉ = ' + u + ' placas' };
          }),
          opt(c, 'omega', 'Perfil omega 2,44 m', 'material', ['691254'], function () {
            var u = ceil(a / 0.61 / 2.44 * 1.05); return { qty: u, formula: f(a) + ' m² ÷ 0,61 m de modulación ÷ 2,44 m × 1,05 = ' + u + ' (modulación NO VERIFICADA)' };
          }),
          opt(c, 'vigueta', 'Vigueta 2,44 m', 'material', ['691255'], function () {
            var u = ceil(a / 1.22 / 2.44 * 1.05); return { qty: u, formula: f(a) + ' m² ÷ 1,22 m ÷ 2,44 m × 1,05 = ' + u + ' (modulación NO VERIFICADA)' };
          }),
          opt(c, 'masilla', 'Masilla para drywall (28 kg)', 'material', ['51755', '1068746'], function () {
            var u = ceil(a * 0.6 / 28); return { qty: u, formula: f(a) + ' m² × 0,6 kg/m² ÷ 28 kg = ' + u + ' cuñetes' };
          }),
          opt(c, 'cinta', 'Cinta de papel 75 m', 'material', ['110488'], function () {
            var u = ceil(a * 1.5 / 75); return { qty: u, formula: f(a) + ' m² × 1,5 m/m² (supuesto) ÷ 75 m = ' + u + ' rollos' };
          }),
          opt(c, 'pintura', 'Pintura lavable tipo 1 (galón)', 'material', ['3056133', '1208'], function () {
            var u = ceil(a * 2 / 20); return { qty: u, formula: f(a) + ' m² × 2 manos ÷ 20 m²/gal = ' + u + ' galones' };
          }),
          labor(c, 'mo', 'Mano de obra de cielo raso', a * 0.5, f(a) + ' m² × 0,5 h/m² (supuesto)')
        ];
      } },

    { code: '03.06', chapter: '03', desc: 'Muros divisorios en drywall: áreas exigidas (Res. 2955/2007)', unit: 'm²', mandatory: true,
      when: function (p) { return p.mlDivisiones > 0; },
      qty: function (p) { return r2(p.mlDivisiones * p.alturaM); }, qtyFormula: function (p) { return f(p.mlDivisiones) + ' ml × altura ' + f(p.alturaM) + ' m'; },
      res: function (p, c, n) {
        return [
          opt(c, 'placa', 'Placa de yeso ½" (dos caras)', 'material', ['71096', '1071312'], function () {
            var u = ceil(n * 2 * 1.10 / 2.977); return { qty: u, formula: '⌈' + f(n) + ' m² × 2 caras × 1,10 ÷ 2,977⌉ = ' + u + ' placas' };
          }),
          opt(c, 'paral', 'Paral 2,44 m', 'material', ['318224', '1239973'], function () {
            var u = ceil(p.mlDivisiones / 0.61 + 1) * ceil(p.alturaM / 2.44); return { qty: u, formula: '(⌈' + f(p.mlDivisiones) + ' ÷ 0,61 + 1⌉) × ⌈' + f(p.alturaM) + ' ÷ 2,44⌉ = ' + u + ' (modulación NO VERIFICADA)' };
          }, { note: 'Calibres distintos (0,53 mm frente a 0,40 mm): verificar con el diseño.' }),
          opt(c, 'canal', 'Canal 2,44 m', 'material', ['321791'], function () {
            var u = ceil(p.mlDivisiones * 2 / 2.44); return { qty: u, formula: '⌈' + f(p.mlDivisiones) + ' ml × 2 ÷ 2,44⌉ = ' + u };
          }),
          opt(c, 'masilla', 'Masilla para drywall (28 kg)', 'material', ['51755', '1068746'], function () {
            var u = ceil(n * 2 * 0.6 / 28); return { qty: u, formula: f(n) + ' m² × 2 caras × 0,6 kg/m² ÷ 28 kg = ' + u };
          }),
          labor(c, 'mo', 'Mano de obra de muros', n * 0.6, f(n) + ' m² × 0,6 h/m² (supuesto)')
        ];
      } },

    { code: '04.01', chapter: '04', desc: 'Tablero de distribución con protecciones', unit: 'und', mandatory: true, techReview: true,
      qty: function (p) { return boardsN(p); }, qtyFormula: function (p) { return '⌈' + circuitsN(p) + ' circuitos ÷ 12 por tablero⌉ = ' + boardsN(p) + ' tablero(s); fases según diseño eléctrico'; },
      res: function (p, c) {
        var circ = ceil(tomasN(p) / 8) + ceil(lumN(p) / 10) + p.cajas;
        var boards = boardsN(p);
        return [
          opt(c, 'tablero', 'Tablero de 12 circuitos', 'material', ['312748', '2227808', '595309'], function () { return { qty: boards, formula: '⌈(' + circ + ' + ' + aaN(p) + ' de aire) ÷ 12⌉ = ' + boards + ' tablero(s)' }; },
            { note: 'Monofásico o trifásico según la acometida: requiere revisión técnica.' }),
          opt(c, 'breaker', 'Breaker 1 × 20 A', 'material', ['3083385', '02161', '2184670'], function () {
            return { qty: circ, formula: '⌈tomas ' + tomasN(p) + ' ÷ 8⌉ + ⌈luminarias ' + lumN(p) + ' ÷ 10⌉ + ' + p.cajas + ' circuitos de caja = ' + circ + ' (supuesto)' };
          }),
          opt(c, 'breaker_aa', 'Breaker 2 × 40 A (aire acondicionado)', 'material', ['3083393', '67778', '2182857'], function () { return { qty: aaN(p), formula: aaN(p) + ' circuito(s) dedicado(s), uno por equipo' }; }),
          labor(c, 'mo', 'Mano de obra de tablero', 6 * boards, boards + ' tablero(s) × 6 h (supuesto)')
        ];
      } },

    { code: '04.02', chapter: '04', desc: 'Salidas de tomacorriente con cableado y tubería', unit: 'und', mandatory: true, techReview: true,
      qty: function (p) { return tomasN(p); }, qtyFormula: function (p) { return '⌈' + f(p.areaM2) + ' m² ÷ 10⌉ + 2 × ' + p.cajas + ' cajas (preliminar, según plano eléctrico)'; },
      res: function (p, c, n) {
        return [
          opt(c, 'toma', 'Toma doble con polo a tierra', 'material', ['1242885', '722150'], function () { return { qty: n, formula: n + ' salidas' }; }),
          opt(c, 'cable', 'Cable THHN 12 AWG (rollo 100 m)', 'material', ['56075', '274234', '1044583'], function () {
            var u = ceil(n * 12 / 100); return { qty: u, formula: n + ' salidas × 12 m (supuesto) ÷ 100 m = ' + u + ' rollos' };
          }),
          opt(c, 'tubo', 'Tubo EMT ½" 3,05 m', 'material', ['3075352'], function () {
            var u = ceil(n * 4 / 3.05); return { qty: u, formula: n + ' × 4 m (supuesto) ÷ 3,05 m = ' + u + ' tubos' };
          }),
          opt(c, 'caja', 'Caja de empalme 2 × 4', 'material', ['206095'], function () { return { qty: n, formula: n + ' cajas' }; }),
          labor(c, 'mo', 'Mano de obra eléctrica', n * 1.5, n + ' salidas × 1,5 h (supuesto)')
        ];
      } },

    { code: '04.03', chapter: '04', desc: 'Iluminación: panel LED 60 × 60, 40 W, de incrustar', unit: 'und', mandatory: true, techReview: true,
      qty: function (p) { return lumN(p); }, qtyFormula: function (p) { return '⌈' + f(p.areaM2) + ' m² ÷ 6 m² por panel⌉ (preliminar, hasta el diseño de iluminación)'; },
      res: function (p, c, n) {
        return [
          opt(c, 'panel', 'Panel LED 60 × 60, 40 W', 'material', ['917518', '692663', '478099', '673481', '1210860'], function () { return { qty: n, formula: n + ' paneles' }; }),
          opt(c, 'cable', 'Cable THHN 12 AWG (rollo 100 m)', 'material', ['56075', '274234', '1044583'], function () {
            var u = ceil(n * 6 / 100); return { qty: u, formula: n + ' × 6 m (supuesto) ÷ 100 m = ' + u + ' rollos' };
          }),
          labor(c, 'mo', 'Mano de obra de instalación', n * 0.75, n + ' × 0,75 h (supuesto)')
        ];
      } },

    { code: '04.04', chapter: '04', desc: 'Luminarias de emergencia (UAECOB)', unit: 'und', mandatory: true,
      qty: function (p) { return Math.max(2, ceil(p.areaM2 / 40)); }, qtyFormula: function (p) { return 'máx(2, ⌈' + f(p.areaM2) + ' ÷ 40⌉) (supuesto; lo define el concepto de Bomberos)'; },
      res: function (p, c, n) {
        return [
          opt(c, 'lampara', 'Lámpara de emergencia LED', 'material', ['1419530', '296356', '758849'], function () { return { qty: n, formula: n + ' unidades' }; }),
          labor(c, 'mo', 'Mano de obra de instalación', n * 0.5, n + ' × 0,5 h (supuesto)')
        ];
      } },

    { code: '05.01', chapter: '05', desc: 'Aire acondicionado minisplit inverter 24.000 BTU con instalación', unit: 'und', mandatory: true, techReview: true,
      qty: function (p) { return aaN(p); }, qtyFormula: function (p) { return 'máx(1, ⌈' + f(p.areaM2) + ' m² ÷ 80 m² por equipo⌉) = ' + aaN(p) + ' (preliminar: la capacidad exige cálculo de carga térmica)'; },
      res: function (p, c) {
        var n = aaN(p);
        return [
          opt(c, 'equipo', 'Equipo minisplit inverter', 'equipo', ['3022989', '8806097838029', '8806087537871', '775139', '782461', '783314', '8806097837992'], function () { return { qty: n, formula: n + ' equipo(s)' }; },
            { note: 'Se usa el precio normal; las ofertas temporales se muestran como nota.' }),
          opt(c, 'instalacion', 'Instalación del aire acondicionado (servicio)', 'servicio', ['324699', '696665'], function () { return { qty: n, formula: n + ' instalación(es)' }; },
            { note: 'Excluye material excedente, adecuación eléctrica, estructuras y trabajo en alturas.' })
        ];
      } },

    { code: '07.01', chapter: '07', desc: 'Góndolas murales metálicas', unit: 'und', mandatory: true,
      qty: function (p, ctx, res) {
        if (res && res[0]) return res[0].qty;
        return Math.floor(p.mlEstanteria / 1.0);
      },
      qtyFormula: function (p) { return f(p.mlEstanteria) + ' m lineales de muro ÷ ancho del módulo elegido (módulos completos)'; },
      res: function (p, c) {
        var g = opt(c, 'gondola', 'Góndola de pared', 'equipo', ['10001974', 'CG120', 'hd43323b1a2', '691162'], function (m) {
          var n = Math.floor(p.mlEstanteria / m.module); return { qty: n, formula: '⌊' + f(p.mlEstanteria) + ' m ÷ ' + f(m.module) + ' m por módulo⌋ = ' + n + ' módulos' };
        }, { note: 'El ancho del módulo cambia cuántos caben. Envío no incluido en los precios publicados.' });
        return [g, labor(c, 'mo', 'Montaje y nivelación', g.qty * 0.5, g.qty + ' módulos × 0,5 h (supuesto)')];
      } },

    { code: '07.02', chapter: '07', desc: 'Góndolas centrales doble cara', unit: 'und', mandatory: true,
      qty: function (p) { return p.gondolasCentrales; }, qtyFormula: function (p) { return 'Góndolas centrales = ' + p.gondolasCentrales; },
      res: function (p, c, n) {
        return [opt(c, 'gondola', 'Góndola central', 'equipo', ['SGDP180N', '10000627', '1GOESU01', 'h323ee3677d'], function () { return { qty: n, formula: n + ' unidades' }; }),
          labor(c, 'mo', 'Montaje', n * 0.5, n + ' × 0,5 h (supuesto)')];
      } },

    { code: '07.03', chapter: '07', desc: 'Mostrador de dispensación y caja', unit: 'und', mandatory: true,
      qty: function (p) { return p.cajas; }, qtyFormula: function (p) { return 'Cajas = ' + p.cajas; },
      res: function (p, c, n) {
        return [opt(c, 'mostrador', 'Mostrador', 'equipo', ['VACF150R', '1MOSLN07', '10000882', 'h5189a10924'], function () { return { qty: n, formula: n + ' unidades' }; },
          { note: 'El cajón monedero va en el punto de venta (09.01).' })];
      } },

    { code: '07.04', chapter: '07', desc: 'Vitrina exhibidora', unit: 'und', mandatory: false,
      qty: function () { return 1; }, qtyFormula: function () { return '1 vitrina (supuesto)'; },
      res: function (p, c, n) { return [opt(c, 'vitrina', 'Vitrina', 'equipo', ['10001413', 'VV110X100X40'], function () { return { qty: n, formula: n + ' unidad' }; })]; } },

    { code: '08.01', chapter: '08', desc: 'Nevera para medicamentos 2–8 °C con registro de temperatura (cadena de frío)', unit: 'und', mandatory: true, techReview: true,
      when: function (p) { return p.refrigeracion === 'si'; },
      qty: function () { return 1; }, qtyFormula: function () { return '1 equipo; capacidad según los productos'; },
      res: function (p, c) {
        return [
          pending(c, 'nevera', 'Refrigerador farmacéutico 2–8 °C', 1, 'und', 'Sin proveedor confiable con precio publicado: los distribuidores piden «solicitar precio» y se descartó un sitio posiblemente comprometido'),
          opt(c, 'datalogger', 'Registrador de temperatura y humedad (datalogger)', 'equipo', ['KEST-0710BLU', 'EXTE-RHT30'], function () { return { qty: 1, formula: '1 unidad' }; })
        ];
      } },

    { code: '09.01', chapter: '09', desc: 'Punto de venta: computador, lector, impresora de recibos y cajón monedero', unit: 'und', mandatory: true,
      qty: function (p) { return p.cajas; }, qtyFormula: function (p) { return 'Cajas = ' + p.cajas; },
      res: function (p, c, n) {
        return [
          (function () {
            var pc = opt(c, 'pc', 'Computador', 'equipo', ['3111273', '199896468947', '3075472'], function () { return { qty: n, formula: n + ' unidades' }; });
            var tope = root.OBCalc.UVT_50;
            if (pc.price) {
              pc.note = pc.price.unitPrice > tope
                ? 'Exclusión de IVA para computadores ≤ 50 UVT ($2.618.700, art. 424 num. 5 ET, fuente secundaria): no aplica, el precio normal supera el tope. Si se compra en oferta por debajo del tope, validar.'
                : 'Precio ≤ 50 UVT ($2.618.700): el computador podría estar excluido de IVA (art. 424 num. 5 ET, fuente secundaria); el prototipo no lo descuenta: validar.';
            }
            return pc;
          })(),
          opt(c, 'lector', 'Lector de código de barras', 'equipo', ['335275', '782772'], function () { return { qty: n, formula: n + ' unidades' }; }),
          opt(c, 'impresora', 'Impresora térmica 80 mm', 'equipo', ['637930', '637931', '102728283'], function () { return { qty: n, formula: n + ' unidades' }; }),
          opt(c, 'cajon', 'Cajón monedero', 'equipo', ['335274', '104476523', '102565558'], function () { return { qty: n, formula: n + ' unidades' }; })
        ];
      } },

    { code: '09.02', chapter: '09', desc: 'UPS 1 kVA para punto de venta', unit: 'und', mandatory: false,
      qty: function (p) { return p.cajas; }, qtyFormula: function (p) { return 'Cajas = ' + p.cajas; },
      res: function (p, c, n) {
        return [opt(c, 'ups', 'UPS interactiva 1000 VA', 'equipo', ['104476531', '102612636', '798302107694', '441714', '415856'], function () { return { qty: n, formula: n + ' unidades' }; },
          { note: 'Alkosto y Ktronix son el mismo grupo y venden la misma UPS FORZA al mismo precio: se cuenta una vez.' })];
      } },

    { code: '10.01', chapter: '10', desc: 'Aviso exterior caja de luz 300 × 90 cm', unit: 'und', mandatory: true,
      qty: function () { return 1; }, qtyFormula: function () { return '1 aviso'; },
      res: function (p, c) {
        return [opt(c, 'aviso', 'Aviso caja de luz en lona traslúcida', 'equipo', ['h2131b234ad'], function () { return { qty: 1, formula: '1 unidad' }; },
          { note: 'Un solo proveedor; precio «+IVA». Aviso en acrílico: NO VERIFICADO.' }),
          labor(c, 'mo', 'Instalación del aviso', 4, '4 h (supuesto; la página no especifica instalación)')];
      } },

    { code: '11.01', chapter: '11', desc: 'Limpieza final de obra', unit: 'm²', mandatory: true,
      qty: function (p) { return r2(p.areaM2); }, qtyFormula: function (p) { return 'Área medida = ' + f(p.areaM2) + ' m²'; },
      res: function (p, c) { return [pending(c, 'limpieza', 'Limpieza final', r2(p.areaM2), 'm²', 'Sin precio real en ninguna fuente consultada (research §4.2)')]; } },

    { code: '11.02', chapter: '11', desc: 'Pruebas, manuales y acta de entrega', unit: 'gl', mandatory: true,
      qty: function () { return 1; }, qtyFormula: function () { return 'Global = 1'; },
      res: function (p, c) { return [pending(c, 'pruebas', 'Pruebas y acta de entrega', 1, 'gl', 'Sin precio real en ninguna fuente consultada (research §4.2)')]; } },

    { code: '12.01', chapter: '12', desc: 'Extintores multipropósito ABC (UAECOB)', unit: 'und', mandatory: true,
      qty: function (p) { return Math.max(2, ceil(p.areaM2 / 50)); }, qtyFormula: function (p) { return 'máx(2, ⌈' + f(p.areaM2) + ' ÷ 50⌉) (supuesto: la cantidad la define el concepto de Bomberos, NO VERIFICADO)'; },
      res: function (p, c, n) { return [opt(c, 'extintor', 'Extintor ABC', 'equipo', ['689564', '2229597', '641565', '689566'], function () { return { qty: n, formula: n + ' unidades' }; })]; } },

    { code: '12.02', chapter: '12', desc: 'Señalización de evacuación fotoluminiscente', unit: 'gl', mandatory: true,
      qty: function () { return 1; }, qtyFormula: function () { return '1 kit + 2 señales de salida (supuesto)'; },
      res: function (p, c) {
        return [opt(c, 'kit', 'Kit de 11 señales', 'material', ['337407'], function () { return { qty: 1, formula: '1 kit' }; }, { note: 'Un solo proveedor encontrado.' }),
          opt(c, 'salida', 'Señal de salida de emergencia', 'material', ['120109'], function () { return { qty: 2, formula: '2 señales' }; })];
      } },

    { code: '12.03', chapter: '12', desc: 'Termohigrómetro para registro de temperatura y humedad (Res. 1403/2007)', unit: 'und', mandatory: true,
      qty: function () { return 1; }, qtyFormula: function () { return '1 por área de almacenamiento'; },
      res: function (p, c) {
        return [opt(c, 'termo', 'Termohigrómetro', 'equipo', ['DT-323', 'EXTE-445703', '366382', 'SNH0013 1A-8'], function () { return { qty: 1, formula: '1 unidad' }; },
          { note: 'La norma exige instrumento calibrado: verificar el certificado de calibración con el proveedor.' })];
      } },

    { code: '13.01', chapter: '13', desc: 'Puerta de acceso en aluminio y vidrio (suministro e instalación)', unit: 'und', mandatory: false,
      qty: function () { return 1; }, qtyFormula: function () { return '1 puerta'; },
      res: function (p, c) { return [opt(c, 'puerta', 'Puerta', 'equipo', ['h0dbde08371', 'kit_001temp'], function () { return { qty: 1, formula: '1 unidad' }; })]; } },

    { code: '13.02', chapter: '13', desc: 'Cortina metálica enrollable 3,0 × 2,2 m', unit: 'und', mandatory: false, defaultExcluded: true,
      qty: function () { return 1; }, qtyFormula: function () { return '1 cortina'; },
      res: function (p, c) { return [opt(c, 'cortina', 'Cortina enrollable (referencia de base de precios)', 'equipo', ['FDC010'], function () { return { qty: 1, formula: '1 unidad' }; },
        { note: 'Precio de la base CYPE (referencia, no de proveedor); IVA no indicado: se trata como sin IVA.' })]; } }
  ];

  var ESTADOS = { obra_gris: 'Obra gris', con_acabados: 'Con acabados existentes', a_demoler: 'Acabados a demoler' };
  var ACABADOS = { estandar: 'Estándar', premium: 'Premium' };
  var CIUDADES = ['Bogotá D. C.', 'Medellín', 'Cali', 'Barranquilla', 'Bucaramanga'];

  function tomasN(p) { return ceil(p.areaM2 / 10) + 2 * p.cajas; }
  function aaN(p) { return Math.max(1, ceil(p.areaM2 / 80)); }
  function circuitsN(p) { return ceil(tomasN(p) / 8) + ceil(lumN(p) / 10) + p.cajas + aaN(p); }
  function boardsN(p) { return Math.max(1, ceil(circuitsN(p) / 12)); }
  function lumN(p) { return ceil(p.areaM2 / 6); }
  function wallM2(p) {
    var g = geometry(p);
    return Math.max(0, g.per * p.alturaM - p.aberturasM2 + 2 * p.mlDivisiones * p.alturaM);
  }

  /** Requisitos de droguería que mueven el costo (research §3). */
  var REQUIREMENTS = [
    { id: 'pisos', text: 'Pisos de material impermeable y resistente, con sistema de drenaje', source: 'Res. 1403/2007, Tít. I Cap. II num. 1.1', covers: ['03.02'], note: 'El sistema de drenaje requiere validación profesional.' },
    { id: 'paredes', text: 'Paredes y muros impermeables, sólidos y de fácil limpieza', source: 'Res. 1403/2007, num. 1.1', covers: ['03.04'] },
    { id: 'techos', text: 'Techos y cielos rasos resistentes, uniformes y de fácil limpieza', source: 'Res. 1403/2007, num. 1.1', covers: ['03.05'] },
    { id: 'ventilacion', text: 'Iluminación y ventilación natural o artificial (puertas abiertas no cuentan)', source: 'Res. 1403/2007, num. 1.1', covers: ['04.03', '05.01'] },
    { id: 'thr', text: 'Registro permanente de temperatura y humedad con instrumento calibrado', source: 'Res. 1403/2007, almacenamiento', covers: ['12.03'] },
    { id: 'frio', text: 'Cadena de frío para medicamentos refrigerados', source: 'Res. 1403/2007, almacenamiento', covers: ['08.01'], unless: 'El cliente no reportó productos refrigerados: confirmar.' },
    { id: 'areas', text: 'Áreas delimitadas: administrativa, recepción, cuarentena, almacenamiento, dispensación y residuos', source: 'Res. 2955/2007', covers: ['03.06', '07.03'] },
    { id: 'sanitaria', text: 'Unidad sanitaria por sexo, una por cada 15 trabajadores', source: 'Res. 1403/2007, num. 1.1.3', covers: [], fallback: 'No incluido: el capítulo hidrosanitario no está modelado; verificar si el local tiene baño.' },
    { id: 'retie', text: 'Certificación de conformidad de la instalación eléctrica (dictamen de inspección)', source: 'RETIE, Res. MinEnergía 40117/2024', covers: [], fallback: 'No incluido: costo NO VERIFICADO; se cotiza aparte con un organismo acreditado.' },
    { id: 'bomberos', text: 'Seguridad humana: extintores, señalización de evacuación, iluminación de emergencia', source: 'UAECOB, guía RD-PR03-GA01 v3', covers: ['12.01', '12.02', '04.04'] },
    { id: 'licencia', text: 'Licencia de construcción si hay cambio de uso o redistribución', source: 'Decreto 1077/2015 (texto oficial NO VERIFICADO)', covers: [], fallback: 'Requiere validación profesional.' }
  ];

  var EXAMPLE_REQUEST = 'Necesito adecuar un local de 80 m² en Bogotá para convertirlo en una droguería. ' +
    'El local está en obra gris, quiero acabados comerciales estándar, mobiliario, instalaciones eléctricas, ' +
    'iluminación, aire acondicionado, equipos de caja y entrega llave en mano. No incluyas inventario de medicamentos.';

  var COMBINING = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
  function norm(s) { return s.toLowerCase().normalize('NFD').replace(COMBINING, ''); }
  var NUM_WORDS = { un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 };

  function evidence(text, re) {
    var m = re.exec(text);
    if (!m) return null;
    var start = Math.max(0, m.index - 25);
    var end = Math.min(text.length, m.index + m[0].length + 25);
    while (start > 0 && text.charAt(start - 1) !== ' ') start--;
    while (end < text.length && text.charAt(end) !== ' ') end++;
    return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
  }
  function field(key, label, value, status, ev, action, kind, options) {
    return { key: key, label: label, value: value, status: status, evidence: ev || null, action: action || 'Ninguna', kind: kind || 'text', options: options || null };
  }
  function opts(map) { return Object.keys(map).map(function (k) { return [k, map[k]]; }); }

  /**
   * Intérprete SIMULADO y determinista: extrae solo lo que el texto dice (con evidencia), marca lo
   * demás como Pendiente o Supuesto y NUNCA produce precios (§13.4).
   */
  function parseRequest(text) {
    var raw = String(text || '').trim();
    if (raw.length < 20) return { ok: false, error: 'La descripción es demasiado corta para interpretarla. Describa el local, la ciudad y los trabajos que necesita.' };
    var t = norm(raw);
    var low = raw.toLowerCase();
    var fields = [];

    var tipo = /droguer/.test(t) ? 'Droguería' : (/farmacia/.test(t) ? 'Farmacia' : null);
    fields.push(tipo ? field('tipo', 'Tipo de negocio', tipo, 'inferido', evidence(raw, /droguer[ií]a|farmacia/i))
      : field('tipo', 'Tipo de negocio', null, 'pendiente', null, 'Confirmar: este prototipo solo modela droguerías'));

    var cityRes = [['Bogotá D. C.', /bogot[aá]/i], ['Medellín', /medell[ií]n/i], ['Cali', /\bcali\b/i], ['Barranquilla', /barranquilla/i], ['Bucaramanga', /bucaramanga/i]];
    var city = null;
    for (var i = 0; i < cityRes.length; i++) { if (cityRes[i][1].test(raw)) { city = cityRes[i]; break; } }
    fields.push(city ? field('ciudad', 'Ciudad', city[0], 'inferido', evidence(raw, city[1]), 'Ninguna', 'select', CIUDADES.map(function (c) { return [c, c]; }))
      : field('ciudad', 'Ciudad', 'Bogotá D. C.', 'supuesto', null, 'Confirmar ubicación del inmueble', 'select', CIUDADES.map(function (c) { return [c, c]; })));

    var areaRe = /(\d+(?:[.,]\d+)?)\s*(?:m2|m²|mts2|mt2|metros cuadrados)/i;
    var am = areaRe.exec(low);
    var area = am ? parseFloat(am[1].replace(',', '.')) : null;
    fields.push(area ? field('areaM2', 'Área del local (m²)', area, 'inferido', evidence(raw, areaRe), 'Confirmar con medición', 'number')
      : field('areaM2', 'Área del local (m²)', null, 'pendiente', null, 'Medir en visita técnica', 'number'));

    var estado = /demoler|demolici/.test(t) ? 'a_demoler' : /obra gris/.test(t) ? 'obra_gris' : /(ya tiene|con) pisos|con acabados/.test(t) ? 'con_acabados' : null;
    fields.push(estado ? field('estado', 'Estado actual del local', estado, 'inferido', evidence(raw, /demoler|demolici[oó]n|obra gris|(ya tiene|con) pisos|con acabados/i), 'Confirmar en visita técnica', 'select', opts(ESTADOS))
      : field('estado', 'Estado actual del local', 'obra_gris', 'supuesto', null, 'Confirmar en visita técnica', 'select', opts(ESTADOS)));

    var acabado = /premium|alta gama/.test(t) ? 'premium' : (/estandar/.test(t) ? 'estandar' : null);
    fields.push(acabado ? field('acabado', 'Nivel de acabado', acabado, 'inferido', evidence(raw, /premium|alta gama|est[aá]ndar/i), 'Ninguna', 'select', opts(ACABADOS))
      : field('acabado', 'Nivel de acabado', 'estandar', 'supuesto', null, 'Validar con el cliente', 'select', opts(ACABADOS)));

    var llave = /llave en mano/.test(t);
    var chapters = [];
    function add(c) { if (chapters.indexOf(c) < 0) chapters.push(c); }
    var hasFloors = /(ya tiene|con) pisos|con acabados/.test(t);
    if (llave) { add('01'); add('10'); add('11'); add('13'); }
    if (/obra gris|acabad|pintur|cielo raso|demoler/.test(t) || (/piso/.test(t) && !hasFloors)) { add('02'); add('03'); }
    if (hasFloors) { add('02'); add('03'); }
    if (/electric|ilumin/.test(t)) add('04');
    if (/aire acondicionado|climatiz/.test(t)) add('05');
    if (/mobiliario|estanter|gondol|vitrin/.test(t)) add('07');
    var refri = /refrigera|nevera|cadena de frio/.test(t);
    if (refri) add('08');
    if (/\bcajas?\b|punto de venta|\bpos\b/.test(t)) add('09');
    if (/puerta|fachada|cortina/.test(t)) add('13');
    if (!chapters.length) {
      return { ok: false, error: 'No identifiqué trabajos en la descripción (acabados, electricidad, mobiliario, climatización, caja…). Agregue el alcance esperado e intente de nuevo.' };
    }
    if (tipo) { add('08'); add('11'); add('12'); }
    chapters.sort();

    var cm = /(\d+|una|un|dos|tres|cuatro|cinco)\s+cajas?\b/.exec(t);
    var cajas = cm ? (NUM_WORDS[cm[1]] || parseInt(cm[1], 10)) : null;
    fields.push(cajas ? field('cajas', 'Cajas registradoras', cajas, 'inferido', evidence(raw, /(\d+|una|un|dos|tres|cuatro|cinco)\s+cajas?/i), 'Ninguna', 'number')
      : field('cajas', 'Cajas registradoras', 1, 'supuesto', null, 'Confirmar con el cliente', 'number'));
    var a = area || 80, frente = 8;
    fields.push(field('frenteM', 'Frente del local (m)', frente, 'supuesto', null, 'Medir en visita técnica', 'number'));
    fields.push(field('alturaM', 'Altura libre (m)', 3, 'supuesto', null, 'Medir en visita técnica', 'number'));
    fields.push(derivedField('mlEstanteria', 'Muros con estantería (m lineales)', 'Crear plano de distribución'));
    fields.push(derivedField('gondolasCentrales', 'Góndolas centrales', 'Confirmar mobiliario central'));
    fields.push(field('aberturasM2', 'Vanos en muros: puertas y vitrinas (m²)', 12, 'supuesto', null, 'Medir en visita técnica', 'number'));
    fields.push(field('anchoAberturasM', 'Ancho de puertas sin guardaescoba (m)', 4, 'supuesto', null, 'Medir en visita técnica', 'number'));
    fields.push(field('mlDivisiones', 'Muros divisorios nuevos (m lineales)', 6, 'supuesto', null, 'Definir áreas exigidas en el plano', 'number'));
    fields.push(field('refrigeracion', 'Productos que requieren refrigeración', refri ? 'si' : 'no', refri ? 'inferido' : 'supuesto', refri ? evidence(raw, /refrigera\w*|nevera|cadena de fr[ií]o/i) : null,
      'Confirmar productos', 'select', [['si', 'Sí'], ['no', 'No']]));
    fields.push(field('redes', 'Estado de redes eléctricas e hidráulicas', 'Por verificar', 'por_verificar', null, 'Inspección técnica'));
    fields.push(field('tributaria', 'Clasificación tributaria del contrato', null, 'pendiente', null, 'Revisar con contador'));

    var exclusions = [
      'Trámites de licencias, permisos y conceptos ante autoridades (sanitario, Bomberos, curaduría).',
      'Certificación RETIE de la instalación eléctrica: costo NO VERIFICADO, se cotiza aparte.',
      'Transporte de mobiliario: los precios publicados de los fabricantes no incluyen envío.',
      'Obras hidrosanitarias (baño, lavamanos): no modeladas en esta cotización.',
      'Obras no descritas en el alcance aprobado.'
    ];
    if (/no inclu\w* (el |la |los )?inventario/.test(t)) exclusions.unshift('Inventario inicial de medicamentos (excluido por solicitud del cliente).');
    if (!refri) exclusions.push('Equipos de refrigeración de medicamentos, hasta confirmar qué productos la requieren.');

    refreshDerived(fields);
    return { ok: true, fields: fields, chapters: chapters, exclusions: exclusions };
  }

  /** Supuestos que se derivan de otros parámetros: se recalculan mientras el usuario no los fije. */
  var DERIVED = {
    mlEstanteria: { rule: '2 × fondo − 2 m (fondo = área ÷ frente)', fn: function (a, fr) { return r2(Math.max(0, 2 * (a / fr) - 2)); } },
    gondolasCentrales: { rule: 'máx(1, ⌊área ÷ 40 m²⌋)', fn: function (a) { return Math.max(1, Math.floor(a / 40)); } }
  };
  function derivedField(key, label, action) {
    var x = field(key, label, null, 'supuesto', null, action, 'number');
    x.derived = true;
    x.baseAction = action;
    return x;
  }
  function refreshDerived(fields) {
    var byKey = {};
    fields.forEach(function (x) { byKey[x.key] = x; });
    var a = byKey.areaM2 && byKey.areaM2.value > 0 ? byKey.areaM2.value : 80;
    var fr = byKey.frenteM && byKey.frenteM.value > 0 ? byKey.frenteM.value : 8;
    fields.forEach(function (x) {
      if (x.derived && x.status === 'supuesto' && DERIVED[x.key]) {
        x.value = DERIVED[x.key].fn(a, fr);
        x.evidence = null;
        x.action = 'Supuesto derivado: ' + DERIVED[x.key].rule + '. ' + x.baseAction;
      }
    });
    return fields;
  }

  function paramsFromFields(fields) {
    var byKey = {};
    fields.forEach(function (x) { byKey[x.key] = x.value; });
    function num(k, d) { var v = byKey[k]; return typeof v === 'number' && v >= 0 ? v : d; }
    return {
      areaM2: num('areaM2', 0), frenteM: num('frenteM', 8) || 8, alturaM: num('alturaM', 3) || 3,
      aberturasM2: num('aberturasM2', 12), anchoAberturasM: num('anchoAberturasM', 4),
      mlEstanteria: num('mlEstanteria', 0), cajas: Math.max(1, Math.round(num('cajas', 1))), gondolasCentrales: Math.round(num('gondolasCentrales', 0)),
      mlDivisiones: num('mlDivisiones', 0),
      estado: byKey.estado || 'obra_gris', acabado: byKey.acabado || 'estandar', ciudad: byKey.ciudad || 'Bogotá D. C.',
      refrigeracion: byKey.refrigeracion || 'no', tipo: byKey.tipo || null
    };
  }

  var BY_CODE = {};
  TEMPLATES.forEach(function (t) { BY_CODE[t.code] = t; });

  /** Recalcula cantidades y recursos de cada partida a partir de los parámetros (m² primero). */
  function applyQuantities(lines, params) {
    lines.forEach(function (l) {
      var t = BY_CODE[l.code];
      var ctx = { choices: l.choices || (l.choices = {}), overrides: l.overrides || (l.overrides = {}), premium: params.acabado === 'premium' };
      l.active = !t.when || t.when(params);
      var res = t.res(params, ctx, t.qty(params, ctx, null));
      l.qtyInstalled = t.qty(params, ctx, res);
      l.qtyFormula = t.qtyFormula(params);
      l.resources = res;
    });
    return lines;
  }

  function generateLines(chapters, params) {
    var lines = TEMPLATES.filter(function (t) { return chapters.indexOf(t.chapter) >= 0; }).map(function (t) {
      return { id: t.code, code: t.code, chapter: t.chapter, desc: t.desc, unit: t.unit, mandatory: !!t.mandatory,
        optional: !t.mandatory, included: !t.defaultExcluded, techReview: !!t.techReview, techValidated: false,
        choices: {}, overrides: {} };
    });
    return applyQuantities(lines, params);
  }

  root.OBData = {
    CHAPTERS: CHAPTERS, OBRA: OBRA, TEMPLATES: TEMPLATES, OPT: OPT, REQUIREMENTS: REQUIREMENTS, ESTADOS: ESTADOS, ACABADOS: ACABADOS, CIUDADES: CIUDADES,
    EXAMPLE_REQUEST: EXAMPLE_REQUEST, LABOR_ID: LABOR_ID,
    meta: meta, selectable: selectable, priceOf: priceOf, laborPrice: laborPrice, defaultTaxClasses: defaultTaxClasses,
    parseRequest: parseRequest, paramsFromFields: paramsFromFields, generateLines: generateLines, applyQuantities: applyQuantities,
    wallM2: wallM2, geometry: geometry, refreshDerived: refreshDerived, DERIVED: DERIVED
  };
})(typeof window !== 'undefined' ? window : globalThis);
