# 04 · Plan de fases

## Cambio principal respecto a tu propuesta: migración incremental

Propones migrar todo en la fase 7. Recomiendo **migrar y conciliar contra BC
en cada fase, módulo a módulo**. Si la migración se deja para el final, los
problemas de clasificación y de diferencias con el Excel aparecen cuando todo
está construido, y corregirlos obliga a tocar todos los módulos a la vez.
Haciéndolo por módulo:
- en la fase 2 ya conciliamos caja y bancos (101–114) contra el BC real;
- cada fase añade sus cuentas a la conciliación;
- la fase 7 queda en "cierre de la migración": conciliar las cuentas
  restantes, ensayar el corte y hacer el arranque en paralelo.

## Fase 0 · Diseño ✅
- Arquitectura, ERD, motor contable, análisis del Excel y plan.
- Decisiones de negocio registradas en [05](05-decisiones-y-preguntas.md) (08/10/2026).

## Fase 1 · Fundaciones + motor contable ✅
> Completada el 08/10/2026 — ver [fases/fase-1.md](fases/fase-1.md).

- Monorepo, Docker Compose, CI (lint, typecheck, unit, integración con Postgres, E2E).
- Auth (login, 2FA, roles configurables por empresa y por recurso, RLS) y auditoría.
- Empresas (DM, GR, KEI, KTR, KGT y SOC), segmentos jerárquicos (999 → 777, Proyectos),
  dimensiones (PV, almacenes, contenedores).
- **Plan de cuentas importado desde BC** (≈330 cuentas), con árbol editable en
  la UI y las anomalías detectadas marcadas para su corrección.
- Monedas, tipos de tasa, **importación de la hoja `Tasas`** y pantalla de tasas.
- Motor de asientos: asiento manual, validaciones, trigger de cuadre,
  inmutabilidad, anulación, periodos, `ledger_balance`.
- Libro diario y mayor por cuenta con filtros y exportación a Excel.
- **Aceptación:** tests del motor en verde (§8 de [03](03-motor-contable.md)),
  demo con asientos manuales y BC básico.

## Fase 2 · Tesorería + Balance de comprobación ✅
Resumen: [fases/fase-2.md](fases/fase-2.md).
- Cuentas de tesorería (empresa y socios), caja, bancos, categorías (ex
  Referencia cruzada) y mapeos.
- Traspasos y cambios de divisa con la 699 y las diferencias realizadas.
- Importación de extractos CSV/XLSX con idempotencia y **conciliación bancaria**.
- Revaluación mensual (tenencia) para tesorería.
- **BC mensual** (USD y moneda original, por empresa y segmento, con exportación
  Excel/PDF).
- **ETL:** `Efectivo_Caja`, `Banco_Emp_Cuba`, `Banco_Emp_Exterior`,
  `Banco_Pers_Cuba`, `Banco_Pers_Exterior`, `Tenencia_Efectivo` y la bandeja de
  revisión.
- **Saldos de apertura al 31/03/2026** para tesorería (asiento de apertura).
- Entidad `SOC – Tesorería de socios` para las cuentas personales 112/113/114.
- **Staging en el VPS de Hostinger** (`kgtaccounting.com`). Requiere que el
  VPS esté contratado al empezar esta fase.
- **Aceptación:** las cuentas 101 (excepto `101.0004` Caja CAD, omitida), 109–114,
  la parte de efectivo de 846/925 y la parte de "Cambios" de 845/924 concilian
  con BC consolidado en abril–octubre de 2026.

## Fase 3 · Contrapartes, proveedores y nómina ✅
Resumen: [fases/fase-3.md](fases/fase-3.md).
- Contrapartes con roles, cuentas corrientes por moneda, partidas abiertas,
  liquidaciones y estado de cuenta.
- Casos especiales: remesas con plataforma/% (Eduardo, Iván, Roger, Nelson,
  Jhonatan), Tienda, Tropicargo, Zelle Invictus (cesión de deuda), clientes de
  Jorge, Coprove (diferencia cambiaria), UNIR, CxC/CxP generales.
