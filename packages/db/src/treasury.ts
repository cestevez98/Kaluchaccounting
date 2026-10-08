import { FUNCTIONAL_CURRENCY, money, roundAmount, sum, toAmountString, toUsd } from '@kaluch/shared';
import type { MovementKind } from '@prisma/client';
import type { Tx } from './client';
import { LedgerError } from './errors';
import { defaultRateType, findRate, isoDate, toDate } from './fx';
import { nextNumber, postEntry, resolveMapping, reverseEntry, type PostLineInput } from './ledger';

export interface TreasuryLegInput {
  treasuryAccountId: string;
  /** + entrada / − salida, en la moneda de la cuenta. */
  amount: string;
  /** Tasa explícita; si no, la vigente del tipo de la cuenta. */
  rate?: string;
}

export interface TreasuryMovementInput {
  companyId: string;
  /** AAAA-MM-DD */
  date: string;
  kind: MovementKind;
  description: string;
  categoryId?: string | null;
  counterAccountId?: string | null;
  segmentId?: string | null;
  posId?: string | null;
  sourceReference?: string | null;
  importRowId?: string | null;
  createdBy?: string | null;
  /** Contraparte (para movimientos con contrapartida en una cuenta de terceros). */
  partyId?: string | null;
  legs: TreasuryLegInput[];
}

/**
 * Contabiliza un movimiento de tesorería (documento + patas + asiento).
 * - MOVEMENT: patas contra la cuenta de la categoría (o la indicada). Sin cuenta → bandeja de revisión.
 * - EXCHANGE / TRANSFER con varias patas: la diferencia en USD es diferencia de cambio realizada (845/924).
 * - EXCHANGE / TRANSFER con una sola pata: contra la transitoria correspondiente, a casar con la otra pata.
 * - OPENING: contra "Saldos de apertura pendientes de distribuir".
 */
