import { endOfMonth, FUNCTIONAL_CURRENCY, money, roundAmount } from '@kaluch/shared';
import type { Book, CapitalMoveKind, LoanDirection, Prisma, TaxAgency } from '@prisma/client';
import type { Tx } from './client';
import { LedgerError } from './errors';
import { isoDate, toDate } from './fx';
import { nextNumber, postEntry, resolveMapping, reverseEntry, type PostLineInput } from './ledger';
import { createOpenItem, upsertParty } from './parties';

type Money = ReturnType<typeof money>;

const usdLine = (accountId: string, amount: Money, memo: string, extra: Partial<PostLineInput> = {}): PostLineInput => ({
  accountId, currency: FUNCTIONAL_CURRENCY, amount: roundAmount(amount).toFixed(4), memo: memo.slice(0, 500), ...extra,
});

async function newDocument(tx: Tx, p: { companyId: string; date: string; docType: string; prefix: string; memo: string; createdBy?: string | null }) {
  const company = await tx.company.findUniqueOrThrow({ where: { id: p.companyId } });
  const date = toDate(p.date);
  const year = date.getUTCFullYear();
  const seq = await nextNumber(tx, company.id, year, p.prefix);
  return tx.document.create({
    data: {
      companyId: company.id, docType: p.docType, number: `${company.code}-${p.prefix}-${year}-${String(seq).padStart(6, '0')}`,
      docDate: date, memo: p.memo.slice(0, 500), createdBy: p.createdBy ?? null,
    },
  });
}

const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

// ───────────────────────── Financiamientos ─────────────────────────

export interface LoanInput {
  partyAccountId: string;
  direction: LoanDirection;
  reference: string;
  description: string;
  startDate: string;
  endDate?: string | null;
  principalUsd: string;
  /** Interés total sobre el principal, en %. */
  ratePct: string;
  /** Cuenta del desembolso (caja, banco…). Sin ella solo se registra el préstamo (ya contabilizado). */
  counterAccountId?: string | null;
  migrated?: boolean;
  createdBy?: string | null;
}

/**
 * Alta de un préstamo. Con cuenta de desembolso se contabiliza el principal (dado: cargo a la cuenta corriente del
 * deudor, 138; recibido: abono a la del prestamista, 411) y se abre una partida por el total a devolver.
 */
export async function createLoan(tx: Tx, input: LoanInput) {
  const principal = roundAmount(money(input.principalUsd));
  if (principal.lte(0)) throw new LedgerError('INVALID_INPUT', 'El principal debe ser positivo');
  const rate = money(input.ratePct);
  if (rate.lt(0)) throw new LedgerError('INVALID_INPUT', 'El interés no puede ser negativo');
  if (input.endDate && input.endDate < input.startDate) throw new LedgerError('INVALID_INPUT', 'El vencimiento es anterior al inicio');
  const pa = await tx.partyAccount.findUnique({ where: { id: input.partyAccountId }, include: { party: true } });
  if (!pa) throw new LedgerError('NOT_FOUND', 'Cuenta corriente no encontrada');
  if (pa.currency !== FUNCTIONAL_CURRENCY) throw new LedgerError('INVALID_INPUT', 'La cuenta corriente del préstamo debe estar en USD');
  if (await tx.loan.findUnique({ where: { companyId_reference: { companyId: pa.companyId, reference: input.reference } } })) {
    throw new LedgerError('INVALID_INPUT', `Ya existe el préstamo ${input.reference}`);
  }
  const interest = roundAmount(principal.times(rate).div(100));
  let documentId: string | null = null;
  if (input.counterAccountId) {
    const memo = `Préstamo ${input.reference} ${input.direction === 'GIVEN' ? 'a' : 'de'} ${pa.party.name}: ${input.description}`;
    const doc = await newDocument(tx, { companyId: pa.companyId, date: input.startDate, docType: 'LOAN', prefix: 'FIN', memo, createdBy: input.createdBy });
    const sign = input.direction === 'GIVEN' ? 1 : -1;
    await postEntry(tx, {
      companyId: pa.companyId, entryDate: input.startDate, kind: 'AUTO', memo, documentId: doc.id, createdBy: input.createdBy ?? null,
      lines: [
        usdLine(pa.accountId, principal.times(sign), memo, { partyId: pa.partyId }),
        usdLine(input.counterAccountId, principal.times(-sign), memo),
      ],
    });
    // Partida abierta por el total a devolver (principal + interés), al vencimiento.
    const total = principal.plus(interest).times(sign);
    await createOpenItem(tx, {
      partyAccountId: pa.id, documentId: doc.id, date: input.startDate, dueDate: input.endDate ?? null,
      amount: total.toFixed(4), amountUsd: total.toFixed(4), reference: input.reference, description: memo,
    });
    documentId = doc.id;
  }
  return tx.loan.create({
    data: {
      companyId: pa.companyId, partyAccountId: pa.id, direction: input.direction, reference: input.reference, description: input.description,
      startDate: toDate(input.startDate), endDate: input.endDate ? toDate(input.endDate) : null, principalUsd: principal.toFixed(4),
      ratePct: rate.toFixed(4), interestUsd: interest.toFixed(4), migrated: input.migrated ?? false, documentId, createdBy: input.createdBy ?? null,
      status: 'ACTIVE',
    },
  });
}

