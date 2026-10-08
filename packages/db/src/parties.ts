import { endOfMonth, FUNCTIONAL_CURRENCY, money, roundAmount, sum, toAmountString, toUsd } from '@kaluch/shared';
import type { OpenItemSide, PartyDocKind, Prisma } from '@prisma/client';
import type { Tx } from './client';
import { LedgerError } from './errors';
import { defaultRateType, findRate, isoDate, toDate } from './fx';
import { nextNumber, postEntry, resolveMapping, type PostLineInput } from './ledger';

/** Puente de la migración: contrapartida de los documentos de deuda importados del Excel. */
export const PARTY_BRIDGE_MAPPING = 'party.migration.bridge';

export interface PartyDocumentInput {
  partyAccountId: string;
  /** AAAA-MM-DD */
  date: string;
  kind: PartyDocKind;
  /** Importe con signo en la moneda de la cuenta corriente: + Debe (nos deben más) / − Haber (les debemos más). */
  amount: string;
  /** Tasa explícita; si no, la vigente del tipo de tasa de la cuenta. */
  rate?: string;
  /** Contrapartida. Si no se indica: apertura → 699.9997; resto → obligatoria. */
  counterAccountId?: string | null;
  /** Línea adicional con otra contraparte (cesión de deuda): misma moneda, importe opuesto. */
  counterPartyAccountId?: string | null;
  description: string;
  reference?: string | null;
  dueDate?: string | null;
  /** Crea una partida abierta por el importe. */
  openItem?: boolean;
  segmentId?: string | null;
  importRowId?: string | null;
  createdBy?: string | null;
}

async function rateFor(tx: Tx, accountId: string, currency: string, date: Date, explicit?: string) {
  if (currency === FUNCTIONAL_CURRENCY) return { rate: '1', rateType: null as string | null };
  const acc = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
  const rateType = acc.revalRateType ?? (await defaultRateType(tx, currency, date));
  const rate = explicit ?? (await findRate(tx, date, currency, rateType)).rate.toString();
  return { rate, rateType };
}

/**
 * Contabiliza un documento de contraparte (cargo, abono, cesión, apertura o nómina):
 * documento + detalle + asiento, y opcionalmente una partida abierta.
 */
