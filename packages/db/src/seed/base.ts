/**
 * Semilla base para producción: catálogos, roles, parámetros, periodos del año
 * en curso y el usuario Superadministrador inicial (desde variables de entorno).
 * Uso: ADMIN_EMAIL=… ADMIN_PASSWORD=… pnpm --filter @kaluch/db seed:base
 */
import { PrismaClient } from '@prisma/client';
import { seedCatalogs, seedPeriods } from './catalogs';
import { ensureUser } from './users';

async function main() {
  const prisma = new PrismaClient();
  try {
    await seedCatalogs(prisma);
    await seedPeriods(prisma, new Date().getUTCFullYear());
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;
    if (email && password) {
      if (password.length < 12) throw new Error('ADMIN_PASSWORD debe tener al menos 12 caracteres');
      await ensureUser(prisma, { email, name: 'Superadministrador', password, role: 'Superadministrador' });
      console.log(`Usuario ${email} listo.`);
    } else {
      console.log('ADMIN_EMAIL/ADMIN_PASSWORD no definidos: no se crea usuario inicial.');
    }
    console.log('Semilla base aplicada.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
