"""Genera public/js/prices.js a partir de research/precios.json (sin red, determinista, LF).

Reglas (revisión de seguridad F4 y de código A7):
- Excluye Imcolmedica por nombre de proveedor Y por dominio (urlsplit): posible sitio comprometido.
- Solo URL https cuyo host esté en la lista permitida; rechaza credenciales (@) en la autoridad.
  Un host nuevo hace fallar la generación: debe revisarse y agregarse a ALLOWED_HOSTS a propósito.
- precio_cop debe ser entero o null.
- id estable: el sku si existe; si no, "h" + sha1(proveedor|producto|url)[:10] (no depende de la posición).
Uso: python tools/build_prices.py
"""
import hashlib
import json
import pathlib
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "research" / "precios.json"
OUT = ROOT / "public" / "js" / "prices.js"

BLOCKED_HOSTS = {"imcolmedica.com.co"}
ALLOWED_HOSTS = {
    "avisospublicitarios.co", "colombia.bioweb.co", "colombia.generadordeprecios.info", "disenosyestructurasjh.com",
    "electronilab.co", "indasoc.com", "industriascruzmr.com", "lemor-productos-y-disenos.webnode.com.co",
    "tecnoprocesoscolombia.com", "tienda.pintuco.com", "tiendadelarquitecto.com", "www.alkosto.com",
    "www.bplmedical.com", "www.comandoconstrucciones.com", "www.easy.com.co", "www.exito.com",
    "www.homecenter.com.co", "www.industriascruz.com.co", "www.ktronix.com", "www.masterspublicidad.com",
    "www.vialambre.com",
}


def fail(msg):
    sys.exit("build_prices: " + msg)


def blocked(host):
    return any(host == b or host.endswith("." + b) for b in BLOCKED_HOSTS)


rows = json.loads(SRC.read_text(encoding="utf-8"))
out = {}
skipped = []
for i, r in enumerate(rows):
    prov = (r.get("proveedor") or "").strip()
    url = (r.get("url") or "").strip()
    host = ""
    if url:
        if any(ord(ch) <= 32 or ord(ch) == 127 for ch in url):
            fail("URL con espacios o caracteres de control (fila %d): %r" % (i, url))
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or "").lower()
        if "@" in parts.netloc:
            fail("URL con credenciales en la autoridad (fila %d): %s" % (i, url))
    if "imcolmedica" in prov.lower() or (host and blocked(host)):
        skipped.append((i, prov))
        continue
    if url:
        if parts.scheme != "https":
            fail("solo se aceptan URL https (fila %d): %s" % (i, url))
        if host not in ALLOWED_HOSTS:
            fail("host no permitido (fila %d): %s; revíselo y agréguelo a ALLOWED_HOSTS" % (i, host))
        url = urllib.parse.urlunsplit(("https", parts.netloc.lower(), parts.path, parts.query, parts.fragment))
    price = r.get("precio_cop")
    if price is not None and (not isinstance(price, int) or isinstance(price, bool) or price <= 0):
        fail("precio_cop no es un entero positivo (fila %d): %r" % (i, price))
    sku = (r.get("sku") or "").strip()
    rid = sku or "h" + hashlib.sha1("|".join([prov, r.get("producto") or "", url]).encode("utf-8")).hexdigest()[:10]
    if rid in out:
        if out[rid]["precio"] != price:
            fail("id duplicado con precio distinto: %s" % rid)
        continue
    out[rid] = {
        "id": rid, "item": r["item_key"], "proveedor": prov, "producto": r.get("producto") or "", "sku": sku,
        "unidad": r.get("unidad") or "", "precio": price, "iva": r.get("incluye_iva"), "url": url,
        "fecha": r.get("fecha_consulta") or "", "notas": r.get("notas") or "",
    }

body = json.dumps(out, ensure_ascii=True, indent=1, sort_keys=True)
text = (
    "// GENERADO por tools/build_prices.py desde research/precios.json. No editar a mano.\n"
    "// Precios reales al consumidor consultados el 2026-10-15. Excluido: Imcolmedica.\n"
    "(function (root) {\n  'use strict';\n  root.OBPrices = " + body + ";\n"
    "})(typeof window !== 'undefined' ? window : globalThis);\n"
)
OUT.write_bytes(text.encode("utf-8"))
print("rows:", len(rows), "written:", len(out), "skipped:", skipped)
for rid, v in sorted(out.items()):
    if rid.startswith("h") and not v["sku"]:
        print("hash-id", rid, v["item"], v["proveedor"], "|", v["producto"][:50])
