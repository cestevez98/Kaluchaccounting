import { PrismaClient, seedDemo } from '@kaluch/db';
import { prepareTestDatabase } from '@kaluch/db/testing';

const E2E_DB = process.env.E2E_DATABASE_URL ?? 'postgresql://kaluch:kaluch@localhost:5432/kaluch_e2e_test?schema=public';

export default async function globalSetup() {
  process.env.TEST_DATABASE_URL = E2E_DB;
  await prepareTestDatabase();
  const prisma = new PrismaClient({ datasourceUrl: E2E_DB });
  await seedDemo(prisma);
  await prisma.$disconnect();
}