/** Interés de un préstamo que corresponde a un mes (por días entre inicio y vencimiento; el último mes, el resto). */
export function loanInterestForMonth(
  loan: { startDate: Date; endDate: Date | null; interestUsd: unknown },
  year: number, month: number, alreadyAccrued: Money,
): Money {
  const interest = money(String(loan.interestUsd));
  if (interest.isZero()) return money(0);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(`${endOfMonth(year, month)}T00:00:00Z`);
  if (!loan.endDate) {
    // Sin vencimiento: todo el interés el mes de inicio.
    return loan.startDate >= from && loan.startDate <= to ? interest.minus(alreadyAccrued) : money(0);
  }
  if (loan.endDate < from || loan.startDate > to) return money(0);
  if (loan.endDate <= to) return roundAmount(interest.minus(alreadyAccrued));
  const total = Math.max(1, daysBetween(loan.startDate, loan.endDate));
  const start = loan.startDate > from ? loan.startDate : from;
  const days = daysBetween(start, new Date(to.getTime() + 86_400_000));
  return roundAmount(interest.times(days).div(total));
}

/**
 * Devenga el interés del mes de los préstamos activos de una empresa (uno por préstamo y mes; repetirlo no hace nada):
 * recibido, gasto financiero (842) contra el prestamista; dado, cuenta del deudor contra ingreso financiero (921).
 */
export async function accrueLoanInterest(tx: Tx, p: { companyId: string; year: number; month: number; createdBy?: string | null }) {
  const loans = await tx.loan.findMany({
    where: { companyId: p.companyId, status: 'ACTIVE', migrated: false, interestUsd: { gt: 0 } },
    include: { accruals: true, partyAccount: { include: { party: true } } },
  });
  const date = endOfMonth(p.year, p.month);
  const out: { loanId: string; reference: string; amountUsd: string }[] = [];
  for (const loan of loans) {
    if (loan.accruals.some((a) => a.year === p.year && a.month === p.month)) continue;
    const done = loan.accruals.reduce((s, a) => s.plus(money(a.amountUsd)), money(0));
    const amount = loanInterestForMonth(loan, p.year, p.month, done);
    if (amount.lte(0)) continue;
    const memo = `Interés ${String(p.month).padStart(2, '0')}/${p.year} del préstamo ${loan.reference} (${loan.partyAccount.party.name})`;
    const doc = await newDocument(tx, { companyId: p.companyId, date, docType: 'LOAN_INTEREST', prefix: 'FIN', memo, createdBy: p.createdBy });
    const ctx = { companyId: p.companyId };
    const pa = loan.partyAccount;
    const lines = loan.direction === 'RECEIVED'
      ? [usdLine(await resolveMapping(tx, 'loan.interest.expense', ctx), amount, memo), usdLine(pa.accountId, amount.neg(), memo, { partyId: pa.partyId })]
      : [usdLine(pa.accountId, amount, memo, { partyId: pa.partyId }), usdLine(await resolveMapping(tx, 'loan.interest.income', ctx), amount.neg(), memo)];
    await postEntry(tx, { companyId: p.companyId, entryDate: date, kind: 'AUTO', memo, documentId: doc.id, createdBy: p.createdBy ?? null, lines });
    await tx.loanAccrual.create({ data: { loanId: loan.id, year: p.year, month: p.month, amountUsd: amount.toFixed(4), documentId: doc.id } });
    out.push({ loanId: loan.id, reference: loan.reference, amountUsd: amount.toFixed(4) });
  }
  return out;
}

