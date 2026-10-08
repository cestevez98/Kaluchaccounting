# Fase 4 · Exportación, distribución, inventario y gastos de operación

Estado: **completada** (09/10/2026). Tests en verde: 99 unitarios/integración + 18 E2E.

## Qué se ha construido

### Facturas de exportación (segmento 888) · `packages/db/src/sales.ts`
- **Emisión**: la factura queda **pendiente de cierre**, con una partida abierta por cobrar al cliente. El asiento:
  - cargo al cliente (136) contra Ventas pendientes (2900);
  - los costos ya conocidos pasan de *mercancías pendientes de facturar* a *costos pendientes*:
    - fábrica: 180.8880 → 2814;
    - logística: 180.8881 → 2815;
    - otros costos: 180.8882 → 2816.
- **Cierre** (fecha de cierre):
  - la venta pasa de 2900 a 900.8880 (productos) o 901.8880 (servicios);
  - los costos pasan de 2814–2816 a costo de ventas (814–816.8880);
  - el costo estimado va a 817.8880, contra Facimpex pendiente de facturar (180.8883);
  - la comisión va a 824.8880, contra la cuenta corriente del vendedor (410.8880), con su partida abierta.
- **Cliente del grupo** (MPM Grupo Roca, MPM D'Milio, Palco): la venta se cierra contra ventas internas
  (1900) y costos 1814–1817.
- **Margen por factura**: importe menos fábrica, logística, otros costos, costo estimado y comisión.

### Distribución (segmento 999)
- **Contenedores**: cada contenedor es un lote con sus costos, inversionistas, ventas y utilidad.
  - **Costos del contenedor** (mercancía, flete, aduana…): van a Mercancías en tránsito (181.9991), contra
    la cuenta corriente del proveedor (con partida por pagar) o la cuenta que se indique.
  - **Recepción en almacén**: reparte el costo en tránsito entre los productos (cantidad y costo de cada uno)
    y lo pasa a Mercancías en almacén (181.9990).
  - Un costo posterior a la recepción se carga a un producto concreto.
- **Kardex por producto y lote**: entradas por recepción y costos, salidas por venta al **costo medio del
  lote**. La última salida de un lote se lleva el resto, así que no quedan residuos de redondeo.
- **Factura de distribución** (a crédito contra la cuenta del cliente, 137, o al contado contra la cuenta de
  cobro). Cada línea registra:
  - ingreso (900.9990);
  - costo identificado del lote (814.9990 contra 181.9990);
  - comisión por unidad del vendedor (824.9990 contra su cuenta 410.9990);
  - **ONAT sobre ventas** devengada (830.9990 contra 480.9990), con el parámetro `onat.sales_rate` (11 %).
    Se puede desmarcar la venta como fiscal.
- **Comisiones** por vendedor y semana, para la liquidación semanal. El pago se registra desde Bancos y Caja
  o con un abono en su cuenta corriente.
- **Inversionistas por contenedor**:
  - capital invertido y % de la utilidad (la suma no puede pasar del 100 %);
  - su parte de la utilidad del contenedor.
- **Utilidad por contenedor**: ventas − costo de ventas − comisiones − ONAT, con el margen, las existencias
  que quedan y el costo total del contenedor. Todas las líneas del diario llevan el contenedor (dimensión
  `container_id`).

### Pantallas y permisos
- **Ventas**:
  - facturas de exportación (listado, pendientes, alta, ficha con asientos y cierre);
  - facturas de distribución (listado con totales, alta por lotes con existencias, ficha);
  - comisiones de vendedores.
- **Inventario**:
  - contenedores con su utilidad;
  - ficha del contenedor: existencias por producto, inversionistas, costos, recepción y movimientos;
  - productos y kardex.
- **Inversiones**: inversionistas por contenedor.
- **Conciliación con el Excel**:
  - preselecciones de cuentas de la fase 4 y de gastos de operación;
  - **totales de control** ING/GAS/UT 777/888/999.
- **Importar Excel**: nuevo modo *"Añadir exportación y distribución (fase 4) a la base ya migrada"*, para
  producción, que ya tiene las fases 1–3.
- **Permisos**:
  - `sales:read` está en todos los roles de consulta;
  - `sales:operate` (facturar) e `inventory:operate` (contenedores) los tienen Contador, Comercial y Ventas
    (`sales:operate`) y Almacén (`inventory:operate`).
- **Al arrancar la API** se sincronizan los catálogos, los roles de sistema, los parámetros y los mapeos
  contables nuevos (`packages/db/src/seed/sync.ts`).

## Migración: ventas, costos y gastos del Excel
`pnpm etl sales data/balance.xlsx`, sobre la base con tesorería y deudas migradas. Usa el mismo intérprete
de fórmulas del BC que la fase 3: cada fila de las hojas suma en el sistema lo mismo que en el BC.

**Alcance**: 88 cuentas.
- Exportación: 136, 180, 900/901.888x, 1900, 1814–1817, 2900, 2814–2816.
- Distribución: 137, 139, 181, 1181, 430, 800, 814–826 de 999 y 777.
- **Todos los gastos e ingresos de operación** que suman los totales de control: 827–844, 847–849, 920, 921,
  926 y 930.
- No entran 845/846/924/925 (cambios y tenencia), que ya migran tesorería y deudas.

### Resultado con el Excel real
Sobre la base de las fases 1–3 (unos 3 minutos):

| | Resultado |
|---|---|
| Aportaciones fila a fila | **38.353** de 29 tablas: `Exportación_*`, `Distribución_*`, `Ponderación_costos`, `Proyectos_Facturación`, `RRHH_Salarios`, `RRHH_Comunicación`, `Fiscal_impuestos`, `Impuestos_Diferencia`, filas de la hoja `Capital`… |
| Documentos | **5.991** asientos de migración posteriores al 31/03/2026 (uno por fila y fecha), más los saldos de apertura |
| Tesorería → cuentas del BC | **1.759** movimientos de caja y bancos que el BC suma en una cuenta de gastos o ingresos (831.9990 comisiones bancarias, 835 transporte, 843 gastos por inversión de cada mercado…) |
| Tesorería → cuenta puente | **2.446** cobros y pagos que la fase 2 llevó por su categoría a ventas, salarios o impuestos. El Excel calcula esas cuentas desde las hojas de ventas, nómina e impuestos; el cobro o pago queda en el puente |

**Conciliación abril–octubre 2026** de todas las cuentas migradas (fases 1–4, 294 filas por mes):

| Mes | Cuadran | Explicadas | **Sin explicar** | Solo en el sistema |
|---|---|---|---|---|
| 04/2026 | 272 | 22 | **0** | 11 |
| 05/2026 | 274 | 20 | **0** | 11 |
| 06/2026 | 268 | 26 | **0** | 11 |
| 07/2026 | 279 | 15 | **0** | 11 |
| 08/2026 | 277 | 17 | **0** | 11 |
| 09/2026 | 273 | 21 | **0** | 11 |
| 10/2026 | 282 | 12 | **0** | 11 |

**Totales de control** (mayo–octubre; en abril el Excel no los calcula):
- **UT 777 y UT 888 cuadran todos los meses**.
- Las diferencias de ING/GAS 888 y 999 son los pares gasto/ingreso compensados: el Excel pone el neto del
  mes en una sola de las dos cuentas y el sistema puede tener las dos.
- La de UT 999 es la tenencia de la caja CAD ya explicada en la fase 3. Por ejemplo, mayo es 1.034,14 USD:
  −40,80 de la caja CAD omitida y −993,32 de las 7 filas de `Banco_Pers_Cuba` (con signo de diferencia
  Excel − sistema).
- Ningún total tiene una diferencia que no salga de cuentas ya explicadas.

**Explicaciones nuevas** (calculadas y comprobadas al céntimo):
- **Estado actual** (2900, 2814–2816, 180.8881, 180.8883): el BC del Excel calcula estas cuentas **sin
  fecha de corte**.
  - Son las facturas pendientes de cierre y las facturas de proveedor sin asignar a la fecha del archivo; el
    Excel muestra el mismo valor en todos los meses.
  - El sistema registra cada fila en su fecha y su saldo acumulado a 31/10/2026 coincide con el Excel.
- **Cabecera 180**: en el Excel la cabecera no es la suma de sus subcuentas. Usa importes con fecha de corte
  y las subcuentas no: la incoherencia es de 324.411,69 USD.
- **Pares compensados** nuevos: 847/926 (diferencias de cobro y pago, gastos recuperados) y 848/920
  (impuestos adicionales).

### Ajustes que la conciliación hizo necesarios
- **Resultados de fórmula igual a 0.** La librería que lee el Excel descarta los resultados "falsos" de las
  fórmulas (0, FALSO). Ahora se leen del modelo de la celda.
  - Afectaba a criterios como `Rev vs Distribución Productos = 0` (181.9991, mercancía en tránsito).
  - Afectaba también a las 7 filas de `Banco_Pers_Cuba`, que en realidad tienen "Movimiento en USD" = 0, no
    vacío.
- **Plan de cuentas**: una cuenta de grupo solo lo es si sus subcuentas van detrás. La 1816 "Sobrevaloración
  por transferencia interna" está después de 1816.8880 y es una cuenta de detalle.
- **Intérprete de fórmulas**:
  - criterios que citan una celda del BC (`$A239`, el nombre del mercado en 843.999-x);
  - SUMIFS sobre filas enteras de otra hoja (`Capital!20:20` con las fechas en la fila 1), para los
    ingresos por inversión 930.999-x;
  - fechas 0 del Excel (30/12/1899) como saldo anterior en los acumulados;
  - en un par de resultados con formas opuestas (847.9991 / 926.9991), el signo lo da la cuenta de ingresos.
- **Movimientos de tesorería**:
  - cuando el BC suma la fila en una cuenta de gastos, manda la fórmula, también sobre la categoría de la
    fase 2 (p. ej. "Mensajería triciclo" → 815/901.9990);
  - también sobre la cuenta puente de la fase 3 (p. ej. "Comisión Distribución" del banco → 831.9990).

## Tests
| Suite | Qué cubre |
|---|---|
| `packages/shared` (12) | Dinero, tasas, formatos es-ES |
| `packages/etl` (26) | Más: criterios con celda del BC, filas enteras de otra hoja, filas de los totales de control |
| `packages/db` (36) | Más: factura de exportación (emisión, cierre, cliente interno, validaciones), contenedor (costos, recepción, costo posterior), venta con costo medio, comisión y ONAT, kardex, utilidad y parte del inversionista, comisiones por semana |
| `apps/api` (25) | Más: exportación por API, contenedor completo hasta la utilidad, permisos de solo lectura |
| E2E (18) | Más: factura de exportación hasta su cierre; venta de distribución desde el contenedor demo, comisiones y kardex |

## En producción
Tras el despliegue automático, en **Configuración → Importar Excel** elige *"Añadir exportación y
distribución (fase 4)"* y sube el mismo Excel (o uno posterior). Hace cuatro cosas:
- actualiza el plan de cuentas y los valores del BC;
- migra la fase 4;
- recalcula las explicaciones;
- deja el resultado en Contabilidad → Conciliación con el Excel.

## Pendiente / a decidir
- **Cuenta puente 699.9995**: la otra pata de los cobros de ventas y de las deudas sigue en el puente,
  identificada por contraparte. Se repartirá en la fase 5 al casar cobros con facturas.
- **Sobrevaloración 999/888** (1816/1181): se migra del Excel. En las facturas nuevas de distribución el costo
  es el costo real del lote; si hace falta registrar la sobrevaloración por transferencia interna, se añade como
  un costo del contenedor.
