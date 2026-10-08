# 02 · Modelo de datos (ERD)

Convenciones:
- PK `id UUID` (v7, ordenable por tiempo) en todas las tablas.
- Importes `NUMERIC(18,4)`, tasas `NUMERIC(20,10)`, porcentajes `NUMERIC(9,6)`.
- Todas las tablas de negocio llevan `company_id`, `created_at`, `created_by`,
  `updated_at` y `updated_by`.
- Los documentos tienen estado `DRAFT → POSTED → VOIDED`. Un documento `POSTED`
  es inmutable y para corregirlo se anula (contra-asiento) y se crea uno nuevo.
- Los nombres de tabla y columna van en inglés (convención técnica). Todo lo
  visible en la UI va en español.

Para que sea legible, el ERD se divide en 6 diagramas.

## 1. Núcleo: organización, monedas y libro mayor

```mermaid
erDiagram
  company ||--o{ fiscal_period : tiene
  company ||--o{ journal_entry : registra
  segment ||--o{ journal_line : clasifica
  account ||--o{ account : "padre de"
  account ||--o{ journal_line : imputa
  journal_entry ||--|{ journal_line : contiene
  journal_entry |o--o| journal_entry : "anula a"
  fiscal_period ||--o{ journal_entry : contiene
  document ||--o{ journal_entry : genera
  currency ||--o{ journal_line : "moneda original"
  rate_type ||--o{ exchange_rate : tipo
  currency ||--o{ exchange_rate : "1 USD = X"
  party |o--o{ journal_line : contraparte
  dimension_value |o--o{ journal_line : "contenedor/proyecto/PV"
  ledger_balance }o--|| account : saldo

  company {
    uuid id PK
    string code "DM, GR, KEI, KTR, KGT, SOC"
    string legal_name
    string section "Distribución | Exportación"
    string country "CU | DO | ES"
    string kind "LEGAL | PARTNER_POOL"
    bool consolidates
  }
  segment {
    uuid id PK
    uuid parent_id FK "777 y PRJ-* cuelgan de 999"
    string code "777 | 888 | 999 | PRJ-*"
    string name
  }
  dimension_value {
    uuid id PK
    string dimension "CONTAINER | PROJECT | POS | WAREHOUSE | MIPYME"
    string code "p.ej. 1ra y 12, ITM, C-045"
    string name
    uuid segment_id FK "segmento por defecto"
  }
  currency {
    string code PK "USD CUP MLC EUR DOP CAD GBP"
    int decimals
  }
  rate_type {
    string code PK "OC | IC | OUE | ORD"
    string name "Oficial, Informal, ..."
  }
  exchange_rate {
    date rate_date
    string currency FK
    string rate_type FK
    string base "USD (salvo CUP/EUR)"
    numeric rate "20,10 · 1 base = rate unidades"
    string source
  }
  account {
    uuid id PK
    uuid parent_id FK
    string code "101"
    string subcode "0001"
    string full_code "101.0001 (único)"
    string name
    string nature "DEUDORA | ACREEDORA | MIXTA"
    string classification "AC PC CC CND CNA"
    bool postable "solo hojas"
    string currency_lock "null = cualquiera"
    string reval_rate_type "IC/OC/ORD… null = no monetaria"
    bool requires_party
    bool is_intercompany "1900, 1814-1817, 696"
    bool is_pending_export "2900, 2814-2816"
    uuid default_segment_id
    bool active
  }
  fiscal_period {
    uuid id PK
    uuid company_id FK
    int year
    int month "0 = apertura, 13 = cierre"
    string status "OPEN | SOFT_CLOSED | LOCKED"
  }
  journal_entry {
    uuid id PK
    uuid company_id FK
    uuid period_id FK
    string number "KEI-2026-000123"
    date entry_date
    string book "BASE | REAL | FISCAL"
    string kind "AUTO | MANUAL | REVAL | CLOSING | OPENING | REVERSAL"
    uuid document_id FK
    uuid reverses_id FK
    string status "POSTED | REVERSED"
    string memo
  }
  journal_line {
    uuid id PK
    uuid entry_id FK
    int line_no
    uuid account_id FK
    uuid segment_id FK
    uuid party_id FK
    uuid treasury_account_id FK
    uuid container_id FK
    uuid project_id FK
    uuid pos_id FK
    uuid counter_company_id FK "intercompañía"
    string currency FK
    numeric amount "orig · + Debe / − Haber"
    numeric rate
    string rate_type FK
    numeric amount_usd "+ Debe / − Haber"
    string cash_flow_category "EFE: OPER/INV/FIN"
    string memo
  }
  ledger_balance {
    uuid company_id
    string book
    uuid period_id
    uuid account_id
    uuid segment_id
    string currency
    numeric debit_usd
    numeric credit_usd
    numeric amount_orig
  }
  document {
    uuid id PK
    uuid company_id FK
    string doc_type
    string number
    date doc_date
    string status "DRAFT POSTED VOIDED"
    uuid source_import_row_id FK "trazabilidad ETL"
  }
```