export async function postPartyDocument(tx: Tx, input: PartyDocumentInput) {
  const amount = money(input.amount);
  if (amount.isZero()) throw new LedgerError('INVALID_INPUT', 'El importe no puede ser 0');
  const pa = await tx.partyAccount.findUnique({ where: { id: input.partyAccountId }, include: { party: true, company: true } });
  if (!pa) throw new LedgerError('NOT_FOUND', 'Cuenta corriente no encontrada');
  if (!pa.active) throw new LedgerError('INVALID_INPUT', `La cuenta corriente ${pa.name} está inactiva`);
  const date = toDate(input.date);
  const { rate, rateType } = await rateFor(tx, pa.accountId, pa.currency, date, input.rate);
  const usd = roundAmount(toUsd(amount, rate));

  const lines: PostLineInput[] = [{
    accountId: pa.accountId, currency: pa.currency, amount: toAmountString(amount), rate, rateType: rateType ?? undefined,
    partyId: pa.partyId, segmentId: input.segmentId ?? null, memo: input.description.slice(0, 500),
  }];
  let counterAccountId: string | null = null;
  if (input.counterPartyAccountId) {
    const other = await tx.partyAccount.findUnique({ where: { id: input.counterPartyAccountId } });
    if (!other) throw new LedgerError('NOT_FOUND', 'Cuenta corriente de destino no encontrada');
    if (other.companyId !== pa.companyId) throw new LedgerError('INVALID_INPUT', 'Las dos cuentas corrientes deben ser de la misma empresa');
    if (other.currency !== pa.currency) throw new LedgerError('INVALID_INPUT', 'Las dos cuentas corrientes deben estar en la misma moneda');
    if (other.id === pa.id) throw new LedgerError('INVALID_INPUT', 'La cuenta de origen y la de destino son la misma');
    counterAccountId = other.accountId;
    lines.push({
      accountId: other.accountId, currency: other.currency, amount: toAmountString(amount.neg()), rate, rateType: rateType ?? undefined,
      partyId: other.partyId, segmentId: input.segmentId ?? null, memo: input.description.slice(0, 500),
    });
  } else {
    counterAccountId = input.counterAccountId
      ?? (input.kind === 'OPENING' ? await resolveMapping(tx, 'opening.balance', { companyId: pa.companyId }) : null);
    if (!counterAccountId) throw new LedgerError('INVALID_INPUT', 'Indica la cuenta de contrapartida');
    if (counterAccountId === pa.accountId) throw new LedgerError('INVALID_INPUT', 'La contrapartida no puede ser la propia cuenta de la contraparte');
    lines.push({
      accountId: counterAccountId, currency: FUNCTIONAL_CURRENCY, amount: usd.neg().toFixed(4),
      segmentId: input.segmentId ?? null, memo: input.description.slice(0, 500),
    });
  }

  const year = date.getUTCFullYear();
  const seq = await nextNumber(tx, pa.companyId, year, 'CTE');
  const doc = await tx.document.create({
    data: {
      companyId: pa.companyId, docType: `PARTY_${input.kind}`,
      number: `${pa.company.code}-CTE-${year}-${String(seq).padStart(6, '0')}`,
      docDate: date, memo: input.description.slice(0, 500), importRowId: input.importRowId ?? null, createdBy: input.createdBy ?? null,
    },
  });
  const entry = await postEntry(tx, {
    companyId: pa.companyId, entryDate: input.date, kind: input.kind === 'OPENING' ? 'OPENING' : 'AUTO',
    memo: `${pa.party.name}: ${input.description}`.slice(0, 500), documentId: doc.id, createdBy: input.createdBy ?? null,
    lines,
  });
  const partyDocument = await tx.partyDocument.create({
    data: {
      id: doc.id, partyAccountId: pa.id, kind: input.kind, amount: toAmountString(amount), currency: pa.currency, rate,
      amountUsd: usd.toFixed(4), counterAccountId, reference: input.reference ?? null,
      dueDate: input.dueDate ? toDate(input.dueDate) : null, description: input.description, entryId: entry.id,
    },
  });
  let openItem = null;
  if (input.openItem) {
    openItem = await createOpenItem(tx, {
      partyAccountId: pa.id, documentId: doc.id, date: input.date, dueDate: input.dueDate ?? null,
      amount: toAmountString(amount), amountUsd: usd.toFixed(4), reference: input.reference ?? doc.number, description: input.description,
    });
  }
  return { document: doc, partyDocument, entry, openItem };
}

/** Crea una partida abierta (importe con signo: + por cobrar / − por pagar). */
export async function createOpenItem(
  tx: Tx,
  p: { partyAccountId: string; documentId: string; date: string; dueDate?: string | null; amount: string; amountUsd: string; reference: string; description: string },
) {
  const pa = await tx.partyAccount.findUniqueOrThrow({ where: { id: p.partyAccountId } });
  const amount = money(p.amount);
  if (amount.isZero()) throw new LedgerError('INVALID_INPUT', 'Una partida abierta no puede ser de importe 0');
  const side: OpenItemSide = amount.gt(0) ? 'RECEIVABLE' : 'PAYABLE';
  return tx.openItem.create({
    data: {
      companyId: pa.companyId, partyId: pa.partyId, partyAccountId: pa.id, documentId: p.documentId, side,
      reference: p.reference, docDate: toDate(p.date), dueDate: p.dueDate ? toDate(p.dueDate) : null, currency: pa.currency,
      amount: amount.abs().toFixed(4), amountUsd: money(p.amountUsd).abs().toFixed(4), openAmount: amount.abs().toFixed(4),
      description: p.description.slice(0, 500),
    },
  });
}

/**
 * Liquida (total o parcialmente) una partida abierta con un pago ya contabilizado
 * (movimiento de tesorería o documento de contraparte) o la da por cerrada (WRITE_OFF).
 */
