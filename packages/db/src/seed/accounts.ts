import type { PrismaClient } from '@prisma/client';

export interface AccountSeedRow {
  code: string;
  subcode: string | null;
  name: string;
  nature: 'DEUDORA' | 'ACREEDORA' | 'MIXTA';
  classification: 'AC' | 'PC' | 'CC' | 'CND' | 'CNA';
  currencyLock?: string | null;
  revalRateType?: string | null;
  revalCurrency?: string | null;
  isIntercompany?: boolean;
  isPendingExport?: boolean;
  defaultSegmentCode?: string | null;
  anomaly?: string | null;
  active?: boolean;
  sortOrder: number;
}

/**
 * Inserta o actualiza el plan de cuentas. Las filas sin subcuenta son cuentas de
 * grupo; son de detalle (postable) solo si no tienen subcuentas. Los códigos
 * repetidos reciben un sufijo interno "#2", "#3"… y se marcan como anomalía.
 */
export async function upsertAccounts(prisma: PrismaClient, rows: AccountSeedRow[]) {
  const segments = new Map((await prisma.segment.findMany()).map((s) => [s.code, s.id]));
  const withChildren = new Set(rows.filter((r) => r.subcode).map((r) => r.code));
  const seen = new Map<string, number>();
  const parentIds = new Map<string, string>();
  const result = { created: 0, updated: 0, duplicates: [] as string[] };

  for (const r of rows) {
    const displayCode = r.subcode ? `${r.code}.${r.subcode}` : r.code;
    const n = (seen.get(displayCode) ?? 0) + 1;
    seen.set(displayCode, n);
    const fullCode = n > 1 ? `${displayCode}#${n}` : displayCode;
    let anomaly = r.anomaly ?? null;
    if (n > 1) {
      result.duplicates.push(displayCode);
      anomaly = [anomaly, `Código duplicado en el Excel (aparición ${n})`].filter(Boolean).join('; ');
    }
    const parentId = r.subcode ? parentIds.get(r.code) ?? null : null;
    const data = {
      parentId,
      code: r.code,
      subcode: r.subcode,
      displayCode,
      name: r.name,
      nature: r.nature,
      classification: r.classification,
      postable: r.subcode ? true : !withChildren.has(r.code),
      currencyLock: r.currencyLock ?? null,
      revalRateType: r.revalRateType ?? null,
      revalCurrency: r.revalCurrency ?? r.currencyLock ?? null,
      isIntercompany: r.isIntercompany ?? false,
      isPendingExport: r.isPendingExport ?? false,
      defaultSegmentId: r.defaultSegmentCode ? segments.get(r.defaultSegmentCode) ?? null : null,
      anomaly,
      active: r.active ?? true,
      sortOrder: r.sortOrder,
    };
    const existing = await prisma.account.findUnique({ where: { fullCode } });
    const acc = existing
      ? await prisma.account.update({ where: { fullCode }, data })
      : await prisma.account.create({ data: { ...data, fullCode } });
    existing ? result.updated++ : result.created++;
    if (!r.subcode && !parentIds.has(r.code)) parentIds.set(r.code, acc.id);
  }
  return result;
}