/**
 * Corto/largo plazo de los préstamos recibidos: el principal de los que vencen a más de un año de la fecha pasa de
 * 411 a 520 (y vuelve cuando ya vence antes). Solo se contabiliza la diferencia con la última reclasificación.
 */
export async function reclassifyLoanTerm(tx: Tx, p: { companyId: string; asOf: string; createdBy?: string | null }) {
  const asOf = toDate(p.asOf);
  const limit = new Date(Date.UTC(asOf.getUTCFullYear() + 1, asOf.getUTCMonth(), asOf.getUTCDate()));
  const loans = await tx.loan.findMany({
    where: { companyId: p.companyId, direction: 'RECEIVED', OR: [{ status: 'ACTIVE' }, { longTermUsd: { gt: 0 } }] },
    include: { partyAccount: { include: { party: true } } },
  });
  const out: { reference: string; longTermUsd: string; movedUsd: string }[] = [];
  for (const loan of loans) {
    const target = loan.status === 'ACTIVE' && loan.endDate && loan.endDate > limit ? money(loan.principalUsd) : money(0);
    const delta = roundAmount(target.minus(money(loan.longTermUsd)));
    if (delta.isZero()) continue;
    const memo = `Préstamo ${loan.reference} (${loan.partyAccount.party.name}): ${delta.gt(0) ? 'a largo plazo' : 'a corto plazo'} al ${p.asOf.split('-').reverse().join('/')}`;
    const doc = await newDocument(tx, { companyId: p.companyId, date: p.asOf, docType: 'LOAN_TERM', prefix: 'FIN', memo, createdBy: p.createdBy });
    const pa = loan.partyAccount;
    await postEntry(tx, {
      companyId: p.companyId, entryDate: p.asOf, kind: 'AUTO', memo, documentId: doc.id, createdBy: p.createdBy ?? null,
      lines: [
        usdLine(pa.accountId, delta, memo, { partyId: pa.partyId }),
        usdLine(await resolveMapping(tx, 'loan.longterm', { companyId: p.companyId }), delta.neg(), memo, { partyId: pa.partyId }),
      ],
    });
    await tx.loan.update({ where: { id: loan.id }, data: { longTermUsd: target.toFixed(4) } });
    out.push({ reference: loan.reference, longTermUsd: target.toFixed(4), movedUsd: delta.toFixed(4) });
  }
  return out;
}

// ───────────────────────── Impuestos ─────────────────────────

export const TAX_AGENCIES: Record<TaxAgency, { label: string; prefix: string; closing: 'QUARTERLY' | 'ANNUAL'; segment: string }> = {
  ONAT: { label: 'ONAT (Cuba)', prefix: 'tax.onat', closing: 'QUARTERLY', segment: '999' },
  HACIENDA: { label: 'Hacienda (España)', prefix: 'tax.hacienda', closing: 'ANNUAL', segment: '888' },
};

async function taxAccounts(tx: Tx, companyId: string, agency: TaxAgency) {
  const k = TAX_AGENCIES[agency].prefix;
  const ctx = { companyId };
  return {
    expense: await resolveMapping(tx, `${k}.expense`, ctx),
    payable: await resolveMapping(tx, `${k}.payable`, ctx),
    loss: await resolveMapping(tx, `${k}.loss`, ctx),
    gain: await resolveMapping(tx, `${k}.gain`, ctx),
  };
}