export async function settleOpenItem(
  tx: Tx,
  p: { openItemId: string; amount: string; date: string; kind?: 'PAYMENT' | 'WRITE_OFF'; paymentDocumentId?: string | null; note?: string | null; createdBy?: string | null },
) {
  const item = await tx.openItem.findUnique({ where: { id: p.openItemId } });
  if (!item) throw new LedgerError('NOT_FOUND', 'Partida abierta no encontrada');
  if (item.status === 'SETTLED' || item.status === 'CANCELLED') throw new LedgerError('INVALID_INPUT', `La partida ${item.reference} ya está cerrada`);
  const amount = money(p.amount);
  if (amount.lte(0)) throw new LedgerError('INVALID_INPUT', 'El importe a liquidar debe ser positivo');
  if (amount.gt(money(item.openAmount))) {
    throw new LedgerError('INVALID_INPUT', `El importe supera el pendiente de la partida ${item.reference} (${money(item.openAmount).toFixed(2)})`);
  }
  if (p.paymentDocumentId) {
    const doc = await tx.document.findUnique({ where: { id: p.paymentDocumentId } });
    if (!doc) throw new LedgerError('NOT_FOUND', 'Documento de pago no encontrado');
    if (doc.status === 'VOIDED') throw new LedgerError('INVALID_INPUT', `El pago ${doc.number} está anulado`);
  }
  const usdAtBooked = roundAmount(money(item.amountUsd).times(amount).div(money(item.amount)));
  let usdAtPayment = usdAtBooked;
  if (item.currency !== FUNCTIONAL_CURRENCY) {
    const acc = await tx.partyAccount.findUniqueOrThrow({ where: { id: item.partyAccountId }, include: { account: true } });
    const rateType = acc.account.revalRateType ?? (await defaultRateType(tx, item.currency, toDate(p.date)));
    usdAtPayment = roundAmount(toUsd(amount, (await findRate(tx, toDate(p.date), item.currency, rateType)).rate.toString()));
  }
  const settlement = await tx.settlement.create({
    data: {
      openItemId: item.id, kind: p.kind ?? 'PAYMENT', paymentDocumentId: p.paymentDocumentId ?? null, date: toDate(p.date),
      amount: amount.toFixed(4), usdAtBooked: usdAtBooked.toFixed(4), usdAtPayment: usdAtPayment.toFixed(4),
      note: p.note ?? null, createdBy: p.createdBy ?? null,
    },
  });
  const open = money(item.openAmount).minus(amount);
  await tx.openItem.update({
    where: { id: item.id },
    data: { openAmount: open.toFixed(4), status: open.isZero() ? 'SETTLED' : 'PARTIAL' },
  });
  return settlement;
}

/** Deshace una liquidación (la partida vuelve a quedar pendiente por ese importe). */
export async function voidSettlement(tx: Tx, settlementId: string) {
  const s = await tx.settlement.findUnique({ where: { id: settlementId }, include: { openItem: true } });
  if (!s) throw new LedgerError('NOT_FOUND', 'Liquidación no encontrada');
  if (s.voided) throw new LedgerError('ALREADY_REVERSED', 'La liquidación ya está anulada');
  await tx.settlement.update({ where: { id: s.id }, data: { voided: true } });
  const open = money(s.openItem.openAmount).plus(money(s.amount));
  return tx.openItem.update({
    where: { id: s.openItemId },
    data: { openAmount: open.toFixed(4), status: open.eq(money(s.openItem.amount)) ? 'OPEN' : 'PARTIAL' },
  });
}

interface PartyBalanceRow {
  account_id: string;
  party_id: string;
  currency: string;
  orig: Prisma.Decimal;
  usd: Prisma.Decimal;
}

/**
 * Reclasificación de fin de mes por signo: el saldo neto de cada cuenta corriente con cuenta
 * opuesta se deja entero en la cuenta que corresponde a su signo (135.x si nos deben, 405.x si
 * debemos), igual que el BC del Excel. Cada ejecución contabiliza solo lo que falta mover, así
 * que repetir un mes es idempotente. Al reclasificar un mes se recalculan los meses posteriores
 * que ya tenían reclasificación.
 */
export async function reclassifyBySign(tx: Tx, companyId: string, year: number, month: number, userId?: string | null) {
  const result = await reclassifyMonth(tx, companyId, year, month, userId);
  const later = await tx.signReclassRun.findMany({
    where: { companyId, status: 'POSTED', OR: [{ year: { gt: year } }, { year, month: { gt: month } }] },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
    distinct: ['year', 'month'],
  });
  for (const r of later) await reclassifyMonth(tx, companyId, r.year, r.month, userId);
  return result;
}

