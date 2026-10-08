import { endOfMonth, FUNCTIONAL_CURRENCY, money, roundAmount, toUsd } from '@kaluch/shared';
import type { Prisma } from '@prisma/client';
import type { Tx } from './client';
import { findRate, toDate } from './fx';
import { postEntry, resolveMapping, reverseEntry, type PostLineInput } from './ledger';

const TREASURY_CODES = new Set(['101', '109', '110', '111', '112', '113', '114']);

interface BalanceRow {
  account_id: string;
  currency: string;
  party_id: string | null;
  orig: Prisma.Decimal;
  usd: Prisma.Decimal;
}

/**
 * Revaluación de fin de mes (tenencia): lleva el saldo en USD de cada cuenta
 * monetaria en moneda extranjera a `saldo original / tasa de cierre` del tipo de
 * tasa de la cuenta. La diferencia va a Gastos/Ingresos por Tenencia (846/925).
 * Idempotente: si el mes ya se revaluó, anula la corrida anterior y recalcula.
 */
export async function revalueMonth(tx: Tx, companyId: string, year: number, month: number, userId?: string | null) {
  const previous = await tx.fxRevaluationRun.findMany({ where: { companyId, year, month, status: 'POSTED' } });
  for (const p of previous) {
    if (p.entryId) await reverseEntry(tx, p.entryId, { createdBy: userId, memo: `Anulación de revaluación ${month}/${year} (se recalcula)` });
    await tx.fxRevaluationRun.update({ where: { id: p.id }, data: { status: 'SUPERSEDED' } });
  }

  const eom = endOfMonth(year, month);
  // Por cuenta, moneda y contraparte: en las cuentas corrientes el ajuste lleva su contraparte
  // (así el estado de cuenta en USD y la reclasificación por signo lo incluyen).
  const balances = await tx.$queryRaw<BalanceRow[]>`
    SELECT jl.account_id, jl.currency, jl.party_id, sum(jl.amount) AS orig, sum(jl.amount_usd) AS usd
    FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id JOIN account a ON a.id = jl.account_id
    WHERE jl.company_id = ${companyId}::uuid AND je.book = 'BASE' AND jl.entry_date <= ${toDate(eom)}::date
      AND a.reval_rate_type IS NOT NULL AND jl.currency <> ${FUNCTIONAL_CURRENCY}
    GROUP BY jl.account_id, jl.currency, jl.party_id`;
  const accounts = new Map(
    (await tx.account.findMany({ where: { id: { in: balances.map((b) => b.account_id) } } })).map((a) => [a.id, a]),
  );

  const run = await tx.fxRevaluationRun.create({ data: { companyId, year, month, createdBy: userId ?? null } });
  const lines: PostLineInput[] = [];
  const counter = new Map<string, ReturnType<typeof money>>();
  let total = money(0);

  for (const b of balances) {
    const acc = accounts.get(b.account_id)!;
    const rate = (await findRate(tx, toDate(eom), b.currency, acc.revalRateType!)).rate.toString();
    const revalued = money(b.orig).isZero() ? money(0) : toUsd(b.orig, rate);
    const diff = roundAmount(revalued.minus(money(b.usd)));
    await tx.fxRevaluationLine.create({
      data: {
        runId: run.id, accountId: acc.id, currency: b.currency, rateType: acc.revalRateType!,
        balanceOrig: money(b.orig).toFixed(4), bookedUsd: money(b.usd).toFixed(4), closingRate: rate,
        revaluedUsd: revalued.toFixed(4), diffUsd: diff.toFixed(4),
      },
    });
    if (diff.isZero()) continue;
    total = total.plus(diff);
    lines.push({ accountId: acc.id, currency: b.currency, amount: '0', amountUsd: diff.toFixed(4), rate, rateType: acc.revalRateType!, partyId: b.party_id, memo: `Revaluación a ${rate} (${acc.revalRateType})` });
    const group = TREASURY_CODES.has(acc.code) ? 'cash' : 'receivables';
    counter.set(group, money(counter.get(group) ?? 0).plus(diff));
  }

  if (lines.length === 0) return { run, entry: null, totalUsd: '0.0000' };
  // Como el Excel, el resultado del mes se compensa por grupo (efectivo / cuentas por cobrar y pagar):
  // neto > 0 → ingreso por tenencia (Haber); neto < 0 → gasto.
  for (const [group, net] of counter) {
    const a = money(net);
    if (a.isZero()) continue;
    const accountId = await resolveMapping(tx, `fx.holding.${group}.${a.gt(0) ? 'gain' : 'loss'}`, { companyId });
    lines.push({ accountId, currency: FUNCTIONAL_CURRENCY, amount: a.neg().toFixed(4), amountUsd: a.neg().toFixed(4), memo: `Tenencia ${month}/${year}` });
  }
  const entry = await postEntry(tx, {
    companyId, entryDate: eom, kind: 'REVAL', memo: `Revaluación de saldos en moneda extranjera ${String(month).padStart(2, '0')}/${year}`,
    documentId: run.id, createdBy: userId ?? null, lines,
  });
  await tx.fxRevaluationRun.update({ where: { id: run.id }, data: { entryId: entry.id, totalUsd: total.toFixed(4) } });
  return { run, entry, totalUsd: total.toFixed(4) };
}

