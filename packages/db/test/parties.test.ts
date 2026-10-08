import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openItemAging, partyBalances, partyStatement, postPartyDocument, postPayroll, postTreasuryMovement, reclassifyBySign,
  revalueMonth, seedDemo, settleOpenItem, trialBalance, upsertParty, upsertPartyAccount, voidSettlement, withTx,
  type PartyDocumentInput,
} from '../src';

const prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
const acc: Record<string, string> = {};
const pa: Record<string, string> = {};
let dm = '';
let kei = '';

const doc = (i: PartyDocumentInput) => withTx(prisma, {}, (tx) => postPartyDocument(tx, i));

async function lineSum(fullCode: string, where: Record<string, unknown> = {}) {
  const s = await prisma.journalLine.aggregate({ where: { accountId: acc[fullCode], ...where }, _sum: { amountUsd: true, amount: true } });
  return { usd: s._sum.amountUsd?.toFixed(4) ?? '0.0000', orig: s._sum.amount?.toFixed(4) ?? '0.0000' };
}

async function setRate(date: string, currency: string, rateType: string, rate: string) {
  const rateDate = new Date(`${date}T00:00:00Z`);
  await prisma.exchangeRate.upsert({
    where: { rateDate_currency_rateType_base: { rateDate, currency, rateType, base: 'USD' } },
    update: { rate },
    create: { rateDate, currency, rateType, base: 'USD', rate },
  });
}

beforeAll(async () => {
  await seedDemo(prisma, { entries: false });
  for (const a of await prisma.account.findMany()) acc[a.fullCode] = a.id;
  for (const p of await prisma.partyAccount.findMany({ include: { party: true } })) pa[p.party.code] = p.id;
  dm = (await prisma.company.findUniqueOrThrow({ where: { code: 'DM' } })).id;
  kei = (await prisma.company.findUniqueOrThrow({ where: { code: 'KEI' } })).id;
});

afterAll(() => prisma.$disconnect());

