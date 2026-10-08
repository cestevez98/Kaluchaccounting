# Fase 3 · Contrapartes, proveedores y nómina

Estado: **completada** (08/10/2026). Tests en verde: 86 unitarios/integración + 16 E2E.

## Qué se ha construido

### Contrapartes y cuentas corrientes (`packages/db/src/parties.ts`)
- **Contraparte**: persona o empresa con roles (cliente, proveedor, trabajador, socio,
  inversionista, vendedor, mensajería/envíos, financiador).
- **Cuenta corriente**: una por contraparte, empresa y moneda. Se contabiliza en una cuenta contable
  (135.x, 405.x, 406, 455…). Todas las líneas llevan la contraparte, así que cada saldo y cada estado
  de cuenta salen del libro diario.
- **Cuenta opuesta por signo**. Las cuentas corrientes de la oficina (135.x por cobrar ↔ 405.x por
  pagar) y la de UNIR (413 ↔ 146.0002) tienen un par. Al cierre de mes, el saldo neto se deja en la
  cuenta que corresponde a su signo, como el `IF(… > 0, …, 0)` del BC del Excel:
  - es una **reclasificación de fin de mes**;
  - es idempotente y solo mueve lo que falta;
  - si se repite un mes, se recalculan también los meses posteriores.
- **Documentos de contraparte**: cargos, abonos, cesiones de deuda (zelle Invictus: de Adrián a
  Luiso), saldos de apertura y nóminas. Cada uno genera documento + asiento.
- **Partidas abiertas y liquidaciones**: facturas, deudas y nóminas pendientes.
  - Se liquidan total o parcialmente con un pago ya contabilizado (movimiento de tesorería o
    documento), o se cierran por diferencia.
  - Una liquidación se puede deshacer.
  - La pantalla propone los pagos de la contraparte que aún no se han aplicado.
- **Antigüedad** de partidas por tramos de 0–30, 31–60, 61–90 y más de 90 días.
- **Revaluación de cuentas corrientes en moneda extranjera** (EUR con OUE, CUP con IC), contra
  846/925.8880. El resultado del mes se compensa por grupo (efectivo / cuentas por cobrar y pagar),
  como hace el Excel.
- **Nómina**: salario y descuento de asistencia contra el gasto de personal por segmento
  (826.8880 / 826.9990 / 826.7770), salario Mipyme contra Pagos anticipados de nómina (146.0003) y
  el neto contra Nóminas por pagar (455), con su partida abierta.
- **Tesorería ↔ contrapartes**: una categoría de caja o banco puede apuntar a la cuenta corriente de
  una contraparte. El cobro o pago va directamente a su cuenta, en su moneda.
- **Cierre de mes** (Contabilidad → Revaluación): revaluación, regularización de las transitorias de
  cambios y traspasos con una sola pata (699.9996 / 699.0003 → 845/924) y reclasificación por signo,
  en un solo paso.

### Pantallas
- **Terceros**:
  - listado con saldo neto;
  - ficha con cuentas corrientes, estado de cuenta exportable a CSV, partidas abiertas y datos;
  - alta de contrapartes y de cuentas corrientes;
  - cargos, abonos y cesiones;
  - reclasificación por signo.
- **Cuentas por cobrar / por pagar**: saldos a una fecha, filtro por tipo de contraparte, antigüedad
  y partidas con liquidación.
- **Compras**: facturas de proveedores y registro de factura (abono con partida abierta).
- **RRHH**: nóminas por periodo con descuentos y estado de pago, y alta de nómina.
- **Dashboard**: total por cobrar y por pagar.
- Permisos nuevos:
  - `parties:read` (todos los roles de consulta);
  - `parties:manage` (Contador, Conciliador);
  - `payroll:manage` (Contador).

## Migración: deudas y nómina del Excel
`pnpm etl debts data/balance.xlsx`, sobre la base ya migrada con `all` y `treasury`.

