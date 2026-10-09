import { money } from '@kaluch/shared';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accrueLoanInterest, accrueTax, capitalByPartner, closeTaxPeriod, closeYear, createLoan, loanInterestForMonth, monthCloseStatus,
  postCapitalMovement, reclassifyLoanTerm, seedDemo, taxSummary, trialBalance, withTx,
} from '../src';

const prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
const acc: Record<string, string> = {};
const pa: Record<string, string> = {};
let kei = '';
let ktr = '';
const run = <T>(fn: Parameters<typeof withTx<T>>[2]) => withTx(prisma, {}, fn);

async function entryLines(entryId: string) {
  const lines = await prisma.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: { lineNo: 'asc' } });
  return lines.map((l) => [l.account.fullCode, l.amountUsd.toFixed(2)]);
}

beforeAll(async () => {
  await seedDemo(prisma, { entries: false });
  for (const a of await prisma.account.findMany()) acc[a.fullCode] = a.id;
  for (const p of await prisma.partyAccount.findMany({ include: { party: true, account: true } })) pa[`${p.party.code}:${p.account.fullCode}`] = p.id;
  kei = (await prisma.company.findUniqueOrThrow({ where: { code: 'KEI' } })).id;
  ktr = (await prisma.company.findUniqueOrThrow({ where: { code: 'KTR' } })).id;
});

afterAll(() => prisma.$disconnect());

describe('financiamientos', () => {
  it('el interés se reparte por días entre inicio y vencimiento y el último mes se lleva el resto', () => {
    const loan = { startDate: new Date('2026-05-16T00:00:00Z'), endDate: new Date('2026-07-15T00:00:00Z'), interestUsd: '610' };
    const may = loanInterestForMonth(loan, 2026, 5, money(0));
    const june = loanInterestForMonth(loan, 2026, 6, may);
    const july = loanInterestForMonth(loan, 2026, 7, may.plus(june));
    // 60 días: 16 en mayo (desde el día 16 inclusive), 30 en junio y el resto en julio.
    expect([may.toFixed(2), june.toFixed(2), july.toFixed(2)]).toEqual(['162.67', '305.00', '142.33']);
    expect(loanInterestForMonth({ ...loan, endDate: null }, 2026, 5, money(0)).toFixed(2)).toBe('610.00');
    expect(loanInterestForMonth({ ...loan, endDate: null }, 2026, 6, money(0)).toFixed(2)).toBe('0.00');
  });

  it('préstamo recibido: desembolso, partida por el total, interés mensual idempotente y corto/largo plazo', async () => {
    const ref = `FI-T-${Date.now()}`;
    const loan = await run((tx) => createLoan(tx, {
      partyAccountId: pa['PRESTAMISTA_DEMO:411']!, direction: 'RECEIVED', reference: ref, description: 'Prueba', startDate: '2026-09-01',
      endDate: '2028-08-31', principalUsd: '10000', ratePct: '12', counterAccountId: acc['109.9001']!,
    }));
    expect(loan.interestUsd.toFixed(2)).toBe('1200.00');
    const lines = await prisma.journalLine.findMany({ where: { entry: { documentId: loan.documentId! } }, include: { account: true }, orderBy: { lineNo: 'asc' } });
    expect(lines.map((l) => [l.account.fullCode, l.amountUsd.toFixed(2)])).toEqual([['411', '-10000.00'], ['109.9001', '10000.00']]);
    const item = await prisma.openItem.findFirstOrThrow({ where: { reference: ref } });
    expect([item.side, item.amount.toFixed(2)]).toEqual(['PAYABLE', '11200.00']);

    const sep = await run((tx) => accrueLoanInterest(tx, { companyId: kei, year: 2026, month: 9 }));
    const mine = sep.find((a) => a.reference === ref)!;
    expect(Number(mine.amountUsd)).toBeCloseTo(1200 * 30 / 730, 2);
    const again = await run((tx) => accrueLoanInterest(tx, { companyId: kei, year: 2026, month: 9 }));
    expect(again.find((a) => a.reference === ref)).toBeUndefined();

    // Vence a casi dos años: todo el principal a largo plazo (520); repetir no mueve nada.
    const term = await run((tx) => reclassifyLoanTerm(tx, { companyId: kei, asOf: '2026-09-30' }));
    expect(term.find((t) => t.reference === ref)).toMatchObject({ longTermUsd: '10000.0000', movedUsd: '10000.0000' });
    expect((await run((tx) => reclassifyLoanTerm(tx, { companyId: kei, asOf: '2026-09-30' }))).find((t) => t.reference === ref)).toBeUndefined();
    // A menos de un año del vencimiento vuelve a corto plazo.
    const back = await run((tx) => reclassifyLoanTerm(tx, { companyId: kei, asOf: '2027-09-30' }));
    expect(back.find((t) => t.reference === ref)).toMatchObject({ longTermUsd: '0.0000', movedUsd: '-10000.0000' });
  });

  it('préstamo dado: el interés es ingreso financiero (921) contra la cuenta del deudor', async () => {
    const ref = `FI-G-${Date.now()}`;
    await run((tx) => createLoan(tx, {
      partyAccountId: pa['DEUDOR_PRESTAMO_DEMO:138']!, direction: 'GIVEN', reference: ref, description: 'Prueba', startDate: '2026-10-05',
      principalUsd: '1000', ratePct: '10', counterAccountId: acc['109.9001']!,
    }));
    const r = await run((tx) => accrueLoanInterest(tx, { companyId: kei, year: 2026, month: 10 }));
    expect(r.find((a) => a.reference === ref)).toMatchObject({ amountUsd: '100.0000' });
    const accrual = await prisma.loanAccrual.findFirstOrThrow({ where: { loan: { reference: ref } } });
    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { documentId: accrual.documentId } });
    expect(await entryLines(entry.id)).toEqual([['138', '100.00'], ['921.8880', '-100.00']]);
  });
});

