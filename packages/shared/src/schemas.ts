import { z } from 'zod';
import { CURRENCIES, RATE_TYPES } from './fx';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato AAAA-MM-DD');
/** Decimal como string para no perder precisión ("1234.5678" o "-10"). */
const decimalString = z.string().regex(/^-?\d{1,14}(\.\d{1,10})?$/, 'Importe no válido');
const positiveDecimal = decimalString.refine((v) => !v.startsWith('-') && Number(v) !== 0, 'Debe ser mayor que 0');
const uuid = z.string().uuid();
/** Booleano de query string: solo "true"/"1" es verdadero (z.coerce.boolean convierte "false" en true). */
const queryBoolean = z.preprocess((v) => v === true || v === 'true' || v === '1', z.boolean());

export const currencySchema = z.enum(CURRENCIES);
export const rateTypeSchema = z.enum(Object.keys(RATE_TYPES) as [keyof typeof RATE_TYPES, ...(keyof typeof RATE_TYPES)[]]);

export const journalLineInputSchema = z
  .object({
    accountId: uuid,
    currency: currencySchema,
    /** Importe en moneda original. Positivo = Debe, negativo = Haber. */
    amount: decimalString,
    /** Si se omite, se busca la tasa vigente del tipo indicado. */
    rate: positiveDecimal.optional(),
    rateType: rateTypeSchema.optional(),
    segmentId: uuid.optional(),
    containerId: uuid.optional(),
    projectId: uuid.optional(),
    posId: uuid.optional(),
    counterCompanyId: uuid.optional(),
    memo: z.string().max(500).optional(),
  })
  .refine((l) => Number(l.amount) !== 0, { message: 'El importe no puede ser 0', path: ['amount'] });

export const journalEntryInputSchema = z.object({
  companyId: uuid,
  entryDate: isoDate,
  book: z.enum(['BASE', 'REAL', 'FISCAL']).default('BASE'),
  memo: z.string().min(1, 'La descripción es obligatoria').max(500),
  lines: z.array(journalLineInputSchema).min(2, 'Un asiento necesita al menos 2 líneas'),
});
export type JournalEntryInput = z.infer<typeof journalEntryInputSchema>;
export type JournalLineInput = z.infer<typeof journalLineInputSchema>;

export const reverseEntryInputSchema = z.object({
  entryDate: isoDate.optional(),
  memo: z.string().max(500).optional(),
});

export const exchangeRateInputSchema = z.object({
  rateDate: isoDate,
  currency: currencySchema,
  rateType: rateTypeSchema,
  base: z.enum(['USD', 'EUR']).default('USD'),
  rate: positiveDecimal,
  source: z.string().max(100).optional(),
});
export type ExchangeRateInput = z.infer<typeof exchangeRateInputSchema>;

export const accountInputSchema = z.object({
  parentId: uuid.nullable().optional(),
  code: z.string().regex(/^\d{3,4}$/, 'Cuenta de 3 o 4 dígitos'),
  subcode: z.string().regex(/^\d{1,6}$/, 'Subcuenta numérica').nullable().optional(),
  name: z.string().min(1).max(200),
  nature: z.enum(['DEUDORA', 'ACREEDORA', 'MIXTA']),
  classification: z.enum(['AC', 'PC', 'CC', 'CND', 'CNA']),
  postable: z.boolean(),
  currencyLock: currencySchema.nullable().optional(),
  revalRateType: rateTypeSchema.nullable().optional(),
  requiresParty: z.boolean().default(false),
  isIntercompany: z.boolean().default(false),
  isPendingExport: z.boolean().default(false),
  defaultSegmentId: uuid.nullable().optional(),
  active: z.boolean().default(true),
});
export type AccountInput = z.infer<typeof accountInputSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

export const trialBalanceQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  /** Vacío = consolidado (todas las empresas a las que el usuario tiene acceso). */
  companyId: uuid.optional(),
  segmentId: uuid.optional(),
  view: z.enum(['REAL', 'FISCAL']).default('REAL'),
  includeZero: queryBoolean.default(false),
});
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

// ───────────────────────── Tesorería (fase 2) ─────────────────────────

export const treasuryMovementInputSchema = z.object({
  companyId: uuid,
  date: isoDate,
  kind: z.enum(['MOVEMENT', 'EXCHANGE', 'TRANSFER']).default('MOVEMENT'),
  description: z.string().min(1, 'El concepto es obligatorio').max(480),
  categoryId: uuid.nullable().optional(),
  counterAccountId: uuid.nullable().optional(),
  segmentId: uuid.nullable().optional(),
  posId: uuid.nullable().optional(),
  legs: z
    .array(
      z.object({
        treasuryAccountId: uuid,
        /** + entrada / − salida */
        amount: decimalString.refine((v) => Number(v) !== 0, 'El importe no puede ser 0'),
        rate: positiveDecimal.optional(),
      }),
    )
    .min(1, 'Indica al menos una cuenta de tesorería')
    .max(10),
});
export type TreasuryMovementApiInput = z.infer<typeof treasuryMovementInputSchema>;

