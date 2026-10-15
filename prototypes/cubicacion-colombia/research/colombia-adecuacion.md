# Adecuación de un local comercial en Colombia (droguería, Bogotá): impuestos, método de presupuesto, normas y precios reales

Investigación de apoyo para el prototipo `prototypes/cubicacion-colombia` (ObraBase AI).
Fecha de corte: **2026-10-15**. Todas las consultas web se hicieron el 2026-10-15 salvo que se indique otra fecha.
Compañero legible por máquina: [`precios.json`](precios.json).

> **Advertencia.** Esto es investigación documental, no asesoría tributaria ni legal. Varias reglas dependen de
> cómo se redacte el contrato y de la calidad tributaria de las partes; un contador debe validar el motor fiscal
> antes de producción. Donde una cifra solo se encontró en una fuente secundaria se dice explícitamente; donde no
> se pudo verificar se marca **NO VERIFICADO**.

Convención de fuentes: `[Fn]` remite a la tabla de fuentes al final (URL + fecha de consulta).
«Primaria» = DIAN, normograma oficial, Secretaría de Hacienda/Alcaldía, Ministerio, página de producto del proveedor.
«Secundaria» = portales contables (Actualícese, Gerencie, Siempre al Día/Alegra, Rankia, INCP, Accounter) o blogs.

---

## 0. Resumen ejecutivo (lo que cambia en el prototipo)

1. **No existe un único «tratamiento fiscal» para todo el presupuesto de una droguería.** La DIAN distingue:
   - *Contrato de construcción de bien inmueble* → IVA 19 % solo sobre honorarios/utilidad pactados en el contrato
     (Decreto 1372/1992 art. 3, compilado en el **art. 1.3.1.7.9 del DUR 1625/2016**) [F5][F6].
   - *Reparaciones, resanes, pinturas, mantenimiento* → **no** son construcción; IVA 19 % sobre el **valor total**
     (materiales + mano de obra + gastos) [F7][F8].
   - *Venta de bienes con instalación* (muebles empotrables, equipos) → venta, IVA 19 % sobre el total (art. 447 ET) [F9].
   - El **art. 462-1 ET (AIU con piso de 10 %) no aplica a construcción**: es solo para aseo, vigilancia, temporales,
     cooperativas de trabajo asociado y contratos sindicales [F5][F10].
   Consecuencia: el presupuesto de una droguería es normalmente **mixto** (obra + suministros). El prototipo aplica
   una sola opción fiscal al subtotal completo (`calc.js → totals(..., taxOption)`); eso no modela el caso real.
2. **Bajo la base «utilidad», el IVA pagado en materiales NO es descontable** para el constructor (solo el IVA de
   costos ligados a los honorarios/utilidad) [F6][F11]. Ese IVA es **costo** y debe ir dentro del APU. Hoy
   `netUnit()` descuenta el IVA de los precios «IVA incluido» en todos los casos: en modo AIU eso **subestima el
   costo directo** en hasta 19/119 ≈ 16 % de los materiales comprados al por menor.
3. **Retenciones**: las practica el **cliente** si es agente de retención; **no** cambian el total facturado, solo el
   neto que recibe el contratista. En la cotización se muestran como información. Construcción: **2 %** sobre el
   pago total, desde **10 UVT = $523.740** (régimen del Decreto 572/2025, vigente de nuevo desde el 1-jul-2026) [F12][F15][F16].
4. **Umbral de 3.500 UVT = $183.309.000**: un contratista persona natural que firme un contrato gravado de cuantía
   individual igual o superior debe inscribirse **antes** como responsable de IVA (Oficio DIAN 13873 de 2026) [F14].
   Una droguería de 80 m² llave en mano puede acercarse a esa cifra: debe ser una regla de validación.
5. **ICA Bogotá** lo paga el contratista sobre sus ingresos (no se suma como línea a la factura); **reteICA** la
   practica el cliente si es agente retenedor. Tarifas de construcción 6,90 ‰ / 7,60 ‰ según CIIU (fuente
   secundaria). El **Acuerdo 724 de 2026** reforma el ICA desde el 1-ene-2027 [F17][F18].

---

## 1. Impuestos y retenciones 2026

### 1.1 Valores base 2026

| Concepto | Valor 2026 | Fuente |
|---|---|---|
| UVT | **$52.374** | Resolución DIAN 000238 del 15-dic-2025 (DO 53.338, 17-dic-2025), art. 868 ET [F1] (primaria) |
| 2 UVT / 4 UVT | $104.748 / $209.496 | cálculo |
| 10 UVT / 27 UVT | $523.740 / $1.414.098 | cálculo |
| 50 UVT (computadores excluidos de IVA) | $2.618.700 | cálculo; art. 424 num. 5 ET [F20] (secundaria) |
| 3.500 UVT (tope no responsable de IVA) | $183.309.000 | cálculo; art. 437 par. 3 ET [F13][F14] |
| SMMLV 2026 | $1.750.905 (auxilio de transporte $249.095) | Decretos 1469 y 1470 de 2025; Decreto 0159 de 2026 tras suspensión provisional del 1469 [F21] (secundaria; NO VERIFICADO en Diario Oficial) |

### 1.2 IVA

**Tarifa general: 19 %** (art. 468 ET, modificado por art. 184 Ley 1819/2016) [F2] (texto vía Actualícese, secundaria;
la consulta a secretariasenado.gov.co falló por conexión rechazada el 2026-10-15). No se encontró ninguna norma
posterior que cambie la tarifa general. Las alzas de IVA del Decreto Legislativo 1474/2025 (licores, apuestas en
línea) fueron declaradas inexequibles por la Corte Constitucional (C-079 de 2026, 15-abr-2026) y no tocaban la
tarifa general [F22].

**(a) Venta de materiales / suministro (incluye venta con instalación).**
- IVA 19 % sobre el valor total de la operación, incluida la instalación (art. 447 ET). La DIAN lo aplica a
  muebles empotrables vendidos e instalados (cocinas, clósets): «la base gravable para el IVA es la indicada en el
  artículo 447 del Estatuto Tributario», «la formula AIU no es aplicable» (Oficio 131 del 13-feb-2018) [F9].
- Aplica a: góndolas, mostradores, vitrinas, nevera de medicamentos, equipos de punto de venta, UPS, aviso, aire
  acondicionado vendido e instalado como equipo.
- Excepción relevante: computadores personales de escritorio o portátiles de valor ≤ 50 UVT ($2.618.700) están
  **excluidos** de IVA (art. 424 num. 5 ET) [F20] (secundaria). Afecta el kit POS (09.01).