const TRANSIT_CLOSING_MEMO = 'Regularización de transitoria de tesorería';

/**
 * Cierre mensual de las transitorias de tesorería: el saldo que dejan los cambios y traspasos
 * registrados con una sola pata (699.9996 / 699.0003) se lleva a diferencias de cambio realizadas
 * (845/924 · Cambios y Traspasos), como hace el Excel con las filas "Cambio" y "Traspaso" del mes.
 * Solo se cierra lo que procede de movimientos de tesorería. Idempotente: si no queda saldo, no hace nada.
 */
export async function closeFxTransits(tx: Tx, companyId: string, year: number, month: number, userId?: string | null) {
  const eom = endOfMonth(year, month);
  const lines: PostLineInput[] = [];
  const result: { transit: string; closedUsd: string }[] = [];
  for (const [transitKey, fxKey] of [['treasury.exchange.transit', 'fx.realized.exchange'], ['treasury.transfer.transit', 'fx.realized.transfer']] as const) {
    const transitId = await resolveMapping(tx, transitKey, { companyId });
    const [row] = await tx.$queryRaw<{ usd: Prisma.Decimal | null }[]>`
      SELECT sum(jl.amount_usd) AS usd
      FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
      WHERE jl.company_id = ${companyId}::uuid AND jl.account_id = ${transitId}::uuid AND je.book = 'BASE'
        AND jl.entry_date <= ${toDate(eom)}::date
        AND (je.document_id IN (SELECT id FROM treasury_movement) OR (je.kind = 'CLOSING' AND jl.memo = ${TRANSIT_CLOSING_MEMO}))`;
    const balance = roundAmount(money(row?.usd ?? 0));
    if (balance.isZero()) continue;
    // Saldo deudor: salió más valor del que entró → pérdida (Debe en 845); acreedor → ganancia (Haber en 924).
    const fxId = await resolveMapping(tx, `${fxKey}.${balance.gt(0) ? 'loss' : 'gain'}`, { companyId });
    lines.push(
      { accountId: transitId, currency: FUNCTIONAL_CURRENCY, amount: balance.neg().toFixed(4), amountUsd: balance.neg().toFixed(4), memo: TRANSIT_CLOSING_MEMO },
      { accountId: fxId, currency: FUNCTIONAL_CURRENCY, amount: balance.toFixed(4), amountUsd: balance.toFixed(4), memo: TRANSIT_CLOSING_MEMO },
    );
    result.push({ transit: transitKey, closedUsd: balance.toFixed(4) });
  }
  if (lines.length === 0) return { entry: null, result };
  const entry = await postEntry(tx, {
    companyId, entryDate: eom, kind: 'CLOSING', createdBy: userId ?? null,
    memo: `Regularización de cambios y traspasos con una sola pata ${String(month).padStart(2, '0')}/${year}`, lines,
  });
  return { entry, result };
}
