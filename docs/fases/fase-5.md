# Fase 5 · Financiamientos, fiscal, capital y cierres

Estado: **completada** (09/10/2026). Tests en verde: 110 unitarios/integración + 20 E2E.

## Qué se ha construido · `packages/db/src/finance.ts`

### Préstamos
- **Préstamos dados** (por cobrar, 138) **y recibidos** (por pagar, 411), con:
  - referencia, entidad, inicio y vencimiento;
  - principal e interés total en %, como el "Importe + %" del Excel.
- **Alta**:
  - Con cuenta de desembolso, contabiliza el principal y abre una partida por el total a devolver (principal +
    interés), con vencimiento.
  - Sin ella, solo registra el préstamo (los migrados del Excel).
- **Devengo mensual del interés**:
  - Se reparte por días entre el inicio y el vencimiento; el último mes se lleva el resto.
  - Sin vencimiento, todo el interés va el mes de inicio.
  - Préstamo recibido: gasto financiero 842 contra el prestamista. Préstamo dado: deudor contra ingreso
    financiero 921.
  - Un devengo por préstamo y mes: repetirlo no duplica nada.
- **Corto/largo plazo**: el principal de los préstamos recibidos que vencen a más de un año pasa de 411 a 520 (y
  vuelve cuando ya vence antes). Solo se contabiliza la diferencia con la última reclasificación.

### Impuestos
- **Organismos**: ONAT (Cuba, Distribución, cierre trimestral) y Hacienda (España, Exportación, cierre anual).
- **Devengo**: gasto 830 contra Gastos acumulados por pagar 480 del organismo. La ONAT de las ventas de
  distribución ya se devenga con cada factura (fase 4).
- **Pagos**: desde Bancos y Caja, con la categoría que apunta a la cuenta 480 del organismo.
- **Cierre del periodo**:
  - Lo declarado frente a lo devengado en el periodo.
  - Si se debía más, la diferencia va a 848 (Gastos adicionales de impuestos); si se debía menos, a 920
    (Ingresos adicionales).
  - Un periodo no se puede cerrar dos veces.
- **Resumen anual** por organismo: devengado, pagado, ajustes y saldo por pagar mes a mes, y los cierres.

### Capital
- **Aportes y retiros de capital** (600) y **reparto de utilidades** (630) por socio, contra caja, banco o una
  cuenta por pagar.
- **Capital por socio**: saldo y % sobre el capital de los socios, y utilidades retenidas.
  - Lo migrado del Excel no tiene socio: el Excel lleva el capital como un único saldo.

### Cierres
- **Lista de cierre de mes** por empresa:
  1. tasas del último día de las monedas con saldo;
  2. bandeja de revisión vacía;
  3. interés de préstamos devengado;
  4. revaluación y reclasificación por signo;
  5. impuestos devengados;
  6. periodo bloqueado.

  Cada paso enlaza con su pantalla.
- **Cierre del ejercicio**:
  - El saldo del año de cada cuenta de ingresos y gastos (por libro y segmento) pasa a Utilidades retenidas
    (630).
  - Va en el **periodo 13** (31/12): diciembre conserva su resultado en el balance de comprobación mensual y
    enero empieza con los resultados a 0.
  - Si se repite, anula el cierre anterior y lo rehace.
  - Deja abiertos los meses del año siguiente (apertura).
  - Un asiento del periodo 0 o 13 se anula en su mismo periodo.

### Pantallas y permisos
- **Financiamientos**: préstamos dados y recibidos (vigentes y devueltos), alta, devengo del mes y corto/largo
  plazo.
- **Impuestos**: ONAT y Hacienda, con su resumen mensual, devengo y cierre del periodo.
- **Contabilidad → Capital por socio** y **Contabilidad → Cierre de mes y de ejercicio**.
- **Importar Excel**: el modo de actualización *"Añadir lo que falta por migrar"* ejecuta solo las fases que
  falten en la base.
- **Permisos nuevos** (los tiene el Contador):
  - `finance:manage`: préstamos;
  - `capital:manage`: aportes, retiros y repartos;
  - `year:close`: cierre del ejercicio.
- Los impuestos usan `tax:manage`.

## Migración: financiamientos dados, impuestos devengados y capital
`pnpm etl fiscal data/balance.xlsx`, tras la de ventas (unos 15 segundos).

