-- CreateEnum
CREATE TYPE "LoanDirection" AS ENUM ('GIVEN', 'RECEIVED');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "TaxAgency" AS ENUM ('ONAT', 'HACIENDA');

-- CreateEnum
CREATE TYPE "TaxDocKind" AS ENUM ('ACCRUAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CapitalMoveKind" AS ENUM ('CONTRIBUTION', 'WITHDRAWAL', 'DISTRIBUTION');

-- CreateTable
CREATE TABLE "loan" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "party_account_id" UUID NOT NULL,
    "direction" "LoanDirection" NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "principal_usd" DECIMAL(18,4) NOT NULL,
    "rate_pct" DECIMAL(9,4) NOT NULL,
    "interest_usd" DECIMAL(18,4) NOT NULL,
    "long_term_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "migrated" BOOLEAN NOT NULL DEFAULT false,
    "document_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_accrual" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "amount_usd" DECIMAL(18,4) NOT NULL,
    "document_id" UUID NOT NULL,

    CONSTRAINT "loan_accrual_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_document" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "agency" "TaxAgency" NOT NULL,
    "kind" "TaxDocKind" NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "amount_usd" DECIMAL(18,4) NOT NULL,
    "declared_usd" DECIMAL(18,4),
    "accrued_usd" DECIMAL(18,4),

    CONSTRAINT "tax_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capital_movement" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "kind" "CapitalMoveKind" NOT NULL,
    "amount_usd" DECIMAL(18,4) NOT NULL,
    "counter_account_id" UUID NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "capital_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "year_close" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "entry_ids" UUID[],
    "result_usd" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "year_close_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loan_document_id_key" ON "loan"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "loan_company_id_reference_key" ON "loan"("company_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "loan_accrual_document_id_key" ON "loan_accrual"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "loan_accrual_loan_id_year_month_key" ON "loan_accrual"("loan_id", "year", "month");

-- CreateIndex
CREATE INDEX "tax_document_company_id_agency_period_from_idx" ON "tax_document"("company_id", "agency", "period_from");

-- CreateIndex
CREATE INDEX "capital_movement_party_id_idx" ON "capital_movement"("party_id");

-- CreateIndex
CREATE UNIQUE INDEX "year_close_company_id_year_key" ON "year_close"("company_id", "year");

-- AddForeignKey
ALTER TABLE "loan" ADD CONSTRAINT "loan_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan" ADD CONSTRAINT "loan_party_account_id_fkey" FOREIGN KEY ("party_account_id") REFERENCES "party_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan" ADD CONSTRAINT "loan_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_accrual" ADD CONSTRAINT "loan_accrual_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_accrual" ADD CONSTRAINT "loan_accrual_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_document" ADD CONSTRAINT "tax_document_id_fkey" FOREIGN KEY ("id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_movement" ADD CONSTRAINT "capital_movement_id_fkey" FOREIGN KEY ("id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_movement" ADD CONSTRAINT "capital_movement_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "year_close" ADD CONSTRAINT "year_close_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Reglas de integridad.
ALTER TABLE loan ADD CONSTRAINT loan_amounts_chk CHECK (principal_usd > 0 AND rate_pct >= 0 AND interest_usd >= 0 AND long_term_usd >= 0);
ALTER TABLE loan ADD CONSTRAINT loan_dates_chk CHECK (end_date IS NULL OR end_date >= start_date);
ALTER TABLE loan_accrual ADD CONSTRAINT loan_accrual_month_chk CHECK (month BETWEEN 1 AND 12);
ALTER TABLE tax_document ADD CONSTRAINT tax_document_period_chk CHECK (period_to >= period_from);
ALTER TABLE capital_movement ADD CONSTRAINT capital_movement_amount_chk CHECK (amount_usd > 0);

-- Auditoría de las tablas nuevas.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['loan', 'loan_accrual', 'tax_document', 'capital_movement', 'year_close']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION trg_audit()', t, t);
  END LOOP;
END $$;
