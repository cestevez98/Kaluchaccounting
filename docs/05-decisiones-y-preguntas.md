# 05 · Decisiones

Registro de decisiones de la fase 0. Respuestas del 08/10/2026.

## Decisiones técnicas

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

## Respuestas de negocio

| # | Pregunta | Decisión | Impacto en el diseño |
|---|---|---|---|
| P1 | Cuentas personales de socios | **(a) Entidad no legal `SOC – Tesorería de socios`**, que consolida en el grupo | `company.kind = PARTNER_POOL`. Las cuentas 112/113/114 viven en SOC. Los movimientos entre SOC y las empresas usan la 696 (operaciones entre dependencias) y se eliminan al consolidar |
| P2 | Nivel del BC | **Consolidado**: el grupo funciona como una única empresa | La vista por defecto de todos los reportes es el **Grupo consolidado**. Por empresa queda como filtro opcional. La conciliación de aceptación se hace a nivel consolidado |
| P3 | Caja CAD con la tasa MLC | **Es un error. La caja CAD se omite** | La subcuenta `101.0004` y sus movimientos se excluyen de la conciliación con BC (marcada "omitida por decisión"). Por defecto **no se migran** y el ETL los lista en un anexo. Ver nota ① |
| P4 | Tipo de tasa de revaluación por cuenta | **Sí**: se toma de la fórmula de cada fila del BC | El ETL extrae, para cada subcuenta, el tipo de tasa que usa su fórmula del BC y lo carga en `account.reval_rate_type` |
| P5 | Real vs Fiscal | **Como en la tabla**: lo fiscal es la contabilidad de la distribuidora en Cuba | El libro `FISCAL` solo aplica a **DM y GR**. Fuente: `Distribución_Costos` (columnas Real/Fiscal) y `Distribución_Productos` (costo fiscal y PV fiscal). Las empresas de exportación solo tienen BASE |
| P6 | Periodo de aceptación | **Abril–octubre 2026** | Noviembre y diciembre se concilian cuando haya datos |
| P7 | Arranque | **(b) Saldos de apertura al 31/03/2026** + movimientos desde el 01/04/2026 | Asiento de apertura por cuenta, subcuenta, moneda y contraparte, tomado del BC de marzo (o recalculado de las tablas a 31/03). Las partidas abiertas de facturas y deudas vivas a esa fecha se importan individualmente para poder liquidarlas |
| P8 | Hosting | **Hostinger, dominio `kgtaccounting.com`** | Ver §1 |
| P9 | Usuarios y roles | Superadministrador, Cajero, Conciliador, Fiscal, Comercial y Ventas, Almacén… y habrá más | Los **roles pasan a ser configurables** (tabla `role` + `role_permission`), no una lista fija. Ver §2 |
| P10 | Doping y Proyectos | **Salen de la Distribución** | Segmentos jerárquicos: `999 Distribución` con hijos `777 Doping` y `PRJ-* Proyectos`. Pertenecen a DM/GR. ERDop 777 sigue siendo un informe propio, y el ERD 999 puede mostrarse con o sin sus hijos |
| P11 | Anomalías del plan de cuentas | **Migrar tal cual** y corregir después | Los códigos duplicados se importan con un sufijo técnico interno (`110.3803` y `110.3803#2`) para no romper la unicidad; la UI muestra el código original con un aviso. Las naturalezas se importan como están, con la anomalía marcada |
| P12 | ONAT | **Sí**: `0,11 × V + 0,35 × (V − costo fiscal − 0,11 × V)`, vigente en 2026 | Parámetros `onat.sales_rate = 0.11` y `onat.profit_rate = 0.35` con vigencia desde 01/01/2026. Se contabiliza como gasto (829/830) contra gastos acumulados (480) en el libro FISCAL de DM/GR. Ver nota ② |

**Notas por confirmar** (si no dices nada, se aplica lo indicado):
- ① "Omitir la caja CAD" se interpreta como no migrarla ni conciliarla. Si esa
  caja existe de verdad y sigue en uso, se crea más adelante con la tasa
  correcta (`CAD/USD (OUE)`).
- ② Se entiende que el ONAT estimado se contabiliza como gasto y no queda solo
  como dato de gestión.

## 1. Despliegue en Hostinger

Estado actual de la cuenta (consultado el 08/10/2026): `kgtaccounting.com`
está registrado y activo, pero **no hay ningún VPS ni plan de hosting web**
contratado en la cuenta.

- El **hosting web compartido** de Hostinger solo ofrece MySQL/MariaDB, sin
  PostgreSQL, Redis ni Docker. No sirve para este sistema: los triggers de
  cuadre, NUMERIC exacto, RLS y las colas dependen de PostgreSQL y Redis.
- **Requisito: un VPS de Hostinger** con Ubuntu 24.04 + Docker. Tamaño
  recomendado **KVM 2** (2 vCPU, 8 GB RAM, 100 GB NVMe) para arrancar, y KVM 4
  cuando haya millones de movimientos. El centro de datos debe estar **en la UE**
  (Lituania, Países Bajos o Francia), por latencia desde España y para que sea
  accesible desde Cuba.
- Arquitectura en el VPS: Docker Compose con `caddy` (HTTPS automático para
  `kgtaccounting.com` y `api.kgtaccounting.com`), `web`, `api`, `worker`,
  `postgres`, `redis` y `pgbackrest`.
- Backups: snapshots semanales del VPS en Hostinger + pgBackRest con
  incrementales diarios y WAL continuo hacia un almacenamiento externo
  (S3-compatible, fuera de Hostinger).
- DNS: registros A de `kgtaccounting.com` y `api.` hacia la IP del VPS.
- Despliegue automático desde GitHub Actions al hacer merge a `main`
  (build de imágenes → GHCR → `docker compose pull && up` por SSH).
- **Contratar el VPS lo decides tú.** No compro nada desde aquí. Hace falta a
  partir de la fase 2 (staging); hasta entonces todo corre en local con Docker Compose.

## 2. Roles configurables

Permisos atómicos (`recurso:acción`, p. ej. `cash:create`, `cash:post`,
`bank:reconcile`, `period:lock`, `tax:post`, `inventory:move`, `sales:create`,
`reports:financial:read`), y roles como conjuntos editables de permisos.
Cada usuario tiene uno o varios roles **por empresa**.

Roles semilla:

| Rol | Permisos principales |
|---|---|
| Superadministrador | Todo, incluidos usuarios, roles, configuración y reapertura de periodos |
| Contador | Plan de cuentas, asientos manuales, revaluación, cierres, todos los reportes |
| Cajero | Caja (entradas, salidas, cambios de divisa) en sus cajas asignadas; arqueo |
| Conciliador | Importación de extractos, conciliación bancaria, traspasos, bandeja de revisión |
| Fiscal | Libro FISCAL, impuestos (ONAT, DGII, Hacienda), costos y PV fiscales, cierres fiscales |
| Comercial y Ventas | Facturación de distribución y exportación, clientes, cobros y sus comisiones |
| Almacén | Contenedores, entradas, traslados, mermas, kardex (sin precios de venta ni utilidades) |
| Solo lectura | Consulta de reportes asignados |

Además, el acceso se puede acotar por **recurso concreto**: un cajero ve solo
sus cajas y un vendedor solo sus ventas y comisiones.