**(b) Contrato de construcción / adecuación.**
- Norma: Decreto 1372/1992 art. 3, compilado en el **art. 1.3.1.7.9 del Decreto Único Reglamentario 1625/2016**
  (no 1.3.1.2.4 como sugería el encargo). Texto citado por la DIAN (Oficio 959 del 16-ene-2019) [F5]:
  «En los contratos de construcción de bien inmueble, el impuesto sobre las ventas se genera sobre la parte de los
  ingresos correspondiente a los honorarios obtenidos por el constructor. Cuando no se pacten honorarios el
  impuesto se causará sobre la remuneración del servicio que corresponda a la utilidad del constructor. Para estos
  efectos, en el respectivo contrato se señalará la parte correspondiente a los honorarios o utilidad, la cual en
  ningún caso podrá ser inferior a la que comercialmente corresponda a contratos iguales o similares.»
- **Condiciones**: (i) que sea realmente construcción de bien inmueble; (ii) que el contrato **señale** la utilidad
  (u honorarios); (iii) que esa utilidad no sea inferior a la comercial de contratos similares. **No hay un
  porcentaje mínimo legal fijo** para construcción; el piso del 10 % es del art. 462-1, que no aplica [F5][F10].
- **IVA descontable**: solo el IVA de costos y gastos ligados a la utilidad/honorarios; el IVA de materiales y
  costos de la obra no se descuenta (Oficio 1095 (906722) del 6-sep-2022: «en ningún caso dará derecho a descuento el impuesto sobre las ventas cancelado por los costos y gastos necesarios para la construcción del bien inmueble») [F11].
  ⇒ En el APU los materiales deben costearse **con IVA**.
- **¿Qué es construcción?** La DIAN separa «la construcción de una obra y otra la realización de reparaciones,
  resanes, pinturas»; las «ampliaciones o transformaciones, realizadas en inmuebles ya construidos» pueden ser
  nueva construcción según las circunstancias; si no es contrato de construcción, «la base gravable se conforma con
  el valor total del contrato, incluyendo materiales, gastos, mano de obra, etc.» (Oficio 44743 del 22-jul-2013) [F7].
  El Concepto 415 (003524) del 25-mar-2025 ratifica que el **mantenimiento** de inmuebles no es construcción [F8].
  Ningún concepto hallado resuelve expresamente «adecuación de local comercial» → **NO VERIFICADO**: la
  clasificación de cada capítulo (03 obra civil con muros de drywall nuevos = probable «transformación»; pintura
  sola = reparación) debe validarla el contador.
- **Administración delegada**: retención 10 %/11 % solo sobre honorarios (art. 1.2.4.4.9 DUR) [F6].

**¿Quién cobra el IVA?** El contratista, si es **responsable de IVA**. Si es **no responsable** (persona natural que
cumple todos los requisitos del art. 437 par. 3: ingresos gravados de 2025 < 3.500 UVT de 2025 ($174.296.500), un solo
establecimiento, sin franquicia, no usuario aduanero, contratos < 3.500 UVT, consignaciones < 3.500 UVT) **no
factura IVA**, pero el IVA que paga en materiales es costo para él [F13][F14]. Si va a firmar un contrato gravado
≥ 3.500 UVT ($183.309.000) debe inscribirse como responsable **antes** de celebrarlo (Oficio DIAN 13873 de 6-ago-2026,
publicado 24-ago-2026) [F14].

### 1.3 Retención en la fuente (renta) — la practica el cliente, si es agente de retención

Estado del **Decreto 572 de 2025**: el Consejo de Estado suspendió provisionalmente sus arts. 2 a 8 el 7-may-2026;
la DIAN ordenó aplicar las reglas anteriores desde el 8-may-2026 (Comunicado 070 de 2026) [F15]. El 2-jun-2026 la
Sección Cuarta revocó la suspensión, con efectos «a partir del primer día calendario del mes siguiente a la
ejecutoria» del auto (expediente 30229) [F16]; las fuentes secundarias fijan esa fecha en el **1-jul-2026** [F12].
No se halló sentencia de fondo al 2026-10-15: **vigente salvo decisión posterior**.

| Concepto | Tarifa | Base mínima con Dec. 572 (vigente) | Base si se volviera a suspender | Fuente |
|---|---|---|---|---|
| Contratos de construcción y urbanización | **2 %** sobre el pago total | 10 UVT = $523.740 | 27 UVT = $1.414.098 | par. 2 art. 1.2.4.9.1 DUR (Oficio 165/2021 [F6]); tabla 2026 [F12] (secundaria) |
| Compras generales, declarante | 2,5 % | 10 UVT = $523.740 | 27 UVT = $1.414.098 | [F12][F15] |
| Compras generales, no declarante | 3,5 % | 10 UVT | 27 UVT | [F12] |
| Servicios generales, declarante | 4 % | 2 UVT = $104.748 | 4 UVT = $209.496 | [F12][F15] |
| Servicios generales, no declarante | 6 % (la tabla secundaria dice «4 % o 6 %») | 2 UVT | 4 UVT | [F12] (secundaria; **NO VERIFICADO** en primaria) |
| Honorarios (diseño, 01.01) | 11 % PJ; 10 %/11 % PN | sin base mínima | — | [F12] |

- En contratos de construcción la retención se calcula sobre **el valor total del pago o abono**, no sobre la utilidad:
  «se practica sobre el valor total del pago o abono en cuenta» (Oficio 165 (901006), 10-feb-2021) [F6].
- Si el contratista está en el **Régimen Simple (SIMPLE)**, no se le practica retención en la fuente a título de
  renta (art. 911 ET), sin perjuicio de la retención de IVA [F23].

### 1.4 Retención de IVA (reteIVA)

- Tarifa general **15 % del IVA** facturado (art. 437-1 ET; el Gobierno puede fijarla hasta 50 %) [F24] (secundaria).
- Agentes de retención de IVA: entidades estatales, **grandes contribuyentes** y los designados por la DIAN, entre
  otros (art. 437-2 ET) [F24] (secundaria). Una droguería pequeña persona natural normalmente **no** es agente.
- Bases mínimas: siguen las de la retención en renta (10 UVT compras / 2 UVT servicios con Dec. 572) — **NO VERIFICADO**
  en fuente primaria.
- Para un contratista SIMPLE, la reteIVA se rige por el num. 9 del art. 437-2 [F23].

### 1.5 ICA y reteICA en Bogotá