export const treasuryAccountInputSchema = z.object({
  companyId: uuid,
  /** Cuenta contable de detalle existente, o se crea la subcuenta indicada bajo el grupo. */
  glAccountId: uuid.optional(),
  groupCode: z.string().regex(/^\d{3}$/).optional(),
  subcode: z.string().regex(/^\d{1,6}$/).optional(),
  kind: z.enum(['CASH', 'BANK', 'WALLET']),
  name: z.string().min(1).max(200),
  currency: currencySchema,
  bank: z.string().max(100).nullable().optional(),
  ownerType: z.enum(['COMPANY', 'PARTNER']).default('COMPANY'),
  ownerName: z.string().max(200).nullable().optional(),
  country: z.string().max(60).nullable().optional(),
});

export const categoryInputSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_]{2,60}$/, 'Código en mayúsculas, números y _'),
  name: z.string().min(1).max(200),
  kind: z.enum(['INCOME', 'EXPENSE', 'EXCHANGE', 'TRANSFER', 'DEBT', 'OTHER']),
  accountId: uuid.nullable().optional(),
  segmentId: uuid.nullable().optional(),
  cashFlowCategory: z.enum(['OPER', 'INV', 'FIN']).default('OPER'),
  active: z.boolean().default(true),
});

export const reclassifyInputSchema = z.object({
  accountId: uuid,
  categoryId: uuid.nullable().optional(),
  note: z.string().max(500).optional(),
});

export const revaluationInputSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  companyId: uuid.optional(),
});

export const userCreateSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  password: z.string().min(12, 'La contraseña debe tener al menos 12 caracteres'),
  assignments: z.array(z.object({ companyId: uuid, roleId: uuid })).default([]),
});

export const userUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  active: z.boolean().optional(),
  password: z.string().min(12, 'La contraseña debe tener al menos 12 caracteres').optional(),
  resetTotp: z.boolean().optional(),
  assignments: z.array(z.object({ companyId: uuid, roleId: uuid })).optional(),
});

export const roleInputSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(300).default(''),
  requires2fa: z.boolean().default(false),
  permissions: z.array(z.string()).min(1),
});

// ───────────── Contrapartes (fase 3) ─────────────

