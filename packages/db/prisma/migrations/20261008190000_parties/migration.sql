-- CreateEnum
CREATE TYPE "PartyKind" AS ENUM ('PERSON', 'COMPANY');

-- CreateEnum
CREATE TYPE "PartyRole" AS ENUM ('CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'PARTNER', 'INVESTOR', 'SELLER', 'COURIER', 'LENDER', 'OTHER');

-- CreateEnum
CREATE TYPE "PartyDocKind" AS ENUM ('CHARGE', 'CREDIT', 'ASSIGNMENT', 'OPENING', 'PAYROLL');

-- CreateEnum
CREATE TYPE "OpenItemSide" AS ENUM ('RECEIVABLE', 'PAYABLE');

-- CreateEnum
CREATE TYPE "OpenItemStatus" AS ENUM ('OPEN', 'PARTIAL', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SettlementKind" AS ENUM ('PAYMENT', 'WRITE_OFF');

-- AlterEnum
ALTER TYPE "EntryKind" ADD VALUE 'RECLASS';

-- AlterTable
ALTER TABLE "cash_category" ADD COLUMN     "party_account_id" UUID;

-- AlterTable
ALTER TABLE "treasury_movement" ADD COLUMN     "party_id" UUID;

-- CreateTable
CREATE TABLE "party" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PartyKind" NOT NULL DEFAULT 'PERSON',
    "roles" "PartyRole"[] DEFAULT ARRAY[]::"PartyRole"[],
    "tax_id" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_account" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "account_id" UUID NOT NULL,
    "opposite_account_id" UUID,
    "name" TEXT NOT NULL,
    "source_sheet" TEXT,
    "source_filter" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "party_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_document" (
    "id" UUID NOT NULL,
    "party_account_id" UUID NOT NULL,
    "kind" "PartyDocKind" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "amount_usd" DECIMAL(18,4) NOT NULL,
    "counter_account_id" UUID,
    "reference" TEXT,
    "due_date" DATE,
    "description" TEXT NOT NULL,
    "entry_id" UUID,

    CONSTRAINT "party_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "open_item" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "party_account_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "side" "OpenItemSide" NOT NULL,
    "reference" TEXT NOT NULL,
    "doc_date" DATE NOT NULL,
    "due_date" DATE,
    "currency" VARCHAR(3) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "amount_usd" DECIMAL(18,4) NOT NULL,
    "open_amount" DECIMAL(18,4) NOT NULL,
    "status" "OpenItemStatus" NOT NULL DEFAULT 'OPEN',
    "description" TEXT NOT NULL,

    CONSTRAINT "open_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement" (
    "id" UUID NOT NULL,
    "open_item_id" UUID NOT NULL,
    "kind" "SettlementKind" NOT NULL DEFAULT 'PAYMENT',
    "payment_document_id" UUID,
    "date" DATE NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "usd_at_booked" DECIMAL(18,4) NOT NULL,
    "usd_at_payment" DECIMAL(18,4) NOT NULL,
    "note" TEXT,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_line" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "employer" TEXT NOT NULL,
    "concept" TEXT NOT NULL,
    "gross" DECIMAL(18,4) NOT NULL,
    "attendance_deduction" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "mipyme_deduction" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "net" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,

    CONSTRAINT "payroll_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign_reclass_run" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "entry_id" UUID,
    "reversal_entry_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "moved_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "sign_reclass_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "party_code_key" ON "party"("code");

-- CreateIndex
CREATE INDEX "party_account_party_id_idx" ON "party_account"("party_id");

-- CreateIndex
CREATE UNIQUE INDEX "party_account_company_id_party_id_currency_account_id_key" ON "party_account"("company_id", "party_id", "currency", "account_id");

-- CreateIndex
CREATE INDEX "party_document_party_account_id_idx" ON "party_document"("party_account_id");

-- CreateIndex
CREATE INDEX "party_document_reference_idx" ON "party_document"("reference");

-- CreateIndex
CREATE INDEX "open_item_document_id_idx" ON "open_item"("document_id");

-- CreateIndex
CREATE INDEX "open_item_party_id_status_idx" ON "open_item"("party_id", "status");

-- CreateIndex
CREATE INDEX "open_item_company_id_side_status_idx" ON "open_item"("company_id", "side", "status");

-- CreateIndex
CREATE INDEX "open_item_reference_idx" ON "open_item"("reference");

-- CreateIndex
CREATE INDEX "settlement_open_item_id_idx" ON "settlement"("open_item_id");

-- CreateIndex
CREATE INDEX "settlement_payment_document_id_idx" ON "settlement"("payment_document_id");

-- CreateIndex
CREATE INDEX "payroll_line_period_idx" ON "payroll_line"("period");

-- CreateIndex
CREATE INDEX "sign_reclass_run_company_id_year_month_idx" ON "sign_reclass_run"("company_id", "year", "month");

-- AddForeignKey
ALTER TABLE "cash_category" ADD CONSTRAINT "cash_category_party_account_id_fkey" FOREIGN KEY ("party_account_id") REFERENCES "party_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_account" ADD CONSTRAINT "party_account_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_account" ADD CONSTRAINT "party_account_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_account" ADD CONSTRAINT "party_account_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_account" ADD CONSTRAINT "party_account_opposite_account_id_fkey" FOREIGN KEY ("opposite_account_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_document" ADD CONSTRAINT "party_document_id_fkey" FOREIGN KEY ("id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_document" ADD CONSTRAINT "party_document_party_account_id_fkey" FOREIGN KEY ("party_account_id") REFERENCES "party_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_item" ADD CONSTRAINT "open_item_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_item" ADD CONSTRAINT "open_item_party_account_id_fkey" FOREIGN KEY ("party_account_id") REFERENCES "party_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_open_item_id_fkey" FOREIGN KEY ("open_item_id") REFERENCES "open_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_line" ADD CONSTRAINT "payroll_line_id_fkey" FOREIGN KEY ("id") REFERENCES "party_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 
-- ── Reglas de contrapartes ──────────────────────────────────────────────────
ALTER TABLE party_document ADD CONSTRAINT party_document_amount_chk CHECK (amount <> 0);
ALTER TABLE party_document ADD CONSTRAINT party_document_rate_chk CHECK (rate > 0);
ALTER TABLE open_item ADD CONSTRAINT open_item_amount_chk CHECK (amount > 0);
ALTER TABLE open_item ADD CONSTRAINT open_item_open_amount_chk CHECK (open_amount >= 0 AND open_amount <= amount);
ALTER TABLE settlement ADD CONSTRAINT settlement_amount_chk CHECK (amount > 0);
ALTER TABLE party_account ADD CONSTRAINT party_account_opposite_chk CHECK (opposite_account_id IS NULL OR opposite_account_id <> account_id);

-- Auditoría de las tablas nuevas.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['party', 'party_account', 'party_document', 'open_item', 'settlement',
    'payroll_line', 'sign_reclass_run']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION trg_audit()', t, t);
  END LOOP;
END $$;