- El ICA lo **declara y paga el contratista** sobre sus ingresos brutos en Bogotá. Práctica usual (no se encontró
  fuente que lo establezca): no se suma como línea a la factura sino que se cubre en la administración del AIU.
  Los requisitos de la factura electrónica (Res. 165/2023 art. 11 num. 13) exigen discriminar IVA, INC y otros
  impuestos «exigidos por ley», no el ICA [F30].
- Tarifas por CIIU (‰), según tabla 2026 publicada por Rankia (actualizada 05-oct-2026, citando a la SDH) [F17]
  (**secundaria**; la resolución SDH-000265 del 13-abr-2021 es la que fija actividad y tarifa [F19] y su anexo no se
  pudo consultar → tarifas **NO VERIFICADAS en primaria**):

| CIIU | Actividad | Tarifa ‰ |
|---|---|---|
| 4111 / 4112 | Construcción de edificios residenciales / no residenciales | 6,90 |
| 4321 | Instalaciones eléctricas | 6,90 |
| 4322 | Fontanería, calefacción y aire acondicionado | 6,90 |
| 4329 | Otras instalaciones especializadas | 6,90 |
| **4330** | **Terminación y acabado de edificios** (la más probable para una adecuación) | **7,60** |
| 4390 | Otras actividades especializadas para la construcción | 7,60 |

  La cartilla ICA de la SDH (SUIT) muestra históricamente 6,9 ‰ para 4111 (grupo 302) [F17].
- **reteICA**: la practica el cliente si es agente retenedor (entidades públicas, grandes contribuyentes DIAN,
  designados por la Dirección de Impuestos de Bogotá) [F25]; bases mínimas citadas para 2026: servicios desde
  4 UVT ($209.496) y compras desde 27 UVT ($1.414.098) [F17] (secundaria; **NO VERIFICADO** en primaria).
  La tarifa de reteICA = tarifa de la actividad del contratista: **NO VERIFICADO**.
- **Acuerdo 724 de 2026** («Ciudad Inteligente»): aprobado en segundo debate el 28-sep-2026, pendiente de sanción;
  reduce los grupos de tarifas y la mayoría de cambios rige desde el **1-ene-2027** [F18]. Las tarifas de
  construcción bajo el nuevo acuerdo: **NO VERIFICADO**.

### 1.6 Quién cobra y quién retiene (resumen para la cotización)

| Concepto | Lo liquida | Efecto en el documento |
|---|---|---|
| IVA 19 % (sobre total o sobre utilidad) | Contratista responsable de IVA | Se suma al subtotal |
| IVA cuando el contratista es no responsable | — | No se factura; el IVA de compras es costo dentro del APU |
| Retención en la fuente renta (2 % construcción / 2,5 % compras / 4 % servicios / 11 % honorarios) | Cliente agente de retención | Informativa: reduce el neto a pagar, no el total |
| ReteIVA (15 % del IVA) | Cliente agente de retención de IVA | Informativa |
| ReteICA Bogotá | Cliente agente retenedor distrital | Informativa |
| ICA | Contratista | Costo (en administración); no se suma |

### 1.7 Ejemplo numérico (costo directo de $100.000.000)

Administración 8 %, imprevistos 5 %, utilidad 10 % (los defaults del prototipo):
A = 8.000.000; I = 5.000.000; U = 10.000.000; subtotal = 123.000.000.

| Tratamiento | Base IVA | IVA | Total factura | Retención 2 % construcción (si cliente agente) | Neto a recibir |
|---|---|---|---|---|---|
| Construcción, utilidad pactada | U = 10.000.000 | 1.900.000 | 124.900.000 | 2 % × 123.000.000 = 2.460.000 (base: pago sin IVA — **NO VERIFICADO** si se excluye el IVA de la base) | 122.440.000 |
| Reparación / suministro (base total) | 123.000.000 | 23.370.000 | 146.370.000 | 2,5 % compras o 4 % servicios según el caso | — |

Diferencia de **$21.470.000** entre los dos tratamientos: es la decisión fiscal que más mueve el total.
Además, en modo «construcción» el costo directo debe incluir el IVA de materiales (punto 0.2).

---

## 2. Cómo se presupuesta una adecuación en Colombia

### 2.1 APU y estructura del presupuesto

- **APU (análisis de precios unitarios)**: para cada ítem, materiales (cantidad × precio × (1 + desperdicio)),
  equipo/herramienta (a menudo % de la mano de obra), mano de obra (rendimiento × jornal con prestaciones) y
  transporte → costo directo unitario. Precio total = Σ (cantidad × APU) + AIU [F26][F27].
- La mano de obra se costea sobre el SMMLV 2026 ($1.750.905) más carga prestacional. Una fuente comercial cita
  jornal de oficial en Bogotá de $100.000–$130.000/día y ayudante $65.000–$85.000/día «con prestaciones», sin
  metodología y con contradicciones internas [F27] (**secundaria, no usar como precio**).
- Construdata es una publicación privada por suscripción [F27]; no se usó ninguna cifra suya.
- No se encontró un listado oficial público 2026 de precios de referencia (IDU / gobernaciones) accesible:
  **NO VERIFICADO**.

**Capítulos típicos de un local comercial** (coinciden con el catálogo del prototipo): preliminares (protección,
demoliciones, retiro de escombros), obra civil (nivelación, muros/drywall), acabados (pisos, zócalo/guardaescoba,
estuco y pintura, cielo raso), instalaciones eléctricas e iluminación (tablero, salidas, luminarias, emergencia),
hidrosanitarias (si hay baño/lavamanos), climatización, carpintería y vidrios (puerta, fachada, cortina enrollable),
mobiliario, equipos, imagen/aviso, seguridad humana (extintores, señalización), aseo y entrega.

### 2.2 Porcentajes AIU

| Fuente | A | I | U | Total |
|---|---|---|---|---|
| Gerencie: «el A.I.U. suele moverse entre el 25% y el 30% del costo directo»; no hay fórmula legal [F10] | — | — | — | 25–30 % |
| OneEstimate (proveedor de software, sin fuente primaria) [F26] | 8–15 % | 1–5 % (hasta 8 %) | 3–8 % | ejemplo no VIS Bogotá 12+5+8 = 25 % |
| Contratación pública: lo fija cada entidad en el pliego (USTA 2021 compara Tunja, Bogotá, Villavicencio, Ibagué; cifras no extraídas) [F28] | — | — | — | NO VERIFICADO |

Los defaults del prototipo (8 / 5 / 10) quedan dentro de esos rangos. Para efectos de IVA en construcción la
utilidad declarada no puede ser inferior a la comercial de contratos similares [F5]: una U artificialmente baja
para reducir el IVA es objetable.

### 2.3 Cotización vs pre-factura vs factura electrónica

