# ObraBase AI — prototipo clicable (iteración 5)

Prototipo de cubicación de locales comerciales en Colombia: **cuánto cuesta adecuar un local vacío para una droguería**,
con precios reales de proveedores colombianos, AIU, IVA y retenciones según las reglas vigentes, y una
cotización / pre-factura lista para revisar. Fuente del producto: `docs/cubicacion-colombia.md` (PRD ObraBase AI).
Fuentes de datos: `research/colombia-adecuacion.md` y `research/precios.json` (consultados el 15/10/2026).

> No es asesoría tributaria ni legal. La clasificación fiscal de cada capítulo la propone el sistema y la confirma un contador.

## Cómo ejecutarlo

```bash
cd prototypes/cubicacion-colombia
npm start            # node server.mjs — sin dependencias, no requiere npm install
```

Abrir <http://127.0.0.1:4317/>. No hay inicio de sesión: el selector **«Actuando como»** cambia entre Laura Gómez
(presupuestista), Andrés Rincón (gerente comercial) e Ing. Camila Torres (responsable técnica). Los datos se guardan en el
navegador; **«Reiniciar demo»** restaura los proyectos de ejemplo; **«Datos de su empresa»** fija la razón social y el NIT del emisor.

Instalación, pruebas, regeneración de precios y cómo obtener el PDF: ver [`README.md`](README.md).

Pruebas: `npm run test:unit` (Node ≥ 18) y, con el servidor en marcha, `npm run test:e2e`
(`tests/e2e.py` recorrido principal + `tests/e2e_actions.py` acciones secundarias; Playwright para Python + Chromium).
Si cambia `research/precios.json`: `python tools/build_prices.py` regenera `public/js/prices.js`.

## Hipótesis

Creemos que **un presupuestista de una empresa de adecuación comercial** podrá **saber en minutos cuánto cuesta adecuar un
local de N m² como droguería en Bogotá —con precios reales de proveedores colombianos, AIU e IVA según las reglas vigentes y
cada cifra trazable a su fuente—** **describiendo el local en texto libre, ajustando los m² y resolviendo solo lo que el sistema
marca como pendiente**, en lugar de **cotizar ítem por ítem en tiendas y armar el presupuesto y la pre-factura a mano en Excel**.

## Guion de demostración (≈ 10 minutos)

1. **Proyectos** → «+ Nuevo proyecto» → «Usar ejemplo: droguería de 80 m² en Bogotá» → «Interpretar solicitud». La matriz
   distingue *Inferencia IA* (con el texto de origen), *Supuesto* y *Pendiente*; los parámetros (estado del local, acabado,
   ciudad, refrigeración) se pueden corregir allí mismo.
2. «Crear proyecto y calcular presupuesto». Arriba, **Parámetros del local**: el **área (m²)** es el parámetro principal.
   Abra «Ver APU» en **03.02**: 62 cajas de porcelanato Homecenter (80 m² × 1,10 ÷ 1,44), pegante, boquilla e instalación,
   cada recurso con proveedor, referencia, enlace, fecha de consulta y si el IVA es costo (construcción) o descontable (venta).
3. Cambie el área a 100 m²: todas las cantidades, compras, precios e impuestos se recalculan (77 cajas).
4. «Comparar proveedores» en **07.01**: el ancho del módulo cambia cuántas góndolas caben (15 de 1,2 m frente a 18 de 1,0 m).
   En **05.01** los equipos de 18.000 BTU y los que no tienen existencias no se pueden elegir.
5. **Aprobación** está bloqueada y dice por qué: cuatro partidas sin precio real (diseño, volqueta, limpieza final, pruebas)
   y la revisión fiscal. Cada bloqueo de precio tiene su botón «Registrar precio» (fuente, justificación y si incluye IVA;
   el IVA viene desmarcado). El sistema no inventa esos valores.
