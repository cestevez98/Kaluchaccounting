import type { PrismaClient } from '@prisma/client';
import { withTx } from '../client';
import { accrueLoanInterest, accrueTax, closeTaxPeriod, createLoan, postCapitalMovement } from '../finance';
import { upsertParty } from '../parties';

/** Socios de DEMOSTRACIÓN (ficticios). */
export async function seedDemoPartners(prisma: PrismaClient) {
  await upsertParty(prisma, { code: 'SOCIO_DEMO_A', name: 'Socia demo A', kind: 'PERSON', roles: ['PARTNER'] });
  await upsertParty(prisma, { code: 'SOCIO_DEMO_B', name: 'Socio demo B', kind: 'PERSON', roles: ['PARTNER'] });
}

/** Préstamos, impuestos y capital de demostración (con asientos). */
export async function seedDemoFinance(prisma: PrismaClient, userId: string) {
  const kei = await prisma.company.findUniqueOrThrow({ where: { code: 'KEI' } });
  const dm = await prisma.company.findUniqueOrThrow({ where: { code: 'DM' } });
  const acc = async (fullCode: string) => (await prisma.account.findUniqueOrThrow({ where: { fullCode } })).id;
  const pa = (party: string, account: string) => prisma.partyAccount.findFirstOrThrow({ where: { party: { code: party }, account: { fullCode: account } } });
  const lender = await pa('PRESTAMISTA_DEMO', '411');
  const borrower = await pa('DEUDOR_PRESTAMO_DEMO', '138');
  const bank = await acc('109.9001');
  const partnerA = await prisma.party.findUniqueOrThrow({ where: { code: 'SOCIO_DEMO_A' } });
  const partnerB = await prisma.party.findUniqueOrThrow({ where: { code: 'SOCIO_DEMO_B' } });
  await withTx(prisma, { userId }, async (tx) => {
    await createLoan(tx, {
      partyAccountId: lender.id, direction: 'RECEIVED', reference: 'FI-DEMO-001', description: 'Financiamiento de contenedor',
      startDate: '2026-05-01', endDate: '2026-10-31', principalUsd: '20000', ratePct: '9', counterAccountId: bank, createdBy: userId,
    });
    await createLoan(tx, {
      partyAccountId: borrower.id, direction: 'GIVEN', reference: 'FI-DEMO-002', description: 'Préstamo a un colaborador',
      startDate: '2026-06-15', endDate: '2027-12-15', principalUsd: '3000', ratePct: '5', counterAccountId: bank, createdBy: userId,
    });
    for (const month of [5, 6, 7, 8]) await accrueLoanInterest(tx, { companyId: kei.id, year: 2026, month, createdBy: userId });
    await postCapitalMovement(tx, { companyId: kei.id, partyId: partnerA.id, kind: 'CONTRIBUTION', date: '2026-04-01', amountUsd: '15000', counterAccountId: bank, description: 'Aporte inicial', createdBy: userId });
    await postCapitalMovement(tx, { companyId: kei.id, partyId: partnerB.id, kind: 'CONTRIBUTION', date: '2026-04-01', amountUsd: '10000', counterAccountId: bank, description: 'Aporte inicial', createdBy: userId });
    for (const [month, amount] of [[4, '800'], [5, '950'], [6, '700']] as const) {
      const m = String(month).padStart(2, '0');
      const last = new Date(Date.UTC(2026, month, 0)).getUTCDate();
      await accrueTax(tx, {
        companyId: dm.id, agency: 'ONAT', date: `2026-${m}-${last}`, periodFrom: `2026-${m}-01`, periodTo: `2026-${m}-${last}`,
        amountUsd: amount, description: `Impuesto sobre ventas ${m}/2026`, createdBy: userId,
      });
    }
    await closeTaxPeriod(tx, { companyId: dm.id, agency: 'ONAT', periodFrom: '2026-04-01', periodTo: '2026-06-30', date: '2026-07-15', declaredUsd: '2600', createdBy: userId });
  });
}
