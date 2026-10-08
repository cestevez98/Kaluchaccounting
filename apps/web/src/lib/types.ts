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

// ───────────── Contrapartes (fase 3) ─────────────

export type PartyRole = 'CUSTOMER' | 'SUPPLIER' | 'EMPLOYEE' | 'PARTNER' | 'INVESTOR' | 'SELLER' | 'COURIER' | 'LENDER' | 'OTHER';

export const PARTY_ROLE_LABELS: Record<PartyRole, string> = {
  CUSTOMER: 'Cliente', SUPPLIER: 'Proveedor', EMPLOYEE: 'Trabajador', PARTNER: 'Socio', INVESTOR: 'Inversionista',
  SELLER: 'Vendedor', COURIER: 'Mensajería / envíos', LENDER: 'Financiador', OTHER: 'Otro',
};

export interface PartyRow {
  id: string;
  code: string;
  name: string;
  kind: 'PERSON' | 'COMPANY';
  roles: PartyRole[];
  taxId: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  active: boolean;
  balanceUsd: string;
  accounts: number;
  openItems: number;
}

export interface PartyBalance {
  partyAccountId: string;
  partyId: string;
  partyCode: string;
  partyName: string;
  roles: PartyRole[];
  companyId: string;
  companyCode: string;
  currency: string;
  accountCode: string;
  oppositeCode: string | null;
  balance: string;
  balanceUsd: string;
  openItems: number;
  oldestOpen: string | null;
}

export interface PartyDetail extends Omit<PartyRow, 'balanceUsd' | 'accounts' | 'openItems'> {
  accounts: PartyBalance[];
  categories: { id: string; code: string; name: string; partyAccountId: string }[];
}

export interface StatementLine {
  date: string;
  entryNumber: string;
  documentId: string | null;
  memo: string;
  accountCode: string;
  currency: string;
  amount: string;
  amountUsd: string;
  balance: string;
  balanceUsd: string;
}

export interface Statement {
  currencies: { currency: string; opening: string; openingUsd: string; closing: string; closingUsd: string; lines: StatementLine[] }[];
}

export interface OpenItemRow {
  id: string;
  companyId: string;
  companyCode?: string;
  partyId: string;
  party: { id: string; name: string; code: string };
  side: 'RECEIVABLE' | 'PAYABLE';
  reference: string;
  docDate: string;
  dueDate: string | null;
  currency: string;
  amount: string;
  amountUsd: string;
  openAmount: string;
  status: 'OPEN' | 'PARTIAL' | 'SETTLED' | 'CANCELLED';
  description: string;
  documentId: string;
  settlements: { id: string; kind: 'PAYMENT' | 'WRITE_OFF'; date: string; amount: string; note: string | null; paymentDocumentId: string | null }[];
}

export interface AgingRow {
  partyId: string;
  partyName: string;
  currency: string;
  buckets: { current: string; d60: string; d90: string; older: string };
  total: string;
  totalUsd: string;
}

export interface PayrollRow {
  id: string;
  period: string;
  employer: string;
  concept: string;
  currency: string;
  gross: string;
  attendanceDeduction: string;
  mipymeDeduction: string;
  net: string;
  number: string;
  date: string;
  partyId: string;
  partyName: string;
  reference: string | null;
  openAmount: string | null;
  status: string | null;
}

export const OPEN_ITEM_STATUS: Record<OpenItemRow['status'], { label: string; tone: 'gray' | 'green' | 'amber' | 'red' | 'blue' }> = {
  OPEN: { label: 'Pendiente', tone: 'amber' },
  PARTIAL: { label: 'Parcial', tone: 'blue' },
  SETTLED: { label: 'Liquidada', tone: 'green' },
  CANCELLED: { label: 'Cancelada', tone: 'gray' },
};