6. Panel **Impuestos (Colombia, 2026)**: el IVA se calcula por capítulo (construcción: 19 % sobre la utilidad;
   mobiliario y equipos: 19 % sobre el total). Marque al cliente como agente de retención: aparecen las retenciones y el
   neto a recibir, sin cambiar el total. Pruebe «No responsable de IVA» con un local grande: aparece el bloqueo de 3.500 UVT.
   Marque «Clasificación revisada con el contador».
7. Cambie a **Andrés Rincón (gerente)** → «Aprobar v1». Se abre la **cotización / pre-factura**: AIU desglosado, IVA por base
   con su norma, retenciones informativas, requisitos de droguería, hipótesis, exclusiones, vigencia y la leyenda
   «Documento no válido como factura». Con todos los precios registrados, **«Imprimir o guardar PDF»** produce el documento
   limpio en A4 (sin la interfaz, con número de página). «Descargar CSV» trae la misma versión y el mismo total.
   «Enviar al cliente (simulado)». Si después se edita el proyecto, nace la v2 y la v1 sigue imprimiéndose igual.

## Qué se construyó (trazabilidad)

| Fuente | Interpretado como | Construido como | Verificado por |
|---|---|---|---|
| Usuario, resp. 1: «cubicación es adecuar un espacio … debo cotizar cada cosa que debo comprar» | El producto es el presupuesto de adecuación completo, con lista de compras | APU por partida con recursos reales; CSV interno «lista de compras» con proveedor, referencia, URL | e2e 3, 3b; `data.test` |
| Usuario, resp. 3 y 7: «aplica las reglas actuales de Colombia», «verifica cómo se hace» | Reglas tributarias 2026 y práctica AIU | IVA por clase de capítulo (art. 1.3.1.7.9 DUR 1625/2016, art. 447 ET, Oficio DIAN 44743/2013); AIU sobre CD; retenciones; 3.500 UVT | `tax.test` (oráculo research §1.7); e2e 4, 10, 11 |
| Research §0.2: el IVA de materiales no es descontable en construcción | IVA de compra como costo cuando no es descontable | `calc.js → ivaIsCost/costUnit` | `regression_iva.test` (rojo con el código anterior) |
| Usuario, resp. 4: «utiliza proveedores reales» | Precios publicados de `precios.json` | 141 filas embebidas (Imcolmedica excluido); comparador por recurso | `data.test`; e2e 6, 6b |
| Usuario, resp. 5: «cotización, pre-factura … con impuestos» | Documento para el cliente con el costo total | Cotización / pre-factura con AIU, IVA por base, retenciones, vigencia, leyenda legal | e2e 13 |
| Usuario, resp. 6: «el size en m² debe ser un parámetro para determinar los precios» | m² como parámetro principal, más los de research §5 | Panel de parámetros; fórmulas visibles en cada APU | e2e 8, 8b; `data.test` |
| PRD §6.2–6.3 matriz de completitud; §13.4 no inventar precios | Evidencia y estados por dato | Inferencia IA / Supuesto / Pendiente; lo sin precio queda Pendiente | e2e 2, 3, 5 |
| PRD §8.1–8.2 motor de cantidades; research §5 reglas usuales | Fórmulas con redondeo y desperdicio | Piso 10 % y cajas completas; pintura por galones; drywall por placas; góndolas por módulo | `data.test`; e2e 3b, 8 |
| PRD §10.3 / Escenario 4 comparador; no elegir lo que incumple | Opciones reales con especificación | Tarjetas por proveedor; no seleccionables con motivo | e2e 6, 6b; `data.test` |
| Research §3 requisitos de droguería (Res. 1403/2007, 2955/2007, RETIE, UAECOB) | Requisitos que mueven el costo | Partidas 03.02, 03.04, 03.05, 03.06, 08.01, 12.01–12.03 y lista de verificación | e2e 13 (cotización §6, «Cubierto en 03.02»); pestaña Levantamiento por revisión visual |
| PRD §5.1 / Escenario 9 bloquear aprobación | Lista de bloqueos con enlace | Pestaña Aprobación; solo el gerente aprueba | e2e 5, 12 |
| PRD §14.5 versiones inmutables; Escenario 8 auditoría | Editar lo aprobado crea vN+1 | Diff de versiones; historial con valor anterior, nuevo, actor y justificación | e2e 15, 16 |
| PRD §21 español colombiano, COP, responsive, WCAG 2.2 AA | Objetivo de diseño | Intl es-CO; tablas apiladas en móvil; foco visible; contraste ≥ 4,5:1 | e2e 18, 19 |

