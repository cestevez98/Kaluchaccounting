-- CreateEnum
CREATE TYPE "ExportService" AS ENUM ('GOODS', 'SERVICES');

-- CreateEnum
CREATE TYPE "SalesDocStatus" AS ENUM ('PENDING', 'CLOSED', 'POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ContainerStatus" AS ENUM ('TRANSIT', 'WAREHOUSE', 'CLOSED');

-- CreateEnum
CREATE TYPE "InventoryLocation" AS ENUM ('TRANSIT', 'WAREHOUSE');

-- CreateEnum
CREATE TYPE "InventoryMoveKind" AS ENUM ('COST', 'RECEIPT', 'SALE', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "export_invoice" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "party_account_id" UUID NOT NULL,
    "seller_party_account_id" UUID,
    "number" TEXT NOT NULL,
    "invoice_date" DATE NOT NULL,
    "close_date" DATE,
    "service" "ExportService" NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL,
    "amount_usd" DECIMAL(18,4) NOT NULL,
    "factory_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "logistics_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "other_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "estimated_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "commission_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "status" "SalesDocStatus" NOT NULL DEFAULT 'PENDING',
    "issue_document_id" UUID NOT NULL,
    "close_document_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "export_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'u',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "container" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "ContainerStatus" NOT NULL DEFAULT 'TRANSIT',
    "arrival_date" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "container_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "container_investor" (
    "id" UUID NOT NULL,
    "container_id" UUID NOT NULL,
    "party_account_id" UUID NOT NULL,
    "invested_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "profit_pct" DECIMAL(9,4) NOT NULL,

    CONSTRAINT "container_investor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movement" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "container_id" UUID NOT NULL,
    "product_id" UUID,
    "date" DATE NOT NULL,
    "kind" "InventoryMoveKind" NOT NULL,
    "location" "InventoryLocation" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "amount_usd" DECIMAL(18,4) NOT NULL,
    "description" TEXT NOT NULL,
    "document_id" UUID NOT NULL,
    "sales_line_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoice" (
    "id" UUID NOT NULL,
    "party_account_id" UUID,
    "counter_account_id" UUID,
    "total_usd" DECIMAL(18,4) NOT NULL,
    "cost_usd" DECIMAL(18,4) NOT NULL,
    "commission_usd" DECIMAL(18,4) NOT NULL,
    "onat_usd" DECIMAL(18,4) NOT NULL,
    "onat_rate" DECIMAL(9,6) NOT NULL,
    "status" "SalesDocStatus" NOT NULL DEFAULT 'POSTED',

    CONSTRAINT "sales_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_line" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "container_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price_usd" DECIMAL(18,4) NOT NULL,
    "amount_usd" DECIMAL(18,4) NOT NULL,
    "cost_usd" DECIMAL(18,4) NOT NULL,
    "commission_per_unit_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "commission_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "seller_party_account_id" UUID,
    "onat_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "sales_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "export_invoice_issue_document_id_key" ON "export_invoice"("issue_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "export_invoice_close_document_id_key" ON "export_invoice"("close_document_id");

-- CreateIndex
CREATE INDEX "export_invoice_status_idx" ON "export_invoice"("status");

-- CreateIndex
CREATE UNIQUE INDEX "export_invoice_company_id_number_key" ON "export_invoice"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "product_code_key" ON "product"("code");

-- CreateIndex
CREATE UNIQUE INDEX "container_company_id_code_key" ON "container"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "container_investor_container_id_party_account_id_key" ON "container_investor"("container_id", "party_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movement_sales_line_id_key" ON "inventory_movement"("sales_line_id");

-- CreateIndex
CREATE INDEX "inventory_movement_container_id_product_id_idx" ON "inventory_movement"("container_id", "product_id");

-- CreateIndex
CREATE INDEX "inventory_movement_product_id_date_idx" ON "inventory_movement"("product_id", "date");

-- CreateIndex
CREATE INDEX "sales_line_container_id_idx" ON "sales_line"("container_id");

-- CreateIndex
CREATE INDEX "sales_line_seller_party_account_id_idx" ON "sales_line"("seller_party_account_id");

-- AddForeignKey
ALTER TABLE "export_invoice" ADD CONSTRAINT "export_invoice_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_invoice" ADD CONSTRAINT "export_invoice_party_account_id_fkey" FOREIGN KEY ("party_account_id") REFERENCES "party_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_invoice" ADD CONSTRAINT "export_invoice_seller_party_account_id_fkey" FOREIGN KEY ("seller_party_account_id") REFERENCES "party_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_invoice" ADD CONSTRAINT "export_invoice_issue_document_id_fkey" FOREIGN KEY ("issue_document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_invoice" ADD CONSTRAINT "export_invoice_close_document_id_fkey" FOREIGN KEY ("close_document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container" ADD CONSTRAINT "container_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container_investor" ADD CONSTRAINT "container_investor_container_id_fkey" FOREIGN KEY ("container_id") REFERENCES "container"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container_investor" ADD CONSTRAINT "container_investor_party_account_id_fkey" FOREIGN KEY ("party_account_id") REFERENCES "party_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_container_id_fkey" FOREIGN KEY ("container_id") REFERENCES "container"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_sales_line_id_fkey" FOREIGN KEY ("sales_line_id") REFERENCES "sales_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice" ADD CONSTRAINT "sales_invoice_id_fkey" FOREIGN KEY ("id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice" ADD CONSTRAINT "sales_invoice_party_account_id_fkey" FOREIGN KEY ("party_account_id") REFERENCES "party_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_line" ADD CONSTRAINT "sales_line_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "sales_invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_line" ADD CONSTRAINT "sales_line_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_line" ADD CONSTRAINT "sales_line_container_id_fkey" FOREIGN KEY ("container_id") REFERENCES "container"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_line" ADD CONSTRAINT "sales_line_seller_party_account_id_fkey" FOREIGN KEY ("seller_party_account_id") REFERENCES "party_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Reglas de integridad.
ALTER TABLE export_invoice ADD CONSTRAINT export_invoice_amount_chk CHECK (amount_usd > 0);
ALTER TABLE export_invoice ADD CONSTRAINT export_invoice_costs_chk CHECK (factory_usd >= 0 AND logistics_usd >= 0 AND other_usd >= 0 AND estimated_usd >= 0 AND commission_usd >= 0);
ALTER TABLE export_invoice ADD CONSTRAINT export_invoice_close_chk CHECK ((status = 'CLOSED') = (close_date IS NOT NULL AND close_document_id IS NOT NULL));
ALTER TABLE container_investor ADD CONSTRAINT container_investor_pct_chk CHECK (profit_pct >= 0 AND profit_pct <= 100 AND invested_usd >= 0);
ALTER TABLE sales_line ADD CONSTRAINT sales_line_qty_chk CHECK (quantity > 0 AND unit_price_usd >= 0 AND cost_usd >= 0 AND commission_usd >= 0 AND onat_usd >= 0);

-- Auditoría de las tablas nuevas.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['export_invoice', 'product', 'container', 'container_investor', 'inventory_movement',
    'sales_invoice', 'sales_line']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION trg_audit()', t, t);
  END LOOP;
END $$;
