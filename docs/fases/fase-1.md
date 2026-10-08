# Fase 1 · Fundaciones + motor contable

Estado: **completada** (08/10/2026). Tests en verde: 41 unitarios/integración + 7 E2E.

## Qué se ha construido

### Monorepo
| Paquete | Contenido |
|---|---|
| `packages/shared` | Dinero exacto (decimal.js, half-even), conversión `1 USD = X`, formatos es-ES (`1.234,56`, `dd/mm/aaaa`), permisos y roles semilla, esquemas Zod compartidos |
| `packages/db` | Esquema Prisma, migraciones SQL con las reglas contables, **motor de asientos**, tasas, parámetros con vigencia, BC y mayor, seeds |
| `packages/etl` | Lectura del Excel: plan de cuentas (hoja BC), tasas (hoja Tasas) y valores de referencia del BC |
| `apps/api` | NestJS: autenticación, permisos por empresa, catálogos, plan de cuentas, tasas, periodos, libro diario, reportes, auditoría, OpenAPI en `/api/docs` |
| `apps/web` | Next.js: acceso (con 2FA), panel, libro diario, nuevo asiento, detalle y anulación, mayor, BC con exportación a Excel, plan de cuentas (árbol), tasas, periodos, auditoría, seguridad |

### Reglas contables garantizadas por la base de datos
No dependen de la API: se cumplen aunque alguien escriba directamente en la base.

- **Cuadre en USD verificado al hacer COMMIT** (constraint trigger diferido): Σ USD = 0 y al menos 2 líneas.
- **Inmutabilidad**: un asiento contabilizado no se modifica ni se borra. Solo se anula con contra-asiento.
- **Periodos**: no se contabiliza en un mes bloqueado. En un mes "en revisión" solo puede hacerlo quien tenga el permiso `ledger:post_soft_closed` (Contador). La fecha tiene que caer dentro del periodo.
- **Cuentas**: solo de detalle y activas; moneda fija si la cuenta la tiene; contraparte obligatoria si la cuenta la exige.
- **Saldos materializados** (`ledger_balance`) por empresa × libro × periodo × cuenta × segmento × moneda, actualizados por trigger. El BC no recorre las líneas del diario.
- **Auditoría** de todas las tablas maestras y de los asientos, con usuario, antes/después y motivo. Las contraseñas y los secretos 2FA nunca se guardan en la auditoría. El registro es de solo inserción.

### Motor de asientos (`packages/db/src/ledger.ts`)
- Cada línea guarda la moneda, el importe original, la tasa, el tipo de tasa y el importe en USD.
- Busca la tasa del día o la última anterior, hasta 7 días (parámetro `fx.max_rate_age_days`). Si no la encuentra, el asiento no se contabiliza y se muestra un mensaje claro.
- El tipo de tasa por defecto es el de revaluación de la cuenta (extraído de la fórmula del BC) o, si no tiene, el de la moneda (CUP→IC, EUR→IC, DOP→ORD…).
- El redondeo de los asientos multimoneda se compensa en la cuenta `699.9999 Redondeo del sistema` si es ≤ 0,01 USD (parámetro). Por encima de eso, el asiento no se contabiliza.
- La anulación usa las mismas tasas con el signo invertido. Si el periodo original está bloqueado, el contra-asiento va al primer periodo abierto.
- Numeración correlativa por empresa y año: `KEI-2026-000123`.

### Balance de comprobación
- Consolidado por defecto, o por empresa. Filtro por segmento, que incluye los subsegmentos (999 → 777, Proyectos).
- Vistas **Real** (BASE + REAL) y **Fiscal/Presentado** (BASE + FISCAL).
- Columnas: saldo inicial, debe, haber, saldo final y **"Valor BC"**, comparable con el Excel: saldo en las cuentas de balance y movimiento del mes en las de ingresos y gastos.
- Desglose por moneda original de cada cuenta.
- Control **Activo = Pasivo + Patrimonio + Resultado**, con alerta si no cuadra.
- Exportación a Excel con formato numérico.

### Seguridad
- Contraseñas con Argon2id. Sesión en cookie httpOnly (o Bearer para integraciones).
- 2FA TOTP opcional, activable desde "Seguridad". El panel avisa si tu rol lo exige.
- Roles configurables por permisos atómicos y asignados **por empresa**. Las consultas solo devuelven las empresas permitidas.