## Cambios de la iteración 5

- **N6/N7** El estado de una partida es el de su recurso menos verificado, con un orden total (de peor a mejor):
  pendiente > vencido > mano de obra estimada por el sistema > estimación del emisor > referencia > publicado registrado a mano >
  cotización vigente > publicado por el sistema. Una partida con un material publicado y una cotización registrada muestra
  «Cotización vigente» (antes «Publicado»), y los conteos de la cotización §5 concuerdan con la frase de precios registrados a mano.
- **Seguridad N3** Los enlaces se validan en `public/js/url.js`: https, sin usuario ni contraseña, sin «@», «\» ni «%2F» en la
  autoridad; el host que se muestra es el que resuelve el analizador de URL. Un enlace registrado a mano cuyo host no está entre los
  proveedores de la investigación muestra «Dominio no listado como proveedor».

## Cambios de la iteración 4 (segunda ronda de revisiones)

- **N1** Tres orígenes de precio, tres rótulos: «Mano de obra estimada» solo cuando la partida tiene mano de obra estimada
  por el sistema (tarifa de referencia × rendimiento supuesto); «Estimación del emisor» para un valor registrado a mano
  como estimación; «Publicado (registrado)» para un precio publicado registrado a mano. La cotización marca «Incluye mano de
  obra estimada» solo en las primeras y «Incluye un valor registrado por el emisor» en las registradas.
  **Política:** «Permitir aprobar con mano de obra estimada» bloquea solo la estimación del sistema. Las estimaciones del
  emisor no bloquean la aprobación (llevan fuente, justificación, fecha y actor en la auditoría), pero generan una
  advertencia visible para quien aprueba y quedan identificadas en la cotización.
- **A9** Los precios registrados a mano tienen su propio rótulo y ayuda en el presupuesto, el APU, el filtro, la cotización y el
  CSV; el diálogo registra la fecha de consulta que indica el usuario (por defecto la fecha de referencia, nunca posterior) y
  el APU muestra el host del enlace junto al enlace.
- **N3** En el comparador se puede fijar la opción automática como elección propia; deja de recalcularse con los parámetros.
- **N4** El pie de la cotización usa la misma fecha de referencia que la fecha y la vigencia del documento.
- **N5** Pruebas de las góndolas centrales derivadas (17 a 700 m²) y de la versión del motor y la tarifa de IVA.
- **Seguridad N1** La neutralización CSV también salta una comilla doble inicial (`x,"=1+1"`).
- **Seguridad F4/N2** El generador rechaza URL con espacios o caracteres de control y escribe la URL normalizada
  (`urlunsplit`); el navegador tampoco acepta enlaces con caracteres de control y muestra el host de los enlaces registrados.
- **Conteo corregido:** `prices.js` tiene 141 entradas: 140 con enlace https y 1 sin enlace (el «144» del informe anterior contaba
  filas de `research/precios.json`, incluidas las excluidas y las duplicadas).

## Cambios de la iteración 3 (revisión de código, revisión de seguridad, README y PDF)

- **A1** La opción automática (menor costo, o la premium) ya no se guarda como elección del usuario: se recalcula en cada
  cambio de parámetros. Solo lo elegido en el comparador queda fijo.
- **A2** Los supuestos derivados (estantería = 2 × fondo − 2 m; góndolas centrales = máx(1, ⌊área ÷ 40⌋)) se recalculan con el
  área hasta que el usuario los fija. Vanos (12 m²) y puertas (4 m) son parámetros «Supuesto» editables. Los tableros
  (⌈circuitos ÷ 12⌉) y los equipos de aire (⌈área ÷ 80⌉, preliminar) escalan con el área.