async function reclassifyMonth(tx: Tx, companyId: string, year: number, month: number, userId?: string | null) {
  const eom = endOfMonth(year, month);
  const pairs = await tx.partyAccount.findMany({
    where: { companyId, oppositeAccountId: { not: null } },
    include: { account: true, party: true },
  });
  const run = await tx.signReclassRun.create({ data: { companyId, year, month, createdBy: userId ?? null } });
  if (pairs.length === 0) return { run, entry: null, movedUsd: '0.0000' };
  const accountIds = [...new Set(pairs.flatMap((p) => [p.accountId, p.oppositeAccountId!]))];
  const rows = await tx.$queryRaw<PartyBalanceRow[]>`
    SELECT jl.account_id, jl.party_id, jl.currency, sum(jl.amount) AS orig, sum(jl.amount_usd) AS usd
    FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
    WHERE jl.company_id = ${companyId}::uuid AND je.book = 'BASE' AND jl.entry_date <= ${toDate(eom)}::date
      AND jl.account_id = ANY(${accountIds}::uuid[]) AND jl.party_id IS NOT NULL
    GROUP BY jl.account_id, jl.party_id, jl.currency`;
  const bal = new Map(rows.map((r) => [`${r.account_id}|${r.party_id}|${r.currency}`, r]));
  const get = (acc: string, party: string, cur: string) => {
    const r = bal.get(`${acc}|${party}|${cur}`);
    return { orig: money(r?.orig ?? 0), usd: money(r?.usd ?? 0) };
  };

  const lines: PostLineInput[] = [];
  let moved = money(0);
  for (const p of pairs) {
    const main = get(p.accountId, p.partyId, p.currency);
    const opp = get(p.oppositeAccountId!, p.partyId, p.currency);
    const netOrig = main.orig.plus(opp.orig);
    const netUsd = main.usd.plus(opp.usd);
    const sign = !netOrig.isZero() ? netOrig.s : netUsd.isZero() ? 0 : netUsd.s;
    // Naturaleza de la cuenta principal: deudora (+) o acreedora (−).
    const mainSign = p.account.nature === 'ACREEDORA' ? -1 : 1;
    const toMain = sign === 0 || sign === mainSign;
    const from = toMain ? { id: p.oppositeAccountId!, ...opp } : { id: p.accountId, ...main };
    const to = toMain ? p.accountId : p.oppositeAccountId!;
    if (roundAmount(from.orig).isZero() && roundAmount(from.usd).isZero()) continue;
    const memo = `Reclasificación por signo ${p.party.name} ${String(month).padStart(2, '0')}/${year}`;
    lines.push(
      { accountId: from.id, currency: p.currency, amount: roundAmount(from.orig).neg().toFixed(4), amountUsd: roundAmount(from.usd).neg().toFixed(4), partyId: p.partyId, memo },
      { accountId: to, currency: p.currency, amount: roundAmount(from.orig).toFixed(4), amountUsd: roundAmount(from.usd).toFixed(4), partyId: p.partyId, memo },
    );
    moved = moved.plus(roundAmount(from.usd).abs());
  }
  if (lines.length === 0) return { run, entry: null, movedUsd: '0.0000' };
  const entry = await postEntry(tx, {
    companyId, entryDate: eom, kind: 'RECLASS', documentId: run.id, createdBy: userId ?? null,
    memo: `Reclasificación de saldos de contrapartes por signo ${String(month).padStart(2, '0')}/${year}`, lines,
  });
  await tx.signReclassRun.update({ where: { id: run.id }, data: { entryId: entry.id, movedUsd: moved.toFixed(4) } });
  return { run, entry, movedUsd: moved.toFixed(4) };
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

/**
 * Estado de cuenta de una contraparte: saldo inicial, movimientos y saldo final por moneda,
 * sumando su cuenta principal y la opuesta (sin las reclasificaciones por signo).
 */
export async function partyStatement(
  tx: Tx | Prisma.TransactionClient,
  p: { partyId: string; companyIds: string[]; from: string; to: string; currency?: string | null },
) {
  const accounts = await tx.partyAccount.findMany({ where: { partyId: p.partyId, companyId: { in: p.companyIds } } });
  const accountIds = [...new Set(accounts.flatMap((a) => [a.accountId, ...(a.oppositeAccountId ? [a.oppositeAccountId] : [])]))];
  if (accountIds.length === 0) return { currencies: [] as { currency: string; opening: string; openingUsd: string; closing: string; closingUsd: string; lines: StatementLine[] }[] };
  const where = {
    partyId: p.partyId, companyId: { in: p.companyIds }, accountId: { in: accountIds },
    ...(p.currency ? { currency: p.currency } : {}),
    entry: { book: 'BASE' as const, kind: { not: 'RECLASS' as const } },
  };
  const openingRows = await tx.journalLine.groupBy({
    by: ['currency'], where: { ...where, entryDate: { lt: toDate(p.from) } }, _sum: { amount: true, amountUsd: true },
  });
  const lines = await tx.journalLine.findMany({
    where: { ...where, entryDate: { gte: toDate(p.from), lte: toDate(p.to) } },
    include: { entry: true, account: true },
    orderBy: [{ entryDate: 'asc' }, { entry: { number: 'asc' } }, { lineNo: 'asc' }],
  });
  const currencies = [...new Set([...openingRows.map((r) => r.currency), ...lines.map((l) => l.currency)])].sort();
  return {
    currencies: currencies.map((currency) => {
      const o = openingRows.find((r) => r.currency === currency);
      let bal = money(o?._sum.amount ?? 0);
      let balUsd = money(o?._sum.amountUsd ?? 0);
      const opening = bal;
      const openingUsd = balUsd;
      const out: StatementLine[] = [];
      for (const l of lines.filter((x) => x.currency === currency)) {
        bal = bal.plus(money(l.amount));
        balUsd = balUsd.plus(money(l.amountUsd));
        out.push({
          date: isoDate(l.entryDate), entryNumber: l.entry.number, documentId: l.entry.documentId, memo: l.memo ?? l.entry.memo,
          accountCode: l.account.displayCode, currency, amount: money(l.amount).toFixed(4), amountUsd: money(l.amountUsd).toFixed(4),
          balance: bal.toFixed(4), balanceUsd: balUsd.toFixed(4),
        });
      }
      return { currency, opening: opening.toFixed(4), openingUsd: openingUsd.toFixed(4), closing: bal.toFixed(4), closingUsd: balUsd.toFixed(4), lines: out };
    }),
  };
}

export interface PartyBalance {
  partyAccountId: string;
  partyId: string;
  partyCode: string;
  partyName: string;
  roles: string[];
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

/** Saldos de las cuentas corrientes a una fecha (+ nos deben / − debemos). */
export async function partyBalances(
  tx: Tx | Prisma.TransactionClient,
  p: { companyIds: string[]; asOf: string; partyId?: string | null },
): Promise<PartyBalance[]> {
  const accounts = await tx.partyAccount.findMany({
    where: { companyId: { in: p.companyIds }, ...(p.partyId ? { partyId: p.partyId } : {}) },
    include: { party: true, company: true, account: true, oppositeAccount: true },
    orderBy: [{ party: { name: 'asc' } }, { currency: 'asc' }],
  });
  if (accounts.length === 0) return [];
  const accountIds = [...new Set(accounts.flatMap((a) => [a.accountId, ...(a.oppositeAccountId ? [a.oppositeAccountId] : [])]))];
  const rows = await tx.$queryRaw<PartyBalanceRow[]>`
    SELECT jl.account_id, jl.party_id, jl.currency, sum(jl.amount) AS orig, sum(jl.amount_usd) AS usd
    FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
    WHERE jl.company_id = ANY(${p.companyIds}::uuid[]) AND je.book = 'BASE' AND jl.entry_date <= ${toDate(p.asOf)}::date
      AND jl.account_id = ANY(${accountIds}::uuid[]) AND jl.party_id IS NOT NULL
    GROUP BY jl.account_id, jl.party_id, jl.currency`;
  const items = await tx.openItem.groupBy({
    by: ['partyAccountId'], where: { partyAccountId: { in: accounts.map((a) => a.id) }, status: { in: ['OPEN', 'PARTIAL'] } },
    _count: true, _min: { docDate: true },
  });
  return accounts.map((a) => {
    const mine = rows.filter((r) => r.party_id === a.partyId && r.currency === a.currency && (r.account_id === a.accountId || r.account_id === a.oppositeAccountId));
    const it = items.find((i) => i.partyAccountId === a.id);
    return {
      partyAccountId: a.id, partyId: a.partyId, partyCode: a.party.code, partyName: a.party.name, roles: a.party.roles,
      companyId: a.companyId, companyCode: a.company.code, currency: a.currency, accountCode: a.account.displayCode,
      oppositeCode: a.oppositeAccount?.displayCode ?? null,
      balance: sum(mine.map((r) => r.orig)).toFixed(4), balanceUsd: sum(mine.map((r) => r.usd)).toFixed(4),
      openItems: it?._count ?? 0, oldestOpen: it?._min.docDate ? isoDate(it._min.docDate) : null,
    };
  });
}

export const AGING_BUCKETS = [
  { key: 'current', label: '0–30 días', max: 30 },
  { key: 'd60', label: '31–60 días', max: 60 },
  { key: 'd90', label: '61–90 días', max: 90 },
  { key: 'older', label: 'Más de 90 días', max: Number.POSITIVE_INFINITY },
] as const;

/** Antigüedad de partidas abiertas (por fecha de vencimiento o, si no tiene, de documento). */
export async function openItemAging(
  tx: Tx | Prisma.TransactionClient,
  p: { companyIds: string[]; side: OpenItemSide; asOf: string },
) {
  const items = await tx.openItem.findMany({
    where: { companyId: { in: p.companyIds }, side: p.side, status: { in: ['OPEN', 'PARTIAL'] }, docDate: { lte: toDate(p.asOf) } },
    include: { party: true },
  });
  const asOf = toDate(p.asOf).getTime();
  const byParty = new Map<string, { partyId: string; partyName: string; currency: string; buckets: Record<string, ReturnType<typeof money>>; total: ReturnType<typeof money>; totalUsd: ReturnType<typeof money> }>();
  for (const it of items) {
    const ref = (it.dueDate ?? it.docDate).getTime();
    const days = Math.max(0, Math.floor((asOf - ref) / 86_400_000));
    const bucket = AGING_BUCKETS.find((b) => days <= b.max)!.key;
    const key = `${it.partyId}|${it.currency}`;
    const row = byParty.get(key) ?? {
      partyId: it.partyId, partyName: it.party.name, currency: it.currency,
      buckets: Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, money(0)])), total: money(0), totalUsd: money(0),
    };
    const open = money(it.openAmount);
    row.buckets[bucket] = row.buckets[bucket]!.plus(open);
    row.total = row.total.plus(open);
    row.totalUsd = row.totalUsd.plus(money(it.amountUsd).times(open).div(money(it.amount)));
    byParty.set(key, row);
  }
  return [...byParty.values()]
    .sort((a, b) => b.totalUsd.cmp(a.totalUsd))
    .map((r) => ({
      partyId: r.partyId, partyName: r.partyName, currency: r.currency,
      buckets: Object.fromEntries(Object.entries(r.buckets).map(([k, v]) => [k, v.toFixed(4)])),
      total: r.total.toFixed(4), totalUsd: roundAmount(r.totalUsd).toFixed(4),
    }));
}