export const PARTY_ROLES = ['CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'PARTNER', 'INVESTOR', 'SELLER', 'COURIER', 'LENDER', 'OTHER'] as const;

export const partyInputSchema = z.object({
  name: z.string().min(1, 'El nombre es obligatorio').max(200),
  kind: z.enum(['PERSON', 'COMPANY']).default('PERSON'),
  roles: z.array(z.enum(PARTY_ROLES)).default([]),
  taxId: z.string().max(40).nullable().optional(),
  email: z.string().email('Correo no válido').max(200).nullable().optional().or(z.literal('')),
  phone: z.string().max(40).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  active: z.boolean().optional(),
});

export const partyAccountInputSchema = z.object({
  companyId: uuid,
  currency: currencySchema,
  accountId: uuid,
  oppositeAccountId: uuid.nullable().optional(),
});

export const partyDocumentInputSchema = z.object({
  partyAccountId: uuid,
  date: isoDate,
  /** CHARGE: nos debe más / le debemos menos. CREDIT: le debemos más / nos debe menos. */
  kind: z.enum(['CHARGE', 'CREDIT', 'ASSIGNMENT']),
  amount: positiveDecimal,
  counterAccountId: uuid.nullable().optional(),
  /** Cesión: cuenta corriente que recibe la deuda. */
  counterPartyAccountId: uuid.nullable().optional(),
  description: z.string().min(1, 'El concepto es obligatorio').max(480),
  reference: z.string().max(80).nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  openItem: z.boolean().default(false),
  segmentId: uuid.nullable().optional(),
});

export const settlementInputSchema = z.object({
  openItemId: uuid,
  amount: positiveDecimal,
  date: isoDate,
  kind: z.enum(['PAYMENT', 'WRITE_OFF']).default('PAYMENT'),
  paymentDocumentId: uuid.nullable().optional(),
  note: z.string().max(300).nullable().optional(),
});

export const payrollInputSchema = z.object({
  partyAccountId: uuid,
  date: isoDate,
  period: z.string().regex(/^\d{4}-\d{2}$/, 'Periodo AAAA-MM'),
  employer: z.string().min(1).max(60),
  concept: z.string().min(1).max(120),
  gross: positiveDecimal,
  attendanceDeduction: decimalString.optional(),
  mipymeDeduction: decimalString.optional(),
  segmentId: uuid.nullable().optional(),
  expenseAccountId: uuid.nullable().optional(),
});

export const signReclassInputSchema = z.object({
  companyId: uuid,
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

// ───────────────────────── Fase 4: exportación y distribución ─────────────────────────

const nonNegativeDecimal = decimalString.refine((v) => !v.startsWith('-'), 'No puede ser negativo');

export const exportInvoiceInputSchema = z.object({
  partyAccountId: uuid,
  number: z.string().trim().min(1).max(60),
  invoiceDate: isoDate,
  service: z.enum(['GOODS', 'SERVICES']),
  internal: z.boolean().optional(),
  description: z.string().trim().min(1).max(500),
  amountUsd: positiveDecimal,
  factoryUsd: nonNegativeDecimal.optional(),
  logisticsUsd: nonNegativeDecimal.optional(),
  otherUsd: nonNegativeDecimal.optional(),
  estimatedUsd: nonNegativeDecimal.optional(),
  commissionUsd: nonNegativeDecimal.optional(),
  sellerPartyAccountId: uuid.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
});

export const exportCloseInputSchema = z.object({ closeDate: isoDate });

export const productInputSchema = z.object({
  code: z.string().trim().min(1).max(40).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().min(1).max(20).default('u'),
});

export const containerInputSchema = z.object({
  companyId: uuid,
  code: z.string().trim().min(1).max(40),
  description: z.string().trim().max(500).default(''),
});

export const containerInvestorInputSchema = z.object({
  partyAccountId: uuid,
  investedUsd: nonNegativeDecimal.default('0'),
  profitPct: decimalString.refine((v) => Number(v) >= 0 && Number(v) <= 100, 'Entre 0 y 100'),
});

export const containerCostInputSchema = z.object({
  date: isoDate,
  amountUsd: decimalString,
  description: z.string().trim().min(1).max(500),
  productId: uuid.nullable().optional(),
  partyAccountId: uuid.nullable().optional(),
  counterAccountId: uuid.nullable().optional(),
  reference: z.string().max(60).nullable().optional(),
});

export const containerReceiptInputSchema = z.object({
  date: isoDate,
  lines: z.array(z.object({ productId: uuid, quantity: positiveDecimal, amountUsd: nonNegativeDecimal })).min(1).max(200),
});

export const salesInvoiceInputSchema = z.object({
  companyId: uuid,
  date: isoDate,
  description: z.string().trim().min(1).max(500),
  partyAccountId: uuid.nullable().optional(),
  counterAccountId: uuid.nullable().optional(),
  fiscal: z.boolean().optional(),
  dueDate: isoDate.nullable().optional(),
  lines: z.array(z.object({
    productId: uuid,
    containerId: uuid,
    quantity: positiveDecimal,
    unitPriceUsd: nonNegativeDecimal,
    commissionPerUnitUsd: nonNegativeDecimal.optional(),
    sellerPartyAccountId: uuid.nullable().optional(),
  })).min(1).max(200),
});

// ───────────────────────── Fase 5: financiamientos, impuestos, capital y cierres ─────────────────────────

export const loanInputSchema = z.object({
  partyAccountId: uuid,
  direction: z.enum(['GIVEN', 'RECEIVED']),
  reference: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(500),
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  principalUsd: positiveDecimal,
  ratePct: nonNegativeDecimal.default('0'),
  counterAccountId: uuid.nullable().optional(),
});

export const monthInputSchema = z.object({
  companyId: uuid,
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

export const loanTermInputSchema = z.object({ companyId: uuid, asOf: isoDate });

export const TAX_AGENCIES = ['ONAT', 'HACIENDA'] as const;

export const taxAccrualInputSchema = z.object({
  companyId: uuid,
  agency: z.enum(TAX_AGENCIES),
  date: isoDate,
  periodFrom: isoDate,
  periodTo: isoDate,
  amountUsd: decimalString,
  description: z.string().trim().min(1).max(500),
});

export const taxCloseInputSchema = z.object({
  companyId: uuid,
  agency: z.enum(TAX_AGENCIES),
  periodFrom: isoDate,
  periodTo: isoDate,
  date: isoDate,
  declaredUsd: nonNegativeDecimal,
});

export const capitalMovementInputSchema = z.object({
  companyId: uuid,
  partyId: uuid,
  kind: z.enum(['CONTRIBUTION', 'WITHDRAWAL', 'DISTRIBUTION']),
  date: isoDate,
  amountUsd: positiveDecimal,
  counterAccountId: uuid,
  description: z.string().trim().min(1).max(500),
});

export const yearCloseInputSchema = z.object({
  companyId: uuid,
  year: z.coerce.number().int().min(2020).max(2100),
});
