/**
 * Explicaciones automáticas (y comprobadas al céntimo) de las diferencias conocidas con el BC del
 * Excel. Solo se registran si la diferencia queda explicada por completo (±0,01 USD).
 */
import { endOfMonth, money, roundAmount } from '@kaluch/shared';
import { compareWithBc, excelSign, type PrismaClient } from '@kaluch/db';
import { TREASURY_SHEETS } from './treasury-import';

type Money = ReturnType<typeof money>;

const USD_COLUMN: Record<string, string> = {
  Efectivo_Caja: 'Mov USD',
  Banco_Emp_Exterior: 'Mov USD',
  Banco_Emp_Cuba: 'Movimiento en USD',
  Banco_Pers_Exterior: 'Movimiento en USD',
  Banco_Pers_Cuba: 'Movimiento en USD',
};

/** Número de una celda guardada en import_row.raw (los Date de exceljs llegan como texto ISO). */
function rawNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t / 86_400_000 + 25569;
  }
  return null;
}

function rawDate(v: unknown): string | null {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10);
  return null;
}

const monthsBetween = (from: string, to: string) => {
  const out: [number, number][] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) { out.push([y, m]); m === 12 ? (y++, (m = 1)) : m++; }
  return out;
};

export async function explainHoldingDifferences(prisma: PrismaClient, p: { from: string; to: string }) {
  const rate = async (date: string, currency: string, rateType: string) => {
    const r = await prisma.exchangeRate.findFirst({ where: { rateDate: new Date(`${date}T00:00:00Z`), currency, rateType, base: 'USD' } });
    return r ? money(r.rate) : null;
  };
  const rows = await prisma.importRow.findMany({
    where: { sheet: { in: [...TREASURY_SHEETS] } },
    select: { id: true, sheet: true, excelRow: true, raw: true },
  });
  const docs = await prisma.document.findMany({ where: { importRowId: { in: rows.map((r) => r.id) } }, select: { id: true, importRowId: true } });
  const legs = await prisma.treasuryLeg.groupBy({ by: ['movementId'], where: { movementId: { in: docs.map((d) => d.id) } }, _sum: { amountUsd: true } });
  const usdOfRow = new Map<string, Money>();
  for (const d of docs) usdOfRow.set(d.importRowId!, money(legs.find((l) => l.movementId === d.id)?._sum.amountUsd ?? 0));

  // Filas cuyo USD por fila está vacío, en error o a 0 en el Excel: su tenencia no las descuenta.
  const broken: { month: string; usd: Money; ref: string }[] = [];
  // Caja CAD (omitida por P3): el Excel la valora a MLC (IC) al cierre y cada fila a CAD (OUE) del día.
  const cadRows: { date: string; cad: Money; broken: boolean }[] = [];
  for (const r of rows) {
    const raw = r.raw as Record<string, unknown>;
    const date = rawDate(raw.FECHA ?? raw.Fecha);
    if (!date) continue;
    const excelUsd = rawNumber(raw[USD_COLUMN[r.sheet]!]);
    // USD por fila vacío, en error o 0 (fórmula sin tasa) en el Excel cuando la fila sí mueve dinero.
    const isBroken = excelUsd === null || excelUsd === 0;
    if (isBroken && usdOfRow.has(r.id) && !usdOfRow.get(r.id)!.isZero()) {
      broken.push({ month: date.slice(0, 7), usd: usdOfRow.get(r.id)!, ref: `${r.sheet} fila ${r.excelRow}` });
    }
    if (r.sheet === 'Efectivo_Caja') {
      const cad = money(rawNumber(raw['Entrada CAD']) ?? 0).plus(money(rawNumber(raw['Salida CAD']) ?? 0));
      if (!cad.isZero()) cadRows.push({ date, cad, broken: isBroken });
    }
  }
  const cadHolding = async (eom: string) => {
    let cum = money(0);
    let booked = money(0);
    for (const c of cadRows) {
      if (c.date > eom) continue;
      cum = cum.plus(c.cad);
      if (c.broken) continue;
      const r = await rate(c.date, 'CAD', 'OUE');
      if (r && !r.isZero()) booked = booked.plus(c.cad.div(r));
    }
    const mlc = await rate(eom, 'MLC', 'IC');
    return (mlc && !mlc.isZero() ? cum.div(mlc) : money(0)).minus(booked);
  };

  await prisma.bcExplanation.deleteMany({ where: { reason: { startsWith: '[auto] Tenencia de efectivo' } } });
  const results: { month: string; excelNet: string; systemNet: string; cad: string; broken: string; residual: string; explained: boolean }[] = [];
  for (const [y, m] of monthsBetween(p.from, p.to)) {
    const cmp = await compareWithBc(prisma, { year: y, month: m, codePrefixes: ['846', '925'] });
    const get = (code: string) => cmp.rows.find((r) => r.displayCode === code);
    const loss = get('846.9990');
    const gain = get('925.9990');
    const excelNet = money(loss?.excel ?? 0).plus(money(gain?.excel ?? 0));
    const systemNet = money(loss?.system ?? 0).plus(money(gain?.system ?? 0));
    const prev = m === 1 ? endOfMonth(y - 1, 12) : endOfMonth(y, m - 1);
    const cad = roundAmount((await cadHolding(endOfMonth(y, m))).minus(await cadHolding(prev)));
    const month = `${y}-${String(m).padStart(2, '0')}`;
    const mine = broken.filter((b) => b.month === month);
    const brokenUsd = mine.reduce((s, b) => s.plus(b.usd), money(0));
    const residual = excelNet.minus(systemNet).minus(cad).minus(brokenUsd);
    const explained = residual.abs().lte(0.01) && !excelNet.minus(systemNet).abs().lte(0.01);
    if (explained) {
      const parts = [`caja CAD omitida (decisión P3; el Excel la valora a la tasa MLC): ${cad.toFixed(2)} USD`];
      if (mine.length) parts.push(`${mine.length} filas con "Movimiento en USD" vacío, en error o a 0 en el Excel, que su tenencia no descuenta: ${brokenUsd.toFixed(2)} USD (${mine.map((b) => b.ref).join(', ')})`);
      const reason = `[auto] Tenencia de efectivo ${String(m).padStart(2, '0')}/${y}: Excel ${excelNet.toFixed(2)} = sistema ${systemNet.toFixed(2)} + ${parts.join(' + ')}`;
      const codes = ['846.9990', '925.9990'];
      // Los totales 846/925 incluyen además las cuentas por cobrar: si esa parte cuadra, la misma explicación vale.
      const hl = get('846');
      const hg = get('925');
      const headerDiff = money(hl?.system ?? 0).plus(money(hg?.system ?? 0)).minus(money(hl?.excel ?? 0)).minus(money(hg?.excel ?? 0));
      if (headerDiff.minus(systemNet.minus(excelNet)).abs().lte(0.01)) codes.push('846', '925');
      await prisma.bcExplanation.createMany({
        data: codes.map((fullCode) => ({ fullCode, year: y, month: m, reason, approved: true })),
      });
    }
    results.push({ month, excelNet: excelNet.toFixed(2), systemNet: systemNet.toFixed(2), cad: cad.toFixed(2), broken: brokenUsd.toFixed(2), residual: residual.toFixed(2), explained });
  }
  return results;
}

