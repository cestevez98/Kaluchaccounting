# Fase 2 · Tesorería + Balance de comprobación

Estado: **completada** (08/10/2026). Tests en verde: 65 unitarios/integración + 12 E2E.

## Qué se ha construido

### Tesorería (`packages/db/src/treasury.ts`)
- **Cuentas de tesorería**: caja, bancos y tarjetas por empresa, país, banco y moneda.
  - Cada una enlazada a su cuenta contable (101, 109–114).
  - Las cuentas personales de los socios pertenecen a la entidad `SOC`.
- **Movimientos**: cobro, pago, traspaso y cambio de divisa. Cada movimiento genera su asiento automáticamente.
  - **Con categoría** (las antiguas "Referencias cruzadas"): la contrapartida es la cuenta contable de la categoría.
  - **Sin categoría, o con una categoría sin cuenta**: va a `699.9998` y aparece en la **bandeja de revisión**. Desde allí se reclasifica uno a uno o en bloque.
  - **Cambios y traspasos con las dos patas**: la diferencia realizada va a 845/924 (`.9990` Cambios, `.8881` Traspasos).
  - **Una sola pata** (la otra está en otra hoja o empresa): el cambio queda en `699.9996` y el traspaso en `699.0003`, igual que en el Excel.
  - **Anulación** con contra-asiento; nunca se borra nada.
- **Revaluación mensual (tenencia)** (`revaluation.ts`):
  - A fin de mes, cada cuenta en moneda extranjera se valora con su tipo de tasa (IC, OUE, ORD…).
  - La diferencia va a 846/925 (`.9990` efectivo, `.8880` CxC).
  - Repetir un mes anula la ejecución anterior y la sustituye.
- **Extractos bancarios** (`bank.ts`):
  - Importa CSV/XLSX y detecta las columnas Fecha, Concepto, Importe o Cargo/Abono.
  - Es idempotente: cada línea lleva un hash, así que reimportar no duplica.
  - **Conciliación automática**: casa por importe exacto y fecha ±3 días, solo cuando hay un único candidato.
  - **Manual**: casar, descasar, ignorar o crear el movimiento desde la línea.
- **Conciliación con el BC del Excel** (`bc-compare.ts`): compara cuenta a cuenta y mes a mes contra los valores del Excel.
  - Cada cuenta queda como OK (±0,01 USD), Explicada (con motivo registrado), Diferencia, o Solo en el sistema.
  - Disponible en pantalla, por API y como xlsx (`pnpm etl compare`).

### Cuentas de sistema
| Cuenta | Uso |
|---|---|
| `699.9996` | Cambios de divisa con una sola pata |
| `699.9997` | Contrapartida de los saldos de apertura (31/03/2026) |
| `699.9998` | Bandeja de revisión: movimientos pendientes de clasificar |
| `699.9999` | Redondeo del sistema (fase 1) |

### Administración y seguridad
- **Usuarios**: alta, baja, cambio de contraseña, reinicio del 2FA y asignación de roles por empresa.
- **Roles**: configurables por permisos. El Superadministrador está protegido.
- Los roles semilla son: Superadministrador, Contador, Cajero, Conciliador, Fiscal, Comercial y Ventas, Almacén y Solo lectura.
- **2FA obligatorio en producción**: quien tenga un rol que lo exige y no lo haya activado solo puede acceder a "Seguridad" hasta activarlo.

### Interfaz (diseño de Figma)
- Menú lateral por módulos, que se puede plegar. Los módulos de fases futuras aparecen desactivados con su número de fase.
- Submenú del módulo, migas de pan, selector de empresa y menú de usuario.
- **Dashboard** con indicadores reales:
  - disponible en caja y bancos;
  - resultado del mes;
  - pendientes de clasificar;
  - líneas de extracto sin casar;
  - cuadre del balance;
  - tesorería por moneda.
- **Bancos y Caja**:
  - resumen con tarjetas por país y total;
  - movimientos con filtros;
  - nuevo movimiento;
  - bandeja de revisión;
  - extractos y conciliación;
  - revaluación;
  - categorías.
- Pantalla de acceso nueva, con el código 2FA en 6 casillas (se puede pegar).
- Tipografía Inter, tablas densas, números en formato es-ES y estilos de impresión.

## Migración: resultado con el Excel real
`pnpm etl all` seguido de `pnpm etl treasury` sobre una base vacía (unos 8 minutos):

| | Resultado |
|---|---|
| Filas leídas | **34.823** de `Efectivo_Caja`, `Banco_Emp_*` y `Banco_Pers_*` |
| Apertura | 12.264 filas hasta el 31/03/2026 resumidas en saldos de apertura |
| Movimientos | **21.871** desde abril de 2026, cada uno trazado a su fila del Excel (`import_row`) |
| Bandeja de revisión | 16.794, casi todos de categorías `Deuda*` (contrapartes). Se clasifican en la fase 3 |
| Cuentas de tesorería | 55 deducidas de las fórmulas del BC y 8 creadas por la migración |
| Categorías | 68 |
| Revaluaciones | Abril a octubre de 2026 |

**Conciliación abril–octubre 2026** (cuentas 101, 109–114 y las partes de efectivo de 845/846/924/925):

| Estado | Cuentas |
|---|---|
| OK (±0,01 USD) | **61** |
| Explicadas | 2: la caja CAD, omitida por decisión P3 (`101.0004`), y su efecto en el total de la 101 |
| No explicadas | **0** |
| Solo en el sistema | 8 (cuentas de sistema 699.x y cuentas creadas por la migración) |

El Excel ignora las celdas de texto en SUMIFS. La migración hace lo mismo: por ejemplo, la "Salida CUP" con valor `e` del 2424 o un `60` guardado como texto el 11/09. Así se reproducen exactamente sus saldos.

## Despliegue
- Imágenes Docker para la API y la web, Caddy (HTTPS automático) y copia diaria con `pg_dump`. Ver [despliegue.md](../despliegue.md).
- **DNS de kgtaccounting.com apuntando al VPS** (A 187.7.70.196 y AAAA), configurado el 08/10/2026.
- El stack de producción se ha probado completo en local:
  - migraciones;
  - usuario administrador;
  - HTTPS con cabeceras de seguridad;
  - 2FA obligatorio;
  - copia de seguridad;
  - ETL dentro del contenedor.
- Falta ejecutar `docker/bootstrap-vps.sh` en el VPS (consola web de Hostinger) y añadir la clave de despliegue en GitHub.

## Tests
| Suite | Qué cubre |
|---|---|
| `packages/shared` (12) | Dinero, tasas, formatos es-ES |
| `packages/db` (21) | Motor de asientos, cobros/pagos, cambios y traspasos con diferencia, bandeja y reclasificación, revaluación y su repetición, conciliación con el BC |
| `packages/etl` (17) | Lectura del Excel, intérprete de SUMIFS y criterios de Excel (comodines, `~`, texto) |
| `apps/api` (15) | Autenticación, permisos por empresa, tesorería, extractos (importación idempotente y conciliación), administración |
| E2E (12) | Acceso, asientos multimoneda, BC, cambio de moneda en caja, bandeja, tesorería, conciliación, alta de usuario cajero |

## Pendiente / a decidir
- **Titular de `Efectivo_Caja`**: se ha importado a nombre de GR. Si es otra empresa, se cambia con `--cash-company` y se vuelve a migrar.
- **Copia de seguridad fuera del servidor**: falta elegir el destino (B2, S3 o Google Drive).
- La bandeja de revisión se vaciará al mapear las categorías `Deuda*` a contrapartes en la fase 3.
