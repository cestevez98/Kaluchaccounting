# Fase 6 · Estados financieros y dashboard

Estado: **completada** (12/10/2026). Tests en verde: 131 unitarios/integración + 23 E2E.

## Qué se ha construido

### Plantillas de los estados · `report_template`, `report_line`
Cada estado es una plantilla de líneas, como las hojas del Excel. Cada línea es una de estas cosas:

| Origen | Qué calcula |
|---|---|
| Suma de cuentas | Una o varias cuentas del plan; una cuenta de grupo incluye sus subcuentas |
| Fórmula | Expresión sobre otras líneas: `[clave]`, `+ − * /`, paréntesis, `SUM([a]:[b])`, `MIN`, `MAX`, `ABS` |
| Resultado del ejercicio | Ingresos − gastos hasta el mes. Puede ser el *realizado* (sin la exportación pendiente de cierre: 2900, 28xx) o *solo lo pendiente* |
| Resultados sin cerrar | Resultado de ejercicios anteriores que aún no se han cerrado |
| Cuentas sin línea | Las cuentas de una clasificación (AC, PC, CC…) que no están en otra línea |
| Flujo de caja | Movimientos de caja y bancos de unas categorías de tesorería, o el resto de una actividad |
| Saldo de caja y bancos | Al inicio o al final del mes |
| Efecto de las tasas | Revaluación, cambios entre cuentas propias y saldos migrados |

Los importes llevan el **signo del Excel**:
- activo, pasivo y patrimonio en positivo;
- ingresos en positivo y gastos en negativo.

Cada línea puede cambiar el signo al presentarse.

### Importación desde el Excel
`pnpm etl statements data/balance.xlsx`, o desde Configuración → Importar Excel. Tarda unos 20 segundos.

Lee las hojas **ES, ER, ERE 888, ERD 999, ERDop 777 y EFE**:
- el texto de cada línea (columna A), con su sangría;
- las cuentas del BC de cada línea: las columnas de la derecha que usa la comprobación del propio Excel;
- los totales: las fórmulas `SUM(B3:B5)`, `+B4+B13…` se traducen a fórmulas entre líneas;
- las participaciones (`IF(DATE(…)>TODAY(),0,−1500)`, `IF(X>0,0,X)`) se traducen a `-1500` y `MIN(0,X)`;
- **las cifras del Excel de cada línea y mes**, con su comprobación contra el BC (la columna "2") y si el importe está
  escrito a mano.

Una plantilla modificada en el diseñador no se sobrescribe al volver a importar: solo se actualizan las cifras
del Excel.

**Lo que el importador corrige o completa** (queda en las notas de la plantilla):
- **ES, total PASIVOS**: en el Excel no suma Comisiones (410), Financiamiento (411), UNIR (413), Nóminas por pagar
  (455) ni Gastos acumulados por pagar (480). Por eso el ES del Excel no cuadraba: en mayo, activos 1.171.968 y
  pasivo + patrimonio 695.816.
- **ES, patrimonio**: el Excel no tiene cuentas en esas filas. El sistema presenta:
  - capital (600);
  - utilidades retenidas (630);
  - otras cuentas de patrimonio;
  - resultados de ejercicios sin cerrar;
  - resultado realizado del período;
  - exportación pendiente de cierre.
- **ES, cuentas sin línea**: "Otros activos" y "Otros pasivos" recogen las cuentas que el Excel no presenta, como
  1181, 520 o la cuenta puente 699.
- **ES, línea de control**: ACTIVOS − (PASIVOS + PATRIMONIO), que debe ser 0.
- **EFE**: en el Excel no calcula (`#REF!` en todas las celdas). Se usa su estructura (Explotación, Inversión y
  Financiación, con sus categorías de caja), más:
  - una línea con el resto de cada actividad;
  - el efecto de las tasas;
  - la conciliación con el saldo final de caja y bancos.
- Un código que no existe completo en el plan se busca por su código base: el ER cita "844" y en el plan es
  844.9990, su única subcuenta.

Sin el Excel (la demo o una base nueva), la API crea al arrancar unas **plantillas predeterminadas** ES, ER y EFE
desde el plan de cuentas, con una línea por cuenta de primer nivel. La importación las sustituye.

### Motor · `packages/db/src/statements.ts`
- **ES**: saldo a fin de cada mes.
- **ER**: movimiento del mes; la columna total suma los meses.
- **EFE**: método directo, desde las líneas del diario de las cuentas de caja y bancos:
  - por categoría de tesorería (código, nombre o alias, sin distinguir acentos ni plurales);
  - por actividad (OPER / INV / FIN);
  - los cambios entre cuentas propias, la revaluación y la apertura van al efecto de las tasas;
  - saldo inicial + flujos + efecto de las tasas = saldo final.
