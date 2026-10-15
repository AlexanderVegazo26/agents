// @ts-check
// Motor de cálculo determinista del prototipo ObraBase AI (iteración 2).
// Importes: ENTEROS en pesos (COP). Porcentajes: enteros en puntos básicos (800 = 8,00 %).
// Toda división redondea explícitamente al peso, mitad hacia arriba.
// Reglas fiscales: ver research/colombia-adecuacion.md §1. NO es asesoría tributaria.
(function (root) {
  'use strict';

  var IVA_BP = 1900;                // Tarifa general 19 % (art. 468 ET)
  var UVT = 52374;                  // UVT 2026, Resolución DIAN 000238 de 2025
  var UVT_3500 = 3500 * UVT;        // 183.309.000: tope para no responsables de IVA (art. 437 par. 3 ET)
  var UVT_50 = 50 * UVT;            // 2.618.700: computadores excluidos de IVA (art. 424 num. 5 ET)
  var PUBLISHED_MAX_AGE_DAYS = 30;  // Política operativa del prototipo, no obligación legal
  var DEMO_TODAY = '2026-10-15';    // Fecha de referencia ÚNICA del demo (consulta de precios, vigencias y fecha de los documentos)
  var ENGINE_VERSION = 'obrabase-calc i4 · UVT 2026 $52.374 · IVA 19 % · reglas research 2026-10-15';
  var RETEIVA_BP = 1500;            // 15 % del IVA (art. 437-1 ET)
  var RETEICA_BP = 76;              // 7,60 ‰ CIIU 4330 Bogotá (fuente secundaria: NO VERIFICADO)

  /**
   * Clases fiscales por capítulo. La clasificación de una «adecuación» NO está resuelta por la DIAN
   * (research §6.1): el sistema propone, el contador decide.
   */
  var TAX_CLASSES = {
    construccion: {
      label: 'Contrato de construcción: IVA 19 % sobre la utilidad',
      ivaBase: 'utilidad',
      legal: 'Art. 1.3.1.7.9 DUR 1625/2016 (Decreto 1372/1992 art. 3); Oficio DIAN 959/2019. El IVA de materiales no es descontable (Oficio DIAN 1095/2022).',
      ret: { bp: 200, minUvt: 10, label: 'Retención en la fuente, contratos de construcción 2 %', legal: 'Par. 2 art. 1.2.4.9.1 DUR; Oficio DIAN 165/2021; base 10 UVT con Decreto 572/2025 (vigente salvo decisión posterior)' }
    },
    reparacion: {
      label: 'Reparación, pintura o mantenimiento: IVA 19 % sobre el valor total',
      ivaBase: 'total',
      legal: 'Oficio DIAN 44743/2013; Concepto DIAN 415/2025 (el mantenimiento no es construcción).',
      ret: { bp: 400, minUvt: 2, label: 'Retención en la fuente, servicios generales (declarante) 4 %', legal: 'Tabla de retención 2026 (fuente secundaria); base 2 UVT con Decreto 572/2025' }
    },
    venta: {
      label: 'Venta de bienes con instalación: IVA 19 % sobre el valor total',
      ivaBase: 'total',
      legal: 'Art. 447 ET; Oficio DIAN 131/2018 (muebles vendidos e instalados: «la fórmula AIU no es aplicable»).',
      ret: { bp: 250, minUvt: 10, label: 'Retención en la fuente, compras generales (declarante) 2,5 %', legal: 'Tabla de retención 2026 (fuente secundaria); base 10 UVT con Decreto 572/2025' }
    },
    honorarios: {
      label: 'Honorarios de diseño: IVA 19 % sobre el valor total',
      ivaBase: 'total',
      legal: 'Art. 468 ET (tarifa general).',
      ret: { bp: 1100, minUvt: 0, label: 'Retención en la fuente, honorarios persona jurídica 11 %', legal: 'Tabla de retención 2026 (fuente secundaria)' }
    }
  };

  var REGIMES = {
    responsable: 'Responsable de IVA (régimen ordinario)',
    simple: 'Régimen SIMPLE, responsable de IVA (sin retención en renta, art. 911 ET)',
    no_responsable: 'Persona natural no responsable de IVA (art. 437 par. 3 ET)'
  };

  /** Redondeo mitad hacia arriba de num/den para enteros no negativos. */
  function divRound(num, den) {
    if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0 || num < 0) {
      throw new RangeError('divRound requiere enteros seguros no negativos: ' + num + '/' + den);
    }
    return Math.floor((num * 2 + den) / (den * 2));
  }
  function pct(amount, bp) { return divRound(amount * bp, 10000); }
  function toMilli(q) {
    if (!(q >= 0) || !isFinite(q)) throw new RangeError('Cantidad inválida: ' + q);
    return Math.round(q * 1000);
  }

  /** Único resolvedor de la clase fiscal de un capítulo: null si no tiene una clase conocida. */
  function taxClassOf(fiscal, chapter) {
    var cls = fiscal && fiscal.classes ? fiscal.classes[chapter] : null;
    return cls && TAX_CLASSES[cls] ? cls : null;
  }

  /** ¿El IVA pagado en la compra es costo? Sí si no es descontable. */
  function ivaIsCost(regime, taxClass) {
    return regime === 'no_responsable' || taxClass === 'construccion';
  }

  /**
   * Costo unitario de un precio de compra.
   * ivaIncluded: true = precio al público con IVA; false = «+IVA»; null = no indicado (se trata como sin IVA, conservador).
   */
  function costUnit(price, ivaCost) {
    var p = price.unitPrice;
    if (price.ivaIncluded === true) return ivaCost ? p : divRound(p * 10000, 10000 + IVA_BP);
    return ivaCost ? p + pct(p, IVA_BP) : p;
  }

  /** Para compatibilidad y para la vista: base neta de un precio (sin IVA). */
  function netUnit(price) { return costUnit(price, false); }

  function resourceCost(res, ivaCost) {
    if (!res.price) return null;
    return divRound(toMilli(res.qty) * costUnit(res.price, ivaCost), 1000);
  }

  /**
   * Costo directo de una partida. ctx = { regime, taxClass }.
   * Partidas con recursos (APU): suma de recursos; cualquier recurso sin precio deja la partida Pendiente.
   */
  function lineCost(line, ctx) {
    ctx = ctx || { regime: 'responsable', taxClass: 'venta' };
    var ivaCost = ivaIsCost(ctx.regime, ctx.taxClass);
    if (line.resources && line.resources.length && !line.manual) {
      var sum = 0;
      for (var i = 0; i < line.resources.length; i++) {
        var c = resourceCost(line.resources[i], ivaCost);
        if (c === null) return null;
        sum += c;
      }
      return sum;
    }
    if (!line.price) return null;
    return divRound(toMilli(line.qtyInstalled) * costUnit(line.price, ivaCost), 1000);
  }

  function daysBetween(fromIso, toIso) {
    var a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
    var b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
    return Math.round((b - a) / 86400000);
  }

  // Severidad para el estado agregado de un APU: el recurso MENOS verificado manda (mayor = peor).
  //   pendiente > vencido > estimado > emisor > referencia > publicado_manual > cotizacion_vigente > publicado
  // 'estimado' = mano de obra estimada POR EL SISTEMA (tarifa de referencia × rendimiento supuesto, sin verificar):
  //              peor que 'emisor', que es un valor registrado a mano con fuente y justificación en la auditoría.
  // 'publicado_manual' = precio publicado registrado a mano (enlace y fecha del usuario): peor que una cotización
  //              vigente, que es una oferta formal con condiciones y vigencia; ambas peores que un precio publicado
  //              tomado por el sistema de la investigación.
  var RANK = { pendiente: 8, vencido: 7, estimado: 6, emisor: 5, referencia: 4, publicado_manual: 3, cotizacion_vigente: 2, publicado: 1 };
  function singleStatus(p, today) {
    if (!p) return 'pendiente';
    if (p.type === 'publicado') {
      if (daysBetween(p.date, today) > PUBLISHED_MAX_AGE_DAYS) return 'vencido';
      return p.manual ? 'publicado_manual' : 'publicado';
    }
    if (p.type === 'cotizado') return p.validUntil && p.validUntil < today ? 'vencido' : 'cotizacion_vigente';
    if (p.type === 'referencia') return 'referencia';
    return p.manual ? 'emisor' : 'estimado';
  }
  /** ¿La partida incluye mano de obra estimada por el sistema (no un valor registrado por el emisor)? */
  function hasLaborProxy(line) {
    return !!(line.resources && line.resources.some(function (r) {
      return r.kind === 'mano_obra' && r.price && r.price.type === 'estimado' && !r.price.manual;
    }));
  }
  /** Estado visible del precio (§19.4); para un APU, el peor estado de sus recursos. */
  function priceStatus(line, today) {
    today = today || DEMO_TODAY;
    if (line.resources && line.resources.length && !line.manual) {
      var worst = 'publicado';
      line.resources.forEach(function (r) {
        var s = singleStatus(r.price, today);
        if (RANK[s] > RANK[worst]) worst = s;
      });
      return worst;
    }
    return singleStatus(line.price, today);
  }

  /**
   * Totales del presupuesto mixto por capítulo.
   * policy: { adminBp, contBp, utilBp, method: 'aiu'|'margen' }
   *   aiu    → A, I y U como % del costo directo (práctica colombiana)
   *   margen → Precio = (CD + A + I) / (1 − m)
   * fiscal: { regime, classes: {capítulo: clase}, client: { renta, iva, ica }, city }
   */
  function totals(lines, policy, fiscal) {
    var regime = fiscal.regime;
    var chapters = {};
    var unpriced = 0;
    var unclassified = [];
    lines.forEach(function (l) {
      if (l.included === false) return;
      var cls = taxClassOf(fiscal, l.chapter);
      if (!cls) { if (unclassified.indexOf(l.chapter) < 0) unclassified.push(l.chapter); return; }
      var c = lineCost(l, { regime: regime, taxClass: cls });
      if (c === null) { unpriced++; return; }
      if (!chapters[l.chapter]) chapters[l.chapter] = { cd: 0, cls: cls };
      chapters[l.chapter].cd += c;
    });
    var t = { cd: 0, admin: 0, cont: 0, util: 0, subtotal: 0, iva: 0, chapters: chapters, unpriced: unpriced, unclassified: unclassified };
    var groups = {};
    Object.keys(chapters).sort().forEach(function (k) {
      var ch = chapters[k];
      ch.a = pct(ch.cd, policy.adminBp);
      ch.i = pct(ch.cd, policy.contBp);
      if (policy.method === 'margen') {
        if (policy.utilBp >= 10000) throw new RangeError('El margen debe ser menor que 100 %');
        var base = ch.cd + ch.a + ch.i;
        ch.u = divRound(base * 10000, 10000 - policy.utilBp) - base;
      } else {
        ch.u = pct(ch.cd, policy.utilBp);
      }
      ch.sub = ch.cd + ch.a + ch.i + ch.u;
      t.cd += ch.cd; t.admin += ch.a; t.cont += ch.i; t.util += ch.u; t.subtotal += ch.sub;
      var g = groups[ch.cls] || (groups[ch.cls] = { cls: ch.cls, sub: 0, util: 0 });
      g.sub += ch.sub; g.util += ch.u;
    });
    t.ivaGroups = Object.keys(groups).sort().map(function (k) {
      var g = groups[k];
      var base = TAX_CLASSES[k].ivaBase === 'utilidad' ? g.util : g.sub;
      var iva = regime === 'no_responsable' ? 0 : pct(base, IVA_BP);
      t.iva += iva;
      return { cls: k, base: base, iva: iva, sub: g.sub, util: g.util };
    });
    t.total = t.subtotal + t.iva;

    // Retenciones: las practica el CLIENTE si es agente. Informativas: no cambian el total.
    var ret = [];
    if (fiscal.client && fiscal.client.renta && regime !== 'simple') {
      t.ivaGroups.forEach(function (g) {
        var r = TAX_CLASSES[g.cls].ret;
        var min = r.minUvt * UVT;
        ret.push({ label: r.label, legal: r.legal, base: g.sub, amount: g.sub >= min ? pct(g.sub, r.bp) : 0,
          note: g.sub >= min ? 'Base sin IVA (NO VERIFICADO si se excluye el IVA de la base)' : 'Por debajo de la base mínima de ' + r.minUvt + ' UVT' });
      });
    }
    if (fiscal.client && fiscal.client.iva && t.iva > 0) {
      ret.push({ label: 'Retención de IVA (reteIVA) 15 % del IVA', legal: 'Art. 437-1 ET (fuente secundaria); bases mínimas NO VERIFICADAS', base: t.iva, amount: pct(t.iva, RETEIVA_BP), note: '' });
    }
    if (fiscal.client && fiscal.client.ica && fiscal.city === 'Bogotá D. C.') {
      ret.push({ label: 'ReteICA Bogotá 7,60 ‰ (CIIU 4330)', legal: 'Tarifa de fuente secundaria (Rankia 2026): NO VERIFICADO; Acuerdo 724/2026 cambia tarifas desde 2027', base: t.subtotal, amount: pct(t.subtotal, RETEICA_BP), note: '' });
    }
    t.retenciones = ret;
    t.retTotal = ret.reduce(function (s, r) { return s + r.amount; }, 0);
    t.neto = t.total - t.retTotal;
    t.icaContratista = fiscal.city === 'Bogotá D. C.' ? pct(t.subtotal, RETEICA_BP) : null;
    t.overNoRespThreshold = regime === 'no_responsable' && t.total >= UVT_3500;
    // Con partidas sin precio el total real será mayor: el tope podría superarse aunque el total parcial no lo haga.
    t.noRespMayExceed = regime === 'no_responsable' && !t.overNoRespThreshold && unpriced > 0;
    return t;
  }

  /** Ejemplo explicativo de §11.3: recargo (AIU sobre costo) frente a margen sobre venta. */
  function priceFromCost(cost, bp, method) {
    if (method === 'margen') return divRound(cost * 10000, 10000 - bp);
    return cost + pct(cost, bp);
  }

  root.OBCalc = {
    IVA_BP: IVA_BP, UVT: UVT, UVT_3500: UVT_3500, UVT_50: UVT_50, PUBLISHED_MAX_AGE_DAYS: PUBLISHED_MAX_AGE_DAYS,
    DEMO_TODAY: DEMO_TODAY, ENGINE_VERSION: ENGINE_VERSION, taxClassOf: taxClassOf, RETEIVA_BP: RETEIVA_BP, RETEICA_BP: RETEICA_BP, TAX_CLASSES: TAX_CLASSES, REGIMES: REGIMES,
    divRound: divRound, pct: pct, toMilli: toMilli, ivaIsCost: ivaIsCost, costUnit: costUnit, netUnit: netUnit,
    resourceCost: resourceCost, lineCost: lineCost, daysBetween: daysBetween, priceStatus: priceStatus, hasLaborProxy: hasLaborProxy, singleStatus: singleStatus,
    totals: totals, priceFromCost: priceFromCost
  };
})(typeof window !== 'undefined' ? window : globalThis);