**Restricciones clave (SQL en migraciones):**
- `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`: al hacer COMMIT, cada
  asiento debe cumplir `SUM(amount_usd) = 0`.
- `CHECK (sign(amount) = sign(amount_usd) OR amount = 0)`.
- Solo se puede imputar a cuentas `postable = true`. Si la cuenta tiene
  `requires_party`, la línea debe llevar `party_id`.
- No se puede contabilizar en un periodo `LOCKED`. En uno `SOFT_CLOSED`, solo el rol Contador.
- `journal_entry`/`journal_line` con estado POSTED: cualquier `UPDATE`/`DELETE`
  se rechaza.
- Índices: `journal_line (company_id, account_id, entry_date)`,
  `(party_id, entry_date)`, `(container_id)`, `(treasury_account_id, entry_date)`.
  `company_id` y `entry_date` se desnormalizan en `journal_line` para que estos
  índices funcionen.
- `exchange_rate`: única por `(rate_date, currency, rate_type, base)`.

> **Por qué `document` como supertipo.** Cada módulo tiene su tabla de detalle
> (`cash_movement`, `sales_invoice`…) con `id` = `document.id` (1:1). Así
> cualquier pago puede apuntar con FK a cualquier documento que liquida
> (`settlement`), la auditoría es uniforme y la trazabilidad "asiento → documento
> → fila del Excel de origen" es directa.

## 2. Tesorería

```mermaid
erDiagram
  treasury_account ||--o{ cash_movement : registra
  treasury_account }o--|| account : "cuenta contable"
  treasury_account }o--o| party : "titular socio"
  cash_movement }o--o| party : contraparte
  transfer ||--|| cash_movement : "pata salida"
  transfer ||--|| cash_movement : "pata entrada"
  bank_statement ||--|{ bank_statement_line : contiene
  bank_statement_line |o--o| cash_movement : concilia
  treasury_account ||--o{ bank_statement : importa

  treasury_account {
    uuid id PK
    uuid company_id FK "empresa cuyo libro la registra"
    string kind "CASH | BANK | WALLET (Tropipay, Stripe, Zelle)"
    string owner_type "COMPANY | PARTNER"
    uuid owner_party_id FK "socio titular"
    string country
    string bank "BHD, Reservas, Metropolitano, Bandec…"
    string account_number "cifrado"
    string last4 "= subcuenta"
    string currency FK
    uuid gl_account_id FK
  }
  cash_movement {
    uuid id PK "= document.id"
    uuid treasury_account_id FK
    date value_date
    string direction "IN | OUT"
    numeric amount
    string currency
    string category "catálogo (ex Referencia cruzada)"
    uuid counter_account_id FK "contrapartida si es simple"
    uuid party_id FK
    uuid segment_id FK
    uuid pos_id FK
    string description
  }
  transfer {
    uuid id PK "= document.id"
    string kind "TRANSFER | FX_EXCHANGE"
    uuid out_movement_id FK
    uuid in_movement_id FK
    numeric fee
    string fx_bucket "CAMBIOS | TRASPASOS"
  }
  bank_statement {
    uuid id PK
    uuid treasury_account_id FK
    date date_from
    date date_to
    numeric opening_balance
    numeric closing_balance
    string file_hash
  }
  bank_statement_line {
    uuid id PK
    date value_date
    numeric amount
    string description
    string line_hash "idempotencia"
    string status "UNMATCHED | MATCHED | IGNORED"
  }
```