describe('cuentas corrientes de contrapartes', () => {
  it('un cargo y un abono se contabilizan en la cuenta de la contraparte con su identificación', async () => {
    const r = await doc({
      partyAccountId: pa.CONTRAPARTE_DEMO!, date: '2026-05-04', kind: 'CHARGE', amount: '1000', counterAccountId: acc['900.0001'],
      description: 'Envío facturado', reference: 'ENV-1', openItem: true,
    });
    expect(r.document.number).toMatch(/^DM-CTE-2026-\d{6}$/);
    const partyId = (await prisma.partyAccount.findUniqueOrThrow({ where: { id: pa.CONTRAPARTE_DEMO } })).partyId;
    const lines = await prisma.journalLine.findMany({ where: { entryId: r.entry.id }, orderBy: { lineNo: 'asc' } });
    expect(lines.map((l) => [l.accountId, l.amountUsd.toFixed(4), l.partyId])).toEqual([
      [acc['135.0001'], '1000.0000', partyId],
      [acc['900.0001'], '-1000.0000', null],
    ]);
    expect(r.openItem).toMatchObject({ side: 'RECEIVABLE', amount: expect.anything(), status: 'OPEN' });
    expect(r.openItem!.openAmount.toFixed(2)).toBe('1000.00');
  });

  it('un pago de tesorería con categoría de contraparte va a su cuenta corriente y liquida la partida', async () => {
    const tre = await prisma.treasuryAccount.findFirstOrThrow({ where: { glAccount: { fullCode: '101.0002' } } });
    const cat = await prisma.cashCategory.findUniqueOrThrow({ where: { code: 'DEUDA_CONTRAPARTE_DEMO' } });
    const m = await withTx(prisma, {}, (tx) => postTreasuryMovement(tx, {
      companyId: dm, date: '2026-05-10', kind: 'MOVEMENT', description: 'Cobro parcial', categoryId: cat.id,
      legs: [{ treasuryAccountId: tre.id, amount: '600' }],
    }));
    expect(m.movement.needsReview).toBe(false);
    const counter = await prisma.journalLine.findFirstOrThrow({ where: { entryId: m.entry.id, accountId: acc['135.0001'] } });
    expect(counter.amountUsd.toFixed(4)).toBe('-600.0000');
    expect(counter.partyId).toBe(m.movement.partyId);

    const item = await prisma.openItem.findFirstOrThrow({ where: { reference: 'ENV-1' } });
    await withTx(prisma, {}, (tx) => settleOpenItem(tx, { openItemId: item.id, amount: '600', date: '2026-05-10', paymentDocumentId: m.document.id }));
    let after = await prisma.openItem.findUniqueOrThrow({ where: { id: item.id } });
    expect([after.status, after.openAmount.toFixed(2)]).toEqual(['PARTIAL', '400.00']);
    await expect(withTx(prisma, {}, (tx) => settleOpenItem(tx, { openItemId: item.id, amount: '500', date: '2026-05-11' })))
      .rejects.toThrow(/supera el pendiente/);
    const s = await prisma.settlement.findFirstOrThrow({ where: { openItemId: item.id } });
    await withTx(prisma, {}, (tx) => voidSettlement(tx, s.id));
    after = await prisma.openItem.findUniqueOrThrow({ where: { id: item.id } });
    expect([after.status, after.openAmount.toFixed(2)]).toEqual(['OPEN', '1000.00']);
  });

  it('la reclasificación por signo deja el saldo acreedor en la 405 y es idempotente', async () => {
    // Saldo en mayo: 1000 − 600 = 400 deudor. Un abono de 900 lo deja en 500 acreedor.
    await doc({ partyAccountId: pa.CONTRAPARTE_DEMO!, date: '2026-05-20', kind: 'CREDIT', amount: '-900', counterAccountId: acc['699.9995'], description: 'Envíos a pagar' });
    await withTx(prisma, {}, (tx) => reclassifyBySign(tx, dm, 2026, 5));
    const tb = await trialBalance(prisma, { companyIds: [dm], year: 2026, month: 5, books: ['BASE', 'REAL'] });
    const row = (c: string) => tb.rows.find((r) => r.displayCode === c);
    expect(row('135.0001')?.bcValue ?? '0.0000').toBe('0.0000');
    expect(row('405.0001')?.bcValue).toBe('-500.0000');
    expect(tb.summary.balanced).toBe(true);
    // Repetir el mes no mueve nada más.
    const again = await withTx(prisma, {}, (tx) => reclassifyBySign(tx, dm, 2026, 5));
    expect(again.entry).toBeNull();
    // En junio vuelve a ser deudor (cargo de 800) y el saldo regresa a la 135.
    await doc({ partyAccountId: pa.CONTRAPARTE_DEMO!, date: '2026-06-03', kind: 'CHARGE', amount: '800', counterAccountId: acc['699.9995'], description: 'Envío' });
    await withTx(prisma, {}, (tx) => reclassifyBySign(tx, dm, 2026, 6));
    const jun = await trialBalance(prisma, { companyIds: [dm], year: 2026, month: 6, books: ['BASE', 'REAL'] });
    expect(jun.rows.find((r) => r.displayCode === '135.0001')?.bcValue).toBe('300.0000');
    expect(jun.rows.find((r) => r.displayCode === '405.0001')?.bcValue ?? '0.0000').toBe('0.0000');
  });

  it('el estado de cuenta suma la cuenta principal y la opuesta sin las reclasificaciones', async () => {
    const party = await prisma.party.findUniqueOrThrow({ where: { code: 'CONTRAPARTE_DEMO' } });
    const st = await partyStatement(prisma, { partyId: party.id, companyIds: [dm], from: '2026-05-01', to: '2026-06-30' });
    const usd = st.currencies.find((c) => c.currency === 'USD')!;
    expect(usd.opening).toBe('0.0000');
    expect(usd.lines.map((l) => l.amount)).toEqual(['1000.0000', '-600.0000', '-900.0000', '800.0000']);
    expect(usd.closing).toBe('300.0000');
    const bal = await partyBalances(prisma, { companyIds: [dm], asOf: '2026-06-30', partyId: party.id });
    expect(bal[0]).toMatchObject({ balance: '300.0000', openItems: 1, oldestOpen: '2026-05-04' });
  });

  it('una cesión de deuda pasa el saldo de una contraparte a otra', async () => {
    const luiso = await upsertParty(prisma, { code: 'LUISO_TEST', name: 'Luiso test', roles: ['CUSTOMER'] });
    const lpa = await upsertPartyAccount(prisma, { companyId: dm, partyId: luiso.id, currency: 'USD', accountId: acc['135.0001']!, oppositeAccountId: acc['405.0001'], name: 'Luiso test USD' });
    await doc({ partyAccountId: pa.CONTRAPARTE_DEMO!, date: '2026-06-10', kind: 'ASSIGNMENT', amount: '-300', counterPartyAccountId: lpa.id, description: 'Cesión de deuda a Luiso' });
    const bal = await partyBalances(prisma, { companyIds: [dm], asOf: '2026-06-30' });
    expect(bal.find((b) => b.partyCode === 'CONTRAPARTE_DEMO')?.balance).toBe('0.0000');
    expect(bal.find((b) => b.partyCode === 'LUISO_TEST')?.balance).toBe('300.0000');
  });

  it('las cuentas corrientes en EUR se revalúan a fin de mes contra 846/925 de cuentas por cobrar', async () => {
    // En KGT, para no interferir con las revaluaciones de DM de otros tests.
    const kgt = (await prisma.company.findUniqueOrThrow({ where: { code: 'KGT' } })).id;
    const party = await prisma.party.findUniqueOrThrow({ where: { code: 'CONTRAPARTE_EUR' } });
    const eur = await upsertPartyAccount(prisma, { companyId: kgt, partyId: party.id, currency: 'EUR', accountId: acc['135.0002']!, oppositeAccountId: acc['405.0002'], name: 'Contraparte demo EUR (KGT)' });
    await setRate('2026-07-01', 'EUR', 'OUE', '0.8');
    await setRate('2026-07-31', 'EUR', 'OUE', '0.9');
    await doc({ partyAccountId: eur.id, date: '2026-07-01', kind: 'CHARGE', amount: '800', counterAccountId: acc['699.9995'], description: 'Factura EUR' });
    expect((await lineSum('135.0002', { companyId: kgt })).usd).toBe('1000.0000');
    const r = await withTx(prisma, {}, (tx) => revalueMonth(tx, kgt, 2026, 7));
    // 800 EUR / 0,9 = 888,89 → pérdida de 111,11 por tenencia de cuentas por cobrar.
    expect(r.totalUsd).toBe('-111.1111');
    expect((await lineSum('846.8880', { companyId: kgt })).usd).toBe('111.1111');
    expect((await lineSum('135.0002', { companyId: kgt })).usd).toBe('888.8889');
  });

  it('antigüedad de partidas abiertas por tramos', async () => {
    await doc({ partyAccountId: pa.PROVEEDOR_DEMO!, date: '2026-03-01', kind: 'CREDIT', amount: '-5000', counterAccountId: acc['699.9995'], description: 'Factura antigua', reference: 'F-1', openItem: true });
    await doc({ partyAccountId: pa.PROVEEDOR_DEMO!, date: '2026-07-20', kind: 'CREDIT', amount: '-2000', counterAccountId: acc['699.9995'], description: 'Factura reciente', reference: 'F-2', openItem: true });
    const aging = await openItemAging(prisma, { companyIds: [kei], side: 'PAYABLE', asOf: '2026-07-31' });
    expect(aging[0]).toMatchObject({ partyName: 'Proveedor demo S.L.', total: '7000.0000', totalUsd: '7000.0000' });
    expect(aging[0]!.buckets).toMatchObject({ current: '2000.0000', older: '5000.0000' });
  });
});

