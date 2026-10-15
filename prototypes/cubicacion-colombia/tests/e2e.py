"""Recorrido de usuario de punta a punta del prototipo ObraBase AI (iteración 2).

Requiere el servidor en marcha (npm start) y Playwright para Python con Chromium.
Uso: python tests/e2e.py [URL] [carpeta-de-capturas]
Sale con código distinto de 0 ante cualquier fallo o error de consola.
Los valores esperados están calculados a mano a partir de research/precios.json (ver comentarios).
"""
import http.client
import io
import os
import sys
import tempfile
import urllib.parse

from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4317/"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="obrabase-shots-")
os.makedirs(SHOTS, exist_ok=True)
results = []


def step(name):
    def deco(fn):
        fn()
        results.append(name)
        print("PASS", name, flush=True)
        return fn
    return deco


def digits(text):
    return int("".join(ch for ch in text if ch.isdigit()))


def row(page, code):
    return page.locator("table.lines tr", has=page.locator("td.mono", has_text=code))


def total(page):
    return digits(page.locator(".totals-list dd.grand").first.inner_text())


def open_apu(page, code):
    t = page.locator('[id="tg-%s"]' % code)
    if t.get_attribute("aria-expanded") != "true":
        t.click()
    expect(page.locator('[id="tr-%s"]' % code)).to_be_visible()


def server_security_checks():
    parsed = urllib.parse.urlparse(URL)
    for path, allowed in (("/..%2fserver.mjs", {403, 404}), ("/%2e%2e/package.json", {403, 404}), ("/js/prices.js", {200}),
                          ("/js/app.js%00", {400}), ("/js%5capp.js", {400}), ("/no-existe.js", {404})):
        conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=5)
        conn.request("GET", path)
        resp = conn.getresponse()
        body = resp.read()
        assert resp.status in allowed, (path, resp.status)
        assert resp.getheader("X-Content-Type-Options") == "nosniff", path
        assert "form-action 'self'" in (resp.getheader("Content-Security-Policy") or ""), path
        if resp.status == 200:
            assert "charset=utf-8" in resp.getheader("Content-Type")
        else:
            assert b"import" not in body, path
        conn.close()


OVERFLOW_JS = """(w) => { const out = []; for (const e of document.querySelectorAll('body *')) {
  if (e.closest('thead')) continue; const r = e.getBoundingClientRect();
  if (r.right > w + 0.5 && r.width > 0) out.push(e.tagName + '.' + e.className + ' right=' + Math.round(r.right) + ' ' + (e.textContent || '').slice(0, 50)); }
  return out.slice(0, 8); }"""


STATE = {}


def csv_total(page, label):
    with page.expect_download() as dl:
        page.click("#btn-csv-v")
    csv = open(dl.value.path(), encoding="utf-8-sig").read()
    assert label in csv, label
    line = [ln for ln in csv.splitlines() if ln.startswith("Total;")][0]
    return int(line.split(";")[5])


def register_price(page, code, price, source, why, kind="estimado", valid=None):
    page.click("#pr-" + code.replace(".", "\\."))
    page.select_option("#pd-type", kind)
    page.fill("#pd-price", str(price))
    page.fill("#pd-source", source)
    if valid:
        page.fill("#pd-valid", valid)
    page.fill("#pd-why", why)
    page.click("#dlg-confirm")
    expect(page.locator("dialog")).to_have_count(0)


