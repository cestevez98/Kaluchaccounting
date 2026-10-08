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