describe('nómina', () => {
  it('contabiliza salario, descuentos y Mipyme y crea la partida a pagar', async () => {
    const seg = await prisma.segment.findUniqueOrThrow({ where: { code: '999' } });
    const r = await withTx(prisma, {}, (tx) => postPayroll(tx, {
      partyAccountId: pa.TRABAJADORA_DEMO!, date: '2026-07-31', period: '2026-07', employer: 'KALUCH', concept: 'Salario',
      gross: '500', attendanceDeduction: '-20', mipymeDeduction: '-30', segmentId: seg.id,
    }));
    const lines = await prisma.journalLine.findMany({ where: { entryId: r.entry.id }, orderBy: { lineNo: 'asc' } });
    expect(lines.map((l) => [l.accountId, l.amountUsd.toFixed(2)])).toEqual([
      [acc['826.9990'], '480.00'],
      [acc['455'], '-450.00'],
      [acc['146.0003'], '-30.00'],
    ]);
    expect(r.openItem).toMatchObject({ side: 'PAYABLE', status: 'OPEN' });
    const detail = await prisma.payrollLine.findUniqueOrThrow({ where: { id: r.document.id } });
    expect(detail.net.toFixed(2)).toBe('450.00');
    await expect(withTx(prisma, {}, (tx) => postPayroll(tx, {
      partyAccountId: pa.TRABAJADORA_DEMO!, date: '2026-07-31', period: '2026-07', employer: 'KALUCH', concept: 'Salario', gross: '100', attendanceDeduction: '20',
    }))).rejects.toThrow(/negativo/);
  });
});