- **Cotización = oferta mercantil.** Código de Comercio art. 845: la oferta debe contener los elementos esenciales
  del negocio y comunicarse al destinatario; art. 846: la oferta es irrevocable una vez comunicada (el oferente
  responde por perjuicios si la revoca) [F29] (texto vía normativa Colpensiones / Gerencie). Por eso la cotización
  debe tener **vigencia explícita**. Contenido recomendado: identificación de las partes (razón social, NIT, calidad
  tributaria: responsable/no responsable de IVA, régimen SIMPLE, gran contribuyente, autorretenedor), descripción
  del alcance y exclusiones, cantidades y unidades, precio unitario y total por ítem/capítulo, AIU desglosado y
  **utilidad expresamente señalada** si se usa la base del art. 1.3.1.7.9, IVA discriminado y su base, plazo de
  ejecución, forma de pago y anticipos, garantías, vigencia de la oferta, retenciones que se esperan (informativas).
- **Pre-factura / cuenta de cobro previa**: **no** es un documento tributario. Los documentos que soportan la venta
  son la factura de venta y los documentos equivalentes que regula la Res. DIAN 165/2023, y la factura electrónica
  debe ser validada previamente por la DIAN (arts. 9 y 11) [F30]. (La referencia al art. 616-1 ET no se verificó
  en texto oficial: **NO VERIFICADO**.) Una pre-factura no tiene CUFE ni validación y no
  soporta costos, deducciones ni IVA descontable. Debe rotularse «Documento no válido como factura».
- **Factura electrónica de venta** (Res. DIAN 000165 del 1-nov-2023, art. 11) [F30], requisitos en resumen:
  denominación «factura electrónica de venta»; nombre/razón social y NIT del vendedor; datos del adquirente (NIT, o
  nombre e identificación, o «consumidor final» 222222222222); consecutivo con prefijo y autorización de numeración;
  fecha y hora de generación y de expedición (validación previa); cantidad, unidad, descripción y código de cada
  ítem; valor total; forma de pago (contado/crédito y plazo) y medio de pago; calidad de agente retenedor de IVA,
  autorretenedor, gran contribuyente o SIMPLE; **impuestos discriminados con su tarifa**; firma digital; **CUFE**;
  URL DIAN en código QR; anexo técnico; datos del software y proveedor tecnológico. Se considera expedida cuando la
  DIAN la valida y se entrega al adquirente.

---

## 3. Requisitos regulatorios de una droguería que mueven el costo

| Requisito | Qué exige | Impacto en el presupuesto | Fuente |
|---|---|---|---|
| Res. 1403/2007 (Manual de condiciones esenciales del servicio farmacéutico), Tít. I Cap. II num. 1.1 | Área física exclusiva, independiente, de circulación restringida y segura; «pisos … de material impermeable, resistente y contar con sistema de drenaje»; «paredes y muros … impermeables, sólidos, de fácil limpieza»; «techos y cielo rasos … resistentes, uniformes y de fácil limpieza y sanitización»; iluminación y ventilación natural y/o artificial (puertas y ventanas abiertas no cuentan como ventilación); sin área mínima («determinadas por el volumen de las actividades») | Porcelanato/vinílico (no alfombra, no madera), pintura lavable tipo 1, cielo raso liso (drywall o lámina lavable); ventilación mecánica o aire acondicionado | [F31] |
| Res. 1403/2007, almacenamiento | Condiciones de temperatura y humedad relativa recomendadas por el fabricante, con registros permanentes con termómetro e higrómetro calibrado; plan de emergencia para mantener la cadena de frío | Climatización (05.01), **termohigrómetro**, nevera con registro de temperatura (08.01), UPS/planta para la nevera | [F31] |
| Res. 2955/2007 (modifica num. 2.1 Cap. V Tít. I) | La droguería dispone de las áreas del num. 1.1.2 Cap. V salvo literales b) y d) y sin sección de materia prima: área administrativa delimitada, recepción, cuarentena, almacenamiento, dispensación, residuos | Divisiones en drywall, mostrador de dispensación, zona de cuarentena señalizada | [F32][F31] |
| Res. 1403/2007 num. 1.1.3 | Unidad sanitaria por sexo, una por cada 15 personas que laboren | Si el local no tiene baño: capítulo hidrosanitario (no está en el prototipo) | [F31] |
| RETIE (instalaciones eléctricas) | Reglamento vigente: Res. MinEnergía 40117/2024, con transiciones prorrogadas (Res. 40304/2025) y derogada al cumplirse estas por la Res. 40284/2026 (no verificada en su contenido) | Certificación de conformidad de la instalación (dictamen de inspección) por organismo acreditado: costo **NO VERIFICADO** | [F33] |
| Bomberos Bogotá (UAECOB) | Concepto técnico de seguridad humana y protección contra incendio: salidas de evacuación, extintores, señalización, detectores, redes eléctricas; guía RD-PR03-GA01 v3 vigente desde 18-may-2026; la clasificación de riesgo define el tipo de inspección | Extintores, señalización de evacuación, luces de emergencia (04.04) | [F34] |
| Licencia de construcción (Decreto 1077/2015) | Las reparaciones locativas (pisos, cielos, enchapes, pintura, redes) no requieren licencia; la **adecuación con cambio de uso** o modificaciones que alteran la distribución sí (art. 2.2.6.1.1.7 según fuente secundaria) | Si aplica: honorarios de curaduría y diseño (01.01) — **NO VERIFICADO** en texto oficial | [F35] |
| NSR-10 | Relevante solo si hay intervención estructural o muros nuevos pesados; en drywall no estructural, no se encontró requisito específico para este caso | **NO VERIFICADO** | — |

---

## 4. Proveedores reales y precios

**Detalle completo: [`precios.json`](precios.json)** — 145 filas, **138 con precio** leído en la página del proveedor
el 2026-10-15 y 7 marcadas `precio_cop: null` / **NO VERIFICADO**. Esquema: `item_key` (código de `data.js` o
`nuevo.*`), `descripcion`, `unidad`, `proveedor`, `producto`, `sku`, `precio_cop`, `incluye_iva`, `url`,
`fecha_consulta`, `notas`.

### 4.1 Cómo se obtuvieron y cómo leerlos

- Precios al consumidor en tiendas en línea. Donde la página muestra precio normal y oferta, `precio_cop` es el
  **normal** y la oferta (con su vigencia) va en `notas`.
- `incluye_iva: true` cuando la página lo dice o, si calla, por la regla de que el precio al público debe informarse
  «incluidos todos los impuestos y costos adicionales» (Ley 1480/2011 art. 26, citada por la DIAN en la Res. 0010/2026;
  SIC Concepto 30988/2011) [F39]. `false` cuando la página dice «+IVA». `null` cuando es una referencia sin IVA claro.