export async function postTreasuryMovement(tx: Tx, input: TreasuryMovementInput) {
  if (input.legs.length === 0) throw new LedgerError('INVALID_INPUT', 'El movimiento no tiene importes');
  const date = toDate(input.date);
  const company = await tx.company.findUnique({ where: { id: input.companyId } });
  if (!company) throw new LedgerError('NOT_FOUND', 'Empresa no encontrada');
  const accounts = await tx.treasuryAccount.findMany({
    where: { id: { in: input.legs.map((l) => l.treasuryAccountId) } },
    include: { glAccount: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const legs = [];
  for (const l of input.legs) {
    const acc = byId.get(l.treasuryAccountId);
    if (!acc) throw new LedgerError('NOT_FOUND', 'Cuenta de tesorería no encontrada');
    if (acc.companyId !== input.companyId) {
      throw new LedgerError('INVALID_INPUT', `La cuenta ${acc.name} pertenece a otra empresa`);
    }
    if (money(l.amount).isZero()) continue;
    let rate = '1';
    let rateType: string | null = null;
    if (acc.currency !== FUNCTIONAL_CURRENCY) {
      rateType = acc.glAccount.revalRateType ?? (await defaultRateType(tx, acc.currency, date));
      rate = l.rate ?? (await findRate(tx, date, acc.currency, rateType)).rate.toString();
    }
    legs.push({ acc, amount: toAmountString(l.amount), rate, rateType, usd: toUsd(l.amount, rate) });
  }
  if (legs.length === 0) throw new LedgerError('INVALID_INPUT', 'El movimiento no tiene importes distintos de 0');

  const category = input.categoryId ? await tx.cashCategory.findUnique({ where: { id: input.categoryId } }) : null;
  const net = roundAmount(sum(legs.map((l) => l.usd)));
  let needsReview = false;
  let partyId: string | null = input.partyId ?? null;
  const counterLines: PostLineInput[] = [];
  const multi = legs.length > 1;

  if (!net.isZero()) {
    let counterAccountId: string;
    if ((input.kind === 'EXCHANGE' || input.kind === 'TRANSFER') && multi) {
      const base = input.kind === 'EXCHANGE' ? 'fx.realized.exchange' : 'fx.realized.transfer';
      // net > 0: entra más valor del que sale → ganancia (Haber); net < 0 → pérdida (Debe).
      counterAccountId = await resolveMapping(tx, `${base}.${net.gt(0) ? 'gain' : 'loss'}`, { companyId: input.companyId });
    } else if (input.kind === 'OPENING') {
      counterAccountId = await resolveMapping(tx, 'opening.balance', { companyId: input.companyId });
    } else if (input.counterAccountId) {
      counterAccountId = input.counterAccountId;
    } else if (input.kind === 'EXCHANGE' || category?.kind === 'EXCHANGE') {
      counterAccountId = await resolveMapping(tx, 'treasury.exchange.transit', { companyId: input.companyId });
    } else if (input.kind === 'TRANSFER' || category?.kind === 'TRANSFER') {
      counterAccountId = await resolveMapping(tx, 'treasury.transfer.transit', { companyId: input.companyId });
    } else if (category?.partyAccountId) {
      counterAccountId = '';
    } else if (category?.accountId) {
      counterAccountId = category.accountId;
    } else {
      counterAccountId = await resolveMapping(tx, 'treasury.suspense', { companyId: input.companyId });
      needsReview = true;
    }
    if (category?.partyAccountId && !counterAccountId) {
      // Categoría de contraparte: la contrapartida es su cuenta corriente, en su moneda.
      const pa = await tx.partyAccount.findUniqueOrThrow({ where: { id: category.partyAccountId } });
      if (pa.companyId !== input.companyId) {
        throw new LedgerError('INVALID_INPUT', `La cuenta corriente de la categoría ${category.name} es de otra empresa`);
      }
      partyId = pa.partyId;
      if (pa.currency === FUNCTIONAL_CURRENCY) {
        counterLines.push({ accountId: pa.accountId, currency: FUNCTIONAL_CURRENCY, amount: net.neg().toFixed(4), partyId, segmentId: input.segmentId ?? category.segmentId ?? null, memo: input.description.slice(0, 500) });
      } else {
        if (legs.some((l) => l.acc.currency !== pa.currency)) {
          throw new LedgerError('INVALID_INPUT', `La cuenta corriente de ${category.name} está en ${pa.currency}: el movimiento debe ser en esa moneda`);
        }
        for (const l of legs) {
          counterLines.push({ accountId: pa.accountId, currency: pa.currency, amount: money(l.amount).neg().toFixed(4), rate: l.rate, rateType: l.rateType ?? undefined, partyId, segmentId: input.segmentId ?? category.segmentId ?? null, memo: input.description.slice(0, 500) });
        }
      }
    } else {
      counterLines.push({
        accountId: counterAccountId,
        currency: FUNCTIONAL_CURRENCY,
        amount: net.neg().toFixed(4),
        segmentId: input.segmentId ?? category?.segmentId ?? null,
        posId: input.posId ?? null,
        memo: input.description.slice(0, 500),
      });
    }
  }

  const year = date.getUTCFullYear();
  const seq = await nextNumber(tx, input.companyId, year, 'TES');
  const doc = await tx.document.create({
    data: {
      companyId: input.companyId,
      docType: 'TREASURY',
      number: `${company.code}-TES-${year}-${String(seq).padStart(6, '0')}`,
      docDate: date,
      memo: input.description.slice(0, 500),
      importRowId: input.importRowId ?? null,
      createdBy: input.createdBy ?? null,
    },
  });

  const entry = await postEntry(tx, {
    companyId: input.companyId,
    entryDate: input.date,
    kind: input.kind === 'OPENING' ? 'OPENING' : 'AUTO',
    memo: input.description.slice(0, 500) || doc.number,
    documentId: doc.id,
    createdBy: input.createdBy ?? null,
    lines: [
      ...legs.map((l) => ({
        accountId: l.acc.glAccountId,
        currency: l.acc.currency,
        amount: l.amount,
        rate: l.rate,
        rateType: l.rateType ?? undefined,
        treasuryAccountId: l.acc.id,
        segmentId: input.segmentId ?? category?.segmentId ?? null,
        cashFlowCategory: category?.cashFlowCategory ?? null,
        memo: input.description.slice(0, 500),
      })),
      ...counterLines,
    ],
  });

  const movement = await tx.treasuryMovement.create({
    data: {
      id: doc.id,
      kind: input.kind,
      categoryId: category?.id ?? null,
      counterAccountId: counterLines[0]?.accountId ?? null,
      segmentId: input.segmentId ?? null,
      posId: input.posId ?? null,
      description: input.description,
      sourceReference: input.sourceReference ?? null,
      partyId,
      needsReview,
      entryId: entry.id,
      legs: {
        create: legs.map((l) => ({
          treasuryAccountId: l.acc.id,
          amount: l.amount,
          currency: l.acc.currency,
          rate: l.rate,
          amountUsd: l.usd.toFixed(4),
          valueDate: date,
        })),
      },
    },
  });
  return { document: doc, movement, entry };
}

/** Anula un movimiento: contra-asiento y documento VOIDED. */
export async function voidTreasuryMovement(tx: Tx, id: string, opts: { createdBy?: string | null; memo?: string }) {
  const m = await tx.treasuryMovement.findUnique({ where: { id }, include: { document: true } });
  if (!m || !m.entryId) throw new LedgerError('NOT_FOUND', 'Movimiento no encontrado');
  if (m.document.status === 'VOIDED') throw new LedgerError('ALREADY_REVERSED', `El movimiento ${m.document.number} ya está anulado`);
  const rev = await reverseEntry(tx, m.entryId, { createdBy: opts.createdBy, memo: opts.memo ?? `Anulación de ${m.document.number}` });
  await tx.document.update({ where: { id }, data: { status: 'VOIDED' } });
  return rev;
}

/**
 * Reclasifica un movimiento de la bandeja: traslada su contrapartida desde la
 * cuenta "Pendiente de clasificar" a la cuenta elegida con un asiento de ajuste.
 */
export async function reclassifyMovement(
  tx: Tx,
  id: string,
  opts: {
    accountId: string; categoryId?: string | null; partyId?: string | null; note?: string; userId?: string | null;
    /** Permite reclasificar un movimiento ya clasificado (migración). */
    allowResolved?: boolean;
  },
) {
  const m = await tx.treasuryMovement.findUnique({ where: { id }, include: { document: true } });
  if (!m || !m.entryId) throw new LedgerError('NOT_FOUND', 'Movimiento no encontrado');
  if (!m.needsReview && !opts.allowResolved) throw new LedgerError('INVALID_INPUT', `El movimiento ${m.document.number} no está pendiente de revisión`);
  // Importe en la contrapartida actual: el asiento del movimiento y, si ya se reclasificó, sus reclasificaciones.
  const lines = await tx.journalLine.findMany({
    where: { accountId: m.counterAccountId ?? undefined, OR: [{ entryId: m.entryId }, { entry: { documentId: m.id } }] },
  });
  const amountUsd = roundAmount(sum(lines.map((l) => l.amountUsd)));
  if (!amountUsd.isZero()) {
    const period = await tx.fiscalPeriod.findUnique({
      where: { companyId_year_month: { companyId: m.document.companyId, year: m.document.docDate.getUTCFullYear(), month: m.document.docDate.getUTCMonth() + 1 } },
    });
    let date = isoDate(m.document.docDate);
    if (period && period.status !== 'OPEN') {
      const firstOpen = await tx.fiscalPeriod.findFirst({
        where: { companyId: m.document.companyId, status: 'OPEN', month: { gte: 1, lte: 12 }, OR: [{ year: { gt: period.year } }, { year: period.year, month: { gt: period.month } }] },
        orderBy: [{ year: 'asc' }, { month: 'asc' }],
      });
      if (!firstOpen) throw new LedgerError('PERIOD_CLOSED', 'No hay un periodo abierto para registrar la reclasificación');
      date = `${firstOpen.year}-${String(firstOpen.month).padStart(2, '0')}-01`;
    }
    await postEntry(tx, {
      companyId: m.document.companyId,
      entryDate: date,
      kind: 'AUTO',
      memo: `Reclasificación de ${m.document.number}: ${m.description}`.slice(0, 500),
      documentId: m.id,
      createdBy: opts.userId ?? null,
      lines: [
        { accountId: opts.accountId, currency: FUNCTIONAL_CURRENCY, amount: amountUsd.toFixed(4), segmentId: lines[0]?.segmentId ?? null, partyId: opts.partyId ?? null },
        { accountId: m.counterAccountId!, currency: FUNCTIONAL_CURRENCY, amount: amountUsd.neg().toFixed(4) },
      ],
    });
  }
  return tx.treasuryMovement.update({
    where: { id },
    data: {
      needsReview: false,
      counterAccountId: opts.accountId,
      categoryId: opts.categoryId ?? m.categoryId,
      partyId: opts.partyId ?? m.partyId,
      reviewNote: opts.note ?? null,
      resolvedAt: new Date(),
      resolvedBy: opts.userId ?? null,
    },
  });
}