## 3. Contrapartes, deudas y liquidaciones

```mermaid
erDiagram
  party ||--o{ party_role : desempeña
  party ||--o{ party_account : "cuenta corriente"
  party_account }o--|| account : "135/405/136/137/408…"
  party ||--o{ remittance : envía
  remittance }o--o| platform : via
  open_item ||--o{ settlement : "liquidado por"
  settlement }o--|| document : "pago/cobro"
  document ||--o| open_item : "crea partida abierta"

  party {
    uuid id PK
    string kind "PERSON | COMPANY"
    string name
    string tax_id
    uuid group_company_id FK "si es empresa del grupo"
  }
  party_role {
    uuid party_id FK
    string role "CUSTOMER SUPPLIER EMPLOYEE PARTNER INVESTOR SELLER GESTOR IMPORTER COURIER LENDER"
  }
  party_account {
    uuid id PK
    uuid company_id FK
    uuid party_id FK
    string currency FK
    uuid receivable_account_id FK
    uuid payable_account_id FK
    numeric default_platform_pct
  }
  platform {
    uuid id PK
    string name "Zelle, Tropipay, Western…"
    numeric default_pct
  }
  remittance {
    uuid id PK "= document.id"
    uuid party_id FK "Eduardo, Iván, Roger…"
    numeric amount_received
    string currency
    uuid platform_id FK
    numeric platform_pct
    numeric courier_fee
    numeric amount_to_deliver
    string deliver_currency
  }
  open_item {
    uuid id PK
    uuid document_id FK "factura, deuda, nómina…"
    uuid party_id FK
    string side "RECEIVABLE | PAYABLE"
    string currency
    numeric amount
    numeric amount_usd_booked
    date due_date
    numeric open_amount "materializado"
  }
  settlement {
    uuid id PK
    uuid open_item_id FK
    uuid payment_document_id FK
    numeric amount_applied "moneda de la partida"
    numeric usd_applied_at_booked
    numeric usd_applied_at_payment
    numeric realized_fx "→ 845/924"
  }
```

- **Partidas abiertas (`open_item`)** sustituyen a la "Referencia cruzada" como
  vínculo real: una factura crea una partida abierta y cada pago la liquida
  (total o parcial) con FK.
- **Zelle Invictus (traspaso de deuda entre personas):** es un documento
  `DEBT_ASSIGNMENT` que cancela la partida con Adrián y abre otra con Luiso.
- **UNIR:** contraparte de rol PARTNER con cuenta 413 (deuda con socios) y
  pagos anticipados 146.

## 4. Exportación

```mermaid
erDiagram
  export_invoice ||--o{ export_cost : costos
  export_invoice ||--o{ export_commission : comisiones
  export_invoice ||--o| open_item : "CxC 136"
  export_invoice }o--|| party : cliente
  export_invoice }o--o| party : importadora
  export_invoice }o--o| export_invoice : "factura interna espejo"
  supplier_invoice ||--o{ cost_allocation : prorrateo
  cost_allocation }o--o| export_invoice : "imputa a"
  supplier_invoice ||--o| open_item : "CxP 406/407/408/409"

  export_invoice {
    uuid id PK "= document.id"
    uuid issuer_company_id FK "KEI/KTR/KGT"
    uuid customer_party_id FK
    uuid importer_party_id FK
    string service_type "Exp. de productos | servicio"
    string invoice_no
    date invoice_date
    numeric fob_value
    string currency
    numeric total
    numeric total_usd
    date closing_date "reconoce ingreso"
    string status "OPEN | CLOSED | CANCELLED"
    bool is_intercompany
    uuid buyer_company_id FK "si cliente = DM/GR"
  }
  export_cost {
    uuid id PK
    uuid export_invoice_id FK
    string cost_type "FABRICA LOGISTICA OTROS FACIMPEX"
    uuid supplier_invoice_id FK
    numeric amount_usd
  }
  export_commission {
    uuid id PK
    uuid export_invoice_id FK
    string kind "COMERCIAL_IMPORTADORA | COMERCIAL | VENDEDOR"
    uuid party_id FK
    numeric amount_usd
  }
  supplier_invoice {
    uuid id PK "= document.id"
    uuid supplier_party_id FK
    string invoice_no
    string category "Fábrica, Logística…"
    string currency
    numeric total
  }
  cost_allocation {
    uuid id PK
    uuid supplier_invoice_id FK
    uuid product_id FK
    numeric units
    numeric pct_units
    numeric unit_cost
    numeric amount_usd
  }
```

