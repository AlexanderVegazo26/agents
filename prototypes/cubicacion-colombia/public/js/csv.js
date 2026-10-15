// @ts-check
// Exportación CSV segura (revisión de seguridad F1/F2).
// Delimitador: punto y coma (;) — el que usa Excel con configuración regional es-CO. Codificación UTF-8 con BOM.
// Defensa contra inyección de fórmulas: cada celda se divide en segmentos por , ; CR LF y TAB (un lector que use otro
// delimitador partiría la celda allí); si un segmento empieza —tras espacios o caracteres de control— por = + - @,
// se le antepone un apóstrofo. Toda celda con , ; " CR LF o TAB va entre comillas.
(function (root) {
  'use strict';
  var TAB = String.fromCharCode(9);
  var LF = String.fromCharCode(10);
  var CR = String.fromCharCode(13);
  var QUOTE = '"';
  var SEPARATORS = [',', ';', CR, LF, TAB];
  var LEADERS = ['=', '+', '-', '@'];

  function isControlOrSpace(ch) { return ch.charCodeAt(0) <= 32; }

  /**
   * Neutraliza un segmento: si su primer carácter significativo es un iniciador de fórmula, antepone «'».
   * Se saltan espacios, caracteres de control y comillas dobles: un lector con otro delimitador puede quitar
   * la comilla de apertura (x,"=1+1") y dejar la fórmula al descubierto.
   */
  function neutralise(seg) {
    var i = 0;
    while (i < seg.length && (isControlOrSpace(seg.charAt(i)) || seg.charAt(i) === QUOTE)) i++;
    if (i < seg.length && LEADERS.indexOf(seg.charAt(i)) >= 0) return seg.slice(0, i) + "'" + seg.slice(i);
    return seg;
  }

  function cell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    // Números puros (importes y cantidades) no se tocan: un importe nunca es negativo en este prototipo.
    if (typeof v === 'number') return s;
    var out = '';
    var seg = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (SEPARATORS.indexOf(ch) >= 0) {
        out += neutralise(seg) + ch;
        seg = '';
      } else {
        seg += ch;
      }
    }
    out += neutralise(seg);
    // Una celda que EMPIEZA por TAB o CR también es un iniciador de fórmula (OWASP CSV injection).
    if (s.charAt(0) === TAB || s.charAt(0) === CR) out = "'" + out;
    var needsQuotes = SEPARATORS.some(function (c) { return out.indexOf(c) >= 0; }) || out.indexOf(QUOTE) >= 0;
    if (needsQuotes) out = QUOTE + out.split(QUOTE).join(QUOTE + QUOTE) + QUOTE;
    return out;
  }
  function row(values) { return values.map(cell).join(';'); }

  function document(rows) {
    return String.fromCharCode(0xFEFF) + rows.map(row).join(CR + LF) + CR + LF;
  }

  root.OBCsv = { cell: cell, row: row, document: document, DELIMITER: ';' };
})(typeof window !== 'undefined' ? window : globalThis);