export interface PayrollInput {
  partyAccountId: string;
  date: string;
  period: string;
  employer: string;
  concept: string;
  gross: string;
  attendanceDeduction?: string;
  mipymeDeduction?: string;
  reference?: string | null;
  expenseAccountId?: string | null;
  segmentId?: string | null;
  createdBy?: string | null;
}

/**
 * Nómina de un trabajador: gasto de personal (salario + descuento de asistencia) contra
 * Nóminas por pagar (neto) y, si hay salario pagado por la Mipyme, contra Pagos anticipados
 * de nómina. Crea la partida abierta que se liquida con los pagos.
 */
export async function postPayroll(tx: Tx, input: PayrollInput) {
  const gross = money(input.gross);
  const attendance = money(input.attendanceDeduction ?? 0);
  const mipyme = money(input.mipymeDeduction ?? 0);
  if (gross.lte(0)) throw new LedgerError('INVALID_INPUT', 'El salario debe ser positivo');
  if (attendance.gt(0) || mipyme.gt(0)) throw new LedgerError('INVALID_INPUT', 'Los descuentos se indican en negativo');
  const net = gross.plus(attendance).plus(mipyme);
  if (net.lt(0)) throw new LedgerError('INVALID_INPUT', 'Los descuentos superan el salario');
  const pa = await tx.partyAccount.findUnique({ where: { id: input.partyAccountId }, include: { party: true, company: true } });
  if (!pa) throw new LedgerError('NOT_FOUND', 'Cuenta corriente no encontrada');
  const expenseId = input.expenseAccountId ?? (await resolveMapping(tx, 'payroll.expense', { companyId: pa.companyId, segmentId: input.segmentId }));
  const date = toDate(input.date);
  const { rate, rateType } = await rateFor(tx, pa.accountId, pa.currency, date);
  const lines: PostLineInput[] = [
    { accountId: expenseId, currency: pa.currency, amount: toAmountString(gross.plus(attendance)), rate, rateType: rateType ?? undefined, segmentId: input.segmentId ?? null, memo: `${input.concept} ${pa.party.name}` },
    { accountId: pa.accountId, currency: pa.currency, amount: toAmountString(net.neg()), rate, rateType: rateType ?? undefined, partyId: pa.partyId, memo: `${input.concept} ${pa.party.name}` },
  ];
  if (!mipyme.isZero()) {
    const mipymeId = await resolveMapping(tx, 'payroll.mipyme', { companyId: pa.companyId });
    lines.push({ accountId: mipymeId, currency: pa.currency, amount: toAmountString(mipyme), rate, rateType: rateType ?? undefined, memo: `Salario Mipyme ${pa.party.name}` });
  }
  const year = date.getUTCFullYear();
  const seq = await nextNumber(tx, pa.companyId, year, 'NOM');
  const number = `${pa.company.code}-NOM-${year}-${String(seq).padStart(6, '0')}`;
  const description = `${input.concept} ${input.period} — ${pa.party.name}`;
  const doc = await tx.document.create({
    data: { companyId: pa.companyId, docType: 'PARTY_PAYROLL', number, docDate: date, memo: description, createdBy: input.createdBy ?? null },
  });
  const entry = await postEntry(tx, { companyId: pa.companyId, entryDate: input.date, kind: 'AUTO', memo: description, documentId: doc.id, createdBy: input.createdBy ?? null, lines });
  const usd = roundAmount(toUsd(net.neg(), rate));
  await tx.partyDocument.create({
    data: {
      id: doc.id, partyAccountId: pa.id, kind: 'PAYROLL', amount: toAmountString(net.neg()), currency: pa.currency, rate, amountUsd: usd.toFixed(4),
      counterAccountId: expenseId, reference: input.reference ?? number, description, entryId: entry.id,
      payroll: {
        create: {
          period: input.period, employer: input.employer, concept: input.concept, gross: gross.toFixed(4),
          attendanceDeduction: attendance.toFixed(4), mipymeDeduction: mipyme.toFixed(4), net: net.toFixed(4), currency: pa.currency,
        },
      },
    },
  });
  const openItem = net.isZero() ? null : await createOpenItem(tx, {
    partyAccountId: pa.id, documentId: doc.id, date: input.date, amount: toAmountString(net.neg()), amountUsd: usd.toFixed(4),
    reference: input.reference ?? number, description,
  });
  return { document: doc, entry, openItem };
}

