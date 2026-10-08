import type { PrismaClient } from '@prisma/client';
import { upsertAccounts } from './seed/accounts';

/**
 * Cuentas de sistema (no existen en el Excel) bajo la 699 Transitoria, y los
 * mapeos contables que usa el motor. Idempotente.
 */
export const SYSTEM_ACCOUNTS = [
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
};

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
  return { missing };
}
