import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

/** Prepara la base de datos de TEST (nunca la de desarrollo): esquema limpio + migraciones. */
export async function prepareTestDatabase() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Define TEST_DATABASE_URL para los tests de integración');
  if (!/test/i.test(url)) throw new Error('TEST_DATABASE_URL debe apuntar a una base de datos de test');
  process.env.DATABASE_URL = url;
  const prisma = new PrismaClient({ datasourceUrl: url });
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  await prisma.$disconnect();
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
  });
}
