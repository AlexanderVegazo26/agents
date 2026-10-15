# ObraBase AI — prototipo de cubicación de locales (Colombia)

Calcula cuánto cuesta adecuar un local comercial vacío para una droguería: cantidades a partir de los m², precios reales
de proveedores colombianos, AIU, IVA y retenciones, y una cotización / pre-factura imprimible en PDF.

Es un **prototipo para aprender**, no un producto: lea las limitaciones al final. El detalle del producto, el guion de
demostración y los supuestos están en [`PROTOTYPE.md`](PROTOTYPE.md).

## Requisitos

| Para | Necesita |
|---|---|
| Usar el prototipo | **Node.js 18 o superior** (no hay que instalar paquetes: no tiene dependencias) y un navegador moderno |
| Pruebas unitarias | Node.js 18 o superior |
| Pruebas de navegador (e2e) | **Python 3** con **Playwright para Python** y su Chromium (`pip install playwright pypdf` y `python -m playwright install chromium`) |
| Regenerar precios | Python 3 (solo biblioteca estándar) |

## Cómo ejecutarlo

```bash
cd prototypes/cubicacion-colombia
npm start
```

Abra <http://127.0.0.1:4317/>. El servidor solo escucha en su propio equipo (127.0.0.1). Para detenerlo: `Ctrl + C`.
Otro puerto: `PORT=5000 npm start`.

No hay inicio de sesión: el selector **«Actuando como»** (arriba a la derecha) cambia entre la presupuestista, el gerente
comercial (único que aprueba) y la responsable técnica (única que valida cantidades).

## Pruebas

```bash
npm run test:unit        # motor de cálculo, impuestos, datos de precios y exportación CSV
npm start                # en otra terminal: las pruebas e2e necesitan el servidor
npm run test:e2e         # recorrido completo en Chromium + acciones secundarias
```

Las pruebas e2e generan `tests/out/cotizacion-v1.pdf` (ignorado por git). Lea el código de salida, no solo el texto:
`npm run test:e2e; echo $?` debe imprimir `0`.

## Regenerar los precios

Los precios reales viven en `research/precios.json` (consultados el 15/10/2026). La aplicación lee una copia generada,
`public/js/prices.js`. Después de editar el JSON:

```bash
npm run build:prices     # = python tools/build_prices.py
```

El generador falla a propósito si una fila trae una URL que no es https, un host que no está en su lista permitida
(`ALLOWED_HOSTS`), credenciales en la URL o un precio que no es un entero. Excluye siempre a Imcolmedica (posible sitio
comprometido). Los identificadores son estables: el código del proveedor, o un hash de proveedor + producto + URL.

## La cotización imprimible (PDF)

1. Abra un proyecto → **Presupuesto**. Las partidas **Pendiente** no tienen un precio con fuente (el sistema no los inventa).
2. Use **«Registrar precio»** en cada una (o desde la pestaña **Aprobación**, que las lista con un botón): tipo, valor, fuente,
   justificación y si el valor ya incluye IVA.
3. En el panel **Impuestos**, revise la clasificación por capítulo y marque **«Clasificación revisada con el contador»**.
4. Cambie a **Andrés Rincón (gerente comercial)** → **Aprobación** → **«Aprobar»**.
5. En la cotización aprobada, pulse **«Imprimir o guardar PDF»** y elija «Guardar como PDF» en el diálogo del navegador.

El documento sale en A4, sin la interfaz de la aplicación, con encabezados de tabla repetidos y número de página.
Un borrador o una versión con ítems sin precio se imprime con la marca **BORRADOR**. Una versión aprobada se imprime
siempre igual: su contenido se guardó al aprobarla y no cambia aunque después se edite el proyecto (eso crea una
versión nueva). **«Descargar CSV»** exporta la misma versión, separada por punto y coma (`;`), en UTF-8.

## Reiniciar el demo

Los datos se guardan solo en el navegador (`localStorage`). El botón **«Reiniciar demo»** (pie de página) borra los
cambios y restaura los tres proyectos de ejemplo. **«Datos de su empresa»** fija la razón social y el NIT del emisor.

## Limitaciones conocidas

- **Precios con fecha 15/10/2026**, al consumidor, tomados de las páginas de los proveedores: cambian y pueden estar
  agotados. No hay consulta en vivo.
- **No es asesoría tributaria.** La clasificación fiscal de cada capítulo es una propuesta; la confirma un contador.
  Varias reglas están marcadas **NO VERIFICADO** en la interfaz.
- **Autenticación simulada**: el selector de persona no protege nada; las restricciones de rol son solo de interfaz.
- **Solo `localStorage`**: sin servidor de datos, sin multiusuario, sin copia de seguridad.
- **La mano de obra se estima** con una tarifa de referencia × rendimientos supuestos; es la mayor fuente de incertidumbre.
- **La pre-factura no es una factura electrónica** (Resolución DIAN 000165 de 2023).