/** Devengo de impuestos: gasto (830) contra Gastos acumulados por pagar (480) del organismo. */
export async function accrueTax(
  tx: Tx,
  p: { companyId: string; agency: TaxAgency; date: string; periodFrom: string; periodTo: string; amountUsd: string; description: string; createdBy?: string | null },
) {
  const amount = roundAmount(money(p.amountUsd));
  if (amount.isZero()) throw new LedgerError('INVALID_INPUT', 'El importe no puede ser 0');
  if (p.periodTo < p.periodFrom) throw new LedgerError('INVALID_INPUT', 'El periodo termina antes de empezar');
  const acc = await taxAccounts(tx, p.companyId, p.agency);
  const seg = await tx.segment.findUnique({ where: { code: TAX_AGENCIES[p.agency].segment } });
  const memo = `${TAX_AGENCIES[p.agency].label}: ${p.description}`;
  const doc = await newDocument(tx, { companyId: p.companyId, date: p.date, docType: 'TAX_ACCRUAL', prefix: 'IMP', memo, createdBy: p.createdBy });
  const entry = await postEntry(tx, {
    companyId: p.companyId, entryDate: p.date, kind: 'AUTO', memo, documentId: doc.id, createdBy: p.createdBy ?? null,
    lines: [usdLine(acc.expense, amount, memo, { segmentId: seg?.id ?? null }), usdLine(acc.payable, amount.neg(), memo)],
  });
  const taxDocument = await tx.taxDocument.create({
    data: { id: doc.id, companyId: p.companyId, agency: p.agency, kind: 'ACCRUAL', periodFrom: toDate(p.periodFrom), periodTo: toDate(p.periodTo), amountUsd: amount.toFixed(4) },
  });
  return { document: doc, entry, taxDocument };
}

/** Lo devengado en un periodo: abonos a la cuenta del organismo que no son ajustes de cierre (incluye la ONAT de las ventas). */
async function accruedInPeriod(tx: Tx, p: { companyId: string; payable: string; from: string; to: string }) {
  const adjustments = await tx.taxDocument.findMany({ where: { companyId: p.companyId, kind: 'ADJUSTMENT' }, select: { id: true } });
  const agg = await tx.journalLine.aggregate({
    where: {
      companyId: p.companyId, accountId: p.payable, amountUsd: { lt: 0 }, entryDate: { gte: toDate(p.from), lte: toDate(p.to) },
      entry: { OR: [{ documentId: null }, { documentId: { notIn: adjustments.map((a) => a.id) } }] },
    },
    _sum: { amountUsd: true },
  });
  return money(agg._sum.amountUsd ?? 0).neg();
}

/**
 * Cierre del periodo fiscal (trimestral ONAT, anual Hacienda): la diferencia entre lo declarado y lo devengado en el
 * periodo va a 848 (se debía más) o a 920 (se debía menos) contra la cuenta del organismo.
 */
export async function closeTaxPeriod(
  tx: Tx,
  p: { companyId: string; agency: TaxAgency; periodFrom: string; periodTo: string; date: string; declaredUsd: string; createdBy?: string | null },
) {
  if (p.periodTo < p.periodFrom) throw new LedgerError('INVALID_INPUT', 'El periodo termina antes de empezar');
  const exists = await tx.taxDocument.findFirst({
    where: { companyId: p.companyId, agency: p.agency, kind: 'ADJUSTMENT', periodFrom: { lte: toDate(p.periodTo) }, periodTo: { gte: toDate(p.periodFrom) } },
  });
  if (exists) throw new LedgerError('INVALID_INPUT', 'Ese periodo (o parte de él) ya está cerrado para este organismo');
  const declared = roundAmount(money(p.declaredUsd));
  if (declared.lt(0)) throw new LedgerError('INVALID_INPUT', 'Lo declarado no puede ser negativo');
  const acc = await taxAccounts(tx, p.companyId, p.agency);
  const accrued = roundAmount(await accruedInPeriod(tx, { companyId: p.companyId, payable: acc.payable, from: p.periodFrom, to: p.periodTo }));
  const diff = declared.minus(accrued);
  const fmt = (d: string) => d.split('-').reverse().join('/');
  const memo = `${TAX_AGENCIES[p.agency].label}: cierre del ${fmt(p.periodFrom)} al ${fmt(p.periodTo)} (declarado ${declared.toFixed(2)}, devengado ${accrued.toFixed(2)})`;
  const doc = await newDocument(tx, { companyId: p.companyId, date: p.date, docType: 'TAX_CLOSE', prefix: 'IMP', memo, createdBy: p.createdBy });
  let entry = null;
  if (!diff.isZero()) {
    const seg = await tx.segment.findUnique({ where: { code: TAX_AGENCIES[p.agency].segment } });
    entry = await postEntry(tx, {
      companyId: p.companyId, entryDate: p.date, kind: 'AUTO', memo, documentId: doc.id, createdBy: p.createdBy ?? null,
      lines: diff.gt(0)
        ? [usdLine(acc.loss, diff, memo, { segmentId: seg?.id ?? null }), usdLine(acc.payable, diff.neg(), memo)]
        : [usdLine(acc.payable, diff.neg(), memo), usdLine(acc.gain, diff, memo, { segmentId: seg?.id ?? null })],
    });
  }
  const taxDocument = await tx.taxDocument.create({
    data: {
      id: doc.id, companyId: p.companyId, agency: p.agency, kind: 'ADJUSTMENT', periodFrom: toDate(p.periodFrom), periodTo: toDate(p.periodTo),
      amountUsd: diff.toFixed(4), declaredUsd: declared.toFixed(4), accruedUsd: accrued.toFixed(4),
    },
  });
  return { document: doc, entry, taxDocument, accruedUsd: accrued.toFixed(4), adjustmentUsd: diff.toFixed(4) };
}

