import { FUNCTIONAL_CURRENCY, money, roundAmount, sum, toAmountString, toUsd } from '@kaluch/shared';
import type { Book, EntryKind, Prisma } from '@prisma/client';
import type { Tx } from './client';
import { LedgerError } from './errors';
import { defaultRateType, findRate, isoDate, toDate } from './fx';
import { getParam } from './params';

export const ROUNDING_MAPPING_KEY = 'ledger.rounding';

export interface PostLineInput {
  accountId: string;
  currency: string;
  /** Importe original con signo (+ Debe / − Haber). */
  amount: string;
  rate?: string;
  rateType?: string;
  /** Solo para asientos de revaluación/apertura: importe USD explícito. */
  amountUsd?: string;
  segmentId?: string | null;
  partyId?: string | null;
  treasuryAccountId?: string | null;
  containerId?: string | null;
  projectId?: string | null;
  posId?: string | null;
  counterCompanyId?: string | null;
  cashFlowCategory?: string | null;
  memo?: string | null;
}

export interface PostEntryInput {
  companyId: string;
  /** AAAA-MM-DD */
  entryDate: string;
  book?: Book;
  kind: EntryKind;
  memo: string;
  documentId?: string | null;
  reversesId?: string | null;
  createdBy?: string | null;
  /** Periodo especial: 0 (apertura) o 13 (cierre del ejercicio). Por defecto, el mes de la fecha. */
  periodMonth?: 0 | 13;
  lines: PostLineInput[];
}

const EXPLICIT_USD_KINDS: EntryKind[] = ['REVAL', 'OPENING', 'CLOSING', 'REVERSAL', 'RECLASS'];