- **A3** Las pruebas comparan: el total de la v1 y su CSV antes y después de editar la v2; y el mismo total en la barra
  lateral, el resumen móvil, la tarjeta de inicio y la cotización borrador. Ambas se vieron fallar con una mutación.
- **A4** «El precio ya incluye IVA» viene desmarcado: honorarios de $3.000.000 quedan en $3.000.000.
- **A5** Una versión aprobada guarda su documento completo (totales, IVA por base, retenciones, costo por ítem, emisor,
  cliente, requisitos y versión del motor de cálculo). La cotización y el CSV de esa versión salen de ahí; solo los
  borradores se recalculan.
- **A6** Un único resolvedor de clase fiscal; un capítulo sin clase bloquea la aprobación y no se suma.
- **A7** Identificadores estables (código del proveedor o hash de proveedor + producto + URL); el generador exige precios
  enteros; las pruebas verifican proveedor y producto de cada id referenciado.
- **A8** La mano de obra estimada aparece como «Estimación interna (referencia: Homecenter 310473…)», sin SKU ni URL comprables.
- **A9** Un precio registrado a mano se marca como tal en la auditoría y en la cotización (§5); «precio publicado» exige el enlace https.
- **A10** Las constantes UVT salen solo de `calc.js`.
- **Nits** Se retiró el bloqueo de «error aritmético» (era tautológico). Cambiar el estado del local o el régimen reinicia la
  revisión fiscal. Con partidas sin precio, un no responsable ve «podría superar 3.500 UVT». Fecha única de referencia
  (15/10/2026) para precios, vigencias y fecha de los documentos.
- **F1/F2** CSV: celdas con `, ; " CR LF TAB` entre comillas; cada segmento que empiece por `= + - @` (o una celda que empiece por
  TAB/CR) se neutraliza con «'». Delimitador documentado: punto y coma.
- **F3** El servidor rechaza NUL y barra invertida con 400 y no registra rutas ni trazas.
- **F4** El generador excluye Imcolmedica también por dominio, rechaza credenciales en la URL y solo acepta hosts de una lista permitida.
- **F5** `nosniff` y CSP también en respuestas de error; CSP con `form-action 'self'`; los enlaces de proveedor solo pueden ser https.
- **D** Hoja de estilo de impresión: A4, márgenes, «Página N de M», encabezados de tabla repetidos, filas y bloque de totales sin
  partir, sin la interfaz. La marca BORRADOR y «Borrador incompleto» solo aparecen en borradores o versiones con ítems sin precio.
  La prueba e2e genera `tests/out/cotizacion-v1.pdf` y comprueba el total, la paginación y la ausencia de BORRADOR.
- **C** `README.md` con requisitos, ejecución, pruebas, regeneración de precios, PDF, reinicio y limitaciones.

## Cambios de la iteración 2

- **Precios reales** en lugar de ficticios: `public/js/prices.js` generado desde `research/precios.json` por `tools/build_prices.py`
  (determinista, LF, solo URL http(s), Imcolmedica excluido por posible sitio comprometido).
- **APU paramétricos**: cada partida es una lista de recursos (material, servicio, equipo, mano de obra) con fórmula visible.
  La mano de obra sin precio publicado se **estima** con la tarifa real de Homecenter 310473 ($86.900 / 4 h) × un
  rendimiento **supuesto**, y la partida queda «Estimado».
- **Motor fiscal nuevo**: clase fiscal por capítulo, régimen del contratista (responsable, SIMPLE, no responsable), IVA de
  compras como costo cuando no es descontable (**corrige un error** de la iteración 1 que subestimaba el costo hasta ~16 %),
  retenciones informativas del cliente, tope de 3.500 UVT, constantes UVT 2026.
- **AIU sobre costo directo** (práctica colombiana) por defecto; el margen sobre venta se mantiene como alternativa (PRD §11.3).
- **Cotización / pre-factura** reemplaza la «propuesta» (la ruta antigua `/propuesta/N` redirige).
- **Parámetros nuevos**: estado del local (obra gris / con acabados / a demoler), nivel de acabado, ciudad, muros divisorios,
  refrigeración. Capítulos nuevos 12 (seguridad humana y requisitos sanitarios) y 13 (carpintería y fachada).