/** Resumen mensual de un organismo: devengado, pagado, ajustes de cierre y saldo por pagar a fin de mes. */
export async function taxSummary(db: Tx | Prisma.TransactionClient, p: { companyIds: string[]; agency: TaxAgency; year: number }) {
  const mapping = await db.accountMapping.findMany({ where: { key: `${TAX_AGENCIES[p.agency].prefix}.payable` } });
  const accounts = [...new Set(mapping.map((m) => m.accountId))];
  const adjustments = new Set((await db.taxDocument.findMany({ where: { kind: 'ADJUSTMENT' }, select: { id: true } })).map((a) => a.id));
  const start = new Date(Date.UTC(p.year, 0, 1));
  const before = await db.journalLine.aggregate({
    where: { companyId: { in: p.companyIds }, accountId: { in: accounts }, entryDate: { lt: start } }, _sum: { amountUsd: true },
  });
  const lines = await db.journalLine.findMany({
    where: { companyId: { in: p.companyIds }, accountId: { in: accounts }, entryDate: { gte: start, lte: new Date(Date.UTC(p.year, 11, 31)) } },
    select: { amountUsd: true, entryDate: true, entry: { select: { documentId: true } } },
  });
  let balance = money(before._sum.amountUsd ?? 0).neg();
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const mine = lines.filter((l) => l.entryDate.getUTCMonth() + 1 === m);
    const isAdj = (l: (typeof mine)[number]) => !!l.entry.documentId && adjustments.has(l.entry.documentId);
    const accrued = mine.filter((l) => !isAdj(l) && money(l.amountUsd).lt(0)).reduce((s, l) => s.minus(money(l.amountUsd)), money(0));
    const paid = mine.filter((l) => !isAdj(l) && money(l.amountUsd).gt(0)).reduce((s, l) => s.plus(money(l.amountUsd)), money(0));
    const adjusted = mine.filter(isAdj).reduce((s, l) => s.minus(money(l.amountUsd)), money(0));
    balance = balance.plus(accrued).minus(paid).plus(adjusted);
    months.push({ month: m, accruedUsd: accrued.toFixed(4), paidUsd: paid.toFixed(4), adjustmentUsd: adjusted.toFixed(4), balanceUsd: balance.toFixed(4) });
  }
  const closings = await db.taxDocument.findMany({
    where: { companyId: { in: p.companyIds }, agency: p.agency, kind: 'ADJUSTMENT', periodTo: { gte: start } },
    include: { document: true }, orderBy: { periodFrom: 'asc' },
  });
  return {
    agency: p.agency, label: TAX_AGENCIES[p.agency].label, closing: TAX_AGENCIES[p.agency].closing, months,
    closings: closings.map((c) => ({
      id: c.id, number: c.document.number, date: isoDate(c.document.docDate), periodFrom: isoDate(c.periodFrom), periodTo: isoDate(c.periodTo),
      declaredUsd: money(c.declaredUsd ?? 0).toFixed(4), accruedUsd: money(c.accruedUsd ?? 0).toFixed(4), adjustmentUsd: money(c.amountUsd).toFixed(4),
    })),
  };
}

// ───────────────────────── Capital ─────────────────────────

/**
 * Aporte (caja o banco contra Capital 600), retiro (al revés) o reparto de utilidades (Utilidades retenidas 630
 * contra la cuenta de pago). Las líneas de capital llevan el socio.
 */