/** Busca la cuenta de un mapeo, de lo más específico a lo más general. */
export async function resolveMapping(
  tx: Tx,
  key: string,
  ctx: { companyId?: string | null; segmentId?: string | null; currency?: string | null },
): Promise<string> {
  const rows = await tx.accountMapping.findMany({ where: { key } });
  const score = (r: (typeof rows)[number]) => {
    if (r.companyId && r.companyId !== ctx.companyId) return -1;
    if (r.segmentId && r.segmentId !== ctx.segmentId) return -1;
    if (r.currency && r.currency !== ctx.currency) return -1;
    return (r.companyId ? 4 : 0) + (r.segmentId ? 2 : 0) + (r.currency ? 1 : 0);
  };
  const best = rows.map((r) => ({ r, s: score(r) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s)[0];
  if (!best) {
    throw new LedgerError('MISSING_MAPPING', `Falta configurar la cuenta para "${key}" en los mapeos contables`);
  }
  return best.r.accountId;
}

/** Periodo de la fecha; si no existe se crea abierto. */
export async function periodFor(tx: Tx, companyId: string, date: Date, month?: number) {
  const year = date.getUTCFullYear();
  const m = month ?? date.getUTCMonth() + 1;
  return tx.fiscalPeriod.upsert({
    where: { companyId_year_month: { companyId, year, month: m } },
    update: {},
    create: { companyId, year, month: m },
  });
}

export async function nextNumber(tx: Tx, companyId: string, year: number, kind = 'ASI'): Promise<number> {
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO document_sequence (company_id, year, kind, last_value)
    VALUES (${companyId}::uuid, ${year}, ${kind}, 1)
    ON CONFLICT (company_id, year, kind) DO UPDATE SET last_value = document_sequence.last_value + 1
    RETURNING last_value`;
  return rows[0]!.last_value;
}

/**
 * Motor de contabilización: convierte cada línea a USD, compensa el redondeo
 * dentro de la tolerancia y persiste el asiento. El cuadre definitivo lo
 * verifica la base de datos al hacer COMMIT.
 */
export async function postEntry(tx: Tx, input: PostEntryInput) {
  if (input.lines.length < 2) {
    throw new LedgerError('INVALID_INPUT', 'Un asiento necesita al menos 2 líneas');
  }
  const date = toDate(input.entryDate);
  const company = await tx.company.findUnique({ where: { id: input.companyId } });
  if (!company) throw new LedgerError('NOT_FOUND', 'Empresa no encontrada');

  const lines: Prisma.JournalLineCreateManyInput[] = [];
  for (const [i, l] of input.lines.entries()) {
    let rate: string;
    let rateType: string | null = l.rateType ?? null;
    if (l.currency === FUNCTIONAL_CURRENCY) {
      rate = '1';
      rateType = null;
    } else if (l.rate) {
      rate = l.rate;
    } else {
      if (!rateType) {
        const acc = await tx.account.findUnique({ where: { id: l.accountId } });
        rateType = acc?.revalRateType ?? (await defaultRateType(tx, l.currency, date));
      }
      rate = (await findRate(tx, date, l.currency, rateType)).rate.toString();
    }
    let amountUsd: string;
    if (l.amountUsd !== undefined) {
      if (!EXPLICIT_USD_KINDS.includes(input.kind)) {
        throw new LedgerError('INVALID_INPUT', 'Solo los asientos de revaluación, apertura, cierre o anulación fijan el USD manualmente');
      }
      amountUsd = toAmountString(l.amountUsd);
    } else {
      amountUsd = toAmountString(toUsd(l.amount, rate));
    }
    lines.push({
      entryId: '', // se rellena abajo
      lineNo: i + 1,
      companyId: input.companyId, // el trigger lo vuelve a fijar desde la cabecera
      entryDate: date,
      accountId: l.accountId,
      segmentId: l.segmentId ?? null,
      partyId: l.partyId ?? null,
      treasuryAccountId: l.treasuryAccountId ?? null,
      containerId: l.containerId ?? null,
      projectId: l.projectId ?? null,
      posId: l.posId ?? null,
      counterCompanyId: l.counterCompanyId ?? null,
      currency: l.currency,
      amount: toAmountString(l.amount),
      rate,
      rateType,
      amountUsd,
      cashFlowCategory: l.cashFlowCategory ?? null,
      memo: l.memo ?? null,
    });
  }

  // Redondeo: compensar diferencias mínimas por conversión multimoneda.
  const residual = roundAmount(sum(lines.map((l) => l.amountUsd as string)));
  if (!residual.isZero()) {
    const tolerance = money(await getParam<string>(tx, 'ledger.rounding_tolerance_usd', date));
    const hasForeign = lines.some((l) => l.currency !== FUNCTIONAL_CURRENCY);
    if (!hasForeign || residual.abs().gt(tolerance)) {
      throw new LedgerError(
        'UNBALANCED',
        `El asiento no cuadra: diferencia de ${residual.toFixed(4)} USD entre Debe y Haber`,
      );
    }
    const roundingAccountId = await resolveMapping(tx, ROUNDING_MAPPING_KEY, { companyId: input.companyId });
    lines.push({
      entryId: '',
      lineNo: lines.length + 1,
      companyId: input.companyId,
      entryDate: date,
      accountId: roundingAccountId,
      currency: FUNCTIONAL_CURRENCY,
      amount: toAmountString(residual.neg()),
      rate: '1',
      rateType: null,
      amountUsd: toAmountString(residual.neg()),
      memo: 'Ajuste de redondeo',
    });
  }

  const period = await periodFor(tx, input.companyId, date, input.periodMonth);
  const seq = await nextNumber(tx, input.companyId, date.getUTCFullYear());
  const number = `${company.code}-${date.getUTCFullYear()}-${String(seq).padStart(6, '0')}`;

  const entry = await tx.journalEntry.create({
    data: {
      companyId: input.companyId,
      periodId: period.id,
      number,
      entryDate: date,
      book: input.book ?? 'BASE',
      kind: input.kind,
      memo: input.memo,
      documentId: input.documentId ?? null,
      reversesId: input.reversesId ?? null,
      createdBy: input.createdBy ?? null,
    },
  });
  await tx.journalLine.createMany({ data: lines.map((l) => ({ ...l, entryId: entry.id })) });
  return entry;
}

/**
 * Anula un asiento con un contra-asiento (mismas líneas, signo invertido,
 * mismas tasas). Nada se borra.
 */
export async function reverseEntry(
  tx: Tx,
  entryId: string,
  opts: { entryDate?: string; memo?: string; createdBy?: string | null },
) {
  const original = await tx.journalEntry.findUnique({ where: { id: entryId }, include: { lines: true, period: true } });
  if (!original) throw new LedgerError('NOT_FOUND', 'Asiento no encontrado');
  if (original.status === 'REVERSED') throw new LedgerError('ALREADY_REVERSED', `El asiento ${original.number} ya está anulado`);
  if (original.kind === 'REVERSAL') {
    throw new LedgerError('INVALID_INPUT', 'Un contra-asiento no se anula; registra un asiento nuevo');
  }

  let entryDate = opts.entryDate;
  // Un asiento de apertura (0) o de cierre (13) se anula en su mismo periodo especial si sigue abierto.
  let periodMonth: 0 | 13 | undefined;
  if (!entryDate) {
    if (original.period.status === 'OPEN') {
      entryDate = isoDate(original.entryDate);
      if (original.period.month === 0 || original.period.month === 13) periodMonth = original.period.month;
    } else {
      const firstOpen = await tx.fiscalPeriod.findFirst({
        where: {
          companyId: original.companyId,
          status: 'OPEN',
          month: { gte: 1, lte: 12 },
          OR: [
            { year: { gt: original.period.year } },
            { year: original.period.year, month: { gt: original.period.month } },
          ],
        },
        orderBy: [{ year: 'asc' }, { month: 'asc' }],
      });
      if (!firstOpen) throw new LedgerError('PERIOD_CLOSED', 'No hay ningún periodo abierto posterior para registrar la anulación');
      entryDate = `${firstOpen.year}-${String(firstOpen.month).padStart(2, '0')}-01`;
    }
  }

  const reversal = await postEntry(tx, {
    companyId: original.companyId,
    entryDate,
    book: original.book,
    kind: 'REVERSAL',
    periodMonth,
    memo: opts.memo ?? `Anulación de ${original.number}: ${original.memo}`,
    reversesId: original.id,
    documentId: original.documentId,
    createdBy: opts.createdBy ?? null,
    lines: original.lines
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        accountId: l.accountId,
        currency: l.currency,
        amount: l.amount.neg().toString(),
        rate: l.rate.toString(),
        rateType: l.rateType ?? undefined,
        amountUsd: l.amountUsd.neg().toString(),
        segmentId: l.segmentId,
        partyId: l.partyId,
        treasuryAccountId: l.treasuryAccountId,
        containerId: l.containerId,
        projectId: l.projectId,
        posId: l.posId,
        counterCompanyId: l.counterCompanyId,
        cashFlowCategory: l.cashFlowCategory,
        memo: l.memo,
      })),
  });
  await tx.journalEntry.update({ where: { id: original.id }, data: { status: 'REVERSED' } });
  return reversal;
}