## 5. Distribución, inventario e inversionistas

```mermaid
erDiagram
  container ||--|{ container_product : contiene
  product ||--o{ container_product : en
  container ||--o{ container_cost : costos
  container_product ||--o{ stock_move : kardex
  warehouse ||--o{ stock_move : ubicación
  sales_invoice ||--|{ sales_line : líneas
  sales_line }o--|| container_product : "sale de lote"
  sales_line ||--o{ commission_accrual : genera
  commission_accrual }o--o| commission_settlement : "liquida (semanal)"
  container ||--o{ investment : financian
  investment }o--|| party : inversionista
  investment ||--o{ investor_flow : "cobros/pagos"
  consignment ||--o{ sales_line : "crédito"

  container {
    uuid id PK
    string code
    uuid mipyme_company_id FK "DM/GR"
    uuid export_invoice_id FK "origen 888"
    string status "TRANSIT | WAREHOUSE | CLOSED"
    bool fiscal_tracked
  }
  container_product {
    uuid id PK
    uuid container_id FK
    uuid product_id FK
    numeric qty_in
    numeric cost_999_usd "real"
    numeric cost_888_usd "transferencia interna"
    numeric other_costs_usd
    numeric fiscal_cost
    numeric fiscal_sale_price
    numeric commission_gestor_cup
    numeric commission_office_cup
    numeric commission_sales_cup
    numeric commission_gestor_usd
    bool closed
  }
  container_cost {
    uuid id PK
    uuid container_id FK
    uuid product_id FK "opcional"
    string cost_type "FACTURA_COMPRA FACTURA_IMPORTACION MARGEN ARANCELES TRANSPORTE MONTACARGAS ESTIBA COSTO_888"
    string version "REAL | FISCAL"
    numeric amount
    string currency
    numeric amount_usd
    date paid_date
  }
  stock_move {
    uuid id PK
    uuid container_product_id FK
    uuid warehouse_id FK
    date move_date
    string kind "IN TRANSFER SALE RETURN SHRINKAGE PROMO"
    numeric qty
    numeric unit_cost_usd
  }
  sales_invoice {
    uuid id PK "= document.id"
    uuid company_id FK "DM/GR"
    string invoice_no
    uuid customer_party_id FK
    uuid seller_party_id FK
    uuid pos_id FK
    date invoice_date
    string collection_currency
    bool on_credit
  }
  sales_line {
    uuid id PK
    uuid sales_invoice_id FK
    uuid container_product_id FK
    string line_kind "SALE RETURN SHRINKAGE PROMO EXPENSE"
    numeric qty_out
    numeric qty_in
    numeric sale_price
    numeric invoice_price "fiscal"
    numeric revenue_usd
    numeric cost_999_usd
    numeric other_costs_usd
    numeric commission_usd
    numeric onat_usd
    numeric investor_share_usd
    numeric profit_usd
    numeric cost_888_usd
  }
  investment {
    uuid id PK
    uuid container_id FK
    uuid investor_party_id FK
    numeric invested_amount
    string currency
    numeric pct_invested
    numeric pct_profit
    date due_collect_date
    string status
  }
```

`sales_line` **guarda** los importes calculados (ingreso, costos, ONAT, utilidad)
en el momento de contabilizar, con la versión de los parámetros usados. Así un
cambio posterior de parámetros no reescribe el pasado.

## 6. Financiamientos, RRHH, fiscal, capital, revaluación, ETL, seguridad