/**
 * Cuentas de "estado actual" (fórmulas del BC sin fecha de corte: facturas de exportación pendientes de cierre,
 * facturas de proveedor sin asignar a una venta). El Excel muestra en todos los meses el estado a la fecha del
 * archivo; el sistema registra cada fila en su fecha. La diferencia queda explicada si el saldo acumulado del
 * sistema (todas las fechas) coincide al céntimo con el valor del Excel.
 */
export async function explainStateAccounts(prisma: PrismaClient, p: { from: string; to: string }) {
  const batches = await prisma.importBatch.findMany({ select: { stats: true } });
  const ids = [...new Set(batches.flatMap((b) => ((b.stats as { stateAccounts?: string[] } | null)?.stateAccounts ?? [])))];
  const accounts = await prisma.account.findMany({ where: { id: { in: ids } } });
  await prisma.bcExplanation.deleteMany({ where: { reason: { startsWith: '[auto] Estado actual' } } });
  const results: { code: string; month: string; excel: string; cumulative: string; explained: boolean }[] = [];
  const [ty, tm] = p.to.split('-').map(Number) as [number, number];
  const cutoff = endOfMonth(ty, tm);
  // Saldo acumulado del sistema (signo del Excel) por fila del BC.
  const cumulativeByRow = new Map<number, Money>();
  for (const acc of accounts) {
    const sum = await prisma.journalLine.aggregate({ where: { accountId: acc.id, entryDate: { lte: new Date(`${cutoff}T00:00:00Z`) } }, _sum: { amountUsd: true } });
    cumulativeByRow.set(acc.sortOrder, roundAmount(money(sum._sum.amountUsd ?? 0).times(excelSign(acc.classification))));
  }
  for (const code of [...new Set(accounts.map((a) => a.displayCode))]) {
    for (const [y, m] of monthsBetween(p.from, p.to)) {
      const month = `${y}-${String(m).padStart(2, '0')}`;
      const cmp = await compareWithBc(prisma, { year: y, month: m, codePrefixes: [code] });
      // Puede haber dos filas con el mismo código (180.8883): la explicación vale si vale para todas.
      const rows = cmp.rows.filter((r) => r.displayCode === code && r.status === 'DIFF');
      if (!rows.length) continue;
      const checks = rows.map((r) => {
        const cum = r.excelRow !== null ? cumulativeByRow.get(r.excelRow) : undefined;
        const explained = !!cum && r.excel !== null && money(r.excel).minus(cum).abs().lte(0.01);
        results.push({ code, month, excel: r.excel ?? '', cumulative: cum?.toFixed(2) ?? '', explained });
        return { r, cum, explained };
      });
      if (!checks.every((c) => c.explained)) continue;
      await prisma.bcExplanation.create({
        data: {
          fullCode: code, year: y, month: m, approved: true,
          reason: `[auto] Estado actual: el BC del Excel calcula ${code} sin fecha de corte (lo pendiente a la fecha del archivo) y muestra el mismo valor en todos los meses; el sistema registra cada fila en su fecha. Saldo acumulado del sistema a ${cutoff.split('-').reverse().join('/')}: ${checks.map((c) => c.cum!.toFixed(2)).join(' y ')} = Excel`,
        },
      });
    }
  }
  return results;
}

