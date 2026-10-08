# 00 · Análisis del Excel actual

Análisis automático de `Balance de comprobación.xlsx` (6,7 MB, 76 hojas,
65 tablas con nombre), hecho el 08/10/2026. Por seguridad, el fichero **no
se sube al repositorio**: contiene datos financieros y personales. El ETL lo
leerá desde una ruta local ignorada por git (`data/`).

## 1. Volumen y rango de fechas

| Tabla | Filas | Fechas |
|---|---:|---|
| Banco_Emp_Cuba | 18.155 | 2024 → 2026. **Fechas guardadas como número de serie (int) sin formato de fecha**; 1.887 filas sin fecha |
| Efectivo_Caja | 11.462 | 31/12/2025 → 03/10/2026 |
| Distribución_Facturación | 6.127 | 24/04/2025 → 02/10/2026 |
| Banco_Emp_Exterior | 4.702 | 31/12/2025 → 05/10/2026 |
| Banco_Pers_Cuba | 1.830 | 05/08/2025 → 12/09/2026 |
| Deuda_Tropicargo | 1.865 | |
| Deuda_Eduardo_Envíos / _Pagos | 1.683 / 931 | |
| Deuda_Ray | 1.437 | |
| Distribución_Costos | 921 | |
| Tasas | 750 | 27/10/2023 → 08/01/2027 (**las filas futuras tienen tasa 0**) |
| Banco_Pers_Exterior | 659 | 13/11/2023 → 08/09/2026 |
| Exportación_Facturas | 89 | 22/09/2025 → 30/09/2026 |

**Consecuencia:** los datos llegan hasta octubre de 2026. En BC, las columnas
de noviembre y diciembre de 2026 repiten el saldo de octubre. La conciliación
de aceptación se hará sobre **abril–octubre 2026** y se ampliará a
noviembre–diciembre cuando haya datos.

## 2. Cómo calcula hoy el BC (y qué implica para el sistema)

1. **BC es un único balance consolidado del grupo** (no uno por empresa). La
   empresa sale de filtros de texto: `Propietario = "Kaluch Export"`,
   `Empresa = "KEI"`, etc. Las cuentas bancarias personales están en el mismo BC
   (112/113/114).
2. **Cuentas de balance = saldo acumulado** (`FECHA <= fin de mes`).
   **Cuentas de resultados = movimiento del mes** (`>= día 1 y <= fin de mes`).
   El sistema comparará de la misma forma.
3. **Las cuentas monetarias en moneda extranjera se valoran a la tasa de cierre
   del mes:** `saldo en moneda original / tasa del último día del mes`. Cada
   movimiento se convierte a la tasa de su día (columnas `Mov USD`), y la
   diferencia entre ambas valoraciones es la tenencia (hojas `Tenencia_*`).
   Esto es exactamente un **saldo revaluado a cierre**. El motor lo reproduce
   con la revaluación mensual (ver [03](03-motor-contable.md)).
4. **Convención de tasas: `1 USD = X unidades`** (cabecera `Tasa 1USD=`). La
   excepción es `CUP/EUR (OC)`, que va contra EUR. Se adopta la misma convención:
   `importe_usd = importe / tasa`.
5. **Tipo de tasa por cuenta:** caja CUP → `CUP/USD (IC)`, caja EUR →
   `EUR/USD (IC)`, bancos DOP → `DOP/USD (ORD)`… El tipo de tasa de
   revaluación debe configurarse **por cuenta/subcuenta**, no por moneda.
6. **Las CxC/CxP por contraparte se presentan según el signo del saldo neto:**
   `IF(CxC > CxP; CxC − CxP; 0)` en la 135 y la fórmula inversa en la 405. En el
   sistema la contraparte tiene un único saldo, que en los informes se presenta
   en CxC o en CxP según su signo (reclasificación de presentación, no asiento).
7. **Reconocimiento de ingresos:**
   - Exportación: se reconoce en la **fecha de cierre** de la factura. Mientras
     no hay cierre vive en 2900/2814–2816 (pendientes).
   - Distribución: se reconoce en la fecha de la factura, línea a línea.
8. **Segmento dentro de la subcuenta:** varias subcuentas codifican el segmento
   (p. ej. `180.8883`, `1816.8880`), y las filas de control `ING/GAS/UT 777/888/999`
   suman subcuentas concretas. En el sistema el segmento es una dimensión del
   asiento, y se conserva el mapeo subcuenta → segmento para comparar.
9. **Cada cuenta del BC se calcula de forma independiente** (no hay partida
   doble). Por eso Activo ≠ Pasivo + Patrimonio. Al pasar a partida doble
   **algunas diferencias con el Excel serán inevitables y correctas**. El
   reporte de conciliación las clasificará (ver §4).

## 3. Errores y anomalías detectados