- Proveedores: facturas y pagos, pagos anticipados (146) y transitoria
  banco→proveedor.
- RRHH: nómina, pagos, acreditación Mipyme, reparto Exportación/Distribución y
  prorrateo de comunicación.
- Revaluación de CxC/CxP en moneda extranjera (`Tenencia_CXC`).
- **ETL:** las 27 hojas `Deuda_*` y las 5 `RRHH_*`.
- **Aceptación:** 135, 146, 405–413, 455, 699 y la parte de CxC de 846/925 concilian.

## Fase 4 · Exportación y Distribución
- Facturas de exportación (FOB, costos, comisiones, utilidad, cierre),
  pendientes 2900/2814–2816, facturas internas y ponderación de costos.
- Contenedores, productos por contenedor, costos Real/Fiscal, inventario
  (almacén/tránsito, kardex) y costo identificado por lote.
- Facturación línea a línea con ingreso, costos, comisiones, ONAT
  (parametrizable), parte del inversionista y sobrevaloración 999/888.
- Comisiones por unidad, liquidación semanal por vendedor, ventas a crédito
  (consignado) y cobros.
- Inversionistas: % invertido y de utilidad, cobros y pagos.
- Utilidad por contenedor/Mipyme.
- **ETL:** `Exportación_*`, `Proyectos_Facturación`, `Ponderación_costos`,
  `Distribución_*`, `Crédito_Distribución`.
- **Aceptación:** 136, 137, 139, 180, 181, 1181, 406–408, 410, 412, 430, 800–826
  y 900–901, 1900, 1814–1817, 2900, 2814–2816 concilian, y los totales de
  control ING/GAS/UT 777/888/999 coinciden.

## Fase 5 · Financiamientos, fiscal, capital y cierres
- Préstamos dados y recibidos, calendario, devengo de intereses (842/921),
  cobros y pagos, corto/largo plazo (138/411/520).
- Fiscal: obligaciones por agencia, devengo vs pago, cierre trimestral ONAT y
  anual Hacienda, diferencias a 848/920, gastos acumulados (480).
- Capital: aportes, retiros y distribución de resultados por socio.
- Asistente de cierre mensual, cierre anual y apertura.
- **ETL:** `Financiamientos`, `Deuda_Financiamientos`, `Fiscal_impuestos`,
  `Impuestos_Diferencia`, `Capital`.
- **Aceptación:** todas las cuentas del BC conciliadas o con diferencia explicada.

## Fase 6 · Estados financieros y dashboard
- Diseñador de estructuras de reporte (líneas ↔ cuentas/segmentos), con las
  plantillas ES, ER, ERDop 777, ERE 888, ERD 999 y EFE replicando la estructura
  actual.
- EFE por método directo a partir de `cash_flow_category` de las líneas de tesorería.
- Vistas Real y Fiscal/Presentado.
- Consolidación con eliminaciones e informe de descuadres intercompañía.
- Alertas: A ≠ P + PN, 699 con saldo antiguo, tasas faltantes, saldos
  intercompañía no recíprocos.
- Dashboard: tesorería por moneda, antigüedad de CxC/CxP, utilidad por
  contenedor y mercado, y comisiones pendientes.
- **Aceptación:** ES/ER/EFE reproducen las cifras correctas del Excel donde no
  hay `#REF!`. Donde los hay, cifras derivadas del mayor con tu validación.

## Fase 7 · Cierre de la migración y arranque
- Ejecución completa del ETL sobre el último Excel y reporte de conciliación final.
- Ensayo del corte (fecha de corte, saldos de apertura y congelación del Excel).
- Operación en paralelo durante un mes (Excel + sistema) con conciliación diaria.
- Formación por rol, manual de usuario, runbook de backups y restauración.
- **Aceptación:** reporte de conciliación sin rojos ni naranjas, y tu firma.

## Al final de cada fase
- CI en verde (unit + integración + E2E del flujo principal de la fase).
- Seeds de demo (datos ficticios, nunca los reales).
- `docs/fases/fase-N.md` con lo hecho, decisiones tomadas, pendientes y el
  reporte de conciliación parcial.
- Demo navegable en staging.
