import type { PrismaClient } from '@prisma/client';
import { upsertAccounts } from './seed/accounts';

/**
 * Cuentas de sistema (no existen en el Excel) bajo la 699 Transitoria, y los
 * mapeos contables que usa el motor. Idempotente.
 */
export const SYSTEM_ACCOUNTS = [
  { subcode: '9995', name: 'Puente de migración - Deudas y nómina del Excel (contrapartida pendiente de clasificar)' },
  { subcode: '9996', name: 'Transitoria - Cambios de moneda pendientes de casar' },
  { subcode: '9997', name: 'Saldos de apertura pendientes de distribuir' },
  { subcode: '9998', name: 'Pendiente de clasificar (bandeja de revisión)' },
  { subcode: '9999', name: 'Redondeo del sistema' },
] as const;

/** Claves de mapeo → código de cuenta (se busca la primera que exista). */
export const DEFAULT_MAPPINGS: Record<string, string[]> = {
  'ledger.rounding': ['699.9999'],
  'treasury.suspense': ['699.9998'],
  'opening.balance': ['699.9997'],
  'treasury.exchange.transit': ['699.9996'],
  'treasury.transfer.transit': ['699.0003', '699.0001'],
  'fx.realized.exchange.loss': ['845.9990', '845.0001'],
  'fx.realized.exchange.gain': ['924.9990', '924.0001'],
  'fx.realized.transfer.loss': ['845.8881', '845.0002'],
  'fx.realized.transfer.gain': ['924.8881', '924.0001'],
  'fx.holding.cash.loss': ['846.9990', '846.0001'],
  'fx.holding.cash.gain': ['925.9990', '925.0001'],
  'fx.holding.receivables.loss': ['846.8880', '846.0001'],
  'fx.holding.receivables.gain': ['925.8880', '925.0001'],
  'party.migration.bridge': ['699.9995'],
  'payroll.expense': ['826.9990', '826.8880'],
  'payroll.mipyme': ['146.0003'],
  // Fase 4: exportación (888).
  'export.pending.sales': ['2900'],
  'export.pending.factory': ['2814'],
  'export.pending.logistics': ['2815'],
  'export.pending.other': ['2816'],
  'export.stock.factory': ['180.8880'],
  'export.stock.logistics': ['180.8881'],
  'export.stock.other': ['180.8882'],
  'export.stock.estimated': ['180.8883'],
  'export.sales.goods': ['900.8880'],
  'export.sales.services': ['901.8880'],
  'export.sales.internal': ['1900'],
  'export.cost.factory': ['814.8880'],
  'export.cost.logistics': ['815.8880'],
  'export.cost.other': ['816.8880'],
  'export.cost.estimated': ['817.8880'],
  'export.commission': ['824.8880'],
  'export.internal.cost.factory': ['1814.8880'],
  'export.internal.cost.logistics': ['1815.8880'],
  'export.internal.cost.other': ['1816.8880'],
  'export.internal.cost.estimated': ['1816.8880#2', '1816.8880'],
  'export.internal.commission': ['1817.8880'],
  // Fase 4: distribución (999).
  'distribution.sales': ['900.9990'],
  'distribution.cost': ['814.9990'],
  'distribution.commission': ['824.9990'],
  'distribution.stock.warehouse': ['181.9990'],
  'distribution.stock.transit': ['181.9991'],
  'onat.expense': ['830.9990', '829.9990'],
  'onat.payable': ['480.9990'],
};

/** Mapeos por segmento (más específicos que los generales). */
export const SEGMENT_MAPPINGS: { key: string; segment: string; code: string }[] = [
  { key: 'payroll.expense', segment: '888', code: '826.8880' },
  { key: 'payroll.expense', segment: '999', code: '826.9990' },
  { key: 'payroll.expense', segment: '777', code: '826.7770' },
];

export async function ensureSystemAccounts(prisma: PrismaClient) {
  const transit = await prisma.account.findFirst({ where: { code: '699', subcode: null } });
  if (!transit) throw new Error('No existe la cuenta de grupo 699 (Transitoria del Sistema)');
  await upsertAccounts(
    prisma,
    SYSTEM_ACCOUNTS.map((a, i) => ({
      code: '699', subcode: a.subcode, name: a.name, nature: 'MIXTA' as const, classification: 'CC' as const,
      sortOrder: 999_990 + i, anomaly: 'Cuenta de sistema (no existe en el Excel)',
    })),
  );
  await prisma.account.updateMany({ where: { code: '699', subcode: { in: SYSTEM_ACCOUNTS.map((a) => a.subcode) } }, data: { parentId: transit.id } });
  if (transit.postable) await prisma.account.update({ where: { id: transit.id }, data: { postable: false } });

  const missing: string[] = [];
  for (const [key, codes] of Object.entries(DEFAULT_MAPPINGS)) {
    if (await prisma.accountMapping.findFirst({ where: { key, companyId: null, segmentId: null, currency: null } })) continue;
    let preferred = null;
    for (const code of codes) {
      preferred = await prisma.account.findFirst({ where: { fullCode: code, postable: true } });
      if (preferred) break;
    }
    if (!preferred) {
      missing.push(key);
      continue;
    }
    await prisma.accountMapping.create({ data: { key, accountId: preferred.id } });
  }
  for (const m of SEGMENT_MAPPINGS) {
    const segment = await prisma.segment.findUnique({ where: { code: m.segment } });
    const account = await prisma.account.findFirst({ where: { fullCode: m.code, postable: true } });
    if (!segment || !account) continue;
    if (await prisma.accountMapping.findFirst({ where: { key: m.key, companyId: null, segmentId: segment.id, currency: null } })) continue;
    await prisma.accountMapping.create({ data: { key: m.key, segmentId: segment.id, accountId: account.id } });
  }
  return { missing };
}