```mermaid
erDiagram
  loan ||--o{ loan_flow : movimientos
  loan ||--o{ loan_accrual : devengos
  employee ||--o{ payroll_line : cobra
  payroll_run ||--|{ payroll_line : contiene
  payroll_line ||--o| open_item : "455 nómina por pagar"
  allocation_rule ||--|{ allocation_share : reparte
  tax_obligation ||--o{ tax_accrual : devenga
  tax_obligation ||--o{ tax_period_close : cierra
  equity_movement }o--|| party : socio
  fx_revaluation_run ||--|{ fx_revaluation_line : detalle
  fx_revaluation_run ||--|| journal_entry : asiento
  import_batch ||--|{ import_row : filas
  import_row ||--o| review_item : "si no clasifica"
  app_user ||--o{ user_company_role : tiene
  role ||--o{ user_company_role : asignado
  role ||--|{ role_permission : incluye
  app_user ||--o{ user_resource_scope : "acotado a"
  audit_log }o--|| app_user : autor
  parameter ||--o{ parameter_version : vigencias

  loan {
    uuid id PK "= document.id"
    string direction "GIVEN (G) | RECEIVED (I)"
    uuid party_id FK
    numeric principal
    numeric rate_pct
    string currency
    date start_date
    date end_date
    string term "CORTO 138/411 | LARGO 520"
  }
  payroll_run {
    uuid id PK
    uuid company_id FK
    date period_date
  }
  payroll_line {
    uuid id PK
    uuid employee_id FK
    numeric gross
    numeric attendance_discount
    numeric mipyme_salary_discount
    numeric net
    string currency
    numeric pct_export
    numeric pct_distribution
  }
  allocation_rule {
    uuid id PK
    string name "Comunicación, Salario compartido"
  }
  tax_obligation {
    uuid id PK
    string agency "ONAT | DGII | HACIENDA"
    string tax_code "R17, IT1, I12, IVA, TSS, INFOTEP…"
    string periodicity "MENSUAL | TRIMESTRAL | ANUAL"
  }
  equity_movement {
    uuid id PK "= document.id"
    string kind "APORTE | RETIRO | DISTRIBUCION"
    uuid partner_party_id FK
    numeric amount_usd
  }
  fx_revaluation_run {
    uuid id PK
    uuid company_id FK
    uuid period_id FK
    string status
  }
  fx_revaluation_line {
    uuid account_id FK
    uuid party_id FK
    string currency
    numeric balance_orig
    numeric booked_usd
    numeric closing_rate
    numeric revalued_usd
    numeric diff_usd "→ 846/925"
  }
  import_batch {
    uuid id PK
    string source_file
    string file_hash
    string table_name "Efectivo_Caja…"
  }
  import_row {
    uuid id PK
    int excel_row
    jsonb raw
    jsonb normalized
    string status "OK REVIEW SKIPPED ERROR"
    uuid document_id FK
  }
  review_item {
    uuid id PK
    string reason
    uuid resolved_by FK
  }
  role {
    uuid id PK
    string name "Superadministrador, Cajero, Conciliador, Fiscal…"
    bool system "roles semilla no borrables"
  }
  role_permission {
    uuid role_id FK
    string permission "cash:post, bank:reconcile, period:lock…"
  }
  user_company_role {
    uuid user_id FK
    uuid company_id FK
    uuid role_id FK
  }
  user_resource_scope {
    uuid user_id FK
    string resource_type "TREASURY_ACCOUNT | SELLER | WAREHOUSE"
    uuid resource_id
  }
  audit_log {
    bigint id PK
    string table_name
    uuid record_id
    string action
    jsonb before
    jsonb after
    uuid user_id FK
    timestamptz at
  }
  parameter {
    string key PK "onat.rate_on_invoice = 0.11"
  }
  parameter_version {
    string key FK
    date valid_from
    jsonb value
  }
```

## 7. Parámetros con vigencia

Los valores que hoy están escritos dentro de las fórmulas (ONAT 11 %, % de
plataforma por defecto, tasa usada por cada cuenta…) van a `parameter` +
`parameter_version` con fecha de vigencia. Cada cálculo usa la versión vigente
en la fecha del documento y guarda cuál usó.