| # | Dónde | Problema | Propuesta |
|---|---|---|---|
| 1 | ER (682 celdas), ERD 999 (2) (837), ERE 888 (2) (326), EFE (40) | `#REF!`: la columna que filtraba `Distribución_Facturación[Referencia cruzada]/[Clasificación]` y unas celdas de año/mes de ES fueron borradas | Se resuelve por diseño: los reportes salen del libro mayor |
| 2 | BC fila 7 (`101.0004` Caja CAD) y caja en `Efectivo_Caja[Mov USD]` | El CAD se convierte con la tasa **`MLC/USD (IC)`**, no con `CAD/USD (OUE)` | **Confirmar** si es intencional |
| 3 | Efectivo_Caja (665), Deuda_Tienda (37), Deuda_César_EUR (11)… | `#DIV/0!` por tasa 0 o ausente en `Tasas` | Validación: no se puede contabilizar sin tasa > 0; bandeja de "tasas faltantes" |
| 4 | Tasas | Filas futuras con 0 y, para algunos pares, días sin dato | Búsqueda de la última tasa anterior con antigüedad máxima configurable |
| 5 | BC | Subcuentas duplicadas: `110.3803` (BBVA EUR y Bankinter EUR), `180.8883`, `1816.8880` | **Corregir** códigos antes de migrar |
| 6 | BC | Naturaleza/clasificación incoherentes: `1900` Ventas internas *Deudora/CNA*, `1181` Mercancías *Acreedora/AC*, `1816` *Acreedora/CND* | Revisar al importar el plan de cuentas |
| 7 | Banco_Emp_Cuba | Fechas como enteros de serie Excel; 1.887 filas vacías o sin propietario | El ETL convierte el serial; las filas vacías se descartan con un registro |
| 8 | Distribución_Facturación[Moneda de cobro] | Valores que no son moneda: `1.1`, `0.3`, `1.17`, `4.85`, `0.75`, `TRF CUP` | `TRF CUP` → CUP (transferencia); los numéricos van a la bandeja de revisión |
| 9 | Distribución_Costos[Tipo] | Hay tipos que no están en `Listados`: `Factura de importación`, `Costo 888`, `895` | Ampliar el catálogo de tipos de costo |
| 10 | Banco_Emp_Cuba[Banco] | `Metropolitano` vs `MetropolitanoG`, `Fincimex` vs `Fincimex 7277/8080` | Normalizar a cuenta bancaria por número |
| 11 | Referencia cruzada | Texto libre con variantes (`Seguridad`/`seguridad`, `Financiamiento`/`financiamiento`/`Financiamientos`, `Transferencia devuelta`/`Devuelta`) | Diccionario de normalización y luego catálogo cerrado |
| 12 | Banco_Emp_Cuba | 17.613 de 18.155 filas **sin Referencia cruzada** | Se clasifican por reglas (concepto, contraparte, importe) y el resto va a la bandeja de revisión |
| 13 | ONAT en Distribución_Facturación | Hoy, en CUP: `V = salidas × precio factura`; `ONAT = 0,11·V + 0,35·(V − salidas × costo fiscal − 0,11·V)`, convertido con `CUP/USD (IC)` del día. Es decir, 11 % sobre ventas + 35 % sobre la utilidad fiscal | Los dos tipos (11 % y 35 %) pasan a ser parámetros con vigencia por fecha |
| 14 | Varias Deuda_* | Columnas genéricas (`Columna1`, `Column10..19`) y cabeceras con espacios (`'FECHA '`, `'CLIENTE '`) | Mapeo documentado por tabla en `packages/etl/mappings/*.yaml` |
| 15 | Deuda_UNIR / _Pagos | Tabla "pivotada": un socio por columna (`Column1..13`) | Se despivota a filas (socio, fecha, importe) |

## 4. Catálogo de "Referencia cruzada" (base de la clasificación automática)

Valores más frecuentes:
- **Efectivo_Caja** (64 valores distintos): Ventas Distribución (2.924), Cambio
  (1.989), Deuda Eduardo (1.161), Deuda Dominico (745), *vacío* (693), Ventas
  minoristas (535), Gastos varios (Distribución) (462), Deuda (394), Deuda
  Carlos (335), Despacho (238), Financiamientos (205), Remesas (183), Salario
  triciclo (169)…
- **Banco_Emp_Exterior** (31): Comisión Distribución (1.546), *vacío* (1.363),
  Deuda (971), Comisión Importación (273), Traspaso (191), Deuda Proveedores,
  Impuesto (R17, IT1, I12, IVA), Interés, TSS, INFOTEP…
- **Banco_Emp_Cuba** (16): *vacío* (17.613), Impuesto (216), Traspaso (69),
  Software de Distribución, Alquiler, Comisión Distribución…

Cada valor normalizado se mapeará a un **tipo de documento + cuenta contable +
contraparte**, en una tabla editable (`etl_classification_rule`). Lo que no
encaje con ninguna regla, o encaje con varias, va a la bandeja de revisión
manual.

## 5. Criterio de conciliación con BC (propuesta refinada)

El reporte de diferencias clasificará cada cuenta y mes en:

| Estado | Significado |
|---|---|
| ✅ Cuadra | \|sistema − Excel\| ≤ 0,01 USD |
| 🔵 Diferencia explicada | Causa documentada que viene del Excel (p. ej. el #2 CAD con tasa MLC, una fórmula que omite una tabla o la presentación CxC/CxP con signo) |
| 🟠 Pendiente de clasificar | Movimientos que siguen en la bandeja de revisión |
| 🔴 Diferencia no explicada | Bug del ETL o del motor: bloquea la aceptación |

**Aceptación:** 0 cuentas en rojo y 0 en naranja para abril–octubre de 2026.
Cada diferencia en azul debe tener tu visto bueno explícito.
