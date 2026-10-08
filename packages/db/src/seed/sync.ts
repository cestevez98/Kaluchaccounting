/**
 * Sincronización al arrancar la API (producción): catálogos, roles de sistema, parámetros y, si el plan de
 * cuentas ya está importado, las cuentas de sistema y los mapeos contables de las fases nuevas. Idempotente.
 */
import { PrismaClient } from '@prisma/client';
import { ensureSystemAccounts } from '../system-accounts';
import { seedCatalogs } from './catalogs';

async function main() {
  const prisma = new PrismaClient();
  try {
    await seedCatalogs(prisma);
    if (await prisma.account.findFirst({ where: { code: '699', subcode: null } })) {
      const { missing } = await ensureSystemAccounts(prisma);
      if (missing.length) console.log(`Mapeos sin cuenta en el plan: ${missing.join(', ')}`);
    }
    console.log('Catálogos y mapeos sincronizados.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