- **Vistas**: Real (libros BASE + REAL) y Fiscal/Presentado (BASE + FISCAL).
- **Filtros**: empresa o consolidado, y segmento (888, 999, 777…).
- **Consolidado**: las empresas que consolidan. Las cuentas intercompañía de resultados (1900 ventas internas,
  18xx costos internos) se eliminan del estado de resultados, que lista lo eliminado; se puede desactivar.
- **Detalle por cuenta** de cada línea, y por categoría en el EFE.
- **Cuentas sin línea**: en los estados completos (ES y ER consolidado), se avisa de cada cuenta con importe que no
  está en ninguna línea.
- **No calcula meses futuros**: las participaciones (−1.500 al mes…) darían importes en meses sin datos.
- **Comparación con el Excel**, línea a línea y mes a mes. Cada línea queda en uno de estos estados: cuadra,
  diferencia explicada, diferencia sin explicar o sin cifra en el Excel. La tolerancia es de ±0,01 por cuenta de la
  línea. Las explicaciones se calculan:
  - la hoja del Excel no coincide con su propio BC, **y el sistema sí coincide con el BC** (se comprueba con los
    valores del BC importados);
  - importe escrito a mano en el Excel (no es una fórmula);
  - el total del Excel no suma las mismas líneas (corregido en el sistema);
  - el total incluye líneas que el Excel no tiene;
  - diferencias ya explicadas de las líneas que suma el total;
  - las explicaciones del BC de las fases 2–5 (caja CAD, tenencia, cabecera 180, cuentas de estado actual…).

### Alertas
- El activo no es igual al pasivo más el patrimonio, por empresa.
- Cuentas puente y transitorias (699.x) con saldo desde hace más de dos meses.
- Faltan tasas de cambio del último día del mes para monedas con saldo.
- Ventas y costos internos que no se compensan en el grupo, y saldos entre empresas que no suman 0.

### Panel de dirección (dashboard)
- Resultado mensual del año:
  - *realizado*: sin facturas de exportación pendientes de cierre;
  - en el consolidado, sin operaciones internas.
- Antigüedad de cobros y pagos en USD (0–30, 31–60, 61–90 y más de 90 días).
- Utilidad por contenedor, con ventas, margen y existencias.
- Utilidad por mercado: ingresos por inversión 930.999-x menos gastos por inversión 843.999-x.
- Inventario valorado y comisiones pendientes de pago a vendedores.
- Las alertas de los estados.

### Pantallas y permisos
- **Estados financieros**:
  - pestañas por plantilla;
  - año y meses desde/hasta, vista Real o Fiscal, segmento y eliminación intercompañía;
  - comparación con el Excel, con un icono por celda que da la cifra del Excel y la explicación;
  - detalle por cuenta o categoría;
  - cuentas sin línea y cuentas eliminadas;
  - alertas y notas de la plantilla;
  - **descarga en Excel**.
- **Diseñador de plantillas**:
  - editar líneas: clave, texto, sangría, negrita, origen, cuentas, fórmula (validada al escribir), categorías,
    actividad y signo;
  - subir, bajar, insertar y quitar líneas;
  - copiar una plantilla con otro código;
  - la API rechaza fórmulas mal escritas, claves repetidas y referencias circulares;
  - los cambios quedan en la auditoría.
- **Importar Excel**:
  - "Añadir lo que falta por migrar" incluye los estados;
  - un modo nuevo, "Solo las plantillas de los estados financieros", actualiza las plantillas y las cifras sin tocar
    la contabilidad.
- **Permisos**:
  - `reports:financial` para ver los estados y el panel;
  - `reports:design` (nuevo; lo tiene el Contador) para diseñar plantillas.

## Resultado con el Excel real
Migración completa (fases 1–5) más las plantillas. Consolidado, vista Real, abril–octubre de 2026 (el ES y el ERE
empiezan en mayo, como en el Excel):

| Estado | Comparaciones | Cuadran | Explicadas | **Sin explicar** | Sin cifra en el Excel |
|---|---|---|---|---|---|
| ES | 216 | 150 | 66 | **0** | 0 |
| ER consolidado | 444 | 368 | 10 | **0** | 66 (`#REF!` del Excel) |
| ERE 888 | 258 | 258 | 0 | **0** | 0 |
| ERD 999 | 344 | 296 | 48 | **0** | 0 |
| ERDop 777 | 98 | 98 | 0 | **0** | 0 |
| EFE | — | — | — | — | el Excel da `#REF!` |

