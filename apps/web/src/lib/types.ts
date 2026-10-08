export interface Account {
  id: string;
  parentId: string | null;
  code: string;
  subcode: string | null;
  fullCode: string;
  displayCode: string;
  name: string;
  nature: 'DEUDORA' | 'ACREEDORA' | 'MIXTA';
  classification: 'AC' | 'PC' | 'CC' | 'CND' | 'CNA';
  postable: boolean;
  currencyLock: string | null;
  revalRateType: string | null;
  isIntercompany: boolean;
  isPendingExport: boolean;
  anomaly: string | null;
  active: boolean;
}

export interface Segment {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
}

export interface DimensionValue {
  id: string;
  dimension: 'CONTAINER' | 'PROJECT' | 'POS' | 'WAREHOUSE';
  code: string;
  name: string;
}

export interface Paged<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

export interface EntrySummary {
  id: string;
  number: string;
  entryDate: string;
  companyCode: string;
  memo: string;
  kind: string;
  book: string;
  status: 'POSTED' | 'REVERSED';
  totalUsd: string;
}

export interface EntryDetail extends Omit<EntrySummary, 'companyCode' | 'totalUsd'> {
  companyId: string;
  createdAt: string;
  company: { code: string; legalName: string };
  reverses: { id: string; number: string } | null;
  reversedBy: { id: string; number: string } | null;
  lines: {
    id: string;
    lineNo: number;
    account: { displayCode: string; name: string };
    currency: string;
    amount: string;
    rate: string;
    rateType: string | null;
    amountUsd: string;
    memo: string | null;
  }[];
}

export interface TrialBalanceRow {
  accountId: string;
  parentId: string | null;
  displayCode: string;
  name: string;
  classification: string;
  postable: boolean;
  level: number;
  opening: string;
  debit: string;
  credit: string;
  closing: string;
  bcValue: string;
  byCurrency: { currency: string; closingOrig: string; closingUsd: string }[];
  anomaly: string | null;
}

export interface TrialBalance {
  year: number;
  month: number;
  rows: TrialBalanceRow[];
  totals: { opening: string; debit: string; credit: string; closing: string };
  summary: { assets: string; liabilities: string; equity: string; income: string; expenses: string; difference: string; balanced: boolean };
}

export const KIND_LABEL: Record<string, string> = {
  AUTO: 'Automático', MANUAL: 'Manual', REVAL: 'Revaluación', CLOSING: 'Cierre', OPENING: 'Apertura', REVERSAL: 'Anulación',
};
export const BOOK_LABEL: Record<string, string> = { BASE: 'Común', REAL: 'Solo real', FISCAL: 'Solo fiscal' };
export const PERIOD_LABEL: Record<string, string> = { OPEN: 'Abierto', SOFT_CLOSED: 'En revisión', LOCKED: 'Bloqueado' };
export const CLASS_LABEL: Record<string, string> = { AC: 'Activo', PC: 'Pasivo', CC: 'Capital', CND: 'Gasto', CNA: 'Ingreso' };

// ───────────── Tesorería (fase 2) ─────────────

export interface TreasuryAccount {
  id: string;
  companyId: string;
  company: { code: string };
  glAccountId: string;
  glAccount: { displayCode: string; revalRateType: string | null };
  kind: 'CASH' | 'BANK' | 'WALLET';
  ownerType: 'COMPANY' | 'PARTNER';
  ownerName: string | null;
  bank: string | null;
  currency: string;
  name: string;
  createdByEtl: boolean;
  active: boolean;
  balance: string;
  balanceUsd: string;
  unmatchedStatementLines: number;
}

export interface CashCategory {
  id: string;
  code: string;
  name: string;
  kind: 'INCOME' | 'EXPENSE' | 'EXCHANGE' | 'TRANSFER' | 'DEBT' | 'OTHER';
  accountId: string | null;
  account: { id: string; displayCode: string; name: string } | null;
  aliases: string[];
  pendingReview: number;
}

export interface MovementLeg {
  id: string;
  treasuryAccountId: string;
  treasuryAccount: { id: string; name: string; currency: string; glAccount?: { displayCode: string } };
  amount: string;
  currency: string;
  rate: string;
  amountUsd: string;
  valueDate: string;
}

export interface Movement {
  id: string;
  kind: 'MOVEMENT' | 'EXCHANGE' | 'TRANSFER' | 'OPENING';
  description: string;
  sourceReference: string | null;
  needsReview: boolean;
  reviewNote: string | null;
  counterAccountId: string | null;
  category: { id: string; code: string; name: string } | null;
  document: { id: string; number: string; docDate: string; status: 'POSTED' | 'VOIDED'; companyId: string; company: { code: string; legalName?: string } };
  legs: MovementLeg[];
}

export const MOVEMENT_KIND_LABEL: Record<string, string> = {
  MOVEMENT: 'Movimiento', EXCHANGE: 'Cambio de moneda', TRANSFER: 'Traspaso', OPENING: 'Saldo de apertura',
};
export const TREASURY_KIND_LABEL: Record<string, string> = { CASH: 'Caja', BANK: 'Banco', WALLET: 'Monedero' };
export const CATEGORY_KIND_LABEL: Record<string, string> = {
  INCOME: 'Ingreso', EXPENSE: 'Gasto', EXCHANGE: 'Cambio de moneda', TRANSFER: 'Traspaso', DEBT: 'Deuda / contraparte', OTHER: 'Otro',
};