describe('impuestos', () => {
  it('devengo contra 480 y cierre del trimestre con la diferencia a 848 o 920', async () => {
    await run((tx) => accrueTax(tx, { companyId: ktr, agency: 'HACIENDA', date: '2025-01-31', periodFrom: '2025-01-01', periodTo: '2025-01-31', amountUsd: '1000', description: 'IVA enero' }));
    const feb = await run((tx) => accrueTax(tx, { companyId: ktr, agency: 'HACIENDA', date: '2025-02-28', periodFrom: '2025-02-01', periodTo: '2025-02-28', amountUsd: '500', description: 'IVA febrero' }));
    expect(await entryLines(feb.entry.id)).toEqual([['830.8880', '500.00'], ['480.8880', '-500.00']]);
    const close = await run((tx) => closeTaxPeriod(tx, { companyId: ktr, agency: 'HACIENDA', periodFrom: '2025-01-01', periodTo: '2025-03-31', date: '2025-04-20', declaredUsd: '1700' }));
    expect([close.accruedUsd, close.adjustmentUsd]).toEqual(['1500.0000', '200.0000']);
    expect(await entryLines(close.entry!.id)).toEqual([['848.8880', '200.00'], ['480.8880', '-200.00']]);
    await expect(run((tx) => closeTaxPeriod(tx, { companyId: ktr, agency: 'HACIENDA', periodFrom: '2025-03-01', periodTo: '2025-03-31', date: '2025-04-20', declaredUsd: '0' })))
      .rejects.toThrow(/ya está cerrado/);
    const sum = await taxSummary(prisma, { companyIds: [ktr], agency: 'HACIENDA', year: 2025 });
    expect(sum.months.slice(0, 4).map((m) => [m.accruedUsd, m.adjustmentUsd, m.balanceUsd])).toEqual([
      ['1000.0000', '0.0000', '1000.0000'], ['500.0000', '0.0000', '1500.0000'], ['0.0000', '0.0000', '1500.0000'], ['0.0000', '200.0000', '1700.0000'],
    ]);
    expect(sum.closings[0]).toMatchObject({ declaredUsd: '1700.0000', accruedUsd: '1500.0000', adjustmentUsd: '200.0000' });
  });
});

