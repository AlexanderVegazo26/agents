"""Acciones secundarias: registrar precio (validaciones), validar cantidad por rol, incluir/excluir partida
opcional, refrigeración como parámetro, datos de la empresa, reiniciar demo y vista de impresión.

Uso: python tests/e2e_actions.py [URL]  (requiere el servidor en marcha). Sale != 0 ante fallos.
(La acción «Revalidar» de la iteración 1 se retiró: todos los precios reales son del 15/10/2026 y ninguno vence.)
"""
import sys

from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4317/"
errors = []


def row(page, code):
    return page.locator("table.lines tr", has=page.locator("td.mono", has_text=code))


def total(page):
    return int("".join(c for c in page.locator(".totals-list dd.grand").first.inner_text() if c.isdigit()))


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1366, "height": 900})
    page.on("console", lambda m: errors.append(m.text) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    page.reload()
    base = URL + "#/proyecto/los-andes/presupuesto"
    page.goto(base)

    # Refrigeración reportada → la nevera aparece Pendiente (sin proveedor confiable); al quitarla desaparece.
    expect(row(page, "08.01")).to_contain_text("Pendiente")
    page.select_option("#pm-refrigeracion", "no")
    expect(row(page, "08.01")).to_have_count(0)
    page.select_option("#pm-refrigeracion", "si")
    expect(row(page, "08.01")).to_contain_text("Pendiente")
    print("PASS refrigeración como parámetro")

    # Registrar precio de la nevera: validaciones y guardado como cotización con vigencia.
    page.click('[id="pr-08.01"]')
    page.click("#dlg-confirm")
    expect(page.locator("#dlg-error")).to_contain_text("precio unitario")
    page.fill("#pd-price", "9800000")
    page.fill("#pd-source", "Distribuidor biomédico, cotización 77")
    page.fill("#pd-why", "Cotización escrita recibida")
    page.select_option("#pd-type", "cotizado")
    page.click("#dlg-confirm")
    expect(page.locator("#dlg-error")).to_contain_text("vigencia")
    page.fill("#pd-valid", "2026-11-30")
    page.click("#dlg-confirm")
    expect(page.locator("dialog")).to_have_count(0)
    expect(row(page, "08.01")).not_to_contain_text("Pendiente")
    # N6: datalogger publicado + nevera con cotización registrada → la partida muestra la cotización.
    expect(row(page, "08.01")).to_contain_text("Cotización vigente")
    print("PASS registrar precio con validaciones")

    # A9: un «precio publicado» registrado a mano exige el enlace https de la fuente.
    page.click('[id="pr-02.02"]')
    page.select_option("#pd-type", "publicado")
    page.fill("#pd-price", "500000")
    page.fill("#pd-source", "Página de un transportador")
    page.fill("#pd-why", "Precio leído en la web")
    page.click("#dlg-confirm")
    expect(page.locator("#dlg-error")).to_contain_text("enlace https")
    page.fill("#pd-url", "http://ejemplo.com/precio")
    page.click("#dlg-confirm")
    expect(page.locator("#dlg-error")).to_contain_text("enlace https")
    print("PASS precio publicado exige enlace https")
    page.keyboard.press("Escape")
    expect(page.locator("dialog")).to_have_count(0)
    expect(row(page, "02.02")).to_contain_text("Pendiente")
    print("PASS Escape cierra el diálogo sin guardar")

    # A9: aceptado con enlace https; queda rotulado como registrado, con el host y la fecha de consulta del usuario.
    page.click('[id="pr-02.02"]')
    page.select_option("#pd-type", "publicado")
    page.fill("#pd-price", "500000")
    page.fill("#pd-source", "Tarifa publicada por un transportador")
    page.fill("#pd-url", "https://www.transportes-ejemplo.com.co/tarifas")
    page.fill("#pd-date", "2026-10-10")
    page.fill("#pd-why", "Precio leído en la web del transportador")
    page.click("#dlg-confirm")
    expect(page.locator("dialog")).to_have_count(0)
    expect(row(page, "02.02")).to_contain_text("Publicado (registrado)")
    expect(row(page, "02.02")).to_contain_text("Precio registrado")
    t = page.locator('[id="tg-02.02"]')
    if t.get_attribute("aria-expanded") != "true":
        t.click()
    apu = page.locator('[id="tr-02.02"]')
    expect(apu).to_contain_text("Registrado manualmente")
    expect(apu).to_contain_text("(www.transportes-ejemplo.com.co)")
    expect(apu).to_contain_text("10 de oct de 2026")
    print("PASS precio publicado registrado: aceptado con https, rotulado, con host y fecha")

    # N3: fijar la opción automática como elección propia: ya no cambia con el acabado.
    page.goto(URL + "#/proyecto/los-andes/comparar/03.02")
    page.check("#pin-porcelanato")
    page.fill("#sel-why", "El cliente ya eligió este porcelanato")
    page.click("#btn-usar-oferta")
    page.wait_for_url("**/presupuesto")
    page.select_option("#pm-acabado", "premium")
    t = page.locator('[id="tg-03.02"]')
    if t.get_attribute("aria-expanded") != "true":
        t.click()
    expect(page.locator('[id="tr-03.02"]')).to_contain_text("Crystal Beige")
    expect(page.locator('[id="tr-03.02"]')).not_to_contain_text("Quarx")
    page.select_option("#pm-acabado", "estandar")
    print("PASS fijar la opción automática como elección propia")

    # Validar cantidad: rechazado como presupuestista, aceptado como técnica.
    page.click('[id="vq-04.01"]')
    expect(page.locator("#toast")).to_contain_text("Solo la responsable técnica")
    page.select_option("#persona", "camila")
    page.click('[id="vq-04.01"]')
    expect(row(page, "04.01")).to_contain_text("Validado")
    print("PASS validar cantidad por rol")

    # Partida opcional: excluir la vitrina (incluida por defecto) resta su valor; incluirla lo restituye.
    before = total(page)
    page.click('[id="inc-07.04"]')
    expect(row(page, "07.04")).to_contain_text("Excluida")
    assert total(page) < before
    page.click('[id="inc-07.04"]')
    assert total(page) == before
    print("PASS incluir/excluir partida opcional")

    page.goto(URL + "#/proyecto/los-andes/historial")
    expect(page.locator("tr", has_text="Precio registrado").filter(has_text="08.01")).to_contain_text("Cotización escrita recibida")
    expect(page.locator("tr", has_text="Precio registrado").filter(has_text="02.02")).to_contain_text("registrado manualmente")
    expect(page.locator("tr", has_text="Cantidad validada")).to_contain_text("Camila Torres")
    print("PASS auditoría de acciones secundarias")

    # Datos de la empresa: se reflejan en la cotización.
    page.click("#btn-company")
    page.fill("#co-name", "Mi Empresa de Adecuaciones S.A.S.")
    page.fill("#co-nit", "900.123.456-7")
    page.click("#dlg-confirm")
    page.goto(URL + "#/proyecto/los-andes/cotizacion/borrador")
    expect(page.locator(".doc-parties")).to_contain_text("Mi Empresa de Adecuaciones S.A.S.")
    expect(page.locator(".doc-parties")).to_contain_text("900.123.456-7")
    print("PASS datos de la empresa en la cotización")

    # Vista de impresión: oculta la interfaz, muestra el documento.
    page.emulate_media(media="print")
    expect(page.locator(".topbar")).to_be_hidden()
    expect(page.locator("#btn-print")).to_be_hidden()
    expect(page.locator("article.doc")).to_be_visible()
    page.emulate_media(media="screen")
    print("PASS vista de impresión")

    # Atajo desde Aprobación: cada bloqueo de precio abre «Registrar precio» directamente.
    page.goto(URL + "#/proyecto/los-andes/aprobacion")
    page.click('[id="ap-pr-11.01-limpieza"]')
    expect(page.locator("dialog")).to_contain_text("Limpieza final")
    page.keyboard.press("Escape")
    expect(page.locator("dialog")).to_have_count(0)
    print("PASS registrar precio desde Aprobación")

    # Reiniciar demo restaura los datos.
    page.click("#btn-reset")
    page.click("#dlg-confirm")
    page.goto(base)
    expect(row(page, "08.01")).to_contain_text("Pendiente")
    print("PASS reiniciar demo")
    browser.close()

if errors:
    print("CONSOLE ERRORS:", errors)
    sys.exit(2)
print("ALL ACTION CHECKS PASSED, 0 console errors")