console_errors = []

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1366, "height": 900}, accept_downloads=True, locale="es-CO")
    page = ctx.new_page()
    page.on("console", lambda m: console_errors.append(m.text) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: console_errors.append("pageerror: " + str(e)))

    @step("servidor: bloquea path traversal y sirve UTF-8")
    def _():
        server_security_checks()

    page.goto(URL)
    page.evaluate("localStorage.clear()")
    page.reload()

    @step("1. lista de proyectos y estado vacío al filtrar")
    def _():
        expect(page.locator("h1")).to_have_text("Proyectos")
        expect(page.locator("article.pcard")).to_have_count(3)
        page.select_option("#f-status", "APPROVED")
        expect(page.get_by_role("heading", name="No hay proyectos en este estado")).to_be_visible()
        page.get_by_role("button", name="Ver todos los proyectos").click()
        expect(page.locator("article.pcard")).to_have_count(3)

    @step("2. nuevo proyecto: validación, interpretación con evidencia")
    def _():
        page.click("#btn-nuevo")
        page.click("#btn-interpretar")
        expect(page.locator("#req-text-err")).to_be_visible()
        page.click("#btn-ejemplo")
        page.click("#btn-interpretar")
        expect(page.get_by_role("status").filter(has_text="Interpretando")).to_be_visible()
        expect(page.locator("#res-title")).to_be_visible(timeout=5000)
        expect(page.locator("#nw-areaM2")).to_have_value("80")
        expect(page.locator("#nw-estado")).to_have_value("obra_gris")
        expect(page.locator(".evidence", has_text="local de 80 m²").first).to_be_visible()
        page.screenshot(path=os.path.join(SHOTS, "02-levantamiento.png"), full_page=True)

    @step("3. presupuesto con precios reales: 03.02 = $6.516.836 (62 cajas) y pendientes sin inventar")
    def _():
        page.click("#btn-crear")
        page.wait_for_url("**/presupuesto")
        # 03.02: ⌈80×1,10÷1,44⌉ = 62 cajas → 89,28 m² × $34.900 = 3.115.872; pegante 16 × 47.154 = 754.464;
        # boquilla 5 × 34.900 = 174.500; instalación 514480 80 × 30.900 = 2.472.000 → 6.516.836 (IVA como costo: construcción)
        expect(row(page, "03.02")).to_contain_text("$ 6.516.836")
        for code in ("01.01", "02.02", "11.01", "11.02"):
            expect(row(page, code)).to_contain_text("Pendiente")
        expect(row(page, "08.01")).to_have_count(0)
        expect(page.locator("#unpriced-note")).to_contain_text("4 partidas sin precio")
        page.screenshot(path=os.path.join(SHOTS, "03-presupuesto.png"), full_page=True)

    pid = page.url.split("/proyecto/")[1].split("/")[0]
    base = URL + "#/proyecto/" + pid

    @step("3b. APU con teclado: IVA como costo en construcción y descontable en venta")
    def _():
        page.locator("#tg-03\\.02").focus()
        page.keyboard.press("Enter")
        expect(page.locator("#tg-03\\.02")).to_have_attribute("aria-expanded", "true")
        apu = page.locator("#tr-03\\.02")
        expect(apu).to_contain_text("62 cajas")
        expect(apu).to_contain_text("Costo con IVA (no descontable)")
        expect(apu).to_contain_text("Homecenter")
        page.locator("#tg-05\\.01").click()
        expect(page.locator("#tr-05\\.01")).to_contain_text("Base sin IVA")

    @step("4. IVA por base: utilidad (construcción) y valor total (venta)")
    def _():
        tl = page.locator(".totals-list").first
        expect(tl).to_contain_text("Contrato de construcción: IVA 19 % sobre la utilidad")
        expect(tl).to_contain_text("Venta de bienes con instalación: IVA 19 % sobre el valor total")

    @step("5. aprobación bloqueada y explicada")
    def _():
        page.goto(base + "/aprobacion")
        expect(page.locator("#btn-aprobar")).to_be_disabled()
        bl = page.locator("ul.issues.bad")
        for txt in ("01.01", "02.02", "11.01", "11.02", "Revisión fiscal pendiente"):
            expect(bl).to_contain_text(txt)

    @step("6. comparador de góndolas: el ancho del módulo cambia la cantidad; justificación obligatoria")
    def _():
        page.goto(base + "/presupuesto")
        expect(row(page, "07.01")).to_contain_text("15 und")  # módulo 1,2 m (Tecnoprocesos): ⌊18 ÷ 1,2⌋ = 15
        page.goto(base + "/comparar/07.01")
        page.check("#of-gondola-10001974")
        page.click("#btn-usar-oferta")
        expect(page.locator("#sel-err")).to_contain_text("motivo")
        page.screenshot(path=os.path.join(SHOTS, "06-comparador.png"), full_page=True)
        page.fill("#sel-why", "Vialambre en Bogotá; módulo de 1,0 m aprovecha mejor el muro.")
        page.click("#btn-usar-oferta")
        page.wait_for_url("**/presupuesto")
        expect(row(page, "07.01")).to_contain_text("18 und")  # ⌊18 ÷ 1,0⌋ = 18

    @step("6b. comparador de aire: 18.000 BTU y sin existencias no son seleccionables")
    def _():
        page.goto(base + "/comparar/05.01")
        expect(page.locator("#of-equipo-782461")).to_be_disabled()
        expect(page.locator("#of-equipo-775139")).to_be_disabled()
        expect(page.locator("#of-equipo-3022989")).to_be_enabled()
        expect(page.get_by_text("No cumple: 18.000 BTU").first).to_be_visible()

    @step("7. registrar precios documentados para los pendientes (con validación)")
    def _():
        page.goto(base + "/presupuesto")
        page.click("#pr-01\\.01")
        page.fill("#pd-price", "3000000")
        page.click("#dlg-confirm")
        expect(page.locator("#dlg-error")).to_contain_text("fuente")
        page.click("dialog >> text=Cancelar")
        register_price(page, "01.01", 3000000, "Honorarios internos de diseño", "Tarifa interna por proyecto de este tamaño")
        # A4: el IVA viene desmarcado por defecto: honorarios de $3.000.000 quedan en $3.000.000 (no 2.521.008).
        expect(row(page, "01.01")).to_contain_text("$ 3.000.000")
        register_price(page, "02.02", 650000, "Transportes Ejemplo, cotización 1234", "Cotización por teléfono confirmada por correo", kind="cotizado", valid="2026-11-15")
        register_price(page, "11.01", 2500, "Estimación interna por m²", "Cuadrilla de aseo, experiencia propia")
        register_price(page, "11.02", 900000, "Estimación interna", "Un día de técnico más documentación")
        expect(page.locator("#unpriced-note")).to_have_count(0)
        # Total 829.500 = 20 lonas × 2.800 (IVA incluido, costo) + volqueta 650.000 sin IVA, a la que en construcción
        # se le suma el IVA porque no es descontable (773.500).
        expect(row(page, "02.02")).to_contain_text("$ 829.500")
        # N6: lonas publicadas + volqueta con cotización registrada → el estado de la partida es la cotización.
        expect(row(page, "02.02")).to_contain_text("Cotización vigente")
        expect(row(page, "02.02")).not_to_contain_text("Publicado")
        open_apu(page, "02.02")
        expect(page.locator('[id="tr-02.02"]')).to_contain_text("Cotización vigente")

    @step("8. el área (m²) recalcula cantidades y compras: 100 m² → 77 cajas")
    def _():
        before = total(page)
        page.fill("#pm-areaM2", "100")
        page.keyboard.press("Tab")
        expect(row(page, "03.02")).to_contain_text("100 m²")
        open_apu(page, "03.02")
        expect(page.locator('[id="tr-03.02"]')).to_contain_text("77 cajas")
        expect(row(page, "07.01")).to_contain_text("23 und")  # estantería derivada 2 × (100 ÷ 8) − 2 = 23 m; módulo 1,0 m  # ⌈100×1,10÷1,44⌉ = 77
        assert total(page) > before
        page.fill("#pm-areaM2", "-5")
        page.keyboard.press("Tab")
        expect(page.locator("#toast")).to_contain_text("debe ser un número mayor que 0")
        expect(page.locator("#pm-areaM2")).to_have_value("100")

    @step("8b. estado del local: con acabados quita la nivelación y propone reparación para la obra")
    def _():
        page.select_option("#pm-estado", "con_acabados")
        expect(row(page, "03.01")).to_have_count(0)
        expect(page.locator("#cls-03")).to_have_value("reparacion")
        page.select_option("#pm-estado", "obra_gris")
        expect(row(page, "03.01")).to_have_count(1)
        expect(page.locator("#cls-03")).to_have_value("construccion")

    @step("9. AIU frente a margen; revisión fiscal marcada")
    def _():
        expect(page.get_by_text("AIU $110; margen $111")).to_be_visible()
        page.check("#fis-reviewed")
        expect(page.locator("#fis-reviewed")).to_be_checked()

    @step("10. retenciones del cliente: informativas, no cambian el total")
    def _():
        before = total(page)
        page.check("#fis-renta")
        expect(page.locator(".ret")).to_contain_text("Neto estimado a recibir")
        assert total(page) == before

    @step("11. no responsable de IVA: sin IVA y bloqueo sobre 3.500 UVT")
    def _():
        page.select_option("#fis-regime", "no_responsable")
        page.fill("#pm-areaM2", "700")
        page.keyboard.press("Tab")
        assert total(page) >= 183309000
        expect(page.get_by_role("alert").filter(has_text="3.500 UVT").first).to_be_visible()
        page.goto(base + "/aprobacion")
        expect(page.locator("ul.issues.bad")).to_contain_text("3.500 UVT")
        page.goto(base + "/presupuesto")
        page.select_option("#fis-regime", "responsable")
        page.fill("#pm-areaM2", "100")
        page.keyboard.press("Tab")
        expect(row(page, "03.02")).to_contain_text("100 m²")
        # Cambiar el régimen invalida la revisión fiscal (nit de la revisión de código): hay que volver a revisarla.
        expect(page.locator("#fis-reviewed")).not_to_be_checked()
        page.check("#fis-reviewed")

    @step("11b. el mismo total en la barra lateral, el resumen móvil, la tarjeta de inicio y la cotización borrador")
    def _():
        page.goto(base + "/presupuesto")
        side = total(page)
        mobile = digits(page.locator("#mobile-summary strong").text_content())
        page.goto(URL + "#/")
        card = digits(page.locator("article.pcard", has_text="Droguería Calle 80").locator("dd.strong").inner_text())
        page.goto(base + "/cotizacion/borrador")
        draft = digits(page.locator("tr.grand td").inner_text())
        assert side == mobile == card == draft, (side, mobile, card, draft)
        STATE["v1_expected"] = side

    @step("12. solo el gerente aprueba; la versión queda congelada")
    def _():
        page.goto(base + "/aprobacion")
        expect(page.locator("ul.issues.bad")).to_have_count(0)
        expect(page.locator("#btn-aprobar")).to_be_disabled()
        page.select_option("#persona", "andres")
        expect(page.locator("#btn-aprobar")).to_be_enabled()
        page.click("#btn-aprobar")
        page.fill("#ap-note", "Aprobado para envío.")
        page.click("#dlg-confirm")
        page.wait_for_url("**/cotizacion/1")

    @step("13. cotización/pre-factura: AIU visible, IVA por base, retenciones, sin proveedores; CSV de la misma versión")
    def _():
        doc = page.locator("article.doc")
        text = doc.inner_text()
        for must in ("Administración", "Imprevistos", "Utilidad", "Documento no válido como factura", "1.3.1.7.9",
                     "Retención en la fuente", "Neto estimado a recibir", "Código de Comercio",
                     "Requisitos de droguería", "Cubierto en 03.02", "Supuesto del prototipo"):
            assert must in text, must
        for forbidden in ("Homecenter", "Vialambre", "Tecnoprocesos", "Alkosto", "Sodimac"):
            assert forbidden not in text, forbidden
        doc_total = digits(doc.locator("tr.grand td").inner_text())
        assert doc_total == STATE["v1_expected"], (doc_total, STATE["v1_expected"])
        # N1: la marca de mano de obra estimada sale de los recursos: 01.01 (honorarios registrados por el emisor) no la
        # lleva; 03.05 (cielo raso con mano de obra estimada por el sistema) sí.
        q0101 = doc.locator("tr.q-item", has=page.locator("td.q-code", has_text="01.01"))
        q0305 = doc.locator("tr.q-item", has=page.locator("td.q-code", has_text="03.05"))
        expect(q0101).not_to_contain_text("Incluye mano de obra estimada")
        expect(q0101).to_contain_text("Incluye un valor registrado por el emisor")
        expect(q0305).to_contain_text("Incluye mano de obra estimada")
        # N6: los conteos de §5 por estado concuerdan con la frase de precios registrados a mano
        # (01.01, 11.01, 11.02 = estimación del emisor; 02.02 = cotización vigente).
        sec5 = doc.locator("section", has=page.locator("h2", has_text="5. Estado de los precios")).inner_text()
        sec5 = " ".join(sec5.replace(chr(160), " ").split())
        counts = {}
        for label in ("Estimación del emisor", "Cotización vigente", "Publicado (registrado)"):
            k = sec5.find(label + " ")
            counts[label] = int(sec5[k + len(label) + 1:].split(" ")[0]) if k >= 0 else 0
        assert counts["Cotización vigente"] == 1 and counts["Estimación del emisor"] == 3, (counts, sec5[:300])
        manual_sentence = "4 ítems incluyen precios registrados manualmente"
        assert manual_sentence in sec5, sec5
        assert sum(counts.values()) == 4, counts
        labor_list = doc.locator("p", has_text="Ítems con mano de obra estimada").inner_text()
        assert "03.05" in labor_list and "01.01" not in labor_list and "11.01" not in labor_list, labor_list
        assert csv_total(page, "v1 aprobada") == doc_total
        STATE["v1_total"] = doc_total
        page.screenshot(path=os.path.join(SHOTS, "13-cotizacion.png"), full_page=True)

    @step("13b. PDF de la cotización aprobada y completa: sin BORRADOR, con el total y paginado")
    def _():
        page.goto(base + "/cotizacion/1")
        expect(page.locator("#ready-note")).to_be_visible()
        expect(page.locator("#quote-doc")).not_to_have_class("doc draft")
        expect(page.locator("#incomplete-note")).to_have_count(0)
        out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
        os.makedirs(out_dir, exist_ok=True)
        pdf_path = os.path.join(out_dir, "cotizacion-v1.pdf")
        page.emulate_media(media="print")
        data = page.pdf(path=pdf_path, format="A4", print_background=True, prefer_css_page_size=True)
        page.emulate_media(media="screen")
        assert data[:5] == b"%PDF-" and len(data) > 20000, len(data)
        from pypdf import PdfReader  # herramienta de prueba, no dependencia del prototipo
        reader = PdfReader(io.BytesIO(data))
        text = " ".join(p.extract_text() or "" for p in reader.pages)
        norm = " ".join(text.replace(chr(160), " ").split())
        expected = "{:,}".format(STATE["v1_total"]).replace(",", ".")
        assert expected in norm, (expected, norm[:400])
        assert "Documento no válido como factura" in norm
        assert "BORRADOR" not in norm
        assert "Página 1 de " + str(len(reader.pages)) in norm, norm[-300:]
        for chrome in ("Actuando como", "Reiniciar demo", "Imprimir o guardar PDF", "Prototipo · IA simulada"):
            assert chrome not in norm, chrome
        print("   PDF:", pdf_path, len(data), "bytes,", len(reader.pages), "páginas", flush=True)

    @step("14. enviar (simulado) cambia el estado en la lista")
    def _():
        page.click("#btn-enviar")
        page.click("#dlg-confirm")
        expect(page.locator("#toast")).to_contain_text("no se envió ningún correo")
        page.goto(URL + "#/")
        expect(page.locator("article.pcard", has_text="Droguería Calle 80")).to_contain_text("Cotización enviada")

    @step("15. editar tras aprobar crea v2; v1 no cambia")
    def _():
        page.goto(base + "/presupuesto")
        page.fill("#pm-alturaM", "3.2")
        page.keyboard.press("Tab")
        expect(page.locator(".meta")).to_contain_text("v2 borrador")
        v2_total = total(page)
        assert v2_total != STATE["v1_total"], "la edición de v2 debía cambiar el total"
        page.goto(base + "/aprobacion")
        expect(page.get_by_text("Cambios frente a v1 aprobada")).to_be_visible()
        # A3/A5: la v1 aprobada se muestra y se exporta desde su instantánea, no desde el proyecto vivo.
        page.goto(base + "/cotizacion/1")
        assert digits(page.locator("tr.grand td").inner_text()) == STATE["v1_total"]
        assert csv_total(page, "v1 aprobada") == STATE["v1_total"]

    @step("16. auditoría: proveedor elegido y precios registrados con actor y justificación")
    def _():
        page.goto(base + "/historial")
        r = page.locator("tr", has_text="Proveedor seleccionado").filter(has_text="07.01")
        expect(r).to_contain_text("Laura Gómez")
        expect(r).to_contain_text("aprovecha mejor el muro")
        expect(page.locator("tr", has_text="Precio registrado").filter(has_text="02.02")).to_contain_text("Cotización recibida")

    @step("17. persistencia tras recargar")
    def _():
        page.reload()
        expect(page.locator(".meta")).to_contain_text("v2 borrador")

    @step("18. teclado: foco al título al cambiar de ruta; enlace para saltar; foco visible")
    def _():
        page.goto(base + "/resumen")
        page.goto(URL + "#/")
        assert page.evaluate("document.activeElement.tagName") == "H1"
        page.reload()
        page.keyboard.press("Tab")
        assert page.evaluate("document.activeElement.className") == "skip"
        page.keyboard.press("Tab")
        page.keyboard.press("Tab")
        assert page.evaluate("getComputedStyle(document.activeElement).outlineStyle") != "none"

    @step("19. responsive: sin desbordamiento y acciones visibles en móvil y tableta")
    def _():
        routes = ("#/", "#/nuevo", "#/proyecto/" + pid + "/presupuesto", "#/proyecto/" + pid + "/comparar/03.02",
                  "#/proyecto/" + pid + "/aprobacion", "#/proyecto/" + pid + "/cotizacion/1", "#/proyecto/" + pid + "/levantamiento")
        for w, hgt in ((375, 812), (768, 1024)):
            page.set_viewport_size({"width": w, "height": hgt})
            for r in routes:
                page.goto(URL + r)
                page.wait_for_timeout(150)
                sw = page.evaluate("document.documentElement.scrollWidth")
                if sw > w:
                    culprits = page.evaluate(OVERFLOW_JS, w)
                    raise AssertionError((w, r, sw, culprits))
            page.goto(URL + "#/proyecto/" + pid + "/presupuesto")
            expect(page.locator("#mobile-summary")).to_be_visible()
            expect(page.locator("#mobile-summary")).to_contain_text("Total a pagar")
            box = page.locator("#cmp-05\\.01").bounding_box()
            assert box and box["x"] >= 0 and box["x"] + box["width"] <= w, (w, box)
            page.screenshot(path=os.path.join(SHOTS, "19-presupuesto-%d.png" % w), full_page=False)
        page.set_viewport_size({"width": 1366, "height": 900})
        page.goto(URL + "#/proyecto/" + pid + "/presupuesto")
        expect(page.locator("#mobile-summary")).to_be_hidden()

    @step("20. proyecto sin área: estado vacío y generación tras medir")
    def _():
        page.goto(URL + "#/proyecto/nueva-granada/presupuesto")
        expect(page.get_by_role("heading", name="Aún no hay partidas")).to_be_visible()
        page.goto(URL + "#/proyecto/nueva-granada/levantamiento")
        expect(page.locator("#btn-generar")).to_be_disabled()
        page.fill("#sv-areaM2", "72")
        page.keyboard.press("Tab")
        expect(page.locator("#btn-generar")).to_be_enabled()
        page.click("#btn-generar")
        page.wait_for_url("**/presupuesto")
        expect(row(page, "07.01")).to_be_visible()

    @step("21. ruta inexistente muestra página no encontrada")
    def _():
        page.goto(URL + "#/proyecto/no-existe")
        expect(page.locator("h1")).to_have_text("Página no encontrada")

    browser.close()

print("screenshots:", SHOTS)
if console_errors:
    print("CONSOLE ERRORS/WARNINGS:")
    for e in console_errors:
        print("  ", e)
    sys.exit(2)
print("ALL %d STEPS PASSED, 0 console errors" % len(results))
