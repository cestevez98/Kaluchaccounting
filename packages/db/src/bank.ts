import { money } from '@kaluch/shared';
import { createHash } from 'node:crypto';
import type { Tx } from './client';
import { LedgerError } from './errors';
import { toDate } from './fx';

export interface StatementLineInput {
  /** AAAA-MM-DD */
  date: string;
  description: string;
  /** + abono / − cargo */
  amount: string;
}

/**
 * Guarda un extracto. Cada línea lleva una huella (fecha|importe|concepto|nº de
 * repetición en el fichero), así reimportar el mismo extracto (o uno solapado)
 * no duplica líneas.
 */
export async function importStatement(
  tx: Tx,
  p: { treasuryAccountId: string; fileName: string; fileHash: string; lines: StatementLineInput[]; userId?: string | null },
) {
  const acc = await tx.treasuryAccount.findUnique({ where: { id: p.treasuryAccountId } });
  if (!acc) throw new LedgerError('NOT_FOUND', 'Cuenta de tesorería no encontrada');
  const dates = p.lines.map((l) => l.date).sort();
  const statement = await tx.bankStatement.create({
    data: {
      treasuryAccountId: acc.id, fileName: p.fileName, fileHash: p.fileHash, createdBy: p.userId ?? null,
      dateFrom: dates[0] ? toDate(dates[0]) : null, dateTo: dates.at(-1) ? toDate(dates.at(-1)!) : null,
    },
  });
  const seen = new Map<string, number>();
  const data = p.lines.map((l) => {
    const base = `${l.date}|${money(l.amount).toFixed(4)}|${l.description.trim().toLowerCase()}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      statementId: statement.id, treasuryAccountId: acc.id, valueDate: toDate(l.date), description: l.description.slice(0, 1000),
      amount: money(l.amount).toFixed(4), lineHash: createHash('sha256').update(`${base}|${n}`).digest('hex'),
    };
  });
  const r = await tx.bankStatementLine.createMany({ data, skipDuplicates: true });
  return { statement, inserted: r.count, duplicates: data.length - r.count };
}

/**
 * Conciliación automática: casa cada línea del extracto con un movimiento de la
 * misma cuenta, mismo importe y fecha a ±`days` días, solo si el candidato es único.
 */
export async function autoReconcile(tx: Tx, treasuryAccountId: string, days = 3) {
  const lines = await tx.bankStatementLine.findMany({ where: { treasuryAccountId, status: 'UNMATCHED' }, orderBy: { valueDate: 'asc' } });
  const used = new Set<string>();
  let matched = 0;
  for (const line of lines) {
    const from = new Date(line.valueDate.getTime() - days * 86_400_000);
    const to = new Date(line.valueDate.getTime() + days * 86_400_000);
    const candidates = await tx.treasuryLeg.findMany({
      where: {
        treasuryAccountId, amount: line.amount, valueDate: { gte: from, lte: to }, statementLine: null,
        movement: { document: { status: 'POSTED' } },
      },
      select: { id: true },
    });
    const free = candidates.filter((c) => !used.has(c.id));
    if (free.length !== 1) continue;
    used.add(free[0]!.id);
    await tx.bankStatementLine.update({ where: { id: line.id }, data: { status: 'MATCHED', legId: free[0]!.id } });
    matched++;
  }
  return { matched, pending: lines.length - matched };
}

export async function matchStatementLine(tx: Tx, lineId: string, legId: string) {
  const line = await tx.bankStatementLine.findUnique({ where: { id: lineId } });
  const leg = await tx.treasuryLeg.findUnique({ where: { id: legId }, include: { statementLine: true } });
  if (!line || !leg) throw new LedgerError('NOT_FOUND', 'Línea o movimiento no encontrado');
  if (leg.treasuryAccountId !== line.treasuryAccountId) throw new LedgerError('INVALID_INPUT', 'El movimiento es de otra cuenta');
  if (leg.statementLine) throw new LedgerError('INVALID_INPUT', 'Ese movimiento ya está conciliado con otra línea');
  if (!money(leg.amount).eq(money(line.amount))) {
    throw new LedgerError('INVALID_INPUT', `Los importes no coinciden (${line.amount.toFixed(2)} ≠ ${leg.amount.toFixed(2)})`);
  }
  return tx.bankStatementLine.update({ where: { id: lineId }, data: { status: 'MATCHED', legId } });
}

export async function setStatementLineStatus(tx: Tx, lineId: string, status: 'UNMATCHED' | 'IGNORED') {
  return tx.bankStatementLine.update({ where: { id: lineId }, data: { status, legId: null } });
}