- **Móvil**: las tablas se apilan como tarjetas y el comparador usa tarjetas; las acciones quedan visibles a 375 px
  (resuelve la salvedad de la iteración 1).
- **Ningún proyecto de ejemplo viene aprobado**: aprobarlo exigiría inventar los precios pendientes.
- **Pruebas retiradas por cambio deliberado** (en `tests/calc.test.mjs` se explica): ofertas ficticias de góndolas, opción fiscal
  única sobre todo el subtotal, piso con 8 % sin redondeo a cajas, reparto proporcional por capítulos, y la acción «Revalidar» y
  el estado «Vencido» en e2e (todos los precios reales son del 15/10/2026 y ninguno vence; la regla sigue cubierta en unitarias).

## Alcance

- **Dentro:** levantamiento desde texto libre, matriz de completitud, parámetros del local, 30 partidas con APU de precios reales,
  comparador de proveedores, AIU, IVA por capítulo, retenciones informativas, tope de 3.500 UVT, requisitos de droguería,
  aprobación con bloqueos, versiones, cotización / pre-factura, CSV, impresión/PDF, auditoría.
- **Fuera (discutido, deliberadamente no construido):** actas de avance y cubicación de obra ejecutada (PRD §15.4), compras y
  órdenes de compra, costo real y cierre, importación de catálogos y extracción con IA, lectura de planos, hidrosanitario
  (baño), capítulo 06 (red, CCTV), factura electrónica, multiempresa, permisos reales.
- **Futuro:** conectores de precios por API (PRD §9.3), cotizaciones reales de proveedores (RFQ), recargo nocturno de mano de obra,
  tarifas ICA del Acuerdo 724/2026, motor fiscal validado y versionado por un contador.

## Supuestos

1. ⚠️ **Clasificación fiscal por capítulo.** La DIAN no resuelve si una «adecuación de local» es construcción o reparación
   (research §6.1, NO VERIFICADO). Propuesta: obra (02, 03, 04, 11) = construcción en obra gris o a demoler, reparación si el
   local ya tiene acabados; mobiliario y equipos (05, 07, 08, 09, 10, 12, 13) = venta con instalación; diseño (01) = honorarios.
   Bloquea la aprobación hasta que se marque «revisada con el contador».
2. ⚠️ **Retenciones por clase de capítulo**: dividir la retención en la fuente según la clase (2 % construcción, 2,5 % compras,
   4 % servicios, 11 % honorarios, tarifas de declarante) es un supuesto del prototipo, no una regla con fuente. Si la base excluye
   el IVA: NO VERIFICADO. Decreto 572/2025 vigente salvo decisión posterior. SIMPLE elimina solo la retención en renta.
3. ⚠️ **Mano de obra estimada**: tarifa al consumidor para trabajos simples (no de obra por contrato) × rendimientos supuestos
   (p. ej. 0,5 h/m² de cielo raso, 1,5 h por salida eléctrica). Es la mayor fuente de incertidumbre del total.
4. Precios: precio **normal** publicado al consumidor (las ofertas temporales van en notas); IVA incluido salvo «+IVA»; un precio
   sin IVA indicado se trata como sin IVA. Los precios de mobiliario no incluyen envío.
5. Rendimientos de material supuestos donde la página es dudosa: pegante 5 kg/m², pintura 20 m²/galón por mano (conservador),
   boquilla 0,3 kg/m², modulación de drywall 0,61 m (NO VERIFICADA).
6. Geometría supuesta: local rectangular, frente 8 m, altura 3 m, 12 m² de vanos, 4 m de puertas; muros con estantería =
   2 × fondo − 2 m (se recalcula con el área hasta que se confirme); 6 ml de muros divisorios. Todo editable y marcado como Supuesto.
