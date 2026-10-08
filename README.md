# Kaluch ERP

ERP financiero-operativo para Grupo Kaluch. Sustituye el libro Excel
"Balance de comprobación.xlsx" (76 hojas) por una aplicación web multiusuario
basada en un libro diario de partida doble, multi-empresa, multi-moneda y
multi-segmento.

**Estado:** Fase 4 completada (09/10/2026): facturas de exportación con su cierre, contenedores,
inventario con kardex, ventas de distribución con costo por lote, comisiones, ONAT, inversionistas y
utilidad por contenedor; migración de ventas, costos y todos los gastos e ingresos de operación del Excel
(0 diferencias sin explicar de abril a octubre). Antes: fase 3 (contrapartes, CxC/CxP, nómina) y fase 2
(tesorería, usuarios, 2FA, despliegue).
Resúmenes: [fase 1](docs/fases/fase-1.md) · [fase 2](docs/fases/fase-2.md) · [fase 3](docs/fases/fase-3.md) ·
[fase 4](docs/fases/fase-4.md) · [despliegue](docs/despliegue.md). Siguiente: fase 5 (financiamientos,
fiscal, capital y cierres).

## Puesta en marcha (desarrollo)

```bash
cp .env.example .env
pnpm install
pnpm db:up                       # PostgreSQL 16 en Docker (o uno local)
pnpm db:migrate && pnpm db:seed  # esquema + datos de demostración
pnpm build
pnpm --filter @kaluch/api start  # API en http://localhost:4000 (OpenAPI en /api/docs)
pnpm --filter @kaluch/web start  # Web en http://localhost:3000
```

Usuario demo: `admin@kaluch.local` / `Kaluch-demo-2026`.

Importar datos reales del Excel (nunca se sube al repositorio; `data/` está en `.gitignore`):

```bash
pnpm etl all data/balance.xlsx        # plan de cuentas + tasas + valores de referencia del BC
pnpm etl treasury data/balance.xlsx   # caja y bancos: apertura, movimientos y revaluaciones
pnpm etl debts data/balance.xlsx      # deudas, proveedores y nómina (después de treasury)
pnpm etl explain                       # explicaciones automáticas de diferencias conocidas
pnpm etl compare data/conciliacion.xlsx  # informe de conciliación con el BC
```

Tests: `pnpm test` (unitarios + integración con PostgreSQL real) y `pnpm e2e` (Playwright).

## Estructura

| Carpeta | Contenido |
|---|---|
| `packages/shared` | Dinero, monedas, formatos es-ES, permisos, esquemas de validación |
| `packages/db` | Esquema y migraciones, motor de asientos, reportes, seeds |
| `packages/etl` | Importación desde el Excel |
| `apps/api` | API REST (NestJS) |
| `apps/web` | Interfaz web (Next.js) |

## Documentación de diseño

| Documento | Contenido |
|---|---|
| [00 · Análisis del Excel](docs/00-analisis-excel.md) | Volumen, cómo calcula el BC, errores detectados y criterio de conciliación |
| [01 · Arquitectura](docs/01-arquitectura.md) | Stack, módulos, despliegue, seguridad, decisiones técnicas |
| [02 · Modelo de datos (ERD)](docs/02-modelo-datos.md) | Entidades, relaciones, restricciones e índices |
| [03 · Motor contable y monedas](docs/03-motor-contable.md) | Asientos, reglas de contabilización, tasas, revaluación, cierres, con ejemplos |
| [04 · Plan de fases](docs/04-plan-de-fases.md) | Alcance, entregables y criterios de aceptación por fase |
| [05 · Decisiones](docs/05-decisiones-y-preguntas.md) | Decisiones técnicas y de negocio, despliegue en Hostinger, roles |
| [Fase 1](docs/fases/fase-1.md) | Resumen de lo construido, resultado de la importación, tests y pendientes |
| [Fase 2](docs/fases/fase-2.md) | Tesorería, migración de caja y bancos, conciliación abril–octubre |
| [Fase 3](docs/fases/fase-3.md) | Contrapartes, CxC/CxP, nómina, migración de deudas guiada por las fórmulas del BC |
| [Fase 4](docs/fases/fase-4.md) | Exportación, contenedores, inventario, ventas de distribución, inversionistas, gastos de operación y totales de control |
| [Despliegue](docs/despliegue.md) | Instalación en el VPS, actualización, carga de datos y copias de seguridad |