describe('capital y cierres', () => {
  it('aportes, retiro y reparto por socio con su participación', async () => {
    const [a, b] = await Promise.all(['SOCIO_DEMO_A', 'SOCIO_DEMO_B'].map((code) => prisma.party.findUniqueOrThrow({ where: { code } })));
    const c = await run((tx) => postCapitalMovement(tx, { companyId: ktr, partyId: a!.id, kind: 'CONTRIBUTION', date: '2025-02-01', amountUsd: '6000', counterAccountId: acc['109.9001']!, description: 'Aporte' }));
    expect(await entryLines(c.entry.id)).toEqual([['109.9001', '6000.00'], ['600.0001', '-6000.00']]);
    await run((tx) => postCapitalMovement(tx, { companyId: ktr, partyId: b!.id, kind: 'CONTRIBUTION', date: '2025-02-01', amountUsd: '4000', counterAccountId: acc['109.9001']!, description: 'Aporte' }));
    await run((tx) => postCapitalMovement(tx, { companyId: ktr, partyId: b!.id, kind: 'WITHDRAWAL', date: '2025-03-01', amountUsd: '1000', counterAccountId: acc['109.9001']!, description: 'Retiro' }));
    const d = await run((tx) => postCapitalMovement(tx, { companyId: ktr, partyId: a!.id, kind: 'DISTRIBUTION', date: '2025-03-15', amountUsd: '300', counterAccountId: acc['109.9001']!, description: 'Dividendo' }));
    expect(await entryLines(d.entry.id)).toEqual([['630', '300.00'], ['109.9001', '-300.00']]);
    const rows = await capitalByPartner(prisma, { companyIds: [ktr], asOf: '2025-12-31' });
    expect(rows.find((r) => r.partyId === a!.id)).toMatchObject({ capitalUsd: '6000.0000', retainedUsd: '-300.0000', sharePct: '66.67' });
    expect(rows.find((r) => r.partyId === b!.id)).toMatchObject({ capitalUsd: '3000.0000', sharePct: '33.33' });
  });

  it('el cierre anual lleva el resultado a 630 en el periodo 13, sin tocar diciembre, y se puede rehacer', async () => {
    const tb = (month: number) => trialBalance(prisma, { companyIds: [ktr], year: 2025, month, books: ['BASE', 'REAL'], includeZero: false });
    const decBefore = (await tb(12)).summary;
    const first = await run((tx) => closeYear(tx, { companyId: ktr, year: 2025 }));
    // Gastos de KTR en 2025: 1.500 de IVA devengado + 200 de cierre = −1.700 de resultado.
    expect(first.resultUsd.toFixed(2)).toBe('-1700.00');
    const decAfter = (await tb(12)).summary;
    expect(decAfter.expenses).toBe(decBefore.expenses);
    const jan = await trialBalance(prisma, { companyIds: [ktr], year: 2026, month: 1, books: ['BASE', 'REAL'], includeZero: true });
    expect(jan.rows.find((r) => r.displayCode === '848')?.opening).toBe('0.0000');
    expect(jan.rows.find((r) => r.displayCode === '630')?.opening).toBe('2000.0000');
    const periods = await prisma.fiscalPeriod.count({ where: { companyId: ktr, year: 2026, month: { gte: 1, lte: 12 } } });
    expect(periods).toBe(12);
    // Rehacer: anula el anterior y deja el mismo resultado.
    const again = await run((tx) => closeYear(tx, { companyId: ktr, year: 2025 }));
    expect(again.resultUsd.toFixed(2)).toBe('-1700.00');
    const jan2 = await trialBalance(prisma, { companyIds: [ktr], year: 2026, month: 1, books: ['BASE', 'REAL'], includeZero: true });
    expect(jan2.rows.find((r) => r.displayCode === '630')?.opening).toBe('2000.0000');
  });

  it('lista de comprobación del cierre de mes', async () => {
    const s = await monthCloseStatus(prisma, { companyId: kei, year: 2026, month: 11 });
    expect(s.checks.map((c) => c.key)).toEqual(['rates', 'tray', 'loans', 'revaluation', 'taxes', 'period']);
    expect(s.checks.find((c) => c.key === 'loans')).toMatchObject({ status: 'PENDING' });
    expect(s.checks.find((c) => c.key === 'period')).toMatchObject({ status: 'PENDING', detail: 'Abierto' });
  });
});
