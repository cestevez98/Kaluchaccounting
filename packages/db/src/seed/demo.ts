/**
 * Datos de DEMOSTRACIÓN (ficticios). Nunca contienen datos reales del grupo.
 * Uso: pnpm db:seed
 */
import { PrismaClient } from '@prisma/client';
import { withTx } from '../client';
import { postEntry } from '../ledger';
import { ensureSystemAccounts } from '../system-accounts';
import { seedDemoTreasury } from './treasury-demo';
import { seedDemoParties } from './parties-demo';
import { seedDemoProducts, seedDemoSales } from './sales-demo';
import { seedDemoFinance, seedDemoPartners } from './finance-demo';
import { upsertAccounts } from './accounts';
import { DEMO_ACCOUNTS } from './accounts-demo';
import { seedCatalogs, seedPeriods } from './catalogs';
import { ensureUser } from './users';

export const DEMO_PASSWORD = 'Kaluch-demo-2026';

/** Tasas sintéticas diarias (1 USD = X) con una deriva suave y determinista. */
function demoRate(base: number, day: number, drift: number) {
  return (base * (1 + drift * day + 0.004 * Math.sin(day / 5))).toFixed(6);
}

export async function seedDemo(prisma: PrismaClient, opts: { entries?: boolean } = {}) {
  await seedCatalogs(prisma);
  await seedPeriods(prisma, 2026);

  await upsertAccounts(
    prisma,
    DEMO_ACCOUNTS.map(([code, subcode, name, nature, classification, o], i) => ({
      code, subcode, name, nature, classification,
      currencyLock: o?.currency ?? null,
      revalRateType: o?.reval ?? null,
      isIntercompany: o?.intercompany,
      isPendingExport: o?.pending,
      defaultSegmentCode: o?.segment ?? null,
      sortOrder: i,
    })),
  );
  await ensureSystemAccounts(prisma);
  await seedDemoTreasury(prisma);
  await seedDemoParties(prisma);
  await seedDemoProducts(prisma);
  await seedDemoPartners(prisma);

  // Tasas 01/01/2026 – 31/10/2026.
  const series: [string, string, string, number, number][] = [
    ['CUP', 'IC', 'USD', 390, 0.0003],
    ['CUP', 'OC', 'USD', 120, 0],
    ['MLC', 'IC', 'USD', 1.9, 0.0001],
    ['EUR', 'IC', 'USD', 0.88, 0.00002],
    ['EUR', 'OC', 'USD', 0.86, 0.00002],
    ['EUR', 'OUE', 'USD', 0.87, 0.00002],
    ['GBP', 'OUE', 'USD', 0.75, 0],
    ['CAD', 'OUE', 'USD', 1.37, 0],
    ['DOP', 'ORD', 'USD', 63, 0.00005],
    ['CUP', 'OC', 'EUR', 135, 0],
  ];
  const start = Date.UTC(2026, 0, 1);
  const data = [];
  for (let day = 0; day < 304; day++) {
    const rateDate = new Date(start + day * 86_400_000);
    for (const [currency, rateType, base, b, drift] of series) {
      data.push({ rateDate, currency, rateType, base, rate: demoRate(b, day, drift), source: 'demo' });
    }
  }
  await prisma.exchangeRate.createMany({ data, skipDuplicates: true });

  const admin = await ensureUser(prisma, {
    email: 'admin@kaluch.local', name: 'Administrador demo', password: DEMO_PASSWORD, role: 'Superadministrador',
  });
  await ensureUser(prisma, { email: 'contador@kaluch.local', name: 'Contador demo', password: DEMO_PASSWORD, role: 'Contador' });
  await ensureUser(prisma, {
    email: 'lectura@kaluch.local', name: 'Lectura demo (solo KEI)', password: DEMO_PASSWORD, role: 'Solo lectura', companyCodes: ['KEI'],
  });

  // Los asientos de demostración se cargan una vez (aunque otros procesos ya hayan contabilizado).
  if (opts.entries === false || (await prisma.journalEntry.findFirst({ where: { memo: 'Aporte inicial de capital (demo)' } }))) return;

  const acc = async (fullCode: string) => (await prisma.account.findUniqueOrThrow({ where: { fullCode } })).id;
  const company = async (code: string) => (await prisma.company.findUniqueOrThrow({ where: { code } })).id;
  const seg999 = (await prisma.segment.findUniqueOrThrow({ where: { code: '999' } })).id;
  const pos = (await prisma.dimensionValue.findUniqueOrThrow({ where: { dimension_code: { dimension: 'POS', code: '1RA-12' } } })).id;
  const [dm, kei] = [await company('DM'), await company('KEI')];

  await withTx(prisma, { userId: admin.id }, async (tx) => {
    await postEntry(tx, {
      companyId: kei, entryDate: '2026-04-01', kind: 'MANUAL', memo: 'Aporte inicial de capital (demo)', createdBy: admin.id,
      lines: [
        { accountId: await acc('109.9001'), currency: 'USD', amount: '25000' },
        { accountId: await acc('600.0001'), currency: 'USD', amount: '-25000' },
      ],
    });
    await postEntry(tx, {
      companyId: dm, entryDate: '2026-04-02', kind: 'MANUAL', memo: 'Aporte en efectivo CUP (demo)', createdBy: admin.id,
      lines: [
        { accountId: await acc('101.0001'), currency: 'CUP', amount: '2000000' },
        { accountId: await acc('600.0001'), currency: 'CUP', amount: '-2000000' },
      ],
    });
    await postEntry(tx, {
      companyId: dm, entryDate: '2026-04-15', kind: 'MANUAL', memo: 'Venta minorista en efectivo — 1ra y 12 (demo)', createdBy: admin.id,
      lines: [
        { accountId: await acc('101.0001'), currency: 'CUP', amount: '120000', segmentId: seg999, posId: pos },
        { accountId: await acc('900.0001'), currency: 'CUP', amount: '-120000', segmentId: seg999, posId: pos },
      ],
    });
    await postEntry(tx, {
      companyId: dm, entryDate: '2026-04-20', kind: 'MANUAL', memo: 'Alquiler de local (demo)', createdBy: admin.id,
      lines: [
        { accountId: await acc('837.0001'), currency: 'CUP', amount: '40000', segmentId: seg999 },
        { accountId: await acc('101.0001'), currency: 'CUP', amount: '-40000' },
      ],
    });
    await postEntry(tx, {
      companyId: kei, entryDate: '2026-05-05', kind: 'MANUAL', memo: 'Venta de exportación cobrada (demo)', createdBy: admin.id,
      lines: [
        { accountId: await acc('109.9001'), currency: 'USD', amount: '8000' },
        { accountId: await acc('900.0002'), currency: 'USD', amount: '-8000' },
      ],
    });
  });
  await seedDemoSales(prisma, admin.id);
  await seedDemoFinance(prisma, admin.id);
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seedDemo(prisma)
    .then(() => console.log('Datos de demostración cargados. Usuario: admin@kaluch.local / ' + DEMO_PASSWORD))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