- **Casi todos los precios son de material o equipo solo**, no de «suministro e instalación» como las partidas del
  prototipo. `notas` dice cuál es cuál y trae la conversión (m²/caja, m de rollo, rendimiento). Para comparar con
  el precio unitario de una partida hay que armar el APU: material × (1 + desperdicio) + mano de obra.
- Se verificaron de nuevo contra la página del producto, al azar: Homecenter 876926 (porcelanato $34.900/m²,
  $50.256/caja de 1,44 m²), Vialambre góndola de pared ($1.290.900 normal / $1.264.900 oferta, «Los precios
  publicados incluyen IVA»), Easy Viniltex galón ($99.900, rendimiento 20–25 m²/gal), Homecenter 3022989
  (Panasonic 24.000 BTU, normal $4.499.900 / oferta $2.449.900 del 3 al 31-oct-2026) y Homecenter 274234
  (THHN 12 AWG 100 m, $257.900). Todos coincidieron.

**Proveedores que funcionaron**: Homecenter/Sodimac (79 filas), Easy (22), Éxito marketplace (6), Alkosto (4),
Ktronix (2; mismo grupo que Alkosto, no es proveedor independiente), Vialambre (4), Tecnoprocesos Colombia (4), Industrias Cruz (4, dos sitios que podrían ser empresas
distintas), Lemor (2), Imcolmedica (2), BIOWEB (3), Indasoc, Electronilab, Masters Publicidad, Tienda del Arquitecto,
Diseños y Estructuras JH, Generador de Precios CYPE (referencia).

**Bloqueados o inútiles** (2026-10-15): Mercado Libre (HTTP 403 en listados, productos y API); Constructor
(constructor.com.co redirige 301 a Homecenter: no es fuente independiente); corona.co («Header overflow»);
tienda.pintuco.com (solo «desde $120.000» sin presentación); distribuidores de neveras médicas BPL Medical, Kassel
Group, Cienytec («Solicitar precio»); secretariasenado.gov.co (conexión rechazada).

### 4.2 Resumen por partida (rangos de `precios.json`)

| item_key | Partida | Lo que se encontró (precio normal, IVA incluido salvo nota) | Proveedores | Partida demo en `data.js` |
|---|---|---|---|---|
| 02.01 | Protección | Plástico 15 m² $13.900; cartón corrugado 1,2 × 10 m $70.900 | Homecenter | $9.500/m² (S+I) |
| 02.02 | Escombros | Lona de escombro $2.800/und. **Contenedor/volqueta en Bogotá: NO VERIFICADO** | Homecenter | $780.000 gl |
| 03.01 | Nivelación | Cemento Argos 50 kg $32.500 (ambos); arena 40 kg $14.900; autonivelante Corona 25 kg $85.900; Sikafloor 130 25 kg $223.790 | Homecenter, Easy | $42.000/m² |
| 03.02 | Porcelanato 60×60 | Material $34.900–$72.900/m² (5 productos); pegante 25 kg $47.154–$65.900; boquilla 5 kg $34.900; **instalación** $30.900/m² (514480), $38.900/m² (522324), $73.900/m² (701369, formato > 80 cm) | Homecenter, Easy | $118.000/m² (S+I) |
| nuevo.piso_vinilico | Piso SPC click | $49.900/m² (ambos); instalación $26.900/m² (514481) | Homecenter, Easy | — |
| 03.03 | Zócalo | Guardaescoba cerámico 9 × 60 cm $11.000/und (≈ $18.300/ml). No se halló guardaescoba en porcelanato | Homecenter | $31.000/ml |
| 03.04 | Estuco y pintura | Estuco 28–30 kg $117.900–$130.900; Viniltex blanco galón $99.900–$103.900, cuñete 5 gal $399.900–$429.900; servicio de pintura hasta 80 m² $960.000 (básica) / $1.240.000 (integral, sin materiales) | Homecenter, Easy | $26.500/m² (S+I) |
| 03.05 | Cielo drywall | Placa yeso ½" 1,22 × 2,44 $49.900 (Knauf y Gyplac; ≈ $16.760/m² de placa); omega y vigueta $3.700; masilla 28 kg $54.900–$64.900; cinta 75 m $8.000 | Homecenter, Easy | $98.000/m² (S+I) |
| nuevo.drywall_muro | Muro divisorio | Paral 2,44 m $9.650–$16.900; canal $12.600; placa $49.900 | Homecenter, Easy | — |
| nuevo.cielo_raso_modular | Cielo modular | Fibra mineral 60×60 caja 3,6 m² $182.900 (≈ $50.800/m², agotado); PVC $65.772/caja 3,48 m²; lámina 120×60 ×5 $55.800 | Homecenter, Easy | — |
| 04.01 | Tablero | Tablero 12 circuitos $90.300–$173.900; breakers 1×20 A $8.900–$21.900; 2×30/40 A $18.900–$86.050 | Homecenter, Easy | $2.850.000 (S+I) |
| 04.02 | Tomas y red | Toma doble P/T $7.490–$17.900; GFCI $42.900–$129.900; THHN 12 AWG 100 m $252.900–$299.900; EMT ½" 3,05 m $11.100; caja 2×4 $800 | Homecenter, Easy | $165.000/salida (S+I) |
| 04.03 | Panel LED 60×60 | $54.900–$116.990 (5 productos; el Tecnolite es 20 W según ficha) | Homecenter, Easy | $238.000 (S+I) |
| 04.04 | Emergencia | $69.190–$92.900 | Homecenter, Easy | $189.000 |
| 05.01 | Aire acondicionado | 24.000 BTU inverter $4.499.900–$6.909.900 normal (ofertas desde $2.449.900); 18.000 BTU $2.299.900–$3.799.900; instalación $279.900–$302.900 (sin materiales extra ni adecuación eléctrica) | Homecenter, Alkosto | Comparador demo $7,9–9,4 M |
| 07.01 | Góndola mural | $1.091.000–$2.399.900 (el de $2.399.900, Homecenter 691162, es un módulo de 1,2 m, re-verificado) | Vialambre, Tecnoprocesos, Industrias Cruz, Homecenter | $760.000–$1.180.000 |
| 07.02 | Góndola central | $796.160–$1.701.000 | Vialambre, Tecnoprocesos, Industrias Cruz, Lemor | $2.350.000 |
| 07.03 | Mostrador | $880.000–$1.753.000. El «Mostrador Farmacia» de industriascruzmr.com publica solo el rango $880.000–$1.635.000 para 8 variantes: la variante de $880.000 está **NO VERIFICADA**. Solo el «Punto de pago» de Vialambre ($1.753.000) trae cajón. La «Cajonera exhibidor» de Lemor ($2.150.000) se reclasificó a `nuevo.cajonera_exhibidor` | Vialambre, Tecnoprocesos, Industrias Cruz | $3.900.000 |
| nuevo.vitrina | Vitrina | $915.100–$1.045.277 | Vialambre, Tecnoprocesos | — |
| 08.01 | Nevera medicamentos | Refrigerador farmacéutico 416 L $14.833.556 y 756 L $24.476.292 (Imcolmedica: sin existencias, sobredimensionados y **el pie de página del sitio tiene enlaces de apuestas, posible sitio comprometido**; no se encontró ningún proveedor confiable con precio publicado de nevera farmacéutica 2–8 °C); vitrina doméstica de comparación $3.299.900–$3.920.900 (**no** es equipo farmacéutico); datalogger $505.800–$959.700 | Imcolmedica, Homecenter, BIOWEB | Pendiente |
| nuevo.termohigrometro | Termohigrómetro | $31.900 (uso no profesional) – $839.900 | Homecenter, Indasoc, BIOWEB, Electronilab | — |
| 09.01 | Kit POS | Computador $3.069.900–$5.399.900; lector $99.900–$229.900; impresora térmica 80 mm $362.900–$420.000; cajón $149.900–$329.900 | Homecenter, Ktronix, Éxito | $4.290.000 (IVA incl.) |
| 09.02 | UPS 1 kVA | $249.900–$698.900 | Homecenter, Alkosto, Ktronix, Éxito | $690.000 |
| 10.01 | Aviso | Caja de luz lona/panaflex 300 × 90 cm $950.000 **+IVA**. Aviso en acrílico/letras LED: **NO VERIFICADO** | Masters Publicidad | $4.600.000 |
| nuevo.puerta_vidrio | Puerta | Vidrio templado 10 mm S+I $776.400; corrediza aluminio $1.134.000 +IVA | Tienda del Arquitecto, Diseños y Estructuras JH | — |
| nuevo.cortina_enrollable | Cortina metálica | $2.112.335 por 3 × 2,2 m con mano de obra (base CYPE, IVA no indicado) | Generador de Precios CYPE | — |
| nuevo.extintor | Extintor ABC | 10 lb $80.900–$121.900; 20 lb $117.900 | Homecenter, Easy | — |
| nuevo.senalizacion | Señalización | Kit 11 señales fotoluminiscentes $149.900; señal salida $26.900 | Homecenter | — |
| nuevo.mano_obra_maestro | Mano de obra | Maestro por medio día (4 h) $86.900 | Homecenter | — |


