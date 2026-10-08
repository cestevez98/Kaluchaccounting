-- CreateEnum
CREATE TYPE "CompanyKind" AS ENUM ('LEGAL', 'PARTNER_POOL');

-- CreateEnum
CREATE TYPE "Dimension" AS ENUM ('CONTAINER', 'PROJECT', 'POS', 'WAREHOUSE');

-- CreateEnum
CREATE TYPE "Nature" AS ENUM ('DEUDORA', 'ACREEDORA', 'MIXTA');

-- CreateEnum
CREATE TYPE "Classification" AS ENUM ('AC', 'PC', 'CC', 'CND', 'CNA');

-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'SOFT_CLOSED', 'LOCKED');

-- CreateEnum
CREATE TYPE "Book" AS ENUM ('BASE', 'REAL', 'FISCAL');

-- CreateEnum
CREATE TYPE "EntryKind" AS ENUM ('AUTO', 'MANUAL', 'REVAL', 'CLOSING', 'OPENING', 'REVERSAL');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateTable
CREATE TABLE "company" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "country" CHAR(2),
    "kind" "CompanyKind" NOT NULL DEFAULT 'LEGAL',
    "consolidates" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segment" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dimension_value" (
    "id" UUID NOT NULL,
    "dimension" "Dimension" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segment_id" UUID,
    "company_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "dimension_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency" (
    "code" VARCHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 2,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "currency_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "rate_type" (
    "code" VARCHAR(8) NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "rate_type_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "exchange_rate" (
    "id" UUID NOT NULL,
    "rate_date" DATE NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "rate_type" VARCHAR(8) NOT NULL,
    "base" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "rate" DECIMAL(20,10) NOT NULL,
    "source" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "exchange_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "parent_id" UUID,
    "code" TEXT NOT NULL,
    "subcode" TEXT,
    "full_code" TEXT NOT NULL,
    "display_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nature" "Nature" NOT NULL,
    "classification" "Classification" NOT NULL,
    "postable" BOOLEAN NOT NULL,
    "currency_lock" VARCHAR(3),
    "reval_rate_type" VARCHAR(8),
    "reval_currency" VARCHAR(3),
    "requires_party" BOOLEAN NOT NULL DEFAULT false,
    "is_intercompany" BOOLEAN NOT NULL DEFAULT false,
    "is_pending_export" BOOLEAN NOT NULL DEFAULT false,
    "default_segment_id" UUID,
    "anomaly" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_mapping" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "company_id" UUID,
    "segment_id" UUID,
    "currency" VARCHAR(3),
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_period" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "fiscal_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entry" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "entry_date" DATE NOT NULL,
    "book" "Book" NOT NULL DEFAULT 'BASE',
    "kind" "EntryKind" NOT NULL,
    "document_id" UUID,
    "reverses_id" UUID,
    "status" "EntryStatus" NOT NULL DEFAULT 'POSTED',
    "memo" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "journal_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_line" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "company_id" UUID NOT NULL,
    "entry_date" DATE NOT NULL,
    "account_id" UUID NOT NULL,
    "segment_id" UUID,
    "party_id" UUID,
    "treasury_account_id" UUID,
    "container_id" UUID,
    "project_id" UUID,
    "pos_id" UUID,
    "counter_company_id" UUID,
    "currency" VARCHAR(3) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "rate_type" VARCHAR(8),
    "amount_usd" DECIMAL(18,4) NOT NULL,
    "cash_flow_category" TEXT,
    "memo" TEXT,

    CONSTRAINT "journal_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_balance" (
    "company_id" UUID NOT NULL,
    "book" "Book" NOT NULL,
    "period_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "account_id" UUID NOT NULL,
    "segment_key" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "debit_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "credit_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "amount_orig" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "ledger_balance_pkey" PRIMARY KEY ("company_id","book","period_id","account_id","segment_key","currency")
);

-- CreateTable
CREATE TABLE "document_sequence" (
    "company_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_sequence_pkey" PRIMARY KEY ("company_id","year","kind")
);

-- CreateTable
CREATE TABLE "parameter" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "parameter_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "parameter_version" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "valid_from" DATE NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "parameter_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "totp_secret" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "system" BOOLEAN NOT NULL DEFAULT false,
    "requires_2fa" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission")
);

