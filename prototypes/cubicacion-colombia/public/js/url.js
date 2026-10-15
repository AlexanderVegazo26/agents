// @ts-check
// Validación de enlaces externos (revisión de seguridad N3).
// Un enlace solo se acepta si es https, sin credenciales y sin «@» ni «\» en la autoridad: así
// «https://www.homecenter.com.co@evil.com/x» no puede mostrarse como el proveedor y abrir otro sitio.
(function (root) {
  'use strict';
  var BACKSLASH = String.fromCharCode(92);

  function safeUrl(u) {
    if (typeof u !== 'string' || u.length < 9) return null;
    for (var i = 0; i < u.length; i++) { var c = u.charCodeAt(i); if (c <= 32 || c === 127) return null; }
    if (u.slice(0, 8).toLowerCase() !== 'https://') return null;
    var rest = u.slice(8);
    var end = rest.length;
    ['/', '?', '#'].forEach(function (ch) { var k = rest.indexOf(ch); if (k >= 0 && k < end) end = k; });
    var authority = rest.slice(0, end);
    if (!authority || authority.indexOf('@') >= 0 || authority.indexOf(BACKSLASH) >= 0 || authority.toLowerCase().indexOf('%2f') >= 0) return null;
    if (u.indexOf(BACKSLASH) >= 0) return null;
    var parsed;
    try { parsed = new URL(u); } catch (e) { return null; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) return null;
    return u;
  }

  /** Host real al que lleva el enlace (según el analizador de URL del navegador), o null. */
  function hostOf(u) {
    var s = safeUrl(u);
    if (!s) return null;
    return new URL(s).hostname;
  }

  root.OBUrl = { safeUrl: safeUrl, hostOf: hostOf };
})(typeof window !== 'undefined' ? window : globalThis);