**Partidas con un solo proveedor (el comparador no tiene con qué comparar):** 02.01 protección, 02.02 lona de
escombro, 03.03 guardaescoba (Easy no devolvió guardaescobas en Colombia), 10.01 aviso (una caja de luz +IVA),
08.01 nevera farmacéutica (un proveedor dudoso), `nuevo.cortina_enrollable` (solo la referencia CYPE),
`nuevo.senalizacion`, `nuevo.mano_obra_maestro`. El par Alkosto/Ktronix no cuenta como dos proveedores: es el mismo
grupo, y la UPS FORZA NT-1011 es el mismo producto al mismo precio.

**Sin precio real en ninguna fuente** (siguen como estimación o pendiente): 01.01 diseño y planos, 02.02
contenedor de escombros, 11.01 limpieza final, 11.02 pruebas y acta, certificación RETIE de la instalación,
aviso en acrílico, segundo proveedor de nevera farmacéutica 2–8 °C, cortina enrollable de un fabricante.

### 4.3 Lo que esto dice del prototipo

- Los precios de **mobiliario** demo están cerca del mercado en góndola mural, pero por encima en góndola central
  ($2,35 M demo vs. $0,8–1,7 M) y mostrador ($3,9 M demo vs. $0,88–1,75 M).
- **Panel LED** demo $238.000 (S+I) frente a $55.000–$117.000 de material: la diferencia debe ser mano de obra y
  cableado, y hoy no se ve en la partida.
- El **aire acondicionado** de 24.000 BTU cuesta en tienda menos que las ofertas demo ($7,9–9,4 M), aunque esas
  incluyen cálculo térmico, instalación y garantía extendida.
- Las ofertas temporales son grandes y cambian rápido: −45 % en un aire Panasonic hasta el 31-oct-2026. La
  política de vigencia de 30 días del prototipo es, si acaso, larga para precios de oferta.
- **IVA en precios al público**: si el contratista factura con base «utilidad» (construcción), el IVA de estos
  precios es costo. Si factura con base «total» y es responsable, es descontable. Ver 0.2.
- **Computadores ≤ 50 UVT ($2.618.700)** están excluidos de IVA [F20]. Ninguno de los computadores encontrados está
  por debajo del tope (el más barato cuesta $3.069.900 normal; en oferta, $2.525.900 sí quedaría por debajo).

---

## 5. Parámetros que deben mover el precio (además de los m²)

| Parámetro | Por qué mueve el precio | Cómo entra al cálculo |
|---|---|---|
| **Área (m²)** | Base de piso, cielo raso, protección, limpieza, luminarias, tomas | Ya es el parámetro principal del prototipo |
| **Frente y fondo / perímetro** | Muros a pintar, zócalo, góndolas murales | Perímetro = 2 × (frente + área/frente); el prototipo ya lo usa |
| **Altura libre (m)** | m² de muro; por encima de 2,50 m Homecenter excluye andamios/escaleras de su servicio de pintura [F36] → recargo por altura | m² muro = perímetro × altura − vanos |
| **Ciudad** | Mano de obra, transporte, ICA (tarifa municipal), disponibilidad de proveedor | Factor regional sobre mano de obra (fuente comercial usa Bogotá = 1,00 [F27], **sin metodología**) y tabla ICA por municipio |
| **Estado del local** (obra gris / con acabados / a demoler) | Obra gris requiere nivelación, estuco completo, red eléctrica nueva; con acabados requiere demolición y escombros | Activar/desactivar capítulos 02–04 y partidas de demolición |
| **Tipo de negocio** (droguería vs. otros) | Res. 1403/2007: superficies lavables, cadena de frío, registros de T/HR, áreas exigidas | Catálogo de partidas obligatorias por tipo |
| **Nivel de acabado** (estándar / premium) | Porcelanato básico vs. premium, pintura tipo 1 vs. lavable, iluminación | Multiplica el precio del material, no la cantidad |
| **Muros divisorios a construir (ml × altura)** | Área administrativa, cuarentena, baño | m² drywall = ml × altura; no está en el prototipo |
| **Carga térmica / ocupación / exposición solar** | Capacidad del aire acondicionado (BTU) | Cálculo técnico; el prototipo ya lo marca «Requiere revisión técnica» |
| **N.º de cajas / puestos** | POS, tomas dedicadas, mostradores | Ya en el prototipo |
| **Régimen fiscal del contratista y del cliente** | IVA sobre utilidad vs. total; IVA de compras como costo; retenciones | Ver sección 1 |
| **Plazo / horario nocturno** (centros comerciales) | Recargo nocturno de mano de obra | **NO VERIFICADO** (no se buscó porcentaje) |