/** Busca o crea una contraparte por código. */
export async function upsertParty(
  tx: Tx | Prisma.TransactionClient,
  p: { code: string; name: string; kind?: 'PERSON' | 'COMPANY'; roles?: Prisma.PartyCreateInput['roles'] },
) {
  const existing = await tx.party.findUnique({ where: { code: p.code } });
  if (existing) {
    const roles = [...new Set([...existing.roles, ...((p.roles as string[] | undefined) ?? [])])];
    if (roles.length !== existing.roles.length) return tx.party.update({ where: { id: existing.id }, data: { roles: roles as never } });
    return existing;
  }
  return tx.party.create({ data: { code: p.code, name: p.name, kind: p.kind ?? 'PERSON', roles: p.roles ?? [] } });
}

/** Busca o crea la cuenta corriente de una contraparte. */
export async function upsertPartyAccount(
  tx: Tx | Prisma.TransactionClient,
  p: { companyId: string; partyId: string; currency: string; accountId: string; oppositeAccountId?: string | null; name: string; sourceSheet?: string | null; sourceFilter?: Prisma.InputJsonValue },
) {
  return tx.partyAccount.upsert({
    where: { companyId_partyId_currency_accountId: { companyId: p.companyId, partyId: p.partyId, currency: p.currency, accountId: p.accountId } },
    update: {},
    create: {
      companyId: p.companyId, partyId: p.partyId, currency: p.currency, accountId: p.accountId, oppositeAccountId: p.oppositeAccountId ?? null,
      name: p.name, sourceSheet: p.sourceSheet ?? null, sourceFilter: p.sourceFilter,
    },
  });
}