7. AIU por defecto 8 / 5 / 10 % sobre costo directo (dentro de los rangos de research §2.2). La utilidad pactada no puede ser
   inferior a la comercial de contratos similares (DUR art. 1.3.1.7.9).
8. Cantidades eléctricas, de extintores y de emergencia son preliminares (las fija el diseño o el concepto de Bomberos).
9. Fecha de referencia 15/10/2026 (fecha de consulta de todos los precios); vigencia de la cotización 30 días.
10. Cronograma (6–8 semanas) y forma de pago (50/40/10) son textos de demostración.
11. Exclusión de IVA de computadores ≤ 50 UVT (art. 424 num. 5 ET): no se aplica en el cálculo; la partida 09.01 avisa si el
    precio elegido queda por debajo del tope (con los precios normales encontrados no ocurre).
12. La opción por defecto de cada recurso es la de menor precio × cantidad entre las que cumplen; la recomendación del
    comparador usa el costo con el tratamiento de IVA. Coinciden con los datos actuales, pero podrían diferir con opciones «+IVA».
13. Equipos de aire acondicionado preliminares: máx(1, ⌈área ÷ 80 m²⌉); la capacidad real exige cálculo de carga térmica.
    Tableros: ⌈circuitos ÷ 12⌉ con circuitos = ⌈tomas ÷ 8⌉ + ⌈paneles ÷ 10⌉ + cajas + equipos de aire (supuesto).
14. Góndolas centrales derivadas del área (máx(1, ⌊área ÷ 40⌋)) mientras no se confirmen: para 64 m² sale 1, no 2.

## Conflictos resueltos

**Conflicto:** el archivo se llama «cubicación»; el PRD trata la cubicación de obra ejecutada (actas, §15.4) como fase 2.
**Decisión:** confirmada por el usuario (resp. 1): «cubicación» es adecuar un local para un negocio y cotizar todo lo que hay que
comprar. Se construyó el presupuesto de adecuación; las actas de avance siguen fuera.

**Conflicto:** PRD §3.6 dice que el cliente no ve costos internos ni márgenes; para el IVA de construcción (art. 1.3.1.7.9 DUR)
el contrato debe **señalar la utilidad**, y la práctica colombiana desglosa el AIU.
**Decisión:** la cotización muestra A, I y U; sigue sin mostrar proveedores ni ofertas alternativas. **Por qué:** la regla
tributaria vigente y la petición del usuario (resp. 3, 5, 7) pesan más que la preferencia del PRD.

**Conflicto:** el usuario pidió proveedores reales (resp. 4); para varias partidas solo hay uno (protección, lonas, guardaescoba,
aviso, señalización, boquilla, instalación de piso) y para otras ninguno (diseño, volqueta, limpieza, pruebas, nevera 2–8 °C).
**Decisión:** se muestra «un solo proveedor encontrado» sin rellenar con un segundo; lo que no tiene precio queda Pendiente y
se registra con fuente y justificación. **Por qué:** PRD §13.4, no inventar precios.

**Conflicto:** PRD §11.3 exige ofrecer recargo y margen; la práctica colombiana es AIU sobre costo directo.
**Decisión:** AIU por defecto, margen como alternativa con la diferencia explicada.

**Conflicto:** PRD §17.2 recomienda Next.js + NestJS + PostgreSQL; el prototipo es HTML/JS sin dependencias.
**Decisión:** sin dependencias; el stack es para el MVP de producción.

## NO VERIFICADO (visible en la interfaz)

Clasificación construcción/reparación de una adecuación; si la base de retención excluye el IVA; bases mínimas de reteIVA;
tarifa ICA/reteICA Bogotá 7,60 ‰ (fuente secundaria) y tarifas del Acuerdo 724/2026; tarifa de retención en servicios para no
declarantes; SMMLV 2026 en Diario Oficial; modulación de drywall; costo de la certificación RETIE; texto del Decreto 1077/2015
sobre licencias; cantidad de extintores; andamios por encima de 2,50 m; precios de volqueta, aviso en acrílico, nevera 2–8 °C,
cortina de fabricante; variante del mostrador de $880.000; Decreto 572/2025 (vigente salvo decisión posterior).

