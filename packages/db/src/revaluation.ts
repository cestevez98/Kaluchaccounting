import { endOfMonth, FUNCTIONAL_CURRENCY, money, roundAmount, toUsd } from '@kaluch/shared';
import type { Prisma } from '@prisma/client';
import type { Tx } from './client';
import { findRate, toDate } from './fx';
import { postEntry, resolveMapping, reverseEntry, type PostLineInput } from './ledger';

const TREASURY_CODES = new Set(['101', '109', '110', '111', '112', '113', '114']);

interface BalanceRow {
  account_id: string;
  currency: string;
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
  const key = year * 100 + month;
  const balances = await tx.$queryRaw<BalanceRow[]>`
    SELECT lb.account_id, lb.currency, sum(lb.amount_orig) AS orig, sum(lb.debit_usd - lb.credit_usd) AS usd
    FROM ledger_balance lb JOIN account a ON a.id = lb.account_id
    WHERE lb.company_id = ${companyId}::uuid AND lb.book = 'BASE' AND lb.year * 100 + lb.month <= ${key}
      AND a.reval_rate_type IS NOT NULL AND lb.currency <> ${FUNCTIONAL_CURRENCY}
    GROUP BY lb.account_id, lb.currency`;
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
    lines.push({ accountId: acc.id, currency: b.currency, amount: '0', amountUsd: diff.toFixed(4), rate, rateType: acc.revalRateType!, memo: `Revaluación a ${rate} (${acc.revalRateType})` });
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