**Reglas de cantidad usuales**

- **Piso**: compra = área × (1 + desperdicio) / m² por caja, redondeado **hacia arriba** a cajas enteras; desperdicio
  ≈ 10 % en colocación recta en recintos rectangulares, 15 % con diagonales o cortes irregulares [F37] (secundaria).
  El prototipo usa 8 % y no redondea a cajas: conviene subir a 10 % y redondear a la caja del proveedor.
- **Pintura**: galones = m² × manos / rendimiento. Viniltex Advance: «rendimiento por capa» de 50 m² por galón
  según la ficha en Homecenter [F38] (rendimiento teórico; el real depende de la superficie).
- **Zócalo/guardaescoba**: perímetro − anchos de puertas, +10 % (el prototipo ya lo hace).
- **Drywall** (muro o cielo): placas = m² / 2,977 m² (placa 1,22 × 2,44) + desperdicio; perfilería por ml según
  modulación (típicamente cada 0,40–0,61 m) — **NO VERIFICADO** en ficha del fabricante.
- **Luminarias y tomas**: las reglas del prototipo (1 panel/6 m², ⌈área/10⌉ tomas) son preliminares; el número real
  sale del diseño luminotécnico y del plano eléctrico bajo RETIE/RETILAP (**NO VERIFICADO** que existan reglas
  normativas de ese tipo).

---

## 6. Todo lo marcado NO VERIFICADO

1. Si una «adecuación de local comercial» es contrato de construcción (IVA sobre utilidad) o reparación (IVA sobre
   el total): ningún concepto DIAN lo resuelve expresamente; depende de cada capítulo.
2. Tarifa de retención en servicios para no declarantes (la fuente secundaria dice «4 % o 6 %»).
3. Bases mínimas de reteIVA y si la base de retención en construcción excluye el IVA.
4. Tarifas ICA Bogotá por CIIU (solo fuente secundaria; el anexo de la Res. SDH-000265/2021 no se consultó) y
   tarifas de construcción bajo el Acuerdo 724/2026.
5. Bases mínimas de reteICA 2026 y que la tarifa de reteICA sea la de la actividad del contratista.
6. SMMLV 2026 en el Diario Oficial (solo fuente secundaria; hubo suspensión provisional del Dec. 1469/2025).
7. Listado oficial público 2026 de precios de referencia (IDU / gobernaciones): no encontrado.
8. AIU fijado por entidades públicas (tesis USTA 2021): cifras no extraídas.
9. Contenido de la Res. MinEnergía 40284/2026 (RETIE) y costo de la certificación de la instalación.
10. Texto oficial del Decreto 1077/2015 sobre licencia en modalidad adecuación (solo fuente secundaria).
11. Requisitos NSR-10 para este caso.
12. Recargo por trabajo nocturno en centros comerciales.
13. Reglas de modulación de perfilería drywall en ficha del fabricante.
14. Precios: contenedor/volqueta de escombros en Bogotá; Viniltex en la tienda Pintuco; segundo proveedor de
    nevera farmacéutica 2–8 °C; aviso en acrílico/letras LED (solo una guía de rangos); cortina enrollable de
    fabricante (solo rangos de guía); Panasonic 24.000 BTU en Alkosto (agotado); Epson TM-T20III en Ktronix (agotado).
15. Sin precio en ninguna fuente: 01.01, 11.01, 11.02.
16. Variante a la que corresponde el «Mostrador Farmacia» de $880.000 (industriascruzmr.com publica solo un rango).
17. Referencia al art. 616-1 ET (pre-factura vs. documentos soporte) en texto oficial.
18. Fiabilidad de Imcolmedica (posible sitio comprometido): sin proveedor confiable con precio de nevera 2–8 °C.

---

## Fuentes

Todas consultadas el **2026-10-15**.