**Cómo funciona.** La migración la guían las fórmulas del BC, igual que la de tesorería:
1. Un intérprete de fórmulas (`packages/etl/src/linear.ts`) convierte la fórmula de cada cuenta en
   "qué columnas de qué tablas suman, con qué signo, con qué fecha de corte y con qué criterios". En
   concreto:
   - detecta los pares por signo (`IF(…,E,0)`) y que la cuenta opuesta es exactamente `−E`;
   - detecta las cuentas en moneda extranjera (`/Tasas[EUR/USD (OUE)]`);
   - resuelve las referencias a otras filas del BC (`409 = total − 406 − 408`).
2. Cada fila de las tablas `Deuda_*`, `RRHH_*`, comisiones, financiamientos e inversionistas se
   contabiliza con el mismo importe con que suma en el BC:
   - Las filas hasta el 31/03/2026 forman el saldo de apertura de cada cuenta corriente.
   - Las posteriores se registran como un documento por fila.
   - La contraparte sale de la cuenta (cuentas dedicadas: Eduardo, Tropicargo, Ray…) o de una columna
     de la fila (proveedor, vendedor, trabajador, entidad, inversionista).
3. Los importes se leen como los suma Excel: las celdas de texto se ignoran y los números con formato
   de fecha cuentan por su valor.
4. **Contrapartida: cuenta puente 699.9995.** El Excel no es de partida doble: la otra pata de una
   deuda (el gasto, el inventario, el ingreso) se calcula en otras hojas que se migran en las fases
   4–6. Hasta entonces queda en el puente, identificada por contraparte.
5. Los pagos de estas deudas que la migración de tesorería dejó en la **bandeja de revisión**
   (categorías Deuda\*, RRHH, financiamientos, inversiones, comisiones de distribución) pasan al mismo
   puente con su contraparte. Así no se cuentan dos veces: el Excel los registra en el banco y en la
   hoja de la deuda.
6. **Partidas abiertas**:
   - facturas de proveedores con sus pagos por nº de factura y la diferencia al cierre;
   - nóminas con sus pagos por referencia;
   - CxC/CxP generales.
7. Revaluación y reclasificación por signo de abril a octubre.

### Resultado con el Excel real
Sobre la base migrada de las fases 1 y 2 (unos 3 minutos):

| | Resultado |
|---|---|
| Aportaciones fila a fila | **9.898** de 29 tablas (`Deuda_*`, `RRHH_Nómina*`, comisiones, financiamientos, inversionistas) |
| Contrapartes | **215** (69 proveedores, 51 vendedores, 32 financiadores, 31 trabajadores…) con **255** cuentas corrientes |
| Documentos | **5.750** posteriores al 31/03/2026, más los saldos de apertura de 43 cuentas corrientes. 209 son nóminas y 1 es la cesión de deuda de zelle Invictus |
| Partidas abiertas | 443 (90 pendientes), con 468 liquidaciones y 124 cierres por diferencia |
| Pagos sin factura localizada | 170 (pagos cuya referencia no coincide con ninguna factura o nómina del Excel; constan en la cuenta corriente pero no se casan) |
| Bandeja de revisión | **4.644** pagos de deudas pasan a la cuenta puente; 2.233 de ellos con su contraparte identificada. Quedan 12.148, casi todos sin referencia en el Excel o de ventas y gastos (fase 4) |

**Conciliación abril–octubre 2026** de las cuentas 101, 109–114, 135, 146, 405–413, 455, 699, 845, 846,
924 y 925 (el resultado detallado está en `data/conciliacion.xlsx`):

| Mes | Cuadran | Explicadas | **Sin explicar** | Solo en el sistema |
|---|---|---|---|---|
| 04/2026 | 136 | 10 | **0** | 11 |
| 05/2026 | 136 | 10 | **0** | 11 |
| 06/2026 | 136 | 10 | **0** | 11 |
| 07/2026 | 134 | 12 | **0** | 11 |
| 08/2026 | 134 | 12 | **0** | 11 |
| 09/2026 | 136 | 10 | **0** | 11 |
| 10/2026 | 138 | 8 | **0** | 11 |

