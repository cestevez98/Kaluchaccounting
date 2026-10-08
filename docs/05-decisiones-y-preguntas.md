# 05 · Decisiones tomadas y preguntas abiertas

## Decisiones propuestas (cambian si me indicas lo contrario)

| # | Decisión | Alternativa descartada |
|---|---|---|
| D1 | NestJS (API) + Next.js (web) en monorepo | Solo Next.js con API routes |
| D2 | Prisma + SQL versionado para triggers, constraints y reportes | Prisma puro / Drizzle |
| D3 | Una base de datos, `company_id` + RLS | Un esquema por empresa |
| D4 | Importes con signo (`+` Debe / `−` Haber) | Columnas debe/haber |
| D5 | Convención de tasas `1 USD = X` (igual que el Excel) | Convención de mercado por par |
| D6 | Cada movimiento a la tasa de su día + revaluación mensual sin reversión | Reversión el día 1 |
| D7 | Lógica de asientos en código, cuentas configurables | DSL de reglas 100 % en la UI |
| D8 | Libros BASE/REAL/FISCAL | Dos bases separadas |
| D9 | Migración incremental por fase | Big-bang en fase 7 |
| D10 | Costo de inventario identificado por lote (contenedor × producto) | Promedio ponderado |
| D11 | ETL en TypeScript reutilizando los handlers del motor | ETL en Python |
| D12 | El Excel no se versiona en git; se carga desde `data/` (ignorado) | Subirlo al repo |

## Preguntas que necesito que respondas

**P1 · ¿En qué libro van las cuentas personales de socios?**
Hoy están en el BC del grupo (112/113/114). Opciones:
- (a) una **entidad no legal "SOC – Tesorería de socios"** que consolida en el
  grupo (recomendado, porque mantiene limpios los libros de cada S.R.L.);
- (b) asignar cada cuenta personal a la empresa para la que opera.

**P2 · ¿El BC de referencia es solo consolidado?** El Excel no tiene BC por
empresa. Propongo conciliar a nivel consolidado y, además, ofrecer BC por
empresa como funcionalidad nueva (sin referencia contra la que comparar).

**P3 · Caja CAD convertida con la tasa `MLC/USD (IC)`.** ¿Es intencional o es
un error? Si es un error, la diferencia se marcará como "explicada".

**P4 · Tipo de tasa de revaluación por cuenta.** Según las fórmulas: caja y
bancos CUP → IC, EUR caja → IC, DOP → ORD. ¿Los bancos EUR de España usan
EUR/USD (OC) u (OUE)? Lo extraeré de cada fórmula del BC, pero confírmame la regla.

**P5 · Real vs Fiscal.** ¿Qué diferencias hay hoy entre el estado "Real" y el
"Presentado", además del costo fiscal, el PV fiscal y el ONAT? ¿Quién usa
cada uno: socios, ONAT, DGII, Hacienda?

**P6 · Periodo de aceptación.** Pediste abril–diciembre de 2026, pero hay datos
hasta octubre de 2026. ¿Conciliamos abril–octubre y ampliamos después?

**P7 · Saldos de apertura.** ¿Desde qué fecha arranca el sistema? Hay
movimientos desde 2023 (Banco_Pers_Exterior) y 2024 (Banco_Emp_Cuba). Opciones:
- (a) importar todo el histórico (más trazabilidad, más revisión manual);
- (b) **saldos de apertura al 31/03/2026 + movimientos desde el 01/04/2026**
  (recomendado: es suficiente para conciliar abril–octubre).

**P8 · Hosting y soberanía de datos.** ¿Dónde se aloja: VPS en Europa, Vercel +
base gestionada, servidor propio? Hay usuarios en Cuba: algunos proveedores
cloud estadounidenses bloquean el acceso desde Cuba (OFAC), y eso puede
descartar Vercel, AWS o GCP para el frontend. Recomiendo un **VPS en la UE**
(p. ej. Hetzner/OVH) con Docker Compose.

**P9 · Usuarios.** ¿Cuántos usuarios y en qué roles? ¿Los vendedores entran al
sistema o solo Operaciones registra sus ventas? ¿Hace falta uso desde móvil en
punto de venta?

**P10 · Doping (777) y Proyectos.** ¿Qué empresa factura Doping? ¿"Proyecto
Iglesia" es un segmento propio o una dimensión dentro de 888/999?

**P11 · Plan de cuentas.** ¿Corregimos ya los códigos duplicados (`110.3803`,
`180.8883`, `1816.8880`) y las naturalezas incoherentes (1900, 1181, 1816),
o los migramos tal cual y los corregimos después?

**P12 · ONAT.** La fórmula actual es `0,11 × ventas fiscales + 0,35 × (ventas
fiscales − costo fiscal − 0,11 × ventas fiscales)`, en CUP y a tasa IC del día.
¿Es correcto y vigente para todo 2026? ¿El 35 % es el impuesto sobre
utilidades? ¿Se contabiliza como gasto 829/830 contra 480, o solo es una
estimación de gestión?