- **ES**: cuadra todos los meses (control 0).
  - Las 66 explicadas:
    - 30 son totales con diferencias ya explicadas en sus líneas;
    - 18 son totales con líneas que el Excel no tiene (patrimonio, "Oficina" vacía en el Excel, otros pasivos), y
      en 6 de ellos el total del Excel tampoco suma todas las líneas (PASIVOS);
    - 12 son explicaciones del BC: caja CAD y cabecera 180 con sus cuentas de estado actual;
    - 6 son "Personal España": la hoja del Excel no coincide con su BC y el sistema coincide con el BC.
- **ER**: 6 explicaciones del BC (tenencia de efectivo) y 4 meses en los que la hoja no coincide con su BC.
  - Cuentas con importe fuera de las líneas: las de Doping 777 (el ER del Excel no las incluye), 849.8880 (ferias,
    solo en el ERE) y las de exportación pendiente de cierre (2900, 2814, 2816).
- **ERD 999**:
  - 14 importes escritos a mano en abril (el Excel no los calcula);
  - 6 explicaciones de tenencia;
  - la participación trimestral de junio, que la plantilla no calcula (fórmula del Excel sobre tres meses);
  - el resto (27) son totales con diferencias explicadas en sus líneas o con líneas que el Excel no tiene.
- **EFE**, a 31/10/2026:

  | | USD |
  |---|---|
  | Saldo inicial (31/03) | 237.596,07 |
  | Explotación | 330.298,69 |
  | Inversión | 84.769,00 |
  | Financiación | −487.964,72 |
  | Efecto de las tasas y saldos migrados | −17.295,58 |
  | **Saldo final** | **147.403,47** |

  El saldo final es el mismo que la línea "Efectivo" del ES.
- **Alertas** a octubre: saldos de las cuentas puente 699.9995/9997/9998 en DM, GR, KEI y KTR desde hace más de dos
  meses. Son las contrapartidas de la migración pendientes de asignar (ver fase 5).

Para repetir la comprobación: `pnpm etl statements-check --from=4 --to=10 [--verbose]`.

## Tests
| Suite | Qué cubre |
|---|---|
| `packages/shared` (17) | Más: fórmulas de las líneas (operaciones, rangos, MIN/MAX/ABS, errores, orden y ciclos), validación del diseñador |
| `packages/etl` (31) | Más: códigos del BC, traducción de totales y participaciones, lectura de una hoja de estado con su comprobación, ES completado (patrimonio y totales corregidos), EFE |
| `packages/db` (51) | Más: ES que cuadra y resultado del ejercicio, ER con total y eliminación intercompañía, EFE por categoría y actividad que concilia, plantilla propia (grupos, MIN, cuenta inexistente), comparación con el Excel (cuadra, diferencia, importe a mano, sin cifra), meses futuros, alerta del puente, panel |
| `apps/api` (32) | Más: plantillas predeterminadas, ES y EFE que cuadran, 404, diseñador (permisos, fórmula mal escrita, ciclo, alta), descarga en Excel, alertas y panel |
| E2E (23) | Más: ES que cuadra con detalle por cuenta, ER y EFE; diseñador (copia, fórmula con error y válida, ver el estado); panel de dirección |

## En producción
Tras el despliegue automático, entra en **Configuración → Importar Excel**, elige *"Añadir lo que falta por
migrar"* y sube el Excel. Como las fases 1–5 ya están, solo importa los estados, en unos 20 segundos. Después:
- **Estados financieros → Estado de situación**: activa "Comparar con el Excel".
- **Dashboard**: el panel de dirección.

## Pendiente / a decidir
- **Cuentas puente 699**: las alertas muestran los saldos pendientes de asignar desde la migración. Hay que
  repartirlos antes del cierre de 2026 (ver fase 5).
- **ER consolidado**: el Excel no incluye Doping (777), ferias (849.8880) ni la exportación pendiente de cierre.
  El sistema lo avisa como "cuentas sin línea". Si se quieren en el ER, se añaden en el diseñador.
- **Participación trimestral** de ERD 999 (fila 65, sobre tres meses): la plantilla no la calcula. Se puede
  escribir en el diseñador como fórmula del mes si se acuerda el criterio.
- **Fase 7**: cierre de la migración y arranque (operación en paralelo, formación, runbook).
