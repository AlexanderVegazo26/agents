// @ts-check
// Interfaz del prototipo ObraBase AI (iteración 2). Script clásico, sin dependencias, sin red.
// Todo texto se inserta con textContent (nunca innerHTML); los enlaces externos solo aceptan http(s).
(function () {
  'use strict';
  var C = window.OBCalc;
  var D = window.OBData;
  var P = window.OBPrices;
  var KEY = 'obrabase-demo-v3';
  var CRLF = String.fromCharCode(13, 10);

  var PERSONAS = {
    laura: { name: 'Laura Gómez', role: 'Presupuestista' },
    andres: { name: 'Andrés Rincón', role: 'Gerente comercial' },
    camila: { name: 'Ing. Camila Torres', role: 'Responsable técnica' }
  };
  var STATUS = {
    SITE_SURVEY_PENDING: 'Visita técnica pendiente',
    COST_REVIEW: 'Revisión económica',
    APPROVED: 'Versión aprobada',
    PROPOSAL_SENT: 'Cotización enviada'
  };
  var STATUS_TONE = { SITE_SURVEY_PENDING: 'warn', COST_REVIEW: 'info', APPROVED: 'ok', PROPOSAL_SENT: 'ok' };
  var PRICE_LABEL = {
    pendiente: 'Pendiente', publicado: 'Publicado', cotizacion_vigente: 'Cotización vigente',
    referencia: 'Referencia', estimado: 'Mano de obra estimada', emisor: 'Estimación del emisor',
    publicado_manual: 'Publicado (registrado)', vencido: 'Vencido'
  };
  var PRICE_HELP = {
    pendiente: 'No existe un precio con fuente: no se inventa.',
    publicado: 'Precio real publicado por el proveedor (consultado el 15/10/2026). No demuestra disponibilidad.',
    cotizacion_vigente: 'Cotización recibida y registrada por el emisor, dentro de su vigencia.',
    publicado_manual: 'Precio publicado registrado a mano por el emisor, con su enlace y fecha de consulta; no verificado por el sistema.',
    emisor: 'Valor registrado a mano por el emisor, con fuente y justificación en la auditoría; no verificado por el sistema.',
    referencia: 'Valor de una base de precios (no de un proveedor).',
    estimado: 'Incluye mano de obra estimada por el sistema: tarifa de referencia × rendimiento supuesto.',
    vencido: 'Ya no cumple la política de vigencia: revalidar.'
  };
  var TYPE_LABEL = { publicado: 'Precio publicado', cotizado: 'Cotización recibida', referencia: 'Precio de referencia', estimado: 'Estimación interna' };
  var KIND_LABEL = { material: 'Material', mano_obra: 'Mano de obra', servicio: 'Servicio', equipo: 'Equipo' };
  var FIELD_LABEL = { confirmado: 'Confirmado', inferido: 'Inferencia IA', supuesto: 'Supuesto', pendiente: 'Pendiente', por_verificar: 'Por verificar' };
  var FIELD_TONE = { confirmado: 'ok', inferido: 'ai', supuesto: 'warn', pendiente: 'bad', por_verificar: 'warn' };
  var CLASS_SHORT = { construccion: 'Construcción · IVA sobre la utilidad', reparacion: 'Reparación · IVA sobre el total', venta: 'Venta con instalación · IVA sobre el total', honorarios: 'Honorarios · IVA sobre el total' };
  var CLASS_NAME = { construccion: 'Construcción', reparacion: 'Reparación o mantenimiento', venta: 'Venta con instalación', honorarios: 'Honorarios' };
  var REGIME_NAME = { responsable: 'Responsable de IVA', simple: 'Régimen SIMPLE', no_responsable: 'No responsable de IVA' };
  var RET_NOTE = 'Supuesto del prototipo (sin fuente primaria): la retención se divide según la clase fiscal de cada capítulo. En un contrato mixto, la base la define el agente retenedor con su contador.';
  var NOT_ADVICE = 'Reglas tomadas de la investigación de 15/10/2026 (DIAN, DUR 1625/2016, ET). No es asesoría tributaria: un contador debe validar la clasificación.';

  var moneyFmt = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  var numFmt = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
  function cop(n) { return n === null || n === undefined ? '—' : moneyFmt.format(n); }
  function nf(n) { return n === null || n === undefined ? '—' : numFmt.format(n); }
  var NBSP = String.fromCharCode(160);
  function nb(s) { return typeof s === 'string' ? s.split(' %').join(NBSP + '%').split(' ‰').join(NBSP + '‰') : s; }
  function pctLabel(bp) { return numFmt.format(bp / 100) + NBSP + '%'; }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
    return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  function fmtDateTime(iso) { return new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }); }
  function localIso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function addDays(iso, n) {
    var d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n));
    return d.toISOString().slice(0, 10);
  }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  // Revisión de seguridad F5/N3: https, sin credenciales ni «@» o «\» en la autoridad (ver public/js/url.js).
  function safeUrl(u) { return window.OBUrl.safeUrl(u); }
  // Hosts de los proveedores conocidos (los de los precios reales): un enlace registrado a mano con otro host se advierte.
  var KNOWN_HOSTS = {};
  Object.keys(P).forEach(function (k) { var host = window.OBUrl.hostOf(P[k].url); if (host) KNOWN_HOSTS[host] = true; });

  // ---------- DOM helper (solo textContent) ----------
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    if (typeof c === 'string' || typeof c === 'number') { el.appendChild(document.createTextNode(String(c))); return; }
    el.appendChild(c);
  }
  function badge(tone, text, title) { return h('span', { class: 'badge ' + tone, title: title || null }, text); }
  function priceBadge(status) { return badge('p-' + status, PRICE_LABEL[status], PRICE_HELP[status]); }
  function fieldBadge(status) { return badge(FIELD_TONE[status], FIELD_LABEL[status]); }
  function extLink(url, text, showHost) {
    var u = safeUrl(url);
    if (!u) return h('span', { class: 'muted' }, 'Sin enlace');
    var host = window.OBUrl.hostOf(u);
    return h('span', { class: 'ext-wrap' },
      h('a', { href: u, target: '_blank', rel: 'noopener noreferrer external', class: 'ext' }, text || 'Ver en el sitio del proveedor', h('span', { class: 'sr-only' }, ' (abre en otra pestaña)')),
      showHost ? h('span', { class: 'small muted host', text: ' (' + host + ')' }) : null,
      showHost && !KNOWN_HOSTS[host] ? h('span', { class: 'block' }, badge('warn', 'Dominio no listado como proveedor', 'El host del enlace no está entre los proveedores de la investigación de precios: verifíquelo antes de usarlo.')) : null);
  }
  function td(label, props) {
    var p = props || {};
    p['data-label'] = label;
    var cell = h('div', { class: 'cell' });
    for (var i = 2; i < arguments.length; i++) add(cell, arguments[i]);
    return h('td', p, cell);
  }

  // ---------- Estado ----------
  var state;
  var ui = { statusFilter: 'all', priceFilter: 'all', expanded: {}, draft: null };

  function actorName() { var p = PERSONAS[state.persona]; return p.name + ' (' + p.role + ')'; }
  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      return s && s.version === 3 && Array.isArray(s.projects) ? s : null;
    } catch (e) {
      console.warn('Estado local ilegible; se restaura el demo.', e);
      return null;
    }
  }
  function audit(p, action, detail, before, after, why, opt) {
    p.audit.unshift({ at: (opt && opt.at) || new Date().toISOString(), actor: (opt && opt.actor) || actorName(),
      action: action, detail: detail || '', before: before || '', after: after || '', why: why || '' });
  }
  function findProject(id) { return state.projects.filter(function (p) { return p.id === id; })[0]; }
  function lastApproved(p) { return p.versions.length ? p.versions[p.versions.length - 1] : null; }
  function isFrozen(p) { var v = lastApproved(p); return !!v && v.n === p.working; }
  function fieldOf(fields, key) { return fields.filter(function (x) { return x.key === key; })[0] || null; }
  function fieldVal(p, key) { var f = fieldOf(p.fields, key); return f ? f.value : null; }

  function beginEdit(p) {
    if (!isFrozen(p)) return;
    var prev = p.working;
    p.working = prev + 1;
    p.status = 'COST_REVIEW';
    audit(p, 'Nueva versión de trabajo', 'v' + prev + ' aprobada queda inmutable', 'v' + prev, 'v' + p.working + ' (borrador)');
    toast('La versión v' + prev + ' aprobada no se modifica: se creó el borrador v' + p.working + '.', 'info');
  }

  // Vista de cálculo: proyecto vivo o versión congelada.
  function view(p, v) {
    if (v) return { lines: v.lines, policy: v.policy, fiscal: v.fiscal, params: v.params, fields: v.fields, exclusions: v.exclusions, chapters: v.chapters };
    return { lines: p.lines, policy: p.policy, fiscal: p.fiscal, params: p.params, fields: p.fields, exclusions: p.exclusions, chapters: p.chapters };
  }
  function activeLines(x) { return x.lines.filter(function (l) { return l.active !== false; }); }
  function fiscalCtx(x) { return { regime: x.fiscal.regime, classes: x.fiscal.classes, client: x.fiscal.client, city: x.params.ciudad }; }
  function lineCtx(x, l) { return { regime: x.fiscal.regime, taxClass: C.taxClassOf(x.fiscal, l.chapter) }; }
  function classShort(cls) { return cls && CLASS_SHORT[cls] ? CLASS_SHORT[cls] : 'Sin clase fiscal'; }
  function classInfo(cls) { return cls && C.TAX_CLASSES[cls] ? C.TAX_CLASSES[cls] : { label: 'Sin clase fiscal asignada', legal: 'Asigne una clase fiscal a este capítulo.', ivaBase: 'total' }; }
  function totalsOf(x) { return C.totals(activeLines(x), x.policy, fiscalCtx(x)); }
  function pendingRes(l) { return l.resources.filter(function (r) { return !r.price; }); }

  function priceLabel(price) {
    if (!price) return 'Sin precio';
    return TYPE_LABEL[price.type] + ' ' + cop(price.unitPrice) + (price.ivaIncluded === true ? ' (IVA incl.)' : price.ivaIncluded === false ? ' (+IVA)' : '');
  }
  function ivaText(price) {
    if (!price) return '—';
    return price.ivaIncluded === true ? 'IVA incluido' : price.ivaIncluded === false ? '+ IVA' : 'IVA no indicado';
  }

  function recompute(p) {
    D.refreshDerived(p.fields);
    p.params = D.paramsFromFields(p.fields);
    if (p.fiscal.classesAuto) {
      var next = D.defaultTaxClasses(p.params.estado);
      if (JSON.stringify(next) !== JSON.stringify(p.fiscal.classes)) { p.fiscal.classes = next; p.fiscal.reviewed = false; }
    }
    if (p.lines.length) D.applyQuantities(p.lines, p.params);
  }

  function buildProject(o) {
    var parsed = D.parseRequest(o.requestText);
    if (!parsed.ok) throw new Error(parsed.error);
    var fields = o.fields || parsed.fields;
    var params = D.paramsFromFields(fields);
    return {
      id: o.id, code: o.code, name: o.name, client: o.client, address: o.address || '',
      createdAt: o.at || new Date().toISOString(), requestText: o.requestText,
      fields: fields, chapters: parsed.chapters, exclusions: parsed.exclusions, params: params,
      lines: params.areaM2 > 0 ? D.generateLines(parsed.chapters, params) : [],
      policy: { adminBp: 800, contBp: 500, utilBp: 1000, method: 'aiu', allowEstimates: true },
      fiscal: { regime: 'responsable', classes: D.defaultTaxClasses(params.estado), classesAuto: true,
        client: { nit: o.nit || '', renta: !!o.agente, iva: false, ica: false }, reviewed: false },
      validityDays: 30, versions: [], working: 1, audit: [],
      status: params.areaM2 > 0 ? 'COST_REVIEW' : 'SITE_SURVEY_PENDING'
    };
  }

  function seed() {
    var s = { version: 3, persona: 'laura', seq: 3, projects: [],
      company: { name: 'Adecuaciones Pinzón & Asociados S.A.S.', nit: '', demo: true } };
    state = s;
    var laura = 'Laura Gómez (Presupuestista)';
    var p1 = buildProject({ id: 'salud-vital', code: 'OB-2026-001', name: 'Droguería Salud Vital — Chapinero',
      client: 'Inversiones Salud Vital S.A.S.', address: 'Cra. 13 # 59-42', at: '2026-10-08T14:05:00-05:00', agente: true,
      requestText: 'Adecuar un local de 64 m2 en Bogotá para droguería. Está en obra gris; acabados estándar, mobiliario, instalaciones eléctricas, iluminación, aire acondicionado, una caja y entrega llave en mano.' });
    audit(p1, 'Proyecto creado', 'Desde texto libre (IA simulada)', '', '', '', { actor: laura, at: '2026-10-08T14:05:00-05:00' });
    var p2 = buildProject({ id: 'los-andes', code: 'OB-2026-002', name: 'Farmacia Los Andes — Suba', client: 'Farmacias Los Andes S.A.S.',
      address: 'Av. Suba # 115-20', at: '2026-10-13T11:30:00-05:00',
      requestText: 'Local de 110 m² en Bogotá para farmacia, ya tiene pisos. Necesitamos mobiliario, iluminación, dos cajas y aire acondicionado. Algunos medicamentos requieren refrigeración.' });
    audit(p2, 'Proyecto creado', 'Desde texto libre (IA simulada)', '', '', '', { actor: laura, at: '2026-10-13T11:30:00-05:00' });
    var p3 = buildProject({ id: 'nueva-granada', code: 'OB-2026-003',
      name: 'Droguería Nueva Granada — Kennedy, local 104 del Centro Comercial Plaza de las Américas, etapa II',
      client: 'Comercializadora Nueva Granada S.A.S.', address: 'Dirección por confirmar', at: '2026-10-14T17:10:00-05:00',
      requestText: 'El cliente quiere abrir una droguería en Kennedy, Bogotá. Falta la visita para medir el local. Quiere mobiliario y punto de venta.' });
    audit(p3, 'Proyecto creado', 'Falta el área: visita técnica pendiente', '', '', '', { actor: laura, at: '2026-10-14T17:10:00-05:00' });
    s.projects = [p3, p2, p1];
    return s;
  }

  // ---------- Validaciones de aprobación ----------
  function checks(p) {
    var x = view(p);
    var blockers = [], warnings = [];
    var t = totalsOf(x);
    var base = '#/proyecto/' + p.id;
    var est = 0, emisor = 0;
    if (!p.lines.length) blockers.push({ text: 'El proyecto no tiene partidas: falta registrar el área del local.', href: base + '/levantamiento' });
    t.unclassified.forEach(function (ch) {
      blockers.push({ text: 'El capítulo ' + ch + ' (' + (D.CHAPTERS[ch] || 'desconocido') + ') no tiene clase fiscal: sus partidas no se suman.', href: base + '/presupuesto#fiscal' });
    });
    activeLines(x).forEach(function (l) {
      if (l.included === false) return;
      pendingRes(l).forEach(function (r) {
        blockers.push({ text: 'Sin precio: ' + l.code + ' ' + r.label + '. ' + (r.pendingReason || ''), href: base + '/presupuesto', line: l.code, res: r.key });
      });
      var s = C.priceStatus(l);
      if (C.hasLaborProxy(l)) est++;
      if (l.resources.some(function (r) { return r.price && r.price.manual && r.price.type === 'estimado'; })) emisor++;
      if (s === 'vencido') warnings.push({ text: 'Precio vencido en ' + l.code + ' ' + l.desc + '.', href: base + '/presupuesto' });
      if (l.techReview && !l.techValidated) warnings.push({ text: 'Cantidad sin validación técnica: ' + l.code + ' ' + l.desc + '.', href: base + '/presupuesto' });
      l.resources.forEach(function (r) {
        var m = r.chosen ? D.meta(r.chosen) : {};
        if (m.verify) warnings.push({ text: l.code + ' ' + r.label + ': ' + m.verify + '.', href: base + '/comparar/' + l.code });
      });
    });
    if (est && !p.policy.allowEstimates) {
      blockers.push({ text: 'La política no permite aprobar con mano de obra estimada por el sistema y hay ' + est + ' partidas que la incluyen.', href: base + '/presupuesto' });
    } else if (est) {
      warnings.push({ text: est + ' partidas incluyen mano de obra estimada (tarifa de referencia × rendimiento supuesto): se identifican en la cotización.', href: base + '/presupuesto' });
    }
    if (emisor) warnings.push({ text: emisor + ' partidas usan una estimación registrada por el emisor (fuente y justificación en la auditoría): se identifican en la cotización.', href: base + '/historial' });
    if (!p.fiscal.reviewed) blockers.push({ text: 'Revisión fiscal pendiente: confirme la clasificación de cada capítulo con el contador.', href: base + '/presupuesto#fiscal' });
    if (t.overNoRespThreshold) {
      blockers.push({ text: 'El contrato (' + cop(t.total) + ') iguala o supera 3.500 UVT (' + cop(C.UVT_3500) + '): un no responsable de IVA debe inscribirse como responsable ANTES de celebrarlo (Oficio DIAN 13873 de 2026).', href: base + '/presupuesto#fiscal' });
    } else if (t.noRespMayExceed) {
      warnings.push({ text: 'No responsable de IVA con partidas sin precio: el total real podría superar 3.500 UVT (' + cop(C.UVT_3500) + '). Revíselo al completar los precios.', href: base + '/presupuesto#fiscal' });
    }
    if (p.params.alturaM > 2.5 && activeLines(x).some(function (l) { return l.code === '03.04'; })) {
      warnings.push({ text: 'Altura libre de ' + nf(p.params.alturaM) + ' m: el servicio de pintura excluye andamios por encima de 2,50 m; su costo no está incluido (NO VERIFICADO).', href: base + '/presupuesto' });
    }
    if (p.params.ciudad !== 'Bogotá D. C.') warnings.push({ text: 'Ciudad ' + p.params.ciudad + ': los precios se consultaron en tiendas con cobertura en Bogotá y la reteICA solo está modelada para Bogotá.', href: base + '/levantamiento' });
    var open = p.fields.filter(function (f) { return f.status !== 'confirmado' && f.status !== 'inferido'; }).length;
    if (open) warnings.push({ text: open + ' datos del levantamiento siguen como supuestos o pendientes: aparecerán como hipótesis.', href: base + '/levantamiento' });
    return { blockers: blockers, warnings: warnings, totals: t };
  }

  // ---------- Toast, diálogos ----------
  var toastTimer = null;
  function toast(msg, tone) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show ' + (tone || 'ok');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 4000);
  }
  function openDialog(title, bodyNodes, confirmLabel, onConfirm, tone) {
    var err = h('p', { class: 'form-error', role: 'alert', id: 'dlg-error' });
    var form = h('form', { method: 'dialog', class: 'dialog-form', novalidate: true },
      h('h2', { id: 'dlg-title', text: title }), bodyNodes, err,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onclick: function () { dlg.close(); } }, 'Cancelar'),
        h('button', { type: 'submit', class: 'btn ' + (tone || 'primary'), id: 'dlg-confirm' }, confirmLabel)));
    var dlg = h('dialog', { 'aria-labelledby': 'dlg-title' }, form);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var e = onConfirm(form);
      if (e) { err.textContent = e; return; }
      dlg.close();
    });
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
    var first = form.querySelector('input, select, textarea');
    if (first) first.focus();
  }

  // ---------- Router ----------
  function render(isRerender) {
    var hash = location.hash.slice(1) || '/';
    var path = hash.split('#')[0];
    var parts = path.split('/').filter(Boolean);
    var main = document.getElementById('app');
    var v;
    if (!parts.length) v = viewProjects();
    else if (parts[0] === 'nuevo') v = viewNew();
    else if (parts[0] === 'proyecto' && findProject(parts[1])) {
      var p = findProject(parts[1]);
      if (parts[2] === 'comparar') v = viewCompare(p, parts[3]);
      else if (parts[2] === 'cotizacion' || parts[2] === 'propuesta') v = viewQuote(p, parts[3]);
      else v = viewProject(p, parts[2] || 'resumen');
    } else v = viewNotFound();
    main.textContent = '';
    main.appendChild(v);
    var h1 = main.querySelector('h1');
    if (h1) h1.setAttribute('tabindex', '-1');
    document.title = (h1 ? h1.textContent + ' · ' : '') + 'ObraBase AI (prototipo)';
    document.getElementById('persona').value = state.persona;
    if (!isRerender) {
      window.scrollTo(0, 0);
      if (h1 && document.body.dataset.ready) h1.focus();
      var anchor = hash.split('#')[1];
      if (anchor) { var a = document.getElementById(anchor); if (a) a.scrollIntoView(); }
    }
    document.body.dataset.ready = '1';
  }
  function rerender() {
    var id = document.activeElement && document.activeElement.id;
    var y = window.scrollY;
    render(true);
    if (id) { var el = document.getElementById(id); if (el) el.focus({ preventScroll: true }); }
    window.scrollTo(0, y);
  }
  function viewNotFound() {
    return h('section', { class: 'empty' }, h('h1', { text: 'Página no encontrada' }),
      h('p', { text: 'El proyecto o la versión que busca no existe en este demo.' }),
      h('a', { class: 'btn primary', href: '#/' }, 'Volver a proyectos'));
  }

  // ---------- Proyectos ----------
  function viewProjects() {
    var fl = ui.statusFilter;
    var list = state.projects.filter(function (p) { return fl === 'all' || p.status === fl; });
    var sel = h('select', { id: 'f-status', onchange: function (e) { ui.statusFilter = e.target.value; rerender(); } },
      h('option', { value: 'all', text: 'Todos los estados' }),
      Object.keys(STATUS).map(function (k) { return h('option', { value: k, text: STATUS[k] }); }));
    sel.value = fl;
    var body;
    if (!list.length) {
      body = h('div', { class: 'empty' },
        h('h2', { text: 'No hay proyectos en este estado' }),
        h('p', { text: 'Ningún proyecto está en «' + STATUS[fl] + '».' }),
        h('button', { class: 'btn', type: 'button', onclick: function () { ui.statusFilter = 'all'; rerender(); } }, 'Ver todos los proyectos'));
    } else {
      body = h('div', { class: 'cards' }, list.map(function (p) {
        var x = view(p);
        var t = p.lines.length ? totalsOf(x) : null;
        var pend = p.lines.length ? activeLines(x).filter(function (l) { return l.included !== false && pendingRes(l).length; }).length : 0;
        var area = fieldVal(p, 'areaM2');
        return h('article', { class: 'pcard' },
          h('div', { class: 'pcard-head' },
            h('h2', { class: 'h3 pcard-title', title: p.name }, h('a', { href: '#/proyecto/' + p.id }, p.name)),
            badge(STATUS_TONE[p.status], STATUS[p.status])),
          h('p', { class: 'muted small', text: p.code + ' · ' + p.client + ' · v' + p.working + (isFrozen(p) ? ' aprobada' : ' borrador') }),
          h('dl', { class: 'pcard-kv' },
            h('dt', { text: 'Área' }), h('dd', { text: area ? nf(area) + ' m²' : 'Por medir' }),
            h('dt', { text: 'Total estimado' }), h('dd', { class: 'strong', text: t ? cop(t.total) : '—' }),
            h('dt', { text: 'Partidas sin precio' }), h('dd', null, p.lines.length ? (pend ? badge('bad', String(pend)) : badge('ok', 'Ninguna')) : '—')),
          h('p', { class: 'small muted pcard-note', text: t && pend ? 'El total no incluye las partidas sin precio.' : ' ' }));
      }));
    }
    return h('section', null,
      h('div', { class: 'page-head' },
        h('div', null, h('h1', { text: 'Proyectos' }), h('p', { class: 'muted', text: 'Cubicación de locales: cuánto cuesta adecuarlos, con precios reales y cada cifra trazable.' })),
        h('a', { class: 'btn primary', href: '#/nuevo', id: 'btn-nuevo' }, '+ Nuevo proyecto')),
      h('div', { class: 'toolbar' }, h('label', { for: 'f-status' }, 'Filtrar por estado'), sel),
      body);
  }

  // ---------- Matriz de completitud ----------
  function fieldInput(f, idPrefix, onValue) {
    if (f.kind === 'number') {
      return h('input', { type: 'number', id: idPrefix + f.key, min: '0', step: 'any', inputmode: 'decimal', class: 'num-input',
        'aria-label': f.label, value: f.value === null ? '' : String(f.value), onchange: function (e) { onValue(f, e.target.value, e.target); } });
    }
    if (f.kind === 'select') {
      var s = h('select', { id: idPrefix + f.key, 'aria-label': f.label, onchange: function (e) { onValue(f, e.target.value, e.target); } },
        f.options.map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
      s.value = f.value;
      return s;
    }
    return f.value === null ? h('span', { class: 'muted' }, '—') : h('span', { text: String(f.value) });
  }
  function renderMatrix(fields, opts) {
    return h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'Matriz de completitud', tabindex: '0' },
      h('table', { class: 'data matrix stack' },
        h('caption', { class: 'sr-only', text: 'Matriz de completitud del levantamiento' }),
        h('thead', null, h('tr', null, ['Dato', 'Valor', 'Estado', 'Origen y acción'].map(function (c) { return h('th', { scope: 'col', text: c }); }))),
        h('tbody', null, fields.map(function (f) {
          var canConfirm = f.status === 'inferido' || f.status === 'supuesto';
          return h('tr', null,
            h('th', { scope: 'row', text: f.label }),
            td('Valor', null, fieldInput(f, opts.idPrefix, opts.onValue)),
            td('Estado', null, fieldBadge(f.status)),
            td('Origen y acción', null,
              f.evidence ? h('span', { class: 'evidence' }, 'Texto de origen: «' + f.evidence + '»') : null,
              h('span', { class: 'small block' }, 'Acción: ' + f.action),
              canConfirm ? h('button', { type: 'button', class: 'btn small', id: opts.idPrefix + 'ok-' + f.key, onclick: function () { opts.onConfirm(f); } }, 'Confirmar') : null));
        }))));
  }
  function parseFieldValue(f, v) {
    if (f.kind === 'number') { var n = parseFloat(v); return n >= 0 && n <= 100000 ? n : null; }
    return v;
  }

  // ---------- Nuevo proyecto ----------
  function viewNew() {
    var d = ui.draft || (ui.draft = { name: '', client: '', address: '', text: '', parsed: null, loading: false, error: null, errors: {} });
    function inp(id, key, label, required, hint) {
      var err = d.errors[key];
      return h('div', { class: 'field' },
        h('label', { for: id }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
        h('input', { id: id, type: 'text', value: d[key], required: required, 'aria-invalid': err ? 'true' : null,
          'aria-describedby': err ? id + '-err' : (hint ? id + '-hint' : null), autocomplete: 'off', oninput: function (e) { d[key] = e.target.value; } }),
        hint ? h('span', { class: 'hint', id: id + '-hint', text: hint }) : null,
        err ? h('span', { class: 'field-error', id: id + '-err', text: err }) : null);
    }
    var textErr = d.errors.text;
    var textarea = h('textarea', { id: 'req-text', rows: '6', 'aria-invalid': textErr ? 'true' : null,
      'aria-describedby': textErr ? 'req-text-err' : 'req-text-hint', oninput: function (e) { d.text = e.target.value; } });
    textarea.value = d.text;

    function interpret() {
      d.errors = {}; d.error = null;
      if (d.text.trim().length < 20) {
        d.errors.text = 'Describa el proyecto con al menos una frase: local, ciudad, área y trabajos.';
        rerender(); document.getElementById('req-text').focus(); return;
      }
      d.loading = true; d.parsed = null; rerender();
      setTimeout(function () {
        var r = D.parseRequest(d.text);
        d.loading = false;
        if (r.ok) d.parsed = r; else d.error = r.error;
        render(true);
        var target = document.getElementById(r.ok ? 'res-title' : 'interp-error');
        if (target) target.focus();
      }, 900);
    }
    function create() {
      d.errors = {};
      if (!d.name.trim()) d.errors.name = 'Escriba el nombre comercial del proyecto.';
      if (!d.client.trim()) d.errors.client = 'Escriba el nombre del cliente.';
      var params = D.paramsFromFields(d.parsed.fields);
      if (!(params.areaM2 > 0)) d.errors.area = 'Registre el área del local (m²): es el parámetro principal para calcular cantidades y precios.';
      if (Object.keys(d.errors).length) {
        rerender();
        document.getElementById(d.errors.name ? 'np-name' : d.errors.client ? 'np-client' : 'nw-areaM2').focus();
        return;
      }
      state.seq += 1;
      var code = 'OB-2026-' + String(state.seq).padStart(3, '0');
      var p = buildProject({ id: 'p' + Date.now().toString(36), code: code, name: d.name.trim(), client: d.client.trim(),
        address: d.address.trim(), requestText: d.text, fields: d.parsed.fields });
      audit(p, 'Proyecto creado', 'Desde texto libre (IA simulada)');
      audit(p, 'Partidas generadas', activeLines(view(p)).length + ' partidas con precios reales consultados el 15/10/2026');
      state.projects.unshift(p);
      save();
      ui.draft = null;
      location.hash = '#/proyecto/' + p.id + '/presupuesto';
      toast('Proyecto ' + code + ' creado. Revise las partidas pendientes y la clasificación fiscal.', 'ok');
    }

    var results = null;
    if (d.loading) {
      results = h('div', { class: 'card loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Interpretando la solicitud…');
    } else if (d.error) {
      results = h('div', { class: 'card error-card', role: 'alert' },
        h('h2', { id: 'interp-error', tabindex: '-1', text: 'No pude interpretar la solicitud' }), h('p', { text: d.error }),
        h('button', { type: 'button', class: 'btn', onclick: interpret }, 'Reintentar'));
    } else if (d.parsed) {
      var r = d.parsed;
      results = h('section', { class: 'card', 'aria-labelledby': 'res-title' },
        h('h2', { id: 'res-title', tabindex: '-1', text: '2. Lo que entendí de la solicitud' }),
        h('p', { class: 'muted', text: 'La IA (simulada en este prototipo) solo extrae lo que el texto dice y muestra la evidencia. Lo que no dice queda como Pendiente o Supuesto. Nunca propone precios: los precios salen de proveedores reales.' }),
        renderMatrix(r.fields, {
          idPrefix: 'nw-',
          onValue: function (f, v) {
            var val = parseFieldValue(f, v);
            f.value = val; f.status = val === null ? 'pendiente' : 'confirmado'; f.evidence = val === null ? null : 'Registrado manualmente';
            f.derived = false;
            D.refreshDerived(r.fields);
            rerender();
          },
          onConfirm: function (f) { f.status = 'confirmado'; f.derived = false; rerender(); }
        }),
        d.errors.area ? h('p', { class: 'field-error', id: 'area-err', role: 'alert', text: d.errors.area }) : null,
        h('div', { class: 'two-col' },
          h('div', null, h('h3', { text: 'Capítulos que se generarán' }),
            h('ul', { class: 'chips' }, r.chapters.map(function (c) { return h('li', { text: c + ' · ' + D.CHAPTERS[c] }); }))),
          h('div', null, h('h3', { text: 'Exclusiones' }), h('ul', null, r.exclusions.map(function (x) { return h('li', { text: x }); })))),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', id: 'btn-crear', onclick: create }, 'Crear proyecto y calcular presupuesto')));
    }
    return h('section', null,
      h('nav', { class: 'crumbs', 'aria-label': 'Ruta' }, h('a', { href: '#/' }, 'Proyectos'), ' / Nuevo proyecto'),
      h('h1', { text: 'Nuevo proyecto' }),
      h('section', { class: 'card', 'aria-labelledby': 'step1' },
        h('h2', { id: 'step1', text: '1. Datos generales y solicitud' }),
        h('div', { class: 'grid3' },
          inp('np-name', 'name', 'Nombre comercial del proyecto', true, 'Ej.: Droguería Central — Teusaquillo'),
          inp('np-client', 'client', 'Cliente', true),
          inp('np-address', 'address', 'Dirección del inmueble', false)),
        h('div', { class: 'field' },
          h('label', { for: 'req-text' }, 'Describa el proyecto como lo pidió el cliente', h('span', { class: 'req', 'aria-hidden': 'true' }, ' *')),
          textarea,
          h('span', { class: 'hint', id: 'req-text-hint', text: 'Texto libre: tipo de negocio, ciudad, área en m², estado del local, trabajos incluidos y exclusiones.' }),
          textErr ? h('span', { class: 'field-error', id: 'req-text-err', text: textErr }) : null),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn', id: 'btn-ejemplo', onclick: function () {
            d.text = D.EXAMPLE_REQUEST; if (!d.name) d.name = 'Droguería Calle 80 — Engativá'; if (!d.client) d.client = 'Drogas La Esperanza S.A.S.'; d.errors = {}; rerender();
          } }, 'Usar ejemplo: droguería de 80 m² en Bogotá'),
          h('button', { type: 'button', class: 'btn primary', id: 'btn-interpretar', disabled: d.loading, onclick: interpret }, d.loading ? 'Interpretando…' : 'Interpretar solicitud'))),
      results);
  }

  // ---------- Proyecto ----------
  function viewProject(p, tab) {
    var tabs = [['resumen', 'Resumen'], ['levantamiento', 'Levantamiento'], ['presupuesto', 'Presupuesto'], ['aprobacion', 'Aprobación'], ['historial', 'Historial']];
    var area = fieldVal(p, 'areaM2');
    var content = tab === 'levantamiento' ? tabSurvey(p) : tab === 'presupuesto' ? tabBudget(p) : tab === 'aprobacion' ? tabApproval(p) : tab === 'historial' ? tabHistory(p) : tabSummary(p);
    var last = lastApproved(p);
    return h('section', null,
      h('nav', { class: 'crumbs', 'aria-label': 'Ruta' }, h('a', { href: '#/' }, 'Proyectos'), ' / ' + p.code),
      h('div', { class: 'page-head' },
        h('div', null,
          h('h1', { class: 'wrap', text: p.name }),
          h('p', { class: 'meta' },
            h('span', { text: p.client }), h('span', { text: p.params.ciudad }),
            h('span', { text: area ? nf(area) + ' m²' : 'Área por medir' }),
            badge(STATUS_TONE[p.status], STATUS[p.status]),
            badge(isFrozen(p) ? 'ok' : 'neutral', 'v' + p.working + (isFrozen(p) ? ' aprobada (solo lectura)' : ' borrador')))),
        h('div', { class: 'head-actions' },
          p.lines.length && !isFrozen(p) ? h('a', { class: 'btn', href: '#/proyecto/' + p.id + '/cotizacion/borrador', id: 'btn-preview' }, 'Vista previa de la cotización') : null,
          last ? h('a', { class: 'btn primary', href: '#/proyecto/' + p.id + '/cotizacion/' + last.n }, 'Cotización v' + last.n) : null)),
      h('nav', { class: 'tabs', 'aria-label': 'Secciones del proyecto' },
        tabs.map(function (t) { return h('a', { href: '#/proyecto/' + p.id + '/' + t[0], 'aria-current': t[0] === tab ? 'page' : null }, t[1]); })),
      content);
  }

  function nextStep(p, ck) {
    var base = '#/proyecto/' + p.id;
    if (!p.lines.length) return ['Registre el área (m²) del local para calcular el presupuesto.', base + '/levantamiento', 'Ir al levantamiento'];
    var b = ck.blockers.filter(function (x) { return x.line; })[0];
    if (b) return [b.text, base + '/presupuesto', 'Ir al presupuesto'];
    if (!p.fiscal.reviewed) return ['Revise la clasificación fiscal por capítulo con el contador.', base + '/presupuesto#fiscal', 'Ir a la revisión fiscal'];
    if (!isFrozen(p)) return [ck.blockers.length ? 'Resuelva los bloqueos de aprobación.' : 'El presupuesto puede enviarse a aprobación del gerente comercial.', base + '/aprobacion', 'Ir a aprobación'];
    if (p.status === 'APPROVED') return ['Versión aprobada: revise la cotización y envíela al cliente.', base + '/cotizacion/' + p.working, 'Ver cotización'];
    return ['Cotización enviada. Cualquier cambio creará una nueva versión.', base + '/cotizacion/' + lastApproved(p).n, 'Ver cotización'];
  }

  function tabSummary(p) {
    var ck = checks(p);
    var t = ck.totals;
    var x = view(p);
    var pend = activeLines(x).filter(function (l) { return l.included !== false && pendingRes(l).length; }).length;
    var est = activeLines(x).filter(function (l) { return l.included !== false && C.hasLaborProxy(l); }).length;
    var open = p.fields.filter(function (f) { return f.status === 'pendiente' || f.status === 'supuesto' || f.status === 'por_verificar'; }).length;
    var ns = nextStep(p, ck);
    var base = '#/proyecto/' + p.id;
    function stat(label, value, sub, href) {
      return h('a', { class: 'stat', href: href }, h('span', { class: 'stat-label', text: label }), h('span', { class: 'stat-value', text: value }), h('span', { class: 'small muted', text: sub }));
    }
    return h('div', null,
      h('div', { class: 'callout' }, h('strong', null, 'Siguiente paso: '), ns[0], ' ', h('a', { href: ns[1], class: 'btn small primary' }, ns[2])),
      h('div', { class: 'stats' },
        stat('Total estimado (con IVA)', p.lines.length ? cop(t.total) : '—', pend ? 'sin incluir ' + pend + ' partidas pendientes' : 'todas las partidas valoradas', base + '/presupuesto'),
        stat('Partidas sin precio', String(pend), pend ? 'bloquean la aprobación' : 'ninguna', base + '/presupuesto'),
        stat('Partidas con mano de obra estimada', String(est), 'tarifa real × rendimiento supuesto', base + '/presupuesto'),
        stat('Datos faltantes o supuestos', String(open), 'en la matriz de completitud', base + '/levantamiento'),
        stat('Bloqueos de aprobación', String(ck.blockers.length), ck.blockers.length ? 'ver detalle' : 'listo para aprobar', base + '/aprobacion')),
      h('section', { class: 'card' }, h('h2', { text: 'Actividad reciente' }),
        h('ol', { class: 'activity' }, p.audit.slice(0, 5).map(function (a) {
          return h('li', null, h('span', { class: 'muted small', text: fmtDateTime(a.at) + ' · ' + a.actor }), h('span', { class: 'block', text: a.action + (a.detail ? ': ' + a.detail : '') }));
        }))));
  }

  function onFieldChange(p) {
    return function (f, v, input) {
      var val = parseFieldValue(f, v);
      if (val === null || (f.kind === 'number' && f.key !== 'mlDivisiones' && f.key !== 'gondolasCentrales' && !(val > 0))) {
        toast('«' + f.label + '» debe ser un número mayor que 0. No se aplicó el cambio.', 'bad');
        input.value = f.value === null ? '' : String(f.value);
        return;
      }
      if (val === f.value) return;
      beginEdit(p);
      var before = f.value === null ? '—' : String(f.value);
      var totBefore = p.lines.length ? totalsOf(view(p)).total : null;
      f.value = val; f.status = 'confirmado'; f.evidence = 'Registrado por ' + actorName(); f.derived = false;
      if (f.key === 'estado' && p.fiscal.reviewed) { p.fiscal.reviewed = false; toast('El estado del local cambió: vuelva a revisar la clasificación fiscal.', 'info'); }
      recompute(p);
      audit(p, 'Parámetro actualizado', f.label, before, String(val));
      save();
      rerender();
      if (p.lines.length) toast('Cantidades y precios recalculados. Total: ' + cop(totBefore) + ' → ' + cop(totalsOf(view(p)).total) + '.', 'ok');
    };
  }
  function onFieldConfirm(p) {
    return function (f) {
      beginEdit(p);
      var before = FIELD_LABEL[f.status];
      f.status = 'confirmado'; f.derived = false;
      audit(p, 'Dato confirmado', f.label, before, 'Confirmado');
      save(); rerender();
    };
  }

  function requirementStatuses(x) {
    var codes = {};
    activeLines(x).forEach(function (l) { if (l.included !== false) codes[l.code] = l; });
    return D.REQUIREMENTS.map(function (r) {
      var covered = r.covers.filter(function (c) { return codes[c]; });
      var status, tone;
      if (covered.length) { status = 'Cubierto en ' + covered.join(', '); tone = 'ok'; }
      else if (r.unless) { status = 'No aplica por ahora: ' + r.unless; tone = 'warn'; }
      else { status = r.fallback || 'No cubierto'; tone = r.fallback && r.fallback.indexOf('validación') >= 0 ? 'warn' : 'bad'; }
      return { text: r.text, source: r.source, note: r.note || '', status: status, tone: tone, label: covered.length ? 'Cubierto' : tone === 'warn' ? 'Validar' : 'No incluido' };
    });
  }
  function renderRequirements(list) {
    return h('ul', { class: 'reqs' }, list.map(function (r) {
      return h('li', null, h('span', { class: 'block strong', text: r.text }), h('span', { class: 'small muted block', text: r.source }),
        badge(r.tone, r.label), ' ', h('span', { class: 'small', text: r.status }),
        r.note ? h('span', { class: 'small muted block', text: r.note }) : null);
    }));
  }
  function requirementsList(x) { return renderRequirements(requirementStatuses(x)); }

  function tabSurvey(p) {
    var gen = null;
    if (!p.lines.length) {
      var ok = p.params.areaM2 > 0;
      gen = h('div', { class: 'callout' }, ok ? 'El área ya está registrada.' : 'Registre el área del local (m²) para calcular el presupuesto.', ' ',
        h('button', { type: 'button', class: 'btn primary small', id: 'btn-generar', disabled: !ok, onclick: function () {
          p.lines = D.generateLines(p.chapters, p.params);
          p.status = 'COST_REVIEW';
          audit(p, 'Partidas generadas', activeLines(view(p)).length + ' partidas');
          save();
          location.hash = '#/proyecto/' + p.id + '/presupuesto';
          toast('Partidas generadas con precios reales.', 'ok');
        } }, 'Generar partidas'));
    }
    return h('div', null, gen,
      h('section', { class: 'card' }, h('h2', { text: 'Solicitud original' }), h('blockquote', { text: p.requestText })),
      h('section', { class: 'card' }, h('h2', { text: 'Matriz de completitud' }),
        h('p', { class: 'muted', text: 'Distingue lo confirmado de lo inferido por la IA y de los supuestos. Cambiar un parámetro recalcula cantidades, precios y totales.' }),
        renderMatrix(p.fields, { idPrefix: 'sv-', onValue: onFieldChange(p), onConfirm: onFieldConfirm(p) })),
      h('section', { class: 'card' }, h('h2', { text: 'Requisitos de droguería que mueven el costo' }),
        h('p', { class: 'muted small', text: 'Fuentes: normograma INVIMA, MinEnergía y UAECOB (research §3). La aprobación sanitaria la da la autoridad, no este sistema.' }),
        requirementsList(view(p))),
      h('div', { class: 'two-col' },
        h('section', { class: 'card' }, h('h2', { text: 'Alcance: capítulos' }),
          h('ul', { class: 'chips' }, p.chapters.map(function (c) { return h('li', { text: c + ' · ' + D.CHAPTERS[c] }); }))),
        h('section', { class: 'card' }, h('h2', { text: 'Exclusiones' }), h('ul', null, p.exclusions.map(function (x) { return h('li', { text: x }); })))));
  }

  // ---------- Presupuesto ----------
  function priceDialog(p, line, res) {
    var cur = res.price && res.price.manual ? res.price : null;
    var typeSel = h('select', { id: 'pd-type', name: 'type' },
      [['cotizado', 'Cotización recibida (con condiciones y vigencia)'], ['estimado', 'Estimación interna documentada'], ['publicado', 'Precio publicado por un proveedor (requiere enlace https)']].map(function (o) {
        return h('option', { value: o[0], text: o[1] });
      }));
    typeSel.value = cur ? cur.type : 'estimado';
    var body = [
      h('p', { class: 'muted', text: line.code + ' · ' + res.label + ' · cantidad ' + nf(res.qty) + ' ' + res.unit }),
      res.pendingReason ? h('p', { class: 'small warn-text', text: 'Por qué está pendiente: ' + res.pendingReason }) : null,
      h('div', { class: 'field' }, h('label', { for: 'pd-type' }, 'Tipo de precio'), typeSel,
        h('span', { class: 'hint', text: 'Una conversación informal sin condiciones no es una cotización. Un precio registrado aquí se marca como «registrado manualmente».' })),
      h('div', { class: 'field' }, h('label', { for: 'pd-price' }, 'Precio unitario (COP) por ' + res.unit),
        h('input', { id: 'pd-price', name: 'price', type: 'number', min: '1', step: '1', inputmode: 'numeric', value: cur ? String(cur.unitPrice) : '' })),
      h('label', { class: 'check', for: 'pd-iva' }, h('input', { type: 'checkbox', id: 'pd-iva', name: 'iva', checked: !!(cur && cur.ivaIncluded === true) }),
        ' El precio ya incluye IVA (márquelo solo si la fuente lo dice; el trabajo propio o una estimación interna normalmente no lo incluye)'),
      h('div', { class: 'field' }, h('label', { for: 'pd-source' }, 'Fuente (proveedor, número de cotización o método)'),
        h('input', { id: 'pd-source', name: 'source', type: 'text', value: cur ? cur.source : '' })),
      h('div', { class: 'field' }, h('label', { for: 'pd-url' }, 'Enlace de la fuente (obligatorio para «precio publicado»)'),
        h('input', { id: 'pd-url', name: 'url', type: 'url', placeholder: 'https://…', value: cur && cur.url ? cur.url : '' })),
      h('div', { class: 'field' }, h('label', { for: 'pd-date' }, 'Fecha de consulta o de la cotización'),
        h('input', { id: 'pd-date', name: 'date', type: 'date', value: cur && cur.date ? cur.date : C.DEMO_TODAY, max: C.DEMO_TODAY })),
      h('div', { class: 'field' }, h('label', { for: 'pd-valid' }, 'Vigencia hasta (obligatoria para cotizaciones)'),
        h('input', { id: 'pd-valid', name: 'valid', type: 'date', value: cur && cur.validUntil ? cur.validUntil : '' })),
      h('div', { class: 'field' }, h('label', { for: 'pd-why' }, 'Justificación'), h('textarea', { id: 'pd-why', name: 'why', rows: '2' }))
    ];
    openDialog('Registrar precio', body, 'Guardar precio', function (form) {
      var type = form.type.value, price = parseInt(form.price.value, 10), src = form.source.value.trim(), why = form.why.value.trim(), valid = form.valid.value;
      var url = form.url.value.trim();
      var date = form.date.value;
      if (!(price > 0)) return 'Escriba un precio unitario mayor que 0.';
      if (!date || date > C.DEMO_TODAY) return 'Indique la fecha de consulta (no puede ser posterior a ' + fmtDate(C.DEMO_TODAY) + ').';
      if (src.length < 3) return 'Indique la fuente o el método: no se aceptan precios sin fuente.';
      if (type === 'cotizado' && !valid) return 'Una cotización necesita fecha de vigencia.';
      if (type === 'publicado' && !safeUrl(url)) return 'Un precio publicado necesita el enlace https de la página del proveedor.';
      if (url && !safeUrl(url)) return 'El enlace debe empezar por https://.';
      if (why.length < 5) return 'Escriba una justificación (se guarda en la auditoría).';
      beginEdit(p);
      var target = p.lines.filter(function (l) { return l.code === line.code; })[0];
      var before = priceLabel(res.price);
      target.overrides[res.key] = { type: type, unitPrice: price, ivaIncluded: form.iva.checked, source: src, url: safeUrl(url) || '', date: date,
        validUntil: valid || null, confidence: type === 'estimado' ? 'Media' : 'Alta', why: why, manual: true };
      D.applyQuantities([target], p.params);
      audit(p, 'Precio registrado', line.code + ' ' + res.label, before, priceLabel(target.overrides[res.key]) + ' (registrado manualmente)', why);
      save(); rerender();
      toast('Precio guardado en ' + line.code + '. Totales recalculados.', 'ok');
      return null;
    });
  }
  function priceDialogFor(p, code, key) {
    var l = p.lines.filter(function (x) { return x.code === code; })[0];
    var r = l && l.resources.filter(function (x) { return x.key === key; })[0];
    if (l && r) priceDialog(p, l, r);
  }

  function validateQty(p, line) {
    if (state.persona !== 'camila') {
      toast('Solo la responsable técnica puede validar cantidades. Cambie a «Ing. Camila Torres» en el selector de persona.', 'bad');
      return;
    }
    beginEdit(p);
    line.techValidated = true;
    audit(p, 'Cantidad validada', line.code + ' ' + line.desc, 'Sin validar', 'Validado (' + nf(line.qtyInstalled) + ' ' + line.unit + ')');
    save(); rerender();
    toast('Cantidad de ' + line.code + ' validada.', 'ok');
  }
  function toggleIncluded(p, line) {
    beginEdit(p);
    line.included = line.included === false;
    audit(p, line.included ? 'Partida incluida' : 'Partida excluida', line.code + ' ' + line.desc);
    save(); rerender();
  }

  function apuTable(x, l, canEdit, p) {
    var ivaCost = C.ivaIsCost(x.fiscal.regime, C.taxClassOf(x.fiscal, l.chapter));
    return h('div', { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Análisis de precio unitario de ' + l.code },
      h('table', { class: 'data apu stack' },
        h('caption', { class: 'sr-only', text: 'Recursos de la partida ' + l.code }),
        h('thead', null, h('tr', null, ['Recurso', 'Producto y proveedor', 'Cantidad', 'Precio unitario', 'IVA en el costo', 'Costo', 'Estado'].map(function (c) { return h('th', { scope: 'col', text: c }); }))),
        h('tbody', null, l.resources.map(function (r) {
          var cost = C.resourceCost(r, ivaCost);
          var pr = r.price;
          return h('tr', null,
            h('th', { scope: 'row' }, h('span', { class: 'block', text: r.label }), h('span', { class: 'small muted', text: KIND_LABEL[r.kind] })),
            td('Producto y proveedor', { class: 'small' },
              pr ? [h('span', { class: 'block', text: pr.source }),
                pr.manual ? h('span', { class: 'block' }, badge('warn', 'Registrado manualmente'), ' consultado ' + fmtDate(pr.date)) : null,
                pr.sku ? h('span', { class: 'muted block', text: 'Ref. ' + pr.sku + ' · consultado ' + fmtDate(pr.date) }) : null,
                pr.url ? extLink(pr.url, pr.manual ? 'Enlace registrado por el emisor' : null, !!pr.manual) : null, pr.notes ? h('span', { class: 'muted block', text: pr.notes }) : null, pr.why ? h('span', { class: 'block', text: 'Justificación: ' + pr.why }) : null]
                : h('span', { class: 'bad-text', text: r.pendingReason || 'Sin precio' }),
              r.note ? h('span', { class: 'block warn-text', text: r.note }) : null),
            td('Cantidad', { class: 'small' }, h('span', { class: 'block strong', text: nf(r.qty) + ' ' + (r.unit || '') }), h('span', { class: 'muted', text: r.formula })),
            td('Precio unitario', { class: 'num' }, pr ? cop(pr.unitPrice) : '—', h('span', { class: 'small muted block', text: ivaText(pr) })),
            td('IVA en el costo', { class: 'small' }, pr ? (pr.ivaIncluded === true ? (ivaCost ? 'Costo con IVA (no descontable)' : 'Base sin IVA: ' + cop(C.netUnit(pr)) + ' (descontable)') : (ivaCost ? 'Se suma IVA: ' + cop(C.costUnit(pr, true)) + ' (no descontable)' : 'Sin IVA (descontable)')) : '—'),
            td('Costo', { class: 'num strong', text: cost === null ? '—' : cop(cost) }),
            td('Estado', null, priceBadge(pr ? (C.priceStatus({ price: pr })) : 'pendiente'),
              canEdit && !pr ? h('button', { type: 'button', class: 'btn small', onclick: function () { priceDialog(p, l, r); } }, 'Registrar precio') : null));
        }))));
  }

  function csvNum(n) { return n === null || n === undefined ? '' : String(n).replace('.', ','); }
  function downloadCsv(p, v, internal) {
    var doc = v ? v.doc : buildDoc(p);
    var t = doc.totals;
    var label = v ? 'v' + v.n + ' aprobada' : 'v' + p.working + ' borrador';
    var rows = [[internal ? 'Cuadro interno de cantidades y compras' : 'Cotización / pre-factura (no válida como factura)', doc.code, doc.projectName, label],
      ['Delimitador: punto y coma; codificación UTF-8', 'Motor: ' + doc.engine], []];
    rows.push(['Código', 'Capítulo', 'Descripción', 'Unidad', 'Cantidad', 'Valor total (COP)', 'Estado del precio']);
    doc.lines.forEach(function (l) {
      rows.push([l.code, D.CHAPTERS[l.chapter] || l.chapter, l.desc, l.unit, csvNum(l.qty), l.cost, PRICE_LABEL[l.status] + (l.manual ? ' (incluye precio registrado manualmente)' : '')]);
    });
    rows.push([]);
    rows.push(['Costo directo', '', '', '', '', t.cd]);
    rows.push(['Administración ' + pctLabel(doc.policy.adminBp), '', '', '', '', t.admin]);
    rows.push(['Imprevistos ' + pctLabel(doc.policy.contBp), '', '', '', '', t.cont]);
    rows.push(['Utilidad ' + pctLabel(doc.policy.utilBp), '', '', '', '', t.util]);
    rows.push(['Subtotal antes de IVA', '', '', '', '', t.subtotal]);
    t.ivaGroups.forEach(function (g) { rows.push(['IVA 19 % — ' + classInfo(g.cls).label + ' (base ' + g.base + ')', '', '', '', '', g.iva]); });
    rows.push(['Total', '', '', '', '', t.total]);
    t.retenciones.forEach(function (r) { rows.push(['Informativo: ' + r.label, '', '', '', '', r.amount]); });
    if (t.retenciones.length) rows.push(['Informativo: neto estimado a recibir', '', '', '', '', t.neto]);
    if (internal) {
      var x = view(p);
      rows.push([]);
      rows.push(['Lista de compras', 'Partida', 'Recurso', 'Proveedor y producto', 'Referencia', 'Cantidad', 'Unidad', 'Precio unitario', 'IVA', 'URL', 'Fecha de consulta']);
      activeLines(x).forEach(function (l) {
        if (l.included === false) return;
        l.resources.forEach(function (r) {
          var pr = r.price;
          var isEstimate = pr && pr.type === 'estimado' && !pr.manual;
          rows.push(['', l.code, r.label, pr ? pr.source : 'PENDIENTE', pr && !isEstimate ? pr.sku || '' : '', csvNum(r.qty), r.unit || '',
            pr ? pr.unitPrice : '', ivaText(pr), pr && !isEstimate ? pr.url || '' : '', pr ? pr.date : '']);
        });
      });
    }
    var text = window.OBCsv.document(rows);
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var a = h('a', { href: URL.createObjectURL(blob), download: p.code + '-' + (v ? 'v' + v.n : 'v' + p.working + '-borrador') + (internal ? '-compras' : '') + '.csv' });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Se descargó el CSV de la ' + label + ' (separado por punto y coma; abre en Excel).', 'ok');
  }

  function totalsPanel(p, t) {
    var pol = p.policy, fis = p.fiscal;
    function row(label, value, help, cls) {
      return [h('dt', { class: cls || null }, nb(label), help ? h('span', { class: 'small muted block', text: nb(help) }) : null), h('dd', { class: cls || null, text: value })];
    }
    function pctInput(id, key, label, max) {
      return h('div', { class: 'field inline' }, h('label', { for: id }, label),
        h('input', { id: id, type: 'number', min: '0', max: String(max), step: '0.5', class: 'num-input', value: String(pol[key] / 100),
          onchange: function (e) {
            var v = parseFloat(e.target.value);
            if (!(v >= 0 && v <= max)) { toast(label + ': escriba un porcentaje entre 0 y ' + max + '. No se aplicó el cambio.', 'bad'); e.target.value = String(pol[key] / 100); return; }
            var bp = Math.round(v * 100);
            if (bp === pol[key]) return;
            beginEdit(p);
            var before = pctLabel(pol[key]);
            pol[key] = bp;
            audit(p, 'Política comercial', label, before, pctLabel(bp));
            save(); rerender();
          } }), h('span', { 'aria-hidden': 'true' }, '%'));
    }
    function radio(name, value, label, checked, onpick) {
      var id = name + '-' + value;
      return h('label', { class: 'check', for: id }, h('input', { type: 'radio', name: name, id: id, value: value, checked: checked, onchange: onpick }), ' ' + label);
    }
    function check(id, label, checked, onchange) {
      return h('label', { class: 'check', for: id }, h('input', { type: 'checkbox', id: id, checked: checked, onchange: onchange }), ' ' + label);
    }
    function setFiscal(label, before, after, fn) {
      beginEdit(p); fn(); audit(p, 'Fiscal', label, before, after); save(); rerender();
    }
    var regimeSel = h('select', { id: 'fis-regime', onchange: function (e) {
      var v = e.target.value; setFiscal('Régimen del contratista', C.REGIMES[fis.regime], C.REGIMES[v], function () { fis.regime = v; fis.reviewed = false; });
    } }, Object.keys(C.REGIMES).map(function (k) { return h('option', { value: k, text: REGIME_NAME[k] }); }));
    regimeSel.value = fis.regime;
    var chapterKeys = activeLines(view(p)).map(function (l) { return l.chapter; }).filter(function (c, i, arr) { return arr.indexOf(c) === i; }).sort();
    var ex = C.priceFromCost(100, pol.utilBp, 'aiu'), em = C.priceFromCost(100, pol.utilBp, 'margen');

    return h('aside', { class: 'totals' },
      h('section', { class: 'card', 'aria-labelledby': 'tot-title' },
        h('h2', { id: 'tot-title', text: 'Resumen económico v' + p.working }),
        h('dl', { class: 'totals-list' },
          row('Costo directo', cop(t.cd), 'Σ APU de las partidas valoradas'),
          row('Administración ' + pctLabel(pol.adminBp), cop(t.admin)),
          row('Imprevistos ' + pctLabel(pol.contBp), cop(t.cont)),
          row('Utilidad ' + pctLabel(pol.utilBp), cop(t.util), pol.method === 'margen' ? 'margen sobre venta' : 'sobre costo directo'),
          row('Subtotal antes de IVA', cop(t.subtotal), null, 'strong'),
          t.ivaGroups.map(function (g) {
            return row('IVA 19 %', cop(g.iva), (fis.regime === 'no_responsable' ? 'No responsable: no factura IVA. ' : '') + 'Base ' + cop(g.base) + ' — ' + C.TAX_CLASSES[g.cls].label);
          }),
          row('Total a pagar', cop(t.total), null, 'grand')),
        t.unpriced ? h('p', { class: 'warn-text small', id: 'unpriced-note', text: t.unpriced + ' partidas sin precio no están sumadas: el total real será mayor.' }) : null,
        t.retenciones.length ? h('div', { class: 'ret' },
          h('h3', { class: 'h4', text: 'Retenciones del cliente (informativo)' }),
          h('dl', { class: 'totals-list' }, t.retenciones.map(function (r) { return row(r.label, '− ' + cop(r.amount), r.note || null); }),
            row('Neto estimado a recibir', cop(t.neto), 'Las retenciones no cambian el total facturado', 'strong')),
          h('p', { class: 'small muted', text: RET_NOTE })) : null,
        t.icaContratista !== null ? h('p', { class: 'small muted', text: 'ICA a cargo del contratista (7,60 ‰, NO VERIFICADO): ' + cop(t.icaContratista) + '. Se cubre en la administración; no se suma a la cotización.' }) : null,
        h('div', { class: 'actions column' },
          h('a', { class: 'btn', href: '#/proyecto/' + p.id + '/cotizacion/borrador', id: 'btn-preview-2' }, 'Vista previa de la cotización'),
          h('button', { type: 'button', class: 'btn', id: 'btn-csv', onclick: function () { downloadCsv(p, null, true); } }, 'Descargar lista de compras (CSV)'),
          h('a', { class: 'btn primary', href: '#/proyecto/' + p.id + '/aprobacion' }, 'Ir a aprobación'))),

      h('section', { class: 'card', id: 'fiscal', 'aria-labelledby': 'fis-title' },
        h('h2', { id: 'fis-title', text: 'Impuestos (Colombia, 2026)' }),
        h('div', { class: 'field' }, h('label', { for: 'fis-regime' }, 'Régimen del contratista'), regimeSel, h('span', { class: 'hint', text: C.REGIMES[fis.regime] })),
        t.overNoRespThreshold ? h('p', { class: 'callout bad small', role: 'alert', text: 'El contrato iguala o supera 3.500 UVT (' + cop(C.UVT_3500) + '): debe inscribirse como responsable de IVA antes de celebrarlo (Oficio DIAN 13873 de 2026).' }) : null,
        h('fieldset', null, h('legend', { text: 'El cliente es agente de retención' }),
          check('fis-renta', 'En la fuente (renta)', fis.client.renta, function (e) { var v = e.target.checked; setFiscal('Cliente agente de retención en renta', String(!v), String(v), function () { fis.client.renta = v; }); }),
          check('fis-iva', 'De IVA (gran contribuyente o designado)', fis.client.iva, function (e) { var v = e.target.checked; setFiscal('Cliente agente de reteIVA', String(!v), String(v), function () { fis.client.iva = v; }); }),
          check('fis-ica', 'De ICA en Bogotá', fis.client.ica, function (e) { var v = e.target.checked; setFiscal('Cliente agente de reteICA', String(!v), String(v), function () { fis.client.ica = v; }); })),
        h('fieldset', null, h('legend', { text: 'Clasificación por capítulo (propuesta)' }),
          h('p', { class: 'small muted', text: 'La DIAN no resuelve si una «adecuación» es construcción o reparación (NO VERIFICADO): cada capítulo se clasifica aparte.' }),
          chapterKeys.map(function (ch) {
            var id = 'cls-' + ch;
            var s = h('select', { id: id, onchange: function (e) {
              var v = e.target.value; setFiscal('Clase fiscal del capítulo ' + ch, fis.classes[ch], v, function () { fis.classes[ch] = v; fis.classesAuto = false; fis.reviewed = false; });
            } }, Object.keys(C.TAX_CLASSES).map(function (k) { return h('option', { value: k, text: CLASS_NAME[k] }); }));
            s.value = fis.classes[ch];
            return h('div', { class: 'field' }, h('label', { for: id }, ch + ' · ' + D.CHAPTERS[ch]), s,
              h('span', { class: 'hint', text: !C.taxClassOf(fis, ch) ? 'Sin clase fiscal: asigne una' : classInfo(C.taxClassOf(fis, ch)).ivaBase === 'utilidad' ? 'IVA 19 % sobre la utilidad' : 'IVA 19 % sobre el valor total' }));
          }),
          h('details', { class: 'small legal-basis' }, h('summary', null, 'Base legal de cada clase'),
            h('ul', null, Object.keys(C.TAX_CLASSES).filter(function (k) { return chapterKeys.some(function (ch) { return fis.classes[ch] === k; }); }).map(function (k) {
              return h('li', null, h('strong', { text: CLASS_SHORT[k] + ': ' }), C.TAX_CLASSES[k].legal);
            })))),
        check('fis-reviewed', 'Clasificación revisada con el contador', fis.reviewed, function (e) { var v = e.target.checked; setFiscal('Revisión fiscal', v ? 'Pendiente' : 'Revisada', v ? 'Revisada' : 'Pendiente', function () { fis.reviewed = v; }); }),
        h('p', { class: 'small warn-text', text: NOT_ADVICE })),

      h('section', { class: 'card', 'aria-labelledby': 'pol-title' },
        h('h2', { id: 'pol-title', text: 'AIU y política comercial' }),
        pctInput('pol-admin', 'adminBp', 'Administración', 50),
        pctInput('pol-cont', 'contBp', 'Imprevistos', 50),
        pctInput('pol-util', 'utilBp', 'Utilidad', 60),
        h('div', { role: 'radiogroup', 'aria-label': 'Método de utilidad', class: 'radios' },
          [['aiu', 'AIU sobre costo directo (práctica colombiana)'], ['margen', 'Margen sobre venta: Precio = (CD + A + I) ÷ (1 − m)']].map(function (m) {
            return radio('method', m[0], m[1], pol.method === m[0], function () {
              beginEdit(p); var before = pol.method; pol.method = m[0]; audit(p, 'Política comercial', 'Método de utilidad', before, m[0]); save(); rerender();
            });
          })),
        h('p', { class: 'small muted', text: 'No son equivalentes: costo $100 con ' + pctLabel(pol.utilBp) + ' → AIU $' + ex + '; margen $' + em + '. Bajo el art. 1.3.1.7.9 la utilidad pactada no puede ser inferior a la comercial de contratos similares.' }),
        check('pol-est', 'Permitir aprobar con mano de obra estimada (se identifica en la cotización)', pol.allowEstimates, function (e) {
          beginEdit(p); pol.allowEstimates = e.target.checked; audit(p, 'Política comercial', 'Aprobar con estimaciones', String(!e.target.checked), String(e.target.checked)); save(); rerender();
        })));
  }

  function omittedNote(x) {
    var shown = {};
    activeLines(x).forEach(function (l) { shown[l.chapter] = true; });
    var why = { '06': 'Red, seguridad y tecnología: no modelado en este prototipo' };
    Object.keys(D.CHAPTERS).forEach(function (c) {
      if (shown[c]) return;
      if (c === '08') why[c] = '08 Equipamiento de farmacia: no aplica sin productos refrigerados';
      else why[c] = c + ' ' + D.CHAPTERS[c] + ': no incluido en el alcance solicitado';
    });
    why['06'] = '06 ' + why['06'];
    var list = Object.keys(why).sort().map(function (k) { return why[k]; });
    return h('p', { class: 'small muted omitted', id: 'omitted-note' }, 'Capítulos que no aparecen con los parámetros actuales: ' + list.join(' · ') + '.');
  }

  function tabBudget(p) {
    if (!p.lines.length) {
      return h('div', { class: 'empty' }, h('h2', { text: 'Aún no hay partidas' }),
        h('p', { text: 'Falta el área del local (m²), el parámetro principal. Regístrela en el levantamiento y genere las partidas.' }),
        h('a', { class: 'btn primary', href: '#/proyecto/' + p.id + '/levantamiento' }, 'Ir al levantamiento'));
    }
    var x = view(p);
    var t = totalsOf(x);
    var frozen = isFrozen(p);
    var pf = ui.priceFilter;
    function match(l) {
      if (pf === 'all') return true;
      if (pf === 'tecnica') return l.techReview && !l.techValidated;
      return C.priceStatus(l) === pf;
    }
    var filterSel = h('select', { id: 'f-price', onchange: function (e) { ui.priceFilter = e.target.value; rerender(); } },
      h('option', { value: 'all', text: 'Todas las partidas' }),
      ['pendiente', 'estimado', 'emisor', 'publicado', 'publicado_manual', 'referencia', 'cotizacion_vigente', 'vencido'].map(function (k) { return h('option', { value: k, text: 'Estado: ' + PRICE_LABEL[k] }); }),
      h('option', { value: 'tecnica', text: 'Requieren revisión técnica' }));
    filterSel.value = pf;

    var onVal = onFieldChange(p);
    var paramKeys = ['areaM2', 'ciudad', 'estado', 'acabado', 'frenteM', 'alturaM', 'mlEstanteria', 'gondolasCentrales', 'mlDivisiones', 'aberturasM2', 'anchoAberturasM', 'cajas', 'refrigeracion'];
    var paramFields = paramKeys.map(function (k) { return fieldOf(p.fields, k); }).filter(Boolean);
    var params = h('section', { class: 'card params-card', 'aria-labelledby': 'pm-title' },
      h('h2', { id: 'pm-title', text: 'Parámetros del local' }),
      h('p', { class: 'small muted', text: 'El área (m²) es el parámetro principal: cambiarla recalcula cantidades, compras, precios e impuestos.' }),
      h('div', { class: 'params' }, paramFields.map(function (f) {
        return h('div', { class: 'field' + (f.key === 'areaM2' ? ' primary-param' : '') },
          h('label', { for: 'pm-' + f.key }, f.label, ' ', fieldBadge(f.status)),
          fieldInput(f, 'pm-', onVal));
      })));

    var pendCount = activeLines(x).filter(function (l) { return l.included !== false && pendingRes(l).length; }).length;
    var mobileSummary = h('div', { class: 'mobile-summary no-print', id: 'mobile-summary' },
      h('span', null, h('span', { class: 'small muted block', text: 'Total a pagar (IVA incluido)' }), h('strong', { class: 'big', text: cop(t.total) }),
        pendCount ? h('span', { class: 'small bad-text block', text: pendCount + ' partidas sin precio no sumadas' }) : null),
      h('button', { type: 'button', class: 'btn small', onclick: function () { var el = document.getElementById('tot-title'); el.setAttribute('tabindex', '-1'); el.scrollIntoView(); el.focus({ preventScroll: true }); } }, 'Ver resumen'));

    var chapters = x.chapters.map(function (c) {
      var rows = activeLines(x).filter(function (l) { return l.chapter === c && match(l); });
      if (!rows.length) return null;
      var ch = t.chapters[c];
      return h('section', { class: 'chapter', 'aria-labelledby': 'ch-' + c },
        h('div', { class: 'chapter-head' },
          h('h3', { id: 'ch-' + c, text: c + ' · ' + D.CHAPTERS[c] }),
          h('span', { class: 'small' }, badge('neutral', classShort(C.taxClassOf(x.fiscal, c))), ' ', h('span', { class: 'muted', text: 'Costo directo ' + cop(ch ? ch.cd : 0) }))),
        h('div', { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Partidas del capítulo ' + D.CHAPTERS[c] },
          h('table', { class: 'data lines stack' },
            h('caption', { class: 'sr-only', text: 'Partidas del capítulo ' + c }),
            h('colgroup', null, ['c-code', 'c-desc', 'c-qty', 'c-cost', 'c-status', 'c-actions'].map(function (k) { return h('col', { class: k }); })),
            h('thead', null, h('tr', null, ['Código', 'Descripción', 'Cantidad', 'Costo total', 'Estado', 'Acciones'].map(function (y) { return h('th', { scope: 'col', text: y }); }))),
            h('tbody', null, rows.map(function (l) {
              var s = C.priceStatus(l);
              var excluded = l.included === false;
              var open = !!ui.expanded[l.code];
              var cost = C.lineCost(l, lineCtx(x, l));
              var pend = pendingRes(l);
              var unitTxt = !excluded && cost !== null && l.qtyInstalled > 0 ? cop(C.divRound(cost * 1000, C.toMilli(l.qtyInstalled))) + NBSP + '/' + NBSP + l.unit : null;
              var hasOptions = l.resources.some(function (r) { return r.options && r.options.length > 1; });
              var acts = [h('button', { type: 'button', class: 'btn small ghost', id: 'tg-' + l.code, 'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'tr-' + l.code,
                onclick: function () { ui.expanded[l.code] = !open; rerender(); } }, open ? 'Ocultar APU' : 'Ver APU')];
              if (hasOptions && !excluded) acts.push(h('a', { class: 'btn small', href: '#/proyecto/' + p.id + '/comparar/' + l.code, id: 'cmp-' + l.code }, 'Comparar proveedores'));
              if (pend.length && !excluded) acts.push(h('button', { type: 'button', class: 'btn small primary', id: 'pr-' + l.code, onclick: function () { priceDialog(p, l, pend[0]); } }, 'Registrar precio'));
              if (l.techReview && !l.techValidated && !excluded) acts.push(h('button', { type: 'button', class: 'btn small', id: 'vq-' + l.code, onclick: function () { validateQty(p, l); } }, 'Validar cantidad'));
              if (l.optional) acts.push(h('button', { type: 'button', class: 'btn small', id: 'inc-' + l.code, onclick: function () { toggleIncluded(p, l); } }, excluded ? 'Incluir' : 'Excluir'));
              var tr = h('tr', { class: (s === 'pendiente' && !excluded ? 'row-pending' : '') + (excluded ? ' row-excluded' : '') },
                td('Código', { class: 'mono c-code' }, l.code),
                td('Descripción', { class: 'c-desc' }, h('span', { class: 'strong-ish', text: l.desc }),
                  h('span', { class: 'tags' },
                    excluded ? badge('neutral', 'Excluida') : l.optional ? badge('neutral', 'Opcional') : null,
                    l.resources.some(function (r) { return r.price && r.price.manual; }) ? badge('warn', 'Precio registrado') : null,
                    l.techReview ? (l.techValidated ? badge('ok', 'Validado') : badge('warn', 'Requiere revisión técnica')) : null)),
                td('Cantidad', { class: 'num c-qty' }, h('span', { class: 'nowrap', text: nf(l.qtyInstalled) + NBSP + l.unit }),
                  unitTxt ? h('span', { class: 'small muted mobile-only', text: ' · ' + unitTxt }) : null),
                td('Costo total', { class: 'num strong c-cost' }, excluded ? '—' : cost === null ? h('span', { class: 'bad-text', text: 'Pendiente' }) : cop(cost),
                  unitTxt ? h('span', { class: 'small muted block nowrap desktop-only', text: unitTxt }) : null),
                td('Estado', { class: 'c-status' }, excluded ? badge('neutral', 'Excluida') : priceBadge(s)),
                td('Acciones', { class: 'c-actions' }, h('div', { class: 'row-actions' }, acts)));
              if (!open) return tr;
              return [tr, h('tr', { class: 'trace', id: 'tr-' + l.code },
                h('td', { colspan: '6' },
                  h('p', { class: 'small' }, h('strong', null, 'Cantidad instalada: '), nf(l.qtyInstalled) + ' ' + l.unit + ' — ' + l.qtyFormula),
                  apuTable(x, l, !frozen, p),
                  h('p', { class: 'small muted', text: 'Clase fiscal del capítulo: ' + classInfo(C.taxClassOf(x.fiscal, l.chapter)).label + '. ' + classInfo(C.taxClassOf(x.fiscal, l.chapter)).legal })))];
            })))));
    }).filter(Boolean);

    return h('div', { class: 'budget' },
      h('div', { class: 'budget-main' },
        frozen ? h('p', { class: 'callout', text: 'Está viendo la v' + p.working + ' aprobada. Cualquier cambio creará automáticamente un borrador v' + (p.working + 1) + '; la versión aprobada no se modifica.' }) : null,
        params,
        mobileSummary,
        h('div', { class: 'toolbar' }, h('label', { for: 'f-price' }, 'Filtrar partidas'), filterSel,
          h('span', { class: 'legend small muted' }, 'Estados: ', ['pendiente', 'estimado', 'emisor', 'publicado', 'publicado_manual', 'referencia'].map(function (k) { return priceBadge(k); }))),
        omittedNote(x),
        chapters.length ? chapters : h('div', { class: 'empty' }, h('h2', { text: 'Ninguna partida coincide con el filtro' }),
          h('button', { type: 'button', class: 'btn', onclick: function () { ui.priceFilter = 'all'; rerender(); } }, 'Quitar filtro'))),
      totalsPanel(p, t));
  }

  // ---------- Comparador de proveedores ----------
  function viewCompare(p, code) {
    var line = p.lines.filter(function (l) { return l.code === code; })[0];
    if (!line) return viewNotFound();
    var x = view(p);
    var ctx = lineCtx(x, line);
    var picks = {}, pins = {};
    line.resources.forEach(function (r) { if (r.chosen) picks[r.key] = r.chosen; });

    function costWith(key, id) {
      var tmp = clone(line);
      tmp.choices[key] = id;
      D.applyQuantities([tmp], p.params);
      var r = tmp.resources.filter(function (y) { return y.key === key; })[0];
      return { line: C.lineCost(tmp, ctx), res: C.resourceCost(r, C.ivaIsCost(ctx.regime, ctx.taxClass)), qty: r.qty, formula: r.formula, unit: r.unit };
    }

    var groups = line.resources.filter(function (r) { return r.options && r.options.length; }).map(function (r) {
      var cards = r.options.map(function (id) {
        var row = P[id], m = D.meta(id);
        var sel = D.selectable(id);
        var reason = !row || row.precio === null ? 'Sin precio publicado' : m.ok === false ? 'No cumple: ' + m.why : m.stock === false ? 'Sin existencias: ' + m.why : null;
        var cw = sel ? costWith(r.key, id) : null;
        return { id: id, row: row, meta: m, selectable: sel, reason: reason, cost: cw };
      });
      var eligible = cards.filter(function (c) { return c.selectable; }).sort(function (a, b) { return a.cost.res - b.cost.res; });
      return { r: r, cards: cards, best: eligible[0] || null, eligible: eligible };
    });

    var errBox = h('p', { class: 'field-error', id: 'sel-err', role: 'alert' });
    var whyArea = h('textarea', { id: 'sel-why', rows: '2', 'aria-describedby': 'sel-err' });
    var form = h('form', { novalidate: true, 'aria-labelledby': 'cmp-title', onsubmit: function (ev) {
      ev.preventDefault();
      var changed = groups.filter(function (g) { return picks[g.r.key] && (picks[g.r.key] !== g.r.chosen || (g.r.auto && pins[g.r.key])); });
      if (!changed.length) { errBox.textContent = 'No cambió ninguna opción.'; return; }
      var why = whyArea.value.trim();
      if (why.length < 5) { errBox.textContent = 'Escriba el motivo de la selección: queda en la auditoría.'; whyArea.focus(); return; }
      beginEdit(p);
      changed.forEach(function (g) {
        var before = g.r.chosen ? P[g.r.chosen].proveedor + ' · ' + P[g.r.chosen].producto : 'Sin opción';
        line.choices[g.r.key] = picks[g.r.key];
        var after = P[picks[g.r.key]].proveedor + ' · ' + P[picks[g.r.key]].producto;
        audit(p, 'Proveedor seleccionado', line.code + ' ' + g.r.label, before, after, why);
      });
      D.applyQuantities([line], p.params);
      save();
      location.hash = '#/proyecto/' + p.id + '/presupuesto';
      toast('Selección aplicada a ' + line.code + '. Cantidades y totales recalculados.', 'ok');
    } },
      groups.map(function (g, gi) {
        return h('fieldset', { class: 'card offer-group' },
          h('legend', { text: g.r.label }),
          h('p', { class: 'small muted', text: 'Cantidad: ' + nf(g.r.qty) + ' ' + (g.r.unit || '') + ' — ' + g.r.formula }),
          g.cards.length < 2 ? h('p', { class: 'small warn-text', text: 'Un solo proveedor encontrado: no hay con qué comparar.' }) : null,
          h('p', { class: 'small muted', text: g.r.auto ? 'Selección actual: automática (menor costo entre las que cumplen; se recalcula si cambian los parámetros).' : 'Selección actual: elegida por el usuario (se mantiene aunque cambien los parámetros).' }),
          g.r.auto && g.eligible.length ? h('label', { class: 'check small', for: 'pin-' + g.r.key },
            h('input', { type: 'checkbox', id: 'pin-' + g.r.key, onchange: function (e) { pins[g.r.key] = e.target.checked; } }),
            ' Fijar la opción seleccionada como mi elección (no se recalculará si cambian los parámetros)') : null,
          g.best && g.eligible.length > 1 ? h('p', { class: 'small' }, 'Recomendación: menor costo entre opciones que cumplen y tienen existencias: ', h('strong', { text: g.best.row.proveedor + ' (' + cop(g.best.cost.res) + ')' }), '. La decisión es suya y queda registrada.') : null,
          h('div', { class: 'offer-grid' }, g.cards.map(function (c) {
            var id = 'of-' + g.r.key + '-' + c.id.replace(/[^a-zA-Z0-9]/g, '_');
            var row = c.row;
            return h('label', { class: 'offer' + (c.selectable ? '' : ' disabled') + (picks[g.r.key] === c.id ? ' picked' : ''), for: id },
              h('span', { class: 'offer-top' },
                h('input', { type: 'radio', name: 'opt-' + gi, id: id, value: c.id, disabled: !c.selectable, checked: picks[g.r.key] === c.id,
                  onchange: function () { picks[g.r.key] = c.id; var all = form.querySelectorAll('.offer'); for (var i = 0; i < all.length; i++) { var inp = all[i].querySelector('input'); all[i].classList.toggle('picked', inp.checked); } } }),
                h('span', { class: 'offer-supplier', text: row.proveedor })),
              h('span', { class: 'offer-product', text: row.producto }),
              h('span', { class: 'offer-price' }, cop(row.precio), h('span', { class: 'small muted', text: ' / ' + row.unidad + ' · ' + ivaText({ ivaIncluded: row.iva }) })),
              c.cost ? h('span', { class: 'small block' }, 'Costo del recurso: ', h('strong', { text: cop(c.cost.res) }), ' (' + nf(c.cost.qty) + ' ' + (c.cost.unit || '') + ')') : null,
              c.cost ? h('span', { class: 'small block muted', text: 'Partida completa con esta opción: ' + cop(c.cost.line) }) : null,
              h('span', { class: 'offer-badges' },
                c.selectable ? badge('ok', 'Cumple') : badge('bad', 'No seleccionable'),
                c.meta.verify ? badge('warn', 'Verificar') : null),
              c.reason ? h('span', { class: 'small bad-text block', text: c.reason }) : null,
              c.meta.verify ? h('span', { class: 'small warn-text block', text: c.meta.verify }) : null,
              h('span', { class: 'small muted block', text: (row.sku ? 'Ref. ' + row.sku + ' · ' : '') + 'consultado ' + fmtDate(row.fecha) }),
              h('details', { class: 'small' }, h('summary', null, 'Notas del proveedor'), h('span', { text: row.notas })),
              extLink(row.url));
          })));
      }),
      h('section', { class: 'card' },
        h('div', { class: 'field' }, h('label', { for: 'sel-why' }, 'Motivo de la selección'), whyArea),
        errBox,
        h('div', { class: 'actions' },
          h('a', { class: 'btn', href: '#/proyecto/' + p.id + '/presupuesto' }, 'Cancelar'),
          h('button', { type: 'submit', class: 'btn primary', id: 'btn-usar-oferta' }, 'Usar la selección en el presupuesto'))));

    return h('section', null,
      h('nav', { class: 'crumbs', 'aria-label': 'Ruta' }, h('a', { href: '#/' }, 'Proyectos'), ' / ', h('a', { href: '#/proyecto/' + p.id + '/presupuesto' }, p.code), ' / Comparar proveedores'),
      h('h1', { id: 'cmp-title', text: 'Comparar proveedores — ' + line.code + ' ' + line.desc }),
      h('p', { class: 'muted', text: 'Precios reales al consumidor consultados el 15/10/2026 (precio normal; las ofertas temporales aparecen en las notas). El costo usa el tratamiento de IVA del capítulo: ' + classInfo(ctx.taxClass).label + '.' }),
      form);
  }

  // ---------- Aprobación y versiones ----------
  function snapshot(p, by, at, note) {
    var doc = buildDoc(p);
    return { n: p.working, approvedBy: by, approvedAt: at, note: note || '', engine: C.ENGINE_VERSION,
      lines: clone(p.lines), policy: clone(p.policy), fiscal: clone(p.fiscal), params: clone(p.params), fields: clone(p.fields),
      exclusions: clone(p.exclusions), chapters: clone(p.chapters), validityDays: p.validityDays, totals: clone(doc.totals), doc: doc, sentAt: null };
  }

  /** Documento de cotización: para un borrador se calcula; para una versión aprobada se GUARDA tal cual. */
  function buildDoc(p) {
    var x = view(p);
    var t = totalsOf(x);
    var lines = activeLines(x).filter(function (l) { return l.included !== false; }).map(function (l) {
      var cost = C.lineCost(l, lineCtx(x, l));
      return { code: l.code, chapter: l.chapter, desc: l.desc, unit: l.unit, qty: l.qtyInstalled, cost: cost,
        unitPrice: cost === null || !(l.qtyInstalled > 0) ? null : C.divRound(cost * 1000, C.toMilli(l.qtyInstalled)),
        status: C.priceStatus(l), manual: l.resources.some(function (r) { return r.price && r.price.manual; }), labor: C.hasLaborProxy(l) };
    });
    return clone({
      engine: C.ENGINE_VERSION, date: C.DEMO_TODAY, validityDays: p.validityDays || 30, code: p.code, projectName: p.name,
      issuer: { name: state.company.name, nit: state.company.nit, demo: !!state.company.demo },
      client: { name: p.client, nit: x.fiscal.client.nit || '', address: p.address || '', city: x.params.ciudad },
      regime: x.fiscal.regime, reviewed: !!x.fiscal.reviewed, classes: x.fiscal.classes, policy: x.policy, params: x.params,
      chapters: x.chapters.filter(function (c) { return lines.some(function (l) { return l.chapter === c; }); }),
      lines: lines, totals: t, fields: x.fields, exclusions: x.exclusions, requirements: requirementStatuses(x),
      tipo: fieldVal(p, 'tipo'), area: fieldVal(p, 'areaM2')
    });
  }

  function diffVersions(a, b) {
    var out = [];
    b.lines.forEach(function (lb) {
      var la = a.lines.filter(function (y) { return y.code === lb.code; })[0];
      if (!la) { out.push(lb.code + ' agregada'); return; }
      if (la.qtyInstalled !== lb.qtyInstalled) out.push(lb.code + ': cantidad ' + nf(la.qtyInstalled) + ' → ' + nf(lb.qtyInstalled) + ' ' + lb.unit);
      if (JSON.stringify(la.choices) !== JSON.stringify(lb.choices)) out.push(lb.code + ': proveedor o producto cambiado');
      if (la.included !== lb.included) out.push(lb.code + (lb.included === false ? ': excluida' : ': incluida'));
    });
    if (a.fiscal.regime !== b.fiscal.regime) out.push('Régimen: ' + C.REGIMES[a.fiscal.regime] + ' → ' + C.REGIMES[b.fiscal.regime]);
    Object.keys(b.fiscal.classes).forEach(function (k) { if (a.fiscal.classes[k] !== b.fiscal.classes[k]) out.push('Capítulo ' + k + ': ' + a.fiscal.classes[k] + ' → ' + b.fiscal.classes[k]); });
    ['adminBp', 'contBp', 'utilBp'].forEach(function (k) { if (a.policy[k] !== b.policy[k]) out.push('AIU ' + k.replace('Bp', '') + ': ' + pctLabel(a.policy[k]) + ' → ' + pctLabel(b.policy[k])); });
    return out;
  }

  function tabApproval(p) {
    var ck = checks(p);
    var isMgr = state.persona === 'andres';
    var frozen = isFrozen(p);
    var last = lastApproved(p);
    var canApprove = !frozen && !ck.blockers.length && isMgr;
    function approve() {
      openDialog('Aprobar versión v' + p.working, [
        h('p', { text: 'Se congelará la v' + p.working + ' con un total de ' + cop(ck.totals.total) + ' (IVA incluido). Los cambios posteriores crearán una nueva versión.' }),
        ck.warnings.length ? h('p', { class: 'warn-text', text: 'Aprueba con ' + ck.warnings.length + ' advertencias visibles en la cotización.' }) : null,
        h('div', { class: 'field' }, h('label', { for: 'ap-note' }, 'Nota de aprobación (opcional)'), h('textarea', { id: 'ap-note', name: 'note', rows: '2' }))
      ], 'Aprobar v' + p.working, function (form) {
        var again = checks(p);
        if (again.blockers.length || state.persona !== 'andres') return 'La aprobación ya no es posible: revise los bloqueos.';
        var note = form.note.value.trim();
        p.versions.push(snapshot(p, actorName(), new Date().toISOString(), note));
        p.status = 'APPROVED';
        audit(p, 'Versión aprobada', 'v' + p.working, 'Borrador', 'Aprobada', note);
        save();
        location.hash = '#/proyecto/' + p.id + '/cotizacion/' + p.working;
        toast('Versión v' + p.working + ' aprobada y congelada. Cotización generada.', 'ok');
        return null;
      });
    }
    var changes = last && !frozen ? diffVersions(last, { lines: p.lines, fiscal: p.fiscal, policy: p.policy }) : [];
    return h('div', { class: 'two-col wide-left' },
      h('div', null,
        h('section', { class: 'card', 'aria-labelledby': 'bl-title' },
          h('h2', { id: 'bl-title', text: frozen ? 'v' + p.working + ' ya está aprobada' : 'Bloqueos de aprobación (' + ck.blockers.length + ')' }),
          frozen ? h('p', { text: 'Para cambiar algo, edite el presupuesto: se creará un borrador nuevo y esta versión permanecerá intacta.' })
            : ck.blockers.length ? h('ul', { class: 'issues bad' }, ck.blockers.map(function (b) {
              return h('li', null, h('span', { text: b.text }), ' ',
                b.res ? h('button', { type: 'button', class: 'btn small primary', id: 'ap-pr-' + b.line + '-' + b.res, onclick: function () { priceDialogFor(p, b.line, b.res); } }, 'Registrar precio')
                  : h('a', { href: b.href }, 'Resolver'));
            }))
              : h('p', { class: 'ok-text', text: 'No hay bloqueos. La versión puede aprobarse.' })),
        h('section', { class: 'card', 'aria-labelledby': 'wn-title' },
          h('h2', { id: 'wn-title', text: 'Advertencias (' + ck.warnings.length + ')' }),
          h('p', { class: 'small muted', text: 'No bloquean, pero quedan visibles para quien aprueba y en la cotización.' }),
          ck.warnings.length ? h('ul', { class: 'issues warn' }, ck.warnings.map(function (w) { return h('li', null, h('span', { text: w.text }), ' ', h('a', { href: w.href }, 'Ver')); })) : h('p', { text: 'Sin advertencias.' })),
        changes.length ? h('section', { class: 'card' }, h('h2', { text: 'Cambios frente a v' + last.n + ' aprobada' }),
          h('p', { text: 'Total: ' + cop(last.totals.total) + ' → ' + cop(ck.totals.total) }),
          h('ul', null, changes.map(function (c) { return h('li', { text: c }); }))) : null,
        !frozen ? h('section', { class: 'card' },
          h('h2', { text: 'Aprobación interna' }),
          !isMgr ? h('p', { class: 'warn-text', id: 'role-note', text: 'Actúa como ' + actorName() + '. Solo el gerente comercial puede aprobar: cambie a «Andrés Rincón» en el selector de persona.' }) : null,
          ck.blockers.length ? h('p', { class: 'bad-text', id: 'block-note', text: 'Aprobación bloqueada: resuelva ' + ck.blockers.length + (ck.blockers.length === 1 ? ' bloqueo' : ' bloqueos') + '.' }) : null,
          h('button', { type: 'button', class: 'btn primary', id: 'btn-aprobar', disabled: !canApprove, 'aria-describedby': !isMgr ? 'role-note' : ck.blockers.length ? 'block-note' : null, onclick: approve }, 'Aprobar v' + p.working)) : null),
      h('section', { class: 'card', 'aria-labelledby': 'vh-title' },
        h('h2', { id: 'vh-title', text: 'Versiones aprobadas' }),
        p.versions.length ? h('ol', { class: 'versions' }, p.versions.slice().reverse().map(function (v) {
          return h('li', null, h('strong', { text: 'v' + v.n }), ' · ', cop(v.doc.totals.total),
            h('span', { class: 'small muted block', text: 'Aprobada por ' + v.approvedBy + ' · ' + fmtDateTime(v.approvedAt) + (v.sentAt ? ' · enviada ' + fmtDateTime(v.sentAt) : '') }),
            h('a', { href: '#/proyecto/' + p.id + '/cotizacion/' + v.n }, 'Ver cotización v' + v.n));
        })) : h('p', { class: 'muted', text: 'Aún no hay versiones aprobadas.' })));
  }

  function tabHistory(p) {
    return h('section', { class: 'card' },
      h('h2', { text: 'Historial de cambios y auditoría' }),
      h('div', { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Historial' },
        h('table', { class: 'data stack' },
          h('caption', { class: 'sr-only', text: 'Eventos de auditoría' }),
          h('thead', null, h('tr', null, ['Fecha', 'Actor', 'Acción', 'Detalle', 'Valor anterior', 'Valor nuevo', 'Justificación'].map(function (c) { return h('th', { scope: 'col', text: c }); }))),
          h('tbody', null, p.audit.map(function (a) {
            return h('tr', null, td('Fecha', { class: 'small nowrap' }, fmtDateTime(a.at)), td('Actor', { class: 'small' }, a.actor),
              td('Acción', null, a.action), td('Detalle', null, a.detail), td('Valor anterior', { class: 'small' }, a.before), td('Valor nuevo', { class: 'small' }, a.after), td('Justificación', { class: 'small' }, a.why));
          })))));
  }

  // ---------- Cotización / pre-factura ----------
  function viewQuote(p, which) {
    var v = null;
    if (which !== 'borrador') {
      v = p.versions.filter(function (y) { return y.n === +which; })[0];
      if (!v) return viewNotFound();
    } else if (!p.lines.length) return viewNotFound();
    var doc = v ? v.doc : buildDoc(p);
    var t = doc.totals;
    var latest = v && lastApproved(p).n === v.n;
    var counts = {}, manual = 0;
    doc.lines.forEach(function (l) { counts[l.status] = (counts[l.status] || 0) + 1; if (l.manual) manual++; });
    var estimated = doc.lines.filter(function (l) { return l.labor; });
    var pendingLines = doc.lines.filter(function (l) { return l.cost === null; });
    var incomplete = !v || pendingLines.length > 0;
    var hyps = doc.fields.filter(function (f) { return f.status === 'supuesto' || f.status === 'pendiente' || f.status === 'por_verificar'; });
    var docNo = doc.code + (v ? '-v' + v.n : '-BORRADOR');

    function send() {
      openDialog('Enviar cotización v' + v.n + ' al cliente', [
        h('p', { text: 'Simulación: no se envía ningún correo. Se registrará el envío en la auditoría y el proyecto pasará a «Cotización enviada».' })
      ], 'Marcar como enviada', function () {
        v.sentAt = new Date().toISOString();
        p.status = 'PROPOSAL_SENT';
        audit(p, 'Cotización enviada (simulado)', 'v' + v.n + ' a ' + p.client);
        save(); rerender();
        toast('Cotización v' + v.n + ' marcada como enviada (simulado: no se envió ningún correo).', 'ok');
        return null;
      });
    }
    function moneyRow(label, value, cls, note) {
      return h('tr', { class: cls || null }, h('th', { scope: 'row', colspan: '4' }, label, note ? h('span', { class: 'small muted block', text: note }) : null), h('td', { class: 'num', colspan: '2', text: value }));
    }

    var itemGroups = doc.chapters.map(function (c) {
      var ls = doc.lines.filter(function (l) { return l.chapter === c; });
      var ch = t.chapters[c];
      return h('tbody', { class: 'chapter-group' },
        h('tr', { class: 'chap-row' }, h('th', { scope: 'rowgroup', colspan: '6' }, c + ' · ' + (D.CHAPTERS[c] || c), h('span', { class: 'small muted', text: '  ·  ' + classShort(doc.classes[c]) }))),
        ls.map(function (l) {
          var up = l.unitPrice === null ? null : cop(l.unitPrice);
          return h('tr', { class: 'q-item' },
            td('Ítem', { class: 'mono q-code' }, l.code),
            td('Descripción', { class: 'q-desc' }, l.desc,
              l.labor ? h('span', { class: 'small muted block q-labor', text: 'Incluye mano de obra estimada' }) : null,
              l.manual ? h('span', { class: 'small muted block q-manual', text: 'Incluye un valor registrado por el emisor' }) : null),
            td('Unidad', { class: 'q-unit' }, l.unit),
            td('Cantidad', { class: 'num q-qty' }, h('span', { class: 'desktop-only', text: nf(l.qty) }),
              h('span', { class: 'mobile-only small', text: nf(l.qty) + NBSP + l.unit + (up ? ' × ' + up : '') })),
            td('Vr. unitario*', { class: 'num q-up nowrap' }, up || '—'),
            td('Vr. total', { class: 'num q-total nowrap' }, l.cost === null ? h('span', { class: 'bad-text', text: 'Pendiente' }) : cop(l.cost)));
        }),
        h('tr', { class: 'chap-sub' }, h('th', { scope: 'row', colspan: '5', text: 'Subtotal costo directo ' + c }), h('td', { class: 'num', text: cop(ch ? ch.cd : 0) })));
    });

    return h('section', null,
      h('div', { class: 'no-print' },
        h('nav', { class: 'crumbs', 'aria-label': 'Ruta' }, h('a', { href: '#/' }, 'Proyectos'), ' / ', h('a', { href: '#/proyecto/' + p.id + '/presupuesto' }, p.code), ' / ' + (v ? 'Cotización v' + v.n : 'Vista previa')),
        h('div', { class: 'actions doc-actions' },
          h('button', { type: 'button', class: 'btn' + (incomplete ? '' : ' primary'), id: 'btn-print', onclick: function () { window.print(); } }, 'Imprimir o guardar PDF'),
          h('button', { type: 'button', class: 'btn', id: 'btn-csv-v', onclick: function () { downloadCsv(p, v, false); } }, 'Descargar CSV'),
          latest && p.status === 'APPROVED' && !v.sentAt ? h('button', { type: 'button', class: 'btn primary', id: 'btn-enviar', onclick: send }, 'Enviar al cliente (simulado)') : null,
          v && v.sentAt ? badge('ok', 'Enviada ' + fmtDateTime(v.sentAt)) : null),
        incomplete ? h('p', { class: 'callout', id: 'draft-note', text: v ? 'Esta versión tiene ítems sin precio.' : 'Vista previa del borrador: no es una oferta. Registre los precios pendientes y apruebe la versión para emitir la cotización imprimible.' })
          : h('p', { class: 'callout', id: 'ready-note', text: 'Cotización aprobada y con todos los precios: «Imprimir o guardar PDF» produce el documento limpio para el cliente.' }),
        h('p', { class: 'small muted', text: 'Documento para el cliente: muestra el AIU desglosado (la utilidad debe quedar señalada para el IVA de construcción) pero no muestra proveedores ni ofertas alternativas. El PDF y el CSV salen de la misma versión.' })),
      h('article', { class: 'doc' + (incomplete ? ' draft' : ''), id: 'quote-doc', 'aria-labelledby': 'doc-title' },
        incomplete ? h('p', { class: 'draft-stamp', 'aria-hidden': 'true', text: 'BORRADOR' }) : null,
        h('header', { class: 'doc-head' },
          h('div', { class: 'doc-parties' },
            h('div', null, h('p', { class: 'small muted', text: 'Emisor' }), h('p', { class: 'strong', text: doc.issuer.name + (doc.issuer.demo ? ' (datos de demostración)' : '') }),
              h('p', { class: 'small', text: 'NIT ' + (doc.issuer.nit || 'por configurar') + ' · ' + C.REGIMES[doc.regime] })),
            h('div', null, h('p', { class: 'small muted', text: 'Cliente' }), h('p', { class: 'strong', text: doc.client.name }),
              h('p', { class: 'small', text: 'NIT ' + (doc.client.nit || 'por registrar') + ' · ' + [doc.client.address, doc.client.city].filter(Boolean).join(' · ') }))),
          h('h1', { id: 'doc-title', class: 'wrap', text: (v ? 'Cotización / pre-factura N.º ' : 'BORRADOR de cotización ') + docNo }),
          h('p', { class: 'meta' }, h('span', { text: doc.projectName }), h('span', { text: 'Fecha ' + fmtDate(doc.date) }),
            h('span', { text: 'Vigente ' + doc.validityDays + ' días, hasta ' + fmtDate(addDays(doc.date, doc.validityDays)) })),
          h('p', { class: 'doc-legal', text: 'Documento no válido como factura. La factura electrónica de venta se expedirá conforme a la Resolución DIAN 000165 de 2023, una vez validada por la DIAN. Esta oferta es irrevocable durante su vigencia (Código de Comercio, arts. 845 y 846).' })),
        h('section', { class: 'keep' }, h('h2', { text: '1. Objeto y establecimiento' }),
          h('p', { text: 'Adecuación de un local de ' + (doc.area ? nf(doc.area) + ' m²' : 'área por medir') + ' en ' + doc.params.ciudad + ' para su operación como ' + (doc.tipo || 'establecimiento comercial').toLowerCase() + ' (estado actual: ' + D.ESTADOS[doc.params.estado].toLowerCase() + '; acabado ' + D.ACABADOS[doc.params.acabado].toLowerCase() + ').' })),
        h('section', null, h('h2', { text: '2. Ítems' }),
          h('div', { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Ítems de la cotización' },
            h('table', { class: 'data quote stack' },
              h('caption', { class: 'sr-only', text: 'Ítems por capítulo' }),
              h('thead', null, h('tr', null, ['Ítem', 'Descripción', 'Unidad', 'Cantidad', 'Vr. unitario*', 'Vr. total'].map(function (c, i) { return h('th', { scope: 'col', class: i > 2 ? 'num' : null, text: c }); }))),
              itemGroups)),
          h('p', { class: 'small muted', text: '* Valor unitario de referencia redondeado al peso; el valor total de cada ítem es el cálculo exacto de su análisis de precios unitarios.' })),
        h('section', { class: 'keep totals-section' }, h('h2', { text: '3. Valor de la oferta' }),
          h('div', { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Totales' },
            h('table', { class: 'data totals-doc' },
              h('caption', { class: 'sr-only', text: 'Totales e impuestos' }),
              h('tbody', null,
                moneyRow('Costo directo', cop(t.cd)),
                moneyRow('Administración (' + pctLabel(doc.policy.adminBp) + ')', cop(t.admin)),
                moneyRow('Imprevistos (' + pctLabel(doc.policy.contBp) + ')', cop(t.cont)),
                moneyRow('Utilidad (' + pctLabel(doc.policy.utilBp) + ')', cop(t.util), null, 'Utilidad señalada para efectos del art. 1.3.1.7.9 del DUR 1625 de 2016 en los capítulos de construcción.'),
                moneyRow('Subtotal antes de IVA', cop(t.subtotal), 'strong'),
                t.ivaGroups.map(function (g) {
                  var info = classInfo(g.cls);
                  return moneyRow(nb('IVA 19 % sobre ' + (info.ivaBase === 'utilidad' ? 'la utilidad' : 'el valor total') + ' (' + classShort(g.cls).split(' · ')[0].toLowerCase() + '; base ' + cop(g.base) + ')'),
                    cop(g.iva), null, (doc.regime === 'no_responsable' ? 'No responsable de IVA: no se factura IVA. ' : '') + info.legal);
                }),
                moneyRow('Total a pagar', cop(t.total), 'grand')))),
          pendingLines.length ? h('p', { class: 'callout bad small', id: 'incomplete-note', text: 'Borrador incompleto: ' + pendingLines.length + ' ítems sin precio no están en el total (' + pendingLines.map(function (l) { return l.code; }).join(', ') + ').' }) : null,
          t.overNoRespThreshold ? h('p', { class: 'callout bad small', text: 'Supera 3.500 UVT (' + cop(C.UVT_3500) + '): el contratista debe inscribirse como responsable de IVA antes de celebrar el contrato (Oficio DIAN 13873 de 2026).' }) : null,
          t.noRespMayExceed ? h('p', { class: 'callout small', text: 'Con los ítems pendientes, el total podría superar 3.500 UVT (' + cop(C.UVT_3500) + ').' }) : null),
        h('section', { class: 'keep' }, h('h2', { text: '4. Retenciones (informativo)' }),
          t.retenciones.length ? [
            h('p', { class: 'small', text: 'El cliente indicó ser agente de retención. Las retenciones se descuentan del pago; no modifican el total de la oferta.' }),
            h('p', { class: 'small muted', text: RET_NOTE }),
            h('div', { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Retenciones' },
              h('table', { class: 'data totals-doc' }, h('caption', { class: 'sr-only', text: 'Retenciones' }),
                h('tbody', null, t.retenciones.map(function (r) { return moneyRow(nb(r.label) + ' (base ' + cop(r.base) + ')', '− ' + cop(r.amount), null, r.legal + (r.note ? '. ' + r.note : '')); }),
                  moneyRow('Neto estimado a recibir', cop(t.neto), 'strong'))))
          ] : h('p', { class: 'small', text: nb('El cliente no está marcado como agente de retención. Si lo es, la retención en la fuente (2 % construcción, 2,5 % compras, 4 % servicios, 11 % honorarios), la reteIVA (15 % del IVA) y la reteICA se descuentan del pago, no del total.') })),
        h('section', { class: 'keep' }, h('h2', { text: '5. Estado de los precios' }),
          h('p', null, Object.keys(counts).map(function (k) { return [priceBadge(k), ' ' + counts[k] + ' ítems  ']; })),
          h('p', { class: 'small', text: 'Materiales y equipos: precios reales al consumidor publicados por proveedores en Colombia, consultados el ' + fmtDate(C.DEMO_TODAY) + ' (precio normal, sujeto a cambio y disponibilidad).' }),
          manual ? h('p', { class: 'small', text: manual + ' ítems incluyen precios registrados manualmente por el emisor (con fuente y justificación en la auditoría); no son precios publicados verificados por el sistema.' }) : null,
          estimated.length ? h('p', { class: 'small', text: 'Ítems con mano de obra estimada (tarifa de referencia × rendimiento supuesto): ' + estimated.map(function (l) { return l.code; }).join(', ') + '.' }) : null),
        h('section', null, h('h2', { text: '6. Requisitos de droguería' }), renderRequirements(doc.requirements)),
        h('section', { class: 'keep' }, h('h2', { text: '7. Hipótesis de cálculo' }),
          hyps.length ? h('ul', null, hyps.map(function (fl) {
            var val = fl.options ? (fl.options.filter(function (o) { return o[0] === fl.value; })[0] || [null, fl.value])[1] : fl.value;
            return h('li', { text: fl.label + ': ' + (val === null ? 'por definir' : String(val)) + ' (' + FIELD_LABEL[fl.status].toLowerCase() + '; ' + fl.action.toLowerCase() + ').' });
          })) : h('p', { text: 'Todos los datos del levantamiento fueron confirmados.' }),
          h('p', { class: 'small', text: 'Si una hipótesis cambia, el valor se recalcula en una nueva versión de esta cotización.' })),
        h('section', { class: 'keep' }, h('h2', { text: '8. Exclusiones' }), h('ul', null, doc.exclusions.map(function (e) { return h('li', { text: e }); }))),
        h('section', { class: 'keep' }, h('h2', { text: '9. Condiciones' }),
          h('ul', null,
            h('li', { text: 'Plazo estimado: 6 a 8 semanas desde la firma y el anticipo, sujeto a la entrega de proveedores (estimación de demostración).' }),
            h('li', { text: nb('Forma de pago: 50 % de anticipo, 40 % contra avance de obra y 10 % contra acta de entrega (condición de demostración).') }),
            h('li', { text: 'Garantías de equipos y mobiliario según las condiciones de cada fabricante.' }),
            h('li', { text: 'Todo cambio de alcance se cotiza como una nueva versión; una versión aceptada no se modifica.' }))),
        h('footer', { class: 'doc-foot keep' },
          h('p', { class: 'small', text: v ? 'Aprobada internamente por ' + v.approvedBy + ' el ' + fmtDate(doc.date) + '.' : 'Borrador sin aprobar.' }),
          h('p', { class: 'small', text: 'Clasificación fiscal ' + (doc.reviewed ? 'marcada como revisada con el contador.' : 'PENDIENTE de revisión profesional.') + ' ' + NOT_ADVICE }),
          h('p', { class: 'small muted', text: 'Cálculo: ' + doc.engine + '.' }))));
  }

  // ---------- Arranque ----------
  function companyDialog() {
    var cmp = state.company;
    openDialog('Datos de su empresa (emisor)', [
      h('div', { class: 'field' }, h('label', { for: 'co-name' }, 'Razón social'), h('input', { id: 'co-name', name: 'name', type: 'text', value: cmp.name })),
      h('div', { class: 'field' }, h('label', { for: 'co-nit' }, 'NIT'), h('input', { id: 'co-nit', name: 'nit', type: 'text', value: cmp.nit }))
    ], 'Guardar', function (form) {
      var name = form.name.value.trim();
      if (name.length < 3) return 'Escriba la razón social.';
      cmp.name = name; cmp.nit = form.nit.value.trim(); cmp.demo = false;
      save(); rerender(); toast('Datos de la empresa guardados.', 'ok');
      return null;
    });
  }
  function init() {
    state = load() || seed();
    save();
    var sel = document.getElementById('persona');
    Object.keys(PERSONAS).forEach(function (k) { sel.appendChild(h('option', { value: k, text: PERSONAS[k].name + ' — ' + PERSONAS[k].role })); });
    sel.value = state.persona;
    sel.addEventListener('change', function () {
      state.persona = sel.value; save(); rerender();
      toast('Ahora actúa como ' + actorName() + '.', 'info');
    });
    document.getElementById('btn-company').addEventListener('click', companyDialog);
    document.getElementById('btn-reset').addEventListener('click', function () {
      openDialog('Reiniciar el demo', [h('p', { text: 'Se borrarán los cambios guardados en este navegador y se restaurarán los proyectos de ejemplo.' })], 'Reiniciar', function () {
        localStorage.removeItem(KEY);
        state = seed(); save();
        ui = { statusFilter: 'all', priceFilter: 'all', expanded: {}, draft: null };
        if (location.hash === '#/' || location.hash === '') render(false); else location.hash = '#/';
        toast('Demo reiniciado.', 'info');
        return null;
      }, 'danger');
    });
    window.addEventListener('hashchange', function () { render(false); });
    render(false);
  }
  init();
})();