export async function postCapitalMovement(
  tx: Tx,
  p: { companyId: string; partyId: string; kind: CapitalMoveKind; date: string; amountUsd: string; counterAccountId: string; description: string; createdBy?: string | null },
) {
  const amount = roundAmount(money(p.amountUsd));
  if (amount.lte(0)) throw new LedgerError('INVALID_INPUT', 'El importe debe ser positivo');
  const party = await tx.party.findUnique({ where: { id: p.partyId } });
  if (!party) throw new LedgerError('NOT_FOUND', 'Socio no encontrado');
  if (!party.roles.includes('PARTNER')) await upsertParty(tx, { code: party.code, name: party.name, roles: ['PARTNER'] });
  const ctx = { companyId: p.companyId };
  const capital = await resolveMapping(tx, 'equity.capital', ctx);
  const retained = await resolveMapping(tx, 'equity.retained', ctx);
  const label = { CONTRIBUTION: 'Aporte de capital', WITHDRAWAL: 'Retiro de capital', DISTRIBUTION: 'Reparto de utilidades' }[p.kind];
  const memo = `${label} — ${party.name}: ${p.description}`;
  const lines = p.kind === 'CONTRIBUTION'
    ? [usdLine(p.counterAccountId, amount, memo), usdLine(capital, amount.neg(), memo, { partyId: party.id })]
    : p.kind === 'WITHDRAWAL'
      ? [usdLine(capital, amount, memo, { partyId: party.id }), usdLine(p.counterAccountId, amount.neg(), memo)]
      : [usdLine(retained, amount, memo, { partyId: party.id }), usdLine(p.counterAccountId, amount.neg(), memo)];
  const doc = await newDocument(tx, { companyId: p.companyId, date: p.date, docType: 'CAPITAL', prefix: 'CAP', memo, createdBy: p.createdBy });
  const entry = await postEntry(tx, { companyId: p.companyId, entryDate: p.date, kind: 'AUTO', memo, documentId: doc.id, createdBy: p.createdBy ?? null, lines });
  const movement = await tx.capitalMovement.create({
    data: { id: doc.id, companyId: p.companyId, partyId: party.id, kind: p.kind, amountUsd: amount.toFixed(4), counterAccountId: p.counterAccountId, description: p.description },
  });
  return { document: doc, entry, movement };
}

/** Capital (600) y utilidades retenidas (630) por socio a una fecha; lo que no tiene socio (migración, cierres), aparte. */
export async function capitalByPartner(db: Tx | Prisma.TransactionClient, p: { companyIds: string[]; asOf: string }) {
  const keys = ['equity.capital', 'equity.retained'];
  const mappings = await db.accountMapping.findMany({ where: { key: { in: keys } } });
  const capitalIds = mappings.filter((m) => m.key === 'equity.capital').map((m) => m.accountId);
  const retainedIds = mappings.filter((m) => m.key === 'equity.retained').map((m) => m.accountId);
  const groups = await db.journalLine.groupBy({
    by: ['partyId', 'accountId'],
    where: { companyId: { in: p.companyIds }, accountId: { in: [...capitalIds, ...retainedIds] }, entryDate: { lte: toDate(p.asOf) } },
    _sum: { amountUsd: true },
  });
  const parties = new Map((await db.party.findMany({ where: { id: { in: groups.map((g) => g.partyId).filter((x): x is string => !!x) } } })).map((x) => [x.id, x]));
  const rows = new Map<string, { partyId: string | null; name: string; capitalUsd: Money; retainedUsd: Money }>();
  for (const g of groups) {
    const k = g.partyId ?? '';
    const r = rows.get(k) ?? { partyId: g.partyId, name: g.partyId ? parties.get(g.partyId)?.name ?? '?' : 'Sin socio asignado (migración y cierres)', capitalUsd: money(0), retainedUsd: money(0) };
    const v = money(g._sum.amountUsd ?? 0).neg();
    if (capitalIds.includes(g.accountId)) r.capitalUsd = r.capitalUsd.plus(v);
    else r.retainedUsd = r.retainedUsd.plus(v);
    rows.set(k, r);
  }
  const partnersCapital = [...rows.values()].filter((r) => r.partyId).reduce((s, r) => s.plus(r.capitalUsd), money(0));
  return [...rows.values()]
    .sort((a, b) => (a.partyId === null ? 1 : b.partyId === null ? -1 : a.name.localeCompare(b.name)))
    .map((r) => ({
      partyId: r.partyId, name: r.name, capitalUsd: r.capitalUsd.toFixed(4), retainedUsd: r.retainedUsd.toFixed(4),
      sharePct: r.partyId && !partnersCapital.isZero() ? r.capitalUsd.div(partnersCapital).times(100).toFixed(2) : null,
    }));
}

