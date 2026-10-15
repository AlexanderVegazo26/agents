// Servidor estático mínimo del prototipo, sin dependencias.
// Solo escucha en 127.0.0.1 y solo sirve archivos dentro de ./public.
// Revisión de seguridad: F3 (NUL y barra invertida → 400; sin rutas absolutas ni trazas en el log)
// y F5 (nosniff + CSP también en las respuestas de error; form-action 'self').
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const PORT = Number(process.env.PORT) || 4317;
const HOST = '127.0.0.1';
const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
};

function send(res, status, body, extra) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...(extra || {}) });
  res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    send(res, 400, 'Bad request');
    return;
  }
  if (pathname.includes(NUL) || pathname.includes(BACKSLASH)) {
    send(res, 400, 'Bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = resolve(join(ROOT, pathname));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    send(res, 403, 'Forbidden');
    return;
  }
  const type = TYPES[extname(file)];
  if (!type) {
    send(res, 404, 'Not found');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR')) {
      send(res, 404, 'Not found');
    } else {
      console.error('Error al leer un archivo estático:', err && err.code ? err.code : 'desconocido');
      send(res, 500, 'Internal error');
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ObraBase AI (prototipo) en http://${HOST}:${PORT}/`);
});