/**
 * Cabeceras del Excel que no suman sus subcuentas (p. ej. 180 usa importes con fecha de corte y sus subcuentas
 * no). El sistema calcula la cabecera como suma de subcuentas: la diferencia queda explicada si es la propia
 * incoherencia del Excel más las diferencias (ya explicadas) de las subcuentas.
 */
export async function explainHeaderInconsistencies(prisma: PrismaClient, p: { from: string; to: string; codes: string[] }) {
  await prisma.bcExplanation.deleteMany({ where: { reason: { startsWith: '[auto] Cabecera del Excel' } } });
  const results: { code: string; month: string; inconsistency: string; explained: boolean }[] = [];
  for (const [y, m] of monthsBetween(p.from, p.to)) {
    const cmp = await compareWithBc(prisma, { year: y, month: m, codePrefixes: p.codes });
    for (const h of cmp.rows.filter((r) => r.status === 'DIFF' && !r.displayCode.includes('.'))) {
      const children = cmp.rows.filter((r) => r.displayCode.startsWith(`${h.displayCode}.`) && r.excel !== null);
      if (!children.length || children.some((c) => c.status === 'DIFF')) continue;
      const excelChildren = children.reduce((s, c) => s.plus(money(c.excel!)), money(0));
      const inconsistency = excelChildren.minus(money(h.excel ?? 0));
      const childDiffs = children.reduce((s, c) => s.plus(money(c.diff)), money(0));
      const explained = !inconsistency.abs().lte(0.01) && money(h.diff).minus(childDiffs).minus(inconsistency).abs().lte(0.01);
      results.push({ code: h.displayCode, month: `${y}-${String(m).padStart(2, '0')}`, inconsistency: inconsistency.toFixed(2), explained });
      if (!explained) continue;
      await prisma.bcExplanation.create({
        data: {
          fullCode: h.displayCode, year: y, month: m, approved: true,
          reason: `[auto] Cabecera del Excel distinta de la suma de sus subcuentas: suma ${excelChildren.toFixed(2)}, cabecera ${money(h.excel ?? 0).toFixed(2)} (incoherencia del Excel ${inconsistency.toFixed(2)})${childDiffs.isZero() ? '' : `, más ${childDiffs.toFixed(2)} de subcuentas explicadas`}`,
        },
      });
    }
  }
  return results;
}
