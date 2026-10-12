-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('BALANCE', 'INCOME', 'CASHFLOW');

-- CreateEnum
CREATE TYPE "ReportLineSource" AS ENUM ('NONE', 'ACCOUNTS', 'FORMULA', 'RESULT_YTD', 'RESULT_PRIOR', 'UNMAPPED', 'CASH', 'CASH_BALANCE', 'CASH_FX');

-- CreateTable
CREATE TABLE "report_template" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ReportKind" NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "origin" TEXT NOT NULL DEFAULT 'SISTEMA',
    "sheet_name" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "check_coverage" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "report_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_line" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "source" "ReportLineSource" NOT NULL DEFAULT 'NONE',
    "accounts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cash_flow" TEXT,
    "formula" TEXT,
    "negate" BOOLEAN NOT NULL DEFAULT false,
    "indent" INTEGER NOT NULL DEFAULT 0,
    "bold" BOOLEAN NOT NULL DEFAULT false,
    "option" TEXT,
    "excel_row" INTEGER,

    CONSTRAINT "report_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_reference" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "line_key" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "value_usd" DECIMAL(18,4),
    "error" TEXT,
    "excel_check" BOOLEAN,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "import_id" UUID,

    CONSTRAINT "report_reference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_template_code_key" ON "report_template"("code");

-- CreateIndex
CREATE INDEX "report_line_template_id_sort_order_idx" ON "report_line"("template_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "report_line_template_id_key_key" ON "report_line"("template_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "report_reference_template_id_line_key_year_month_key" ON "report_reference"("template_id", "line_key", "year", "month");

-- AddForeignKey
ALTER TABLE "report_line" ADD CONSTRAINT "report_line_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "report_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_reference" ADD CONSTRAINT "report_reference_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "report_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reglas de integridad.
ALTER TABLE report_reference ADD CONSTRAINT report_reference_month_chk CHECK (month BETWEEN 1 AND 12);
ALTER TABLE report_line ADD CONSTRAINT report_line_formula_chk CHECK (source <> 'FORMULA' OR formula IS NOT NULL);

-- Auditoría de los cambios en las plantillas (diseñador de estados).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['report_template', 'report_line']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION trg_audit()', t, t);
  END LOOP;
END $$;