// ───────────────────────── Cierres ─────────────────────────

/**
 * Cierre del ejercicio: el saldo del año de cada cuenta de resultados (por libro y segmento) pasa a Utilidades
 * retenidas (630) en el periodo 13 (31/12), así diciembre conserva su resultado en los informes mensuales. Si el año
 * ya estaba cerrado, se anula el cierre anterior y se rehace. Deja abiertos los periodos del año siguiente.
 */
export async function closeYear(tx: Tx, p: { companyId: string; year: number; createdBy?: string | null }) {
  const previous = await tx.yearClose.findUnique({ where: { companyId_year: { companyId: p.companyId, year: p.year } } });
  if (previous) {
    for (const id of previous.entryIds) await reverseEntry(tx, id, { memo: `Anulación del cierre del ejercicio ${p.year}`, createdBy: p.createdBy ?? null });
    await tx.yearClose.delete({ where: { id: previous.id } });
  }
  const nominal = await tx.account.findMany({ where: { classification: { in: ['CND', 'CNA'] } }, select: { id: true } });
  const retained = await resolveMapping(tx, 'equity.retained', { companyId: p.companyId });
  const rows = await tx.$queryRaw<{ book: Book; account_id: string; segment_key: string; usd: Prisma.Decimal }[]>`
    SELECT lb.book, lb.account_id, lb.segment_key::text AS segment_key, sum(lb.debit_usd - lb.credit_usd) AS usd
    FROM ledger_balance lb
    WHERE lb.company_id = ${p.companyId}::uuid AND lb.year = ${p.year} AND lb.account_id = ANY(${nominal.map((a) => a.id)}::uuid[])
    GROUP BY lb.book, lb.account_id, lb.segment_key
    HAVING sum(lb.debit_usd - lb.credit_usd) <> 0`;
  const NO_SEGMENT = '00000000-0000-0000-0000-000000000000';
  const entryIds: string[] = [];
  let result = money(0);
  const date = `${p.year}-12-31`;
  for (const book of ['BASE', 'REAL', 'FISCAL'] as Book[]) {
    const mine = rows.filter((r) => r.book === book);
    if (!mine.length) continue;
    const memo = `Cierre del ejercicio ${p.year}${book === 'BASE' ? '' : ` (libro ${book === 'REAL' ? 'solo real' : 'solo fiscal'})`}: resultados a Utilidades retenidas`;
    const lines: PostLineInput[] = mine.map((r) => usdLine(r.account_id, money(r.usd).neg(), memo, { segmentId: r.segment_key === NO_SEGMENT ? null : r.segment_key }));
    const net = mine.reduce((s, r) => s.plus(money(r.usd)), money(0));
    if (!roundAmount(net).isZero()) lines.push(usdLine(retained, net, memo));
    const entry = await postEntry(tx, {
      companyId: p.companyId, entryDate: date, periodMonth: 13, book, kind: 'CLOSING', memo, createdBy: p.createdBy ?? null, lines,
    });
    entryIds.push(entry.id);
    if (book !== 'FISCAL') result = result.minus(net);
  }
  const close = await tx.yearClose.create({
    data: { companyId: p.companyId, year: p.year, entryIds, resultUsd: roundAmount(result).toFixed(4), createdBy: p.createdBy ?? null },
  });
  // Apertura: periodos del año siguiente abiertos (el balance arrastra solo; los resultados empiezan en 0).
  for (let month = 1; month <= 12; month++) {
    await tx.fiscalPeriod.upsert({
      where: { companyId_year_month: { companyId: p.companyId, year: p.year + 1, month } }, update: {}, create: { companyId: p.companyId, year: p.year + 1, month },
    });
  }
  return close;
}

export type CloseCheckStatus = 'OK' | 'PENDING' | 'INFO';
export interface CloseCheck { key: string; label: string; status: CloseCheckStatus; detail: string }