-- CreateTable
CREATE TABLE "user_company_role" (
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "user_company_role_pkey" PRIMARY KEY ("user_id","company_id","role_id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "table_name" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "user_id" UUID,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bc_reference" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "full_code" TEXT NOT NULL,
    "excel_row" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "value_usd" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bc_reference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batch" (
    "id" UUID NOT NULL,
    "source_file" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "table_name" TEXT NOT NULL,
    "stats" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_code_key" ON "company"("code");

-- CreateIndex
CREATE UNIQUE INDEX "segment_code_key" ON "segment"("code");

-- CreateIndex
CREATE UNIQUE INDEX "dimension_value_dimension_code_key" ON "dimension_value"("dimension", "code");

-- CreateIndex
CREATE INDEX "exchange_rate_currency_rate_type_rate_date_idx" ON "exchange_rate"("currency", "rate_type", "rate_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rate_rate_date_currency_rate_type_base_key" ON "exchange_rate"("rate_date", "currency", "rate_type", "base");

-- CreateIndex
CREATE UNIQUE INDEX "account_full_code_key" ON "account"("full_code");

-- CreateIndex
CREATE INDEX "account_parent_id_idx" ON "account"("parent_id");

-- CreateIndex
CREATE INDEX "account_code_idx" ON "account"("code");

-- CreateIndex
CREATE INDEX "account_mapping_key_idx" ON "account_mapping"("key");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_period_company_id_year_month_key" ON "fiscal_period"("company_id", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entry_reverses_id_key" ON "journal_entry"("reverses_id");

-- CreateIndex
CREATE INDEX "journal_entry_company_id_entry_date_idx" ON "journal_entry"("company_id", "entry_date");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entry_company_id_number_key" ON "journal_entry"("company_id", "number");

-- CreateIndex
CREATE INDEX "journal_line_company_id_account_id_entry_date_idx" ON "journal_line"("company_id", "account_id", "entry_date");

-- CreateIndex
CREATE INDEX "journal_line_party_id_entry_date_idx" ON "journal_line"("party_id", "entry_date");

-- CreateIndex
CREATE INDEX "journal_line_container_id_idx" ON "journal_line"("container_id");

-- CreateIndex
CREATE INDEX "journal_line_treasury_account_id_entry_date_idx" ON "journal_line"("treasury_account_id", "entry_date");

-- CreateIndex
CREATE UNIQUE INDEX "journal_line_entry_id_line_no_key" ON "journal_line"("entry_id", "line_no");

-- CreateIndex
CREATE INDEX "ledger_balance_year_month_idx" ON "ledger_balance"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "parameter_version_key_valid_from_key" ON "parameter_version"("key", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "role_name_key" ON "role"("name");

-- CreateIndex
CREATE INDEX "audit_log_table_name_record_id_idx" ON "audit_log"("table_name", "record_id");

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- CreateIndex
CREATE UNIQUE INDEX "bc_reference_import_id_excel_row_year_month_key" ON "bc_reference"("import_id", "excel_row", "year", "month");

-- AddForeignKey
ALTER TABLE "segment" ADD CONSTRAINT "segment_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dimension_value" ADD CONSTRAINT "dimension_value_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_mapping" ADD CONSTRAINT "account_mapping_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_period" ADD CONSTRAINT "fiscal_period_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "fiscal_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "journal_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parameter_version" ADD CONSTRAINT "parameter_version_key_fkey" FOREIGN KEY ("key") REFERENCES "parameter"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_company_role" ADD CONSTRAINT "user_company_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_company_role" ADD CONSTRAINT "user_company_role_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_company_role" ADD CONSTRAINT "user_company_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
