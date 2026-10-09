import type { PrismaClient } from '@prisma/client';
import { upsertParty, upsertPartyAccount } from '../parties';

/** Contrapartes de DEMOSTRACIÓN (ficticias). */
const PARTIES: { code: string; name: string; kind: 'PERSON' | 'COMPANY'; roles: ('CUSTOMER' | 'SUPPLIER' | 'EMPLOYEE' | 'PARTNER' | 'COURIER' | 'SELLER' | 'INVESTOR' | 'LENDER' | 'OTHER')[]; company: string; currency: string; account: string; opposite?: string }[] = [
  { code: 'CONTRAPARTE_DEMO', name: 'Contraparte demo', kind: 'PERSON', roles: ['COURIER'], company: 'DM', currency: 'USD', account: '135.0001', opposite: '405.0001' },
  { code: 'CONTRAPARTE_EUR', name: 'Contraparte demo EUR', kind: 'PERSON', roles: ['CUSTOMER'], company: 'DM', currency: 'EUR', account: '135.0002', opposite: '405.0002' },
  { code: 'PROVEEDOR_DEMO', name: 'Proveedor demo S.L.', kind: 'COMPANY', roles: ['SUPPLIER'], company: 'KEI', currency: 'USD', account: '406' },
  { code: 'TRABAJADORA_DEMO', name: 'Trabajadora demo', kind: 'PERSON', roles: ['EMPLOYEE'], company: 'DM', currency: 'USD', account: '455' },
  // Fase 4: exportación y distribución.
  { code: 'CLIENTE_EXPORTACION_DEMO', name: 'Cliente exportación demo S.A.', kind: 'COMPANY', roles: ['CUSTOMER'], company: 'KEI', currency: 'USD', account: '136' },
  { code: 'CLIENTE_DISTRIBUCION_DEMO', name: 'Cliente distribución demo', kind: 'PERSON', roles: ['CUSTOMER'], company: 'GR', currency: 'USD', account: '137' },
  { code: 'VENDEDOR_DEMO', name: 'Vendedor demo', kind: 'PERSON', roles: ['SELLER'], company: 'GR', currency: 'USD', account: '410.9990' },
  { code: 'VENDEDOR_DEMO', name: 'Vendedor demo', kind: 'PERSON', roles: ['SELLER'], company: 'KEI', currency: 'USD', account: '410.8880' },
  { code: 'INVERSIONISTA_DEMO', name: 'Inversionista demo', kind: 'PERSON', roles: ['INVESTOR'], company: 'GR', currency: 'USD', account: '412' },
  // Fase 5: financiamientos y socios.
  { code: 'PRESTAMISTA_DEMO', name: 'Prestamista demo', kind: 'PERSON', roles: ['LENDER'], company: 'KEI', currency: 'USD', account: '411' },
  { code: 'DEUDOR_PRESTAMO_DEMO', name: 'Deudor de préstamo demo', kind: 'PERSON', roles: ['OTHER'], company: 'KEI', currency: 'USD', account: '138' },
  { code: 'PROVEEDOR_DISTRIBUCION_DEMO', name: 'Proveedor distribución demo', kind: 'COMPANY', roles: ['SUPPLIER'], company: 'GR', currency: 'USD', account: '406' },
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