## Migración: resultado con el Excel real
`pnpm etl all data/balance.xlsx` sobre una base vacía:

| | Resultado |
|---|---|
| Plan de cuentas | **308 cuentas** (+ `699.9999` de sistema), 254 de detalle. 44 con tipo de tasa de revaluación extraído de su fórmula |
| Duplicados | `110.3803`, `180.8883`, `1816.8880` → importados con sufijo interno `#2` (decisión P11) |
| Anomalías marcadas | 12 naturalezas incoherentes (920.x, 921.8880, 924.x, 925.x, 926.8880 con clasificación CND; 1900, 1816, 1181) + caja CAD omitida |
| Tasas | **7.192 tasas diarias** (27/10/2023 → 2026). Se descartan 298 vacías o a 0. Una fecha duplicada en el Excel (27/10/2023) |
| Referencia BC | **2.970 valores** (330 filas × 9 meses, abril–diciembre 2026) guardados para la conciliación de las fases siguientes |
| Tiempo | ~9 s para leer el Excel completo |

El Excel resuelve por sí mismo la pregunta P4: **los bancos EUR de España usan `EUR/USD (OUE)`**, y la caja y los bancos CUP/MLC usan IC.

La importación es idempotente: si se repite, actualiza sin duplicar.

## Cómo probarlo en local
```bash
cp .env.example .env
pnpm install
pnpm db:up                 # o un PostgreSQL 16 local
pnpm db:migrate && pnpm db:seed
pnpm build
pnpm --filter @kaluch/api start          # http://localhost:4000/api/docs
pnpm --filter @kaluch/web start          # http://localhost:3000
```
Usuarios demo (contraseña `Kaluch-demo-2026`): `admin@kaluch.local` (Superadministrador),
`contador@kaluch.local` (Contador), `lectura@kaluch.local` (Solo lectura, solo KEI).

Datos reales: copia el Excel a `data/` (ignorado por git) y ejecuta `pnpm etl all data/balance.xlsx`.

## Tests
| Suite | Qué cubre |
|---|---|
| `shared` (12) | Redondeo, conversión, tasa 0, formatos es-ES (incluido "40.000" = cuarenta mil), fechas, permisos, booleanos de query |
| `db` (13) | Motor contra PostgreSQL real: tasas, redondeo, descuadres (también saltándose la API), inmutabilidad, periodos, anulación, auditoría, **test de propiedades** (25 asientos multimoneda aleatorios siempre cuadran), BC y mayor |
| `api` (8) | Login, 2FA, permisos por empresa, errores en español, anulación, BC, Excel, periodos con motivo, OpenAPI |
| `etl` (8) | Parser del BC y de Tasas sobre un libro sintético (sin datos reales), fechas serial de Excel, errores de celda |
| E2E (7) | Acceso, panel, asiento multimoneda + anulación, descuadre, BC + Excel, plan de cuentas, usuario de solo lectura |

Durante las pruebas aparecieron tres errores, ya corregidos y cubiertos por tests:
- En es-ES, "40.000" se leía como 40.
- El filtro "cuentas sin saldo" se ignoraba (`"false"` se convertía en verdadero).
- El proxy de la API quedaba fijado en el build en lugar de leerse en ejecución.

## Pendiente (pasa a fases siguientes)
| Tema | Fase |
|---|---|
| **Administración de usuarios y roles desde la UI** (hoy: semilla y `seed:base` con `ADMIN_EMAIL`) | 2 |
| Imágenes Docker de producción, Caddy/HTTPS y despliegue en el VPS de Hostinger | 2 |
| RLS de PostgreSQL como segunda barrera por empresa (hoy el aislamiento lo hace la API) | 2 |
| 2FA obligatorio para los roles que lo exigen (hoy solo se avisa) | 2, antes de producción |
| ESLint con reglas propias (sin `parseFloat` en dinero, límites entre módulos) | 2 |
| Exportación a PDF | 2 |
| Redis/BullMQ para importaciones largas | 2 |
| UI de mapeos contables (`account_mapping`) | 2 |
| Revaluación mensual (tenencia), caja, bancos, traspasos y extractos | 2 |