| Id | Fuente | URL | Tipo |
|---|---|---|---|
| F1 | DIAN, Resolución 000238 de 2025 (UVT 2026) | https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0238_2025.htm ; confirmación INCP: https://incp.org.co/publicaciones/infoincp-publicaciones/impuestos/2025/12/dian-fijo-en-52-374-en-valor-de-la-uvt-para-el-ano-gravable-2026/ | primaria (contenido leído en el resultado de búsqueda del normograma) |
| F2 | Estatuto Tributario art. 468 (Actualícese) | https://actualicese.com/estatutotributario/468-2/ | secundaria (secretariasenado.gov.co rechazó la conexión) |
| F5 | DIAN, Oficio 959 del 16-ene-2019 | https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_0959_2019.htm | primaria |
| F6 | DIAN, Oficio 165 (901006) del 10-feb-2021 | https://www.cijuf.org.co/node/20996 ; https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_901006_2021.htm | primaria (texto reproducido por CIJUF) |
| F7 | DIAN, Oficio 44743 del 22-jul-2013 | https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_44743_2013.htm | primaria |
| F8 | DIAN, Concepto 415 (003524) del 25-mar-2025 | https://cijuf.org.co/node/27882 | primaria (texto reproducido por CIJUF) |
| F9 | DIAN, Oficio 131 del 13-feb-2018 | https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_0131_2018.htm | primaria |
| F10 | ET art. 462-1 (Actualícese); Gerencie «AIU» | https://actualicese.com/estatutotributario/462-1/ ; https://www.gerencie.com/aiu.html | secundaria |
| F11 | DIAN, Oficio 1095 (906722) del 6-sep-2022 | https://www.cijuf.org.co/node/24031 | primaria (texto reproducido por CIJUF) |
| F12 | Siempre al Día (Alegra), «Tabla de retención en la fuente 2026», actualizada 02-jul-2026 | https://siemprealdia.co/colombia/impuestos/tabla-de-retencion-en-la-fuente-2026/ | secundaria |
| F13 | Actualícese, montos para ser no responsable de IVA en 2026 | https://actualicese.com/montos-para-ser-no-responsables-de-iva-en-2026/ | secundaria |
| F14 | DIAN, Oficio 13873 (int 1333) del 6-ago-2026 | https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_13873_2026.htm | primaria |
| F15 | DIAN, Comunicado de Prensa 070 del 8-may-2026 | https://www.dian.gov.co/Prensa/Paginas/NG-Comunicado-de-Prensa-070-2026.aspx | primaria |
| F16 | Consejo de Estado, auto del 2-jun-2026, exp. 30229 (Accounter); Brigard Urrutia | https://accounter.co/normatividad/consejo-de-estado-revoca-suspension-provisional-del-decreto-572-de-2025-y-restablece-sus-efectos-en-materia-de-retencion-y-autorretencion-en-renta-sentencia-ce-30229-de-2026 ; https://www.bu.com.co/es/insights/noticias/consejo-de-estado-revoca-suspension-del-decreto-572-de-2025 | primaria reproducida / secundaria |
| F17 | Rankia, «Impuesto ICA 2026», actualizado 05-oct-2026 | https://www.rankia.co/blog/dian/3510937-impuesto-ica-porcentaje-formulario-tarifas | secundaria |
| F18 | Alcaldía de Bogotá, tarifas ICA Acuerdo «Ciudad Inteligente», 28-sep-2026 | https://bogota.gov.co/mi-ciudad/hacienda/que-actividades-economicas-con-tarifas-mas-bajas-de-ica-en-bogota | primaria |
| F19 | Alcaldía de Bogotá, Resolución SDH-000265 del 13-abr-2021 | https://bogota.gov.co/mi-ciudad/hacienda/se-actualizan-actividades-y-tarifas-de-ica | primaria (sin el anexo de tarifas) |
| F20 | Gerencie, computadores excluidos de IVA | https://www.gerencie.com/computadores-excluidos-de-iva.html | secundaria |
| F21 | Siempre al Día, salario mínimo 2026 | https://siemprealdia.co/colombia/derecho-laboral/salario-minimo-2026/ | secundaria |
| F22 | El País (Cali), la Corte tumba el decreto de impuestos de la emergencia (C-079/2026) | https://www.elpais.com.co/colombia/corte-tumba-decreto-de-impuestos-de-emergencia-economica-y-ordena-devolver-recursos-1504.html | secundaria (prensa) |
| F23 | ET art. 911 (Actualícese) | https://actualicese.com/estatutotributario/911-2/ | secundaria |
| F24 | Actualícese, retención a título de IVA; Siempre al Día, tabla reteIVA 2025 | https://actualicese.com/archivo/retencion-en-la-fuente-a-titulo-del-iva/ ; https://siemprealdia.co/colombia/impuestos/tabla-de-retencion-en-la-fuente-por-iva-2025/ | secundaria |
| F25 | Secretaría de Hacienda de Bogotá, plazos reteICA 2026; La República | https://www.haciendabogota.gov.co/es/noticias/el-17-de-julio-vence-el-plazo-para-declarar-y-pagar-reteica-del-tercer-bimestre-de-2026 ; https://www.larepublica.co/economia/agentes-retenedores-deben-declarar-y-pagar-el-reteica-antes-del-16-de-enero-4303360 | primaria / secundaria |
| F26 | OneEstimate, «AIU en obra civil» | https://oneestimate.ai/blog/aiu-obra-civil-que-es-como-calcular | secundaria (proveedor de software) |
| F27 | OneEstimate, «Precios mano de obra construcción Colombia 2026», 31-may-2026 | https://oneestimate.ai/blog/precios-mano-obra-construccion-colombia-2026 | secundaria (proveedor de software, sin metodología) |
| F28 | Bustos y Camargo (2021), Universidad Santo Tomás, AIU fijado por entidades públicas | https://repository.usta.edu.co/items/c57d395a-b72c-469d-ae71-66b56552fa42/full | académica |
| F29 | Código de Comercio arts. 845–846 (normativa Colpensiones); Gerencie, oferta mercantil | https://normativa.colpensiones.gov.co/colpens/docs/codigo_comercio_pr026.htm ; https://www.gerencie.com/oferta-mercantil.html | primaria reproducida / secundaria (contenido leído en resultados de búsqueda) |
| F30 | DIAN, Resolución 000165 del 1-nov-2023 (arts. 9 y 11) | https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm | primaria |
| F31 | Resolución 1403 de 2007 (normograma INVIMA) | https://normograma.invima.gov.co/compilacion/docs/resolucion_minproteccion_1403_2007.htm | primaria |
| F32 | Resolución 2955 del 27-ago-2007 (normograma INVIMA) | https://normograma.invima.gov.co/compilacion/docs/resolucion_minproteccion_2955_2007.htm | primaria |
| F33 | MinEnergía, RETIE: Res. 40117/2024 y 40304/2025 | https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_minminas_40117_2024.htm ; https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_minminas_40304_2025.htm | primaria (contenido leído en resultados de búsqueda) |
| F34 | UAECOB Bomberos Bogotá, guía RD-PR03-GA01 v3; Cámara de Comercio de Bogotá | https://www.bomberosbogota.gov.co/sites/default/files/documentos/rd-pr03-ga01-guia-prestacion-del-servicio-de-inspecciones-tecnicas-v3.docx ; https://www.ccb.org.co/servicios/crea-tu-empresa/constituye-tu-empresa/condiciones-de-seguridad-humana | primaria (contenido leído en resultados de búsqueda) |
| F35 | Gerencie, modificaciones que requieren licencia de construcción | https://www.gerencie.com/modificaciones-a-una-vivienda-que-requieren-licencia-de-construccion.html | secundaria |
| F36 | Homecenter, «Inst Pintura Basica hasta 80 M2» (3110593) | https://www.homecenter.com.co/homecenter-co/product/3110593 | primaria (proveedor) |
| F37 | Hacecuentas, calculadora de pisos/porcelanato | https://hacecuentas.com/calculadora-pisos-ceramicos-porcellanato-cajas | secundaria |
| F38 | Homecenter, Viniltex Advance blanco 1 galón (ficha) | https://www.homecenter.com.co/homecenter-co/product/01339/pintura-para-interior-tipo-1-blanca-viniltex-advance-1-galon/01342/ | primaria (proveedor; contenido leído en resultado de búsqueda) |
| F39 | Ley 1480/2011 art. 26 citada por la DIAN (Res. 0010/2026); SIC Concepto 30988/2011 | https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0010_2026.htm ; https://vlex.com.co/vid/concepto-n-30988-superintendencia-1037734405 | primaria / secundaria |
