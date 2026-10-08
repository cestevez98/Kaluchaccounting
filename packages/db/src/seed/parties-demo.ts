import type { PrismaClient } from '@prisma/client';
import { upsertParty, upsertPartyAccount } from '../parties';

/** Contrapartes de DEMOSTRACIÓN (ficticias). */
const PARTIES: { code: string; name: string; kind: 'PERSON' | 'COMPANY'; roles: ('CUSTOMER' | 'SUPPLIER' | 'EMPLOYEE' | 'PARTNER' | 'COURIER')[]; company: string; currency: string; account: string; opposite?: string }[] = [
  { code: 'CONTRAPARTE_DEMO', name: 'Contraparte demo', kind: 'PERSON', roles: ['COURIER'], company: 'DM', currency: 'USD', account: '135.0001', opposite: '405.0001' },
  { code: 'CONTRAPARTE_EUR', name: 'Contraparte demo EUR', kind: 'PERSON', roles: ['CUSTOMER'], company: 'DM', currency: 'EUR', account: '135.0002', opposite: '405.0002' },
  { code: 'PROVEEDOR_DEMO', name: 'Proveedor demo S.L.', kind: 'COMPANY', roles: ['SUPPLIER'], company: 'KEI', currency: 'USD', account: '406' },
  { code: 'TRABAJADORA_DEMO', name: 'Trabajadora demo', kind: 'PERSON', roles: ['EMPLOYEE'], company: 'DM', currency: 'USD', account: '455' },
];

export async function seedDemoParties(prisma: PrismaClient) {
  for (const p of PARTIES) {
    const party = await upsertParty(prisma, { code: p.code, name: p.name, kind: p.kind, roles: p.roles });
    const company = await prisma.company.findUniqueOrThrow({ where: { code: p.company } });
    const account = await prisma.account.findUniqueOrThrow({ where: { fullCode: p.account } });
    const opposite = p.opposite ? await prisma.account.findUniqueOrThrow({ where: { fullCode: p.opposite } }) : null;
    await upsertPartyAccount(prisma, {
      companyId: company.id, partyId: party.id, currency: p.currency, accountId: account.id, oppositeAccountId: opposite?.id ?? null,
      name: `${p.name} ${p.currency}`,
    });
  }
  // Categoría de tesorería ligada a la cuenta corriente de la contraparte demo.
  const pa = await prisma.partyAccount.findFirstOrThrow({ where: { party: { code: 'CONTRAPARTE_DEMO' }, currency: 'USD' } });
  await prisma.cashCategory.upsert({
    where: { code: 'DEUDA_CONTRAPARTE_DEMO' },
    update: {},
    create: { code: 'DEUDA_CONTRAPARTE_DEMO', name: 'Deuda Contraparte demo', kind: 'DEBT', partyAccountId: pa.id },
  });
}