## Lo que necesita la versión real (revisión de seguridad)

La autenticación simulada es una limitación conocida del prototipo. Una versión real necesita:

- Autorización en el servidor para cada acción (registrar precios, aprobar, enviar, cambiar la clasificación fiscal).
- Separación de funciones: quien prepara un presupuesto no puede aprobarlo.
- Inmutabilidad de las versiones aprobadas garantizada por el servidor, no por el navegador.
- Auditoría en el servidor, solo de adición, con el usuario autenticado (no el nombre elegido en un selector).
- Aislamiento por organización (tenant) en cada consulta.
- Revisión de tratamiento de datos personales según la Ley 1581 de 2012 (clientes, NIT, contactos).

## Atajos del prototipo (revisar antes de producción)

- Selector de persona en lugar de autenticación; las restricciones de rol son solo de interfaz.
- Estado en `localStorage`; sin backend ni API. El servidor solo sirve archivos estáticos en 127.0.0.1.
- IA simulada con expresiones regulares (`public/js/data.js → parseRequest`).
- Precios congelados al 15/10/2026 en `prices.js`; sin consulta en vivo ni verificación de existencias.
- Reglas fiscales en código (`public/js/calc.js`), sin versionado ni aprobación de un contador.
- «Excel» es CSV con `;` y BOM UTF-8; «PDF» es la impresión del navegador; «Enviar» es simulado.
- El enlace «Ver en el sitio del proveedor» abre la página del proveedor en otra pestaña (el prototipo no hace llamadas de red).

## Preguntas abiertas

- ¿Qué capítulos considera el contador construcción y cuáles reparación o venta, para un local en obra gris?
- ¿Qué rendimientos de mano de obra usan hoy (h/m² de cielo raso, h por salida eléctrica…) y qué tarifa de cuadrilla?
- ¿El cliente típico (droguería) es agente de retención? ¿Cuál es el régimen de su empresa?
- ¿Prefieren comprar al proveedor más barato o a uno solo (logística, garantía, envío)?
- ¿Qué vigencia y forma de pago usan en sus cotizaciones?

## Qué aprender con este prototipo

1. **¿El total se parece a lo que cuesta de verdad?** Compare con un presupuesto real de una droguería de tamaño similar:
   ¿qué partida se desvía más (mano de obra estimada, mobiliario sin envío)?
2. **¿La lista de compras con proveedor, referencia y enlace les ahorra la búsqueda en tiendas?** ¿Comprarían así?
3. **¿El IVA por capítulo coincide con cómo facturan hoy?** ¿Lo entienden sin un contador al lado?
4. **¿Confían en una cotización que dice qué ítems son estimados?** ¿O preferirían ocultarlo?
5. **¿El área como parámetro principal basta?** ¿Qué otro dato cambia más el precio en su experiencia?
6. **¿La cotización / pre-factura es enviable tal cual?** ¿Qué le falta (logo, firma, formato propio)?
7. **¿Qué partes no se echaron de menos?** (importación de catálogos, compras, actas): señal para recortar el MVP.

## Archivos

- `README.md` (cómo ejecutarlo), `public/index.html`, `public/styles.css` (incluye la hoja de impresión), `public/js/calc.js`
  (motor de cálculo y fiscal), `public/js/data.js` (catálogo de APU, cantidades, requisitos, intérprete simulado),
  `public/js/prices.js` (generado), `public/js/csv.js` (exportación CSV segura), `public/js/url.js` (validación de enlaces),
  `public/js/app.js` (interfaz).
- `server.mjs` (servidor estático), `tools/build_prices.py` (genera `prices.js`), `research/` (fuentes; no se modifican).
- `tests/calc.test.mjs`, `tests/tax.test.mjs`, `tests/data.test.mjs`, `tests/regression_iva.test.mjs`, `tests/csv.test.mjs`, `tests/url.test.mjs`
  (unitarias), `tests/e2e.py`, `tests/e2e_actions.py` (navegador; generan `tests/out/`, ignorado por git).
