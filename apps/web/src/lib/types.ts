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

// ───────────────────────── Fase 4: ventas, contenedores e inventario ─────────────────────────

export interface ExportInvoiceRow {
  id: string; companyId: string; companyCode: string; number: string; invoiceDate: string; closeDate: string | null;
  service: 'GOODS' | 'SERVICES'; internal: boolean; description: string; status: 'PENDING' | 'CLOSED';
  partyId: string; partyName: string; partyAccountId: string; sellerName: string | null;
  amountUsd: string; factoryUsd: string; logisticsUsd: string; otherUsd: string; estimatedUsd: string; commissionUsd: string; marginUsd: string;
}
export interface ExportInvoiceDetail extends ExportInvoiceRow {
  issueDocument: string; closeDocument: string | null;
  lines: { date: string; entry: string; account: string; accountName: string; amountUsd: string; memo: string | null }[];
}
export const EXPORT_STATUS: Record<ExportInvoiceRow['status'], { label: string; tone: 'amber' | 'green' }> = {
  PENDING: { label: 'Pendiente de cierre', tone: 'amber' },
  CLOSED: { label: 'Cerrada', tone: 'green' },
};

export interface ProductRow { id: string; code: string; name: string; unit: string; active: boolean; stockQuantity: string; stockUsd: string }

export interface ContainerInvestorRow { id: string; partyAccountId: string; partyId: string; name: string; investedUsd: string; profitPct: string; shareUsd: string }
export interface ContainerRow {
  id: string; code: string; description: string; status: 'TRANSIT' | 'WAREHOUSE' | 'CLOSED'; arrivalDate: string | null;
  totalCostUsd: string; soldQuantity: string; revenueUsd: string; costOfSalesUsd: string; commissionUsd: string; onatUsd: string;
  utilityUsd: string; marginPct: string | null; stockQuantity: string; stockUsd: string; investors: ContainerInvestorRow[];
}
export interface ContainerDetail extends ContainerRow {
  companyId: string; companyCode: string; transitUsd: string;
  lots: { productId: string; productName: string; quantity: string; valueUsd: string }[];
  movements: { id: string; date: string; kind: string; location: string; product: string | null; quantity: string; amountUsd: string; description: string; document: string }[];
}
export const CONTAINER_STATUS: Record<ContainerRow['status'], { label: string; tone: 'blue' | 'green' | 'gray' }> = {
  TRANSIT: { label: 'En tránsito', tone: 'blue' },
  WAREHOUSE: { label: 'En almacén', tone: 'green' },
  CLOSED: { label: 'Cerrado', tone: 'gray' },
};
export const MOVE_KIND_LABEL: Record<string, string> = { COST: 'Costo', RECEIPT: 'Recepción', SALE: 'Venta', ADJUSTMENT: 'Ajuste' };

export interface StockRow {
  containerId: string; containerCode: string; companyId: string; productId: string; productCode: string; productName: string; unit: string;
  quantity: string; valueUsd: string; unitCostUsd: string;
}
export interface KardexRow {
  id: string; date: string; kind: string; container: string; document: string; description: string;
  quantity: string; amountUsd: string; balanceQuantity: string; balanceUsd: string;
}
export interface SalesInvoiceRow {
  id: string; number: string; date: string; companyCode: string; description: string | null; customer: string | null; partyId: string | null; lines: number;
  totalUsd: string; costUsd: string; commissionUsd: string; onatUsd: string; marginUsd: string; status: string;
}
export interface SalesInvoiceDetail {
  id: string; number: string; date: string; companyCode: string; description: string | null; customer: string | null; partyId: string | null; onatRate: string;
  totalUsd: string; costUsd: string; commissionUsd: string; onatUsd: string;
  lines: { id: string; product: string; unit: string; container: string; containerId: string; quantity: string; unitPriceUsd: string; amountUsd: string; costUsd: string; commissionUsd: string; onatUsd: string; seller: string | null }[];
}
export interface CommissionRow {
  sellerPartyAccountId: string; partyId: string; seller: string; week: string; units: string; salesUsd: string; commissionUsd: string; invoices: string[];
}

// ───────────────────────── Fase 5: financiamientos, impuestos, capital y cierres ─────────────────────────

export interface LoanRow {
  id: string; companyCode: string; reference: string; description: string; direction: 'GIVEN' | 'RECEIVED'; status: 'ACTIVE' | 'CLOSED'; migrated: boolean;
  partyId: string; partyName: string; accountCode: string; startDate: string; endDate: string | null; principalUsd: string; ratePct: string;
  interestUsd: string; accruedUsd: string; longTermUsd: string; openUsd: string | null;
}
export interface TaxMonth { month: number; accruedUsd: string; paidUsd: string; adjustmentUsd: string; balanceUsd: string }
export interface TaxClosing { id: string; number: string; date: string; periodFrom: string; periodTo: string; declaredUsd: string; accruedUsd: string; adjustmentUsd: string }
export interface TaxSummary { agency: 'ONAT' | 'HACIENDA'; label: string; closing: 'QUARTERLY' | 'ANNUAL'; months: TaxMonth[]; closings: TaxClosing[] }
export interface CapitalPartner { partyId: string | null; name: string; capitalUsd: string; retainedUsd: string; sharePct: string | null }
export interface CapitalMovementRow { id: string; number: string; companyCode: string; date: string; partyId: string; partyName: string; kind: string; amountUsd: string; description: string }
export interface CloseCheck { key: string; label: string; status: 'OK' | 'PENDING' | 'INFO'; detail: string }
export interface MonthClose { year: number; month: number; periodStatus: string; checks: CloseCheck[] }
export interface YearCloseRow { id: string; companyCode: string; year: number; resultUsd: string; entries: number; createdAt: string }
export const CAPITAL_KIND_LABEL: Record<string, string> = { CONTRIBUTION: 'Aporte', WITHDRAWAL: 'Retiro', DISTRIBUTION: 'Reparto de utilidades' };
