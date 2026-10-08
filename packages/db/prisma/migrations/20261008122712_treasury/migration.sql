-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'POSTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "TreasuryKind" AS ENUM ('CASH', 'BANK', 'WALLET');

-- CreateEnum
CREATE TYPE "OwnerType" AS ENUM ('COMPANY', 'PARTNER');

-- CreateEnum
CREATE TYPE "CategoryKind" AS ENUM ('INCOME', 'EXPENSE', 'EXCHANGE', 'TRANSFER', 'DEBT', 'OTHER');

-- CreateEnum
CREATE TYPE "MovementKind" AS ENUM ('MOVEMENT', 'EXCHANGE', 'TRANSFER', 'OPENING');

-- CreateEnum
CREATE TYPE "StatementLineStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'IGNORED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('OK', 'REVIEW', 'SKIPPED', 'ERROR');

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "doc_type" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "doc_date" DATE NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'POSTED',
    "memo" TEXT NOT NULL,
    "import_row_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_account" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "gl_account_id" UUID NOT NULL,
    "kind" "TreasuryKind" NOT NULL,
    "owner_type" "OwnerType" NOT NULL DEFAULT 'COMPANY',
    "owner_name" TEXT,
    "country" TEXT,
    "bank" TEXT,
    "last4" TEXT,
    "currency" VARCHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "source_sheet" TEXT,
    "source_filter" JSONB,
    "created_by_etl" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasury_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_category" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "CategoryKind" NOT NULL,
    "account_id" UUID,
    "segment_id" UUID,
    "cash_flow_category" TEXT NOT NULL DEFAULT 'OPER',
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "cash_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_movement" (
    "id" UUID NOT NULL,
    "kind" "MovementKind" NOT NULL,
    "category_id" UUID,
    "counter_account_id" UUID,
    "segment_id" UUID,
    "pos_id" UUID,
    "description" TEXT NOT NULL,
    "source_reference" TEXT,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "review_note" TEXT,
    "resolved_at" TIMESTAMPTZ,
    "resolved_by" UUID,
    "entry_id" UUID,

    CONSTRAINT "treasury_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_leg" (
    "id" UUID NOT NULL,
    "movement_id" UUID NOT NULL,
    "treasury_account_id" UUID NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "amount_usd" DECIMAL(18,4) NOT NULL,
    "value_date" DATE NOT NULL,

    CONSTRAINT "treasury_leg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement" (
    "id" UUID NOT NULL,
    "treasury_account_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "date_from" DATE,
    "date_to" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "bank_statement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_line" (
    "id" UUID NOT NULL,
    "statement_id" UUID NOT NULL,
    "treasury_account_id" UUID NOT NULL,
    "value_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "line_hash" TEXT NOT NULL,
    "status" "StatementLineStatus" NOT NULL DEFAULT 'UNMATCHED',
    "leg_id" UUID,

    CONSTRAINT "bank_statement_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_revaluation_run" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "entry_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "total_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "fx_revaluation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_revaluation_line" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "rate_type" TEXT NOT NULL,
    "balance_orig" DECIMAL(18,4) NOT NULL,
    "booked_usd" DECIMAL(18,4) NOT NULL,
    "closing_rate" DECIMAL(20,10) NOT NULL,
    "revalued_usd" DECIMAL(18,4) NOT NULL,
    "diff_usd" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "fx_revaluation_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_row" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "sheet" TEXT NOT NULL,
    "excel_row" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "status" "ImportRowStatus" NOT NULL,
    "message" TEXT,

    CONSTRAINT "import_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bc_explanation" (
    "id" UUID NOT NULL,
    "full_code" TEXT NOT NULL,
    "year" INTEGER,
    "month" INTEGER,
    "reason" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bc_explanation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_import_row_id_key" ON "document"("import_row_id");

-- CreateIndex
CREATE INDEX "document_company_id_doc_date_idx" ON "document"("company_id", "doc_date");

-- CreateIndex
CREATE UNIQUE INDEX "document_company_id_number_key" ON "document"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "treasury_account_gl_account_id_key" ON "treasury_account"("gl_account_id");

-- CreateIndex
CREATE INDEX "treasury_account_company_id_idx" ON "treasury_account"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_category_code_key" ON "cash_category"("code");

-- CreateIndex
CREATE INDEX "treasury_movement_needs_review_idx" ON "treasury_movement"("needs_review");

-- CreateIndex
CREATE INDEX "treasury_leg_treasury_account_id_value_date_idx" ON "treasury_leg"("treasury_account_id", "value_date");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_line_leg_id_key" ON "bank_statement_line"("leg_id");

-- CreateIndex
CREATE INDEX "bank_statement_line_treasury_account_id_status_idx" ON "bank_statement_line"("treasury_account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_line_treasury_account_id_line_hash_key" ON "bank_statement_line"("treasury_account_id", "line_hash");

-- CreateIndex
CREATE INDEX "fx_revaluation_run_company_id_year_month_idx" ON "fx_revaluation_run"("company_id", "year", "month");

-- CreateIndex
CREATE INDEX "import_row_status_idx" ON "import_row"("status");

-- CreateIndex
CREATE UNIQUE INDEX "import_row_sheet_excel_row_batch_id_key" ON "import_row"("sheet", "excel_row", "batch_id");

-- CreateIndex
CREATE INDEX "bc_explanation_full_code_idx" ON "bc_explanation"("full_code");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_account" ADD CONSTRAINT "treasury_account_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_account" ADD CONSTRAINT "treasury_account_gl_account_id_fkey" FOREIGN KEY ("gl_account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_category" ADD CONSTRAINT "cash_category_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_movement" ADD CONSTRAINT "treasury_movement_id_fkey" FOREIGN KEY ("id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_movement" ADD CONSTRAINT "treasury_movement_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "cash_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_leg" ADD CONSTRAINT "treasury_leg_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "treasury_movement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_leg" ADD CONSTRAINT "treasury_leg_treasury_account_id_fkey" FOREIGN KEY ("treasury_account_id") REFERENCES "treasury_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement" ADD CONSTRAINT "bank_statement_treasury_account_id_fkey" FOREIGN KEY ("treasury_account_id") REFERENCES "treasury_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_line" ADD CONSTRAINT "bank_statement_line_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "bank_statement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_line" ADD CONSTRAINT "bank_statement_line_leg_id_fkey" FOREIGN KEY ("leg_id") REFERENCES "treasury_leg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fx_revaluation_line" ADD CONSTRAINT "fx_revaluation_line_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "fx_revaluation_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Reglas de tesorería ─────────────────────────────────────────────────────
ALTER TABLE treasury_leg ADD CONSTRAINT treasury_leg_amount_chk CHECK (amount <> 0);
ALTER TABLE treasury_leg ADD CONSTRAINT treasury_leg_rate_chk CHECK (rate > 0);

-- Auditoría de las tablas nuevas.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document', 'treasury_account', 'cash_category', 'treasury_movement',
    'fx_revaluation_run', 'bank_statement', 'bank_statement_line', 'bc_explanation']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION trg_audit()', t, t);
  END LOOP;
END $$;