- **138** (préstamos dados) desde `Financiamientos` y `Deuda_Financiamientos`, por entidad.
- **480** (impuestos por pagar a ONAT y Hacienda) desde `Impuestos_Diferencia`: gasto, pagado y cierres.
- **630** (utilidades retenidas) desde la fila "INGRESO KM" de la hoja `Capital`.
- **600 Capital**: el Excel no lo saca de ninguna hoja.
  - En abril es el cuadre del propio BC (suma de unas filas menos otras).
  - Desde mayo es el capital anterior más el resultado consolidado del mes, los ingresos por inversión y los
    gastos posteriores al cierre (hoja `Capital`, fila 26). Es decir, **el Excel capitaliza el resultado cada
    mes**.
  - Además, el BC del Excel no cuadra. En mayo: activos 1.256.031,65, pasivos 811.327,04, patrimonio 717.117,34.
  - El saldo no se puede reconstruir desde los movimientos, así que se migra **la variación mensual de su valor
    en el BC**, contra la cuenta puente 699.9995. Cada asiento lo dice en su concepto: *"saldo calculado por el
    Excel"*.
- **Registro de préstamos**: las 287 operaciones de `Financiamientos` quedan registradas como préstamos
  recibidos (107 vigentes y 180 devueltos).
  - Lo recibido es el principal, y la diferencia con lo que se devuelve es el interés.
  - Sus importes ya están contabilizados por las aportaciones al BC, así que van **marcados como migrados** y su
    interés no se vuelve a devengar.

### Resultado con el Excel real
Migración completa desde cero (fases 1–5). **Todas las cuentas del BC**, no solo las migradas:

| Mes | Cuadran | Explicadas | **Sin explicar** | Solo en el sistema |
|---|---|---|---|---|
| 04/2026 | 286 | 22 | **0** | 11 |
| 05/2026 | 288 | 20 | **0** | 11 |
| 06/2026 | 282 | 26 | **0** | 11 |
| 07/2026 | 293 | 15 | **0** | 11 |
| 08/2026 | 291 | 17 | **0** | 11 |
| 09/2026 | 287 | 21 | **0** | 11 |
| 10/2026 | 296 | 12 | **0** | 11 |

Con esto se cumple el criterio de aceptación del proyecto: el BC del sistema coincide con el del Excel a
±0,01 USD por cuenta, y cada diferencia tiene una explicación calculada y comprobada al céntimo. Las
explicaciones son las de las fases 3 y 4:
- caja CAD y filas sin USD del Excel;
- pares gasto/ingreso compensados;
- cuentas de estado actual;
- cabecera 180.

Las "solo en el sistema" son las cuentas de sistema (699.999x) y las subcuentas bancarias creadas por la
migración.

## Tests
| Suite | Qué cubre |
|---|---|
| `packages/shared` (12) | Dinero, tasas, formatos es-ES |
| `packages/etl` (26) | Intérprete de fórmulas del BC, lectura del Excel, totales de control |
| `packages/db` (43) | Más: reparto del interés por días, préstamo recibido con partida, devengo idempotente, corto/largo plazo de ida y vuelta, préstamo dado, devengo y cierre de impuestos con su diferencia y resumen, capital por socio (aportes, retiro, reparto), cierre del ejercicio en el periodo 13 sin tocar diciembre y repetible, lista de cierre de mes |
| `apps/api` (29) | Más: préstamo y devengo por API, ONAT (devengo, cierre, resumen), aporte y capital por socio, lista de cierre, permisos de solo lectura. La API se probó en varios órdenes de ejecución |
| E2E (20) | Más: préstamo recibido hasta su interés; impuestos, capital por socio y cierre de mes |

## En producción
Tras el despliegue automático, en **Configuración → Importar Excel** elige *"Añadir lo que falta por migrar"* y
sube el Excel. En una base con la fase 4 ya migrada, solo ejecuta la fase 5 (unos 3 minutos con la
actualización del BC y la conciliación).

## Pendiente / a decidir
- **Capital y cuenta puente**: el capital migrado (600) es el saldo calculado por el Excel, que ya incluye los
  resultados de abril–octubre. Esos resultados siguen también en las cuentas de ingresos y gastos (el sistema no
  capitaliza cada mes), y la cuenta puente compensa la diferencia.
  - **Al cerrar 2026** conviene revisar con el contador qué parte del capital migrado corresponde a resultados
    del año, para no contarlos dos veces en Utilidades retenidas.
  - Se puede hacer con un asiento de reclasificación del puente contra 600/630.
- **Préstamos migrados**: su devolución está en las cuentas corrientes (411) del Excel, pero no hay partida
  abierta por préstamo. Los préstamos nuevos sí la tienen.
- **Fase 6**: estados financieros (ES, ER por segmento, EFE) y dashboard.