/** Lista de comprobación del cierre de un mes para una empresa. */
export async function monthCloseStatus(db: Tx | Prisma.TransactionClient, p: { companyId: string; year: number; month: number }) {
  const from = new Date(Date.UTC(p.year, p.month - 1, 1));
  const eomIso = endOfMonth(p.year, p.month);
  const eom = toDate(eomIso);
  const checks: CloseCheck[] = [];

  // 1. Tasas del último día para las monedas con saldo.
  const currencies = await db.journalLine.groupBy({
    by: ['currency'], where: { companyId: p.companyId, entryDate: { lte: eom }, currency: { not: FUNCTIONAL_CURRENCY } }, _sum: { amount: true },
  });
  const withBalance = currencies.filter((c) => !money(c._sum.amount ?? 0).isZero()).map((c) => c.currency);
  const rated = new Set((await db.exchangeRate.findMany({ where: { rateDate: eom, currency: { in: withBalance } }, select: { currency: true } })).map((r) => r.currency));
  const missing = withBalance.filter((c) => !rated.has(c));
  checks.push({
    key: 'rates', label: 'Tasas de cambio del último día del mes', status: missing.length ? 'PENDING' : 'OK',
    detail: missing.length ? `Falta la tasa del ${eomIso.split('-').reverse().join('/')} de ${missing.join(', ')}` : withBalance.length ? `Hay tasas de ${withBalance.join(', ')}` : 'Sin saldos en otras monedas',
  });

  // 2. Bandeja de revisión del mes.
  const tray = await db.treasuryMovement.count({ where: { needsReview: true, document: { companyId: p.companyId, docDate: { gte: from, lte: eom } } } });
  checks.push({ key: 'tray', label: 'Movimientos de caja y bancos clasificados', status: tray ? 'PENDING' : 'OK', detail: tray ? `${tray} movimientos en la bandeja de revisión` : 'Bandeja vacía' });

  // 3. Interés de préstamos.
  const loans = await db.loan.findMany({
    where: { companyId: p.companyId, status: 'ACTIVE', migrated: false, interestUsd: { gt: 0 }, startDate: { lte: eom }, OR: [{ endDate: null }, { endDate: { gte: from } }] },
    include: { accruals: { where: { year: p.year, month: p.month } } },
  });
  const pendingLoans = loans.filter((l) => !l.accruals.length && loanInterestForMonth(l, p.year, p.month, money(0)).gt(0));
  checks.push({
    key: 'loans', label: 'Interés de préstamos devengado', status: pendingLoans.length ? 'PENDING' : 'OK',
    detail: pendingLoans.length ? `${pendingLoans.length} préstamos sin devengar: ${pendingLoans.map((l) => l.reference).slice(0, 5).join(', ')}` : loans.length ? 'Devengado' : 'Sin préstamos con interés',
  });

  // 4. Revaluación, transitorias y reclasificación por signo (Contabilidad → Revaluación).
  const reval = await db.fxRevaluationRun.findFirst({ where: { companyId: p.companyId, year: p.year, month: p.month } });
  const reclass = await db.signReclassRun.findFirst({ where: { companyId: p.companyId, year: p.year, month: p.month } });
  checks.push({
    key: 'revaluation', label: 'Revaluación y reclasificación por signo', status: reval && reclass ? 'OK' : 'PENDING',
    detail: reval && reclass ? 'Hechas' : `Falta${!reval ? ' la revaluación' : ''}${!reval && !reclass ? ' y' : ''}${!reclass ? ' la reclasificación por signo' : ''}`,
  });

  // 5. Impuestos devengados en el mes (informativo).
  const taxes = await db.taxDocument.count({ where: { companyId: p.companyId, kind: 'ACCRUAL', periodFrom: { lte: eom }, periodTo: { gte: from } } });
  checks.push({ key: 'taxes', label: 'Impuestos devengados', status: 'INFO', detail: taxes ? `${taxes} devengos en el mes` : 'Sin devengos registrados en el mes (la ONAT de las ventas se devenga con cada factura)' });

  // 6. Estado del periodo.
  const period = await db.fiscalPeriod.findUnique({ where: { companyId_year_month: { companyId: p.companyId, year: p.year, month: p.month } } });
  checks.push({
    key: 'period', label: 'Periodo cerrado', status: period?.status === 'LOCKED' ? 'OK' : 'PENDING',
    detail: period?.status === 'LOCKED' ? 'Bloqueado' : period?.status === 'SOFT_CLOSED' ? 'En revisión de cierre: falta bloquearlo' : 'Abierto',
  });
  return { year: p.year, month: p.month, periodStatus: period?.status ?? 'OPEN', checks };
}