**Explicaciones** (todas calculadas y comprobadas al céntimo, ninguna es manual):
- **Caja CAD** (101.0004 y el total 101), omitida por la decisión P3.
- **Tenencia de efectivo** (846/925.9990):
  - La caja CAD omitida: el Excel la valora a la tasa MLC (IC) y cada fila a CAD (OUE).
  - 7 filas de `Banco_Pers_Cuba` (893–896, 999, 1003 y 1031) tienen "Movimiento en USD" vacío en el
    Excel. Su tenencia no las descuenta: −993,32 USD en mayo y −197,39 USD en junio. Aquí el sistema
    tiene el dato correcto y el Excel el error.
- **Pares gasto/ingreso** (845/924, 846/925 y sus subcuentas): el Excel pone el resultado neto del mes
  en una sola de las dos cuentas; el sistema puede tener las dos (una empresa gana y otra pierde). El
  neto coincide.

**Solo en el sistema**:
- las cuentas de sistema 699.9995 (puente), 699.9997 (apertura) y 699.9998 (bandeja);
- 8 subcuentas bancarias creadas por la migración de tesorería.

### Ajustes que la conciliación hizo necesarios
- **Columnas calculadas de las tablas.** La librería que lee el Excel no las devuelve en el modelo de
  tabla ("Pagado USD", "A pagar", "Diferencia de pago"…), así que la cabecera se lee directamente de
  la hoja.
- **Revaluación por contraparte**: el ajuste de tenencia lleva su contraparte, así que la
  reclasificación por signo y el estado de cuenta en USD lo incluyen.
- **Cierre mensual de las transitorias de tesorería** (699.9996 cambios, 699.0003 traspasos). El saldo
  que dejan los cambios y traspasos con una sola pata se lleva a 845/924 (Cambios / Traspasos), como el
  Excel con las filas "Cambio", "Traspaso" y "Devolución" del mes.
- **Diferencia en pagos a Coprove** (845/924.8880): se migra fila a fila desde `Deuda_Coprove_Pagos`.

## Correcciones a la fase 2
- La comparación de la fase 2 solo cubrió las cuentas **101 y 109–114** (cuadran). Las partes de
  efectivo de 845/846/924/925 se comprueban ahora; el resumen de la fase 2 lo decía mal y está
  corregido.
- **Signo del Excel en la comparación**: el BC del Excel muestra el pasivo con saldo acreedor en
  positivo y los gastos en negativo. La comparación aplica ese signo según la clasificación de la
  cuenta (el "Valor BC" del sistema sigue siendo deudor positivo).
- La revaluación compensa el resultado del mes por grupo, como el Excel, en lugar de separar
  ganancias y pérdidas por cuenta.
- La migración de tesorería lee como números las celdas con formato de fecha (una fila más).
- Los totales de grupo de la comparación no suman las cuentas de sistema (699.999x).

## Tests
| Suite | Qué cubre |
|---|---|
| `packages/shared` (12) | Dinero, tasas, formatos es-ES |
| `packages/db` (30) | Motor de asientos, tesorería, revaluación; contrapartes: cargos y abonos, liquidación y su anulación, reclasificación por signo idempotente, estado de cuenta, cesión, revaluación de cuentas corrientes en EUR, antigüedad, nómina, cierre de transitorias |
| `packages/etl` (23) | Lectura del Excel, SUMIFS, intérprete de fórmulas del BC (pares por signo, tasas, referencias entre filas, importes del mes), números con formato de fecha |
| `apps/api` (21) | Autenticación, tesorería, extractos; contrapartes: alta, cuentas corrientes, factura con partida abierta y liquidación, saldos, antigüedad, estado de cuenta, cesión, nómina, permisos de solo lectura, reclasificación |
| E2E (16) | Fases 1–2 más: factura de proveedor y cuentas por pagar, cargo y estado de cuenta, nómina, cuentas por cobrar y reclasificación |

## Pendiente / a decidir
- **Empresa de las deudas de la oficina**: las cuentas corrientes sin columna de empresa (135/405,
  455, 410–413) se han migrado a KEI. Las de proveedores usan su columna Empresa (Logix → GR). Si otra
  asignación es más correcta, se cambia con `--debt-company` y se vuelve a migrar.
- **Cuenta puente 699.9995**: se irá vaciando cuando las fases 4–6 migren la otra pata (costes de
  exportación, ventas de distribución, gastos).
