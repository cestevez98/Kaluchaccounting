import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compareWithBc, postTreasuryMovement, reclassifyMovement, revalueMonth, seedDemo, trialBalance,
  voidTreasuryMovement, withTx, type TreasuryMovementInput,
} from '../src';

const prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
const acc: Record<string, string> = {};
const tre: Record<string, string> = {};
const cat: Record<string, string> = {};
let dm = '';

const post = (i: Omit<TreasuryMovementInput, 'companyId'> & { companyId?: string }) =>
  withTx(prisma, {}, (tx) => postTreasuryMovement(tx, { companyId: dm, ...i }));

async function balance(fullCode: string, companyId = dm) {
  const s = await prisma.journalLine.aggregate({ where: { accountId: acc[fullCode], companyId }, _sum: { amountUsd: true, amount: true } });
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
  for (const t of await prisma.treasuryAccount.findMany({ include: { glAccount: true } })) tre[t.glAccount.fullCode] = t.id;
  for (const c of await prisma.cashCategory.findMany()) cat[c.code] = c.id;
  dm = (await prisma.company.findUniqueOrThrow({ where: { code: 'DM' } })).id;
});

afterAll(() => prisma.$disconnect());

describe('tesorería', () => {
  it('un movimiento con categoría va contra la cuenta de la categoría', async () => {
    const r = await post({
      date: '2026-08-03', kind: 'MOVEMENT', description: 'Venta del día', categoryId: cat.VENTA_MINORISTA,
      legs: [{ treasuryAccountId: tre['101.0001']!, amount: '40000', rate: '400' }],
    });
    expect(r.document.number).toMatch(/^DM-TES-2026-\d{6}$/);
    expect(r.movement.needsReview).toBe(false);
    const lines = await prisma.journalLine.findMany({ where: { entryId: r.entry.id }, orderBy: { lineNo: 'asc' } });
    expect(lines.map((l) => [l.accountId, l.amountUsd.toFixed(4)])).toEqual([
      [acc['101.0001'], '100.0000'],
      [acc['900.0001'], '-100.0000'],
    ]);
    expect(lines[0]!.treasuryAccountId).toBe(tre['101.0001']);
  });

  it('sin categoría va a la bandeja y se reclasifica con un asiento de ajuste', async () => {
    const r = await post({
      date: '2026-08-04', kind: 'MOVEMENT', description: 'Pago sin clasificar', sourceReference: 'Gastos varios',
      legs: [{ treasuryAccountId: tre['101.0002']!, amount: '-50' }],
    });
    expect(r.movement.needsReview).toBe(true);
    expect((await balance('699.9998')).usd).toBe('50.0000');
    await withTx(prisma, {}, (tx) => reclassifyMovement(tx, r.movement.id, { accountId: acc['837.0001']!, note: 'Era alquiler' }));
    expect((await balance('699.9998')).usd).toBe('0.0000');
    expect((await balance('837.0001')).usd).toBe('50.0000');
    const m = await prisma.treasuryMovement.findUniqueOrThrow({ where: { id: r.movement.id } });
    expect(m).toMatchObject({ needsReview: false, reviewNote: 'Era alquiler' });
  });

  it('cambio de moneda con dos patas: la diferencia va a variación de tasas de cambio', async () => {
    const r = await post({
      date: '2026-08-05', kind: 'EXCHANGE', description: 'Cambio 100 USD', categoryId: cat.CAMBIO,
      legs: [
        { treasuryAccountId: tre['101.0002']!, amount: '-100' },
        { treasuryAccountId: tre['101.0001']!, amount: '41000', rate: '400' },
      ],
    });
    const lines = await prisma.journalLine.findMany({ where: { entryId: r.entry.id }, orderBy: { lineNo: 'asc' } });
    expect(lines.at(-1)).toMatchObject({ accountId: acc['924.0001'] });
    expect(lines.at(-1)!.amountUsd.toFixed(4)).toBe('-2.5000');
  });

  it('un cambio con una sola pata queda en la transitoria para casarlo', async () => {
    const r = await post({
      date: '2026-08-06', kind: 'MOVEMENT', description: 'Cambio por transferencia', categoryId: cat.CAMBIO,
      legs: [{ treasuryAccountId: tre['101.0002']!, amount: '20' }],
    });
    const lines = await prisma.journalLine.findMany({ where: { entryId: r.entry.id } });
    expect(lines.some((l) => l.accountId === acc['699.9996'])).toBe(true);
  });

  it('las patas deben ser de la empresa del movimiento', async () => {
    const err = await post({
      date: '2026-08-06', kind: 'MOVEMENT', description: 'x', legs: [{ treasuryAccountId: tre['109.9001']!, amount: '1' }],
    }).catch((e) => e);
    expect(err.message).toMatch(/pertenece a otra empresa/);
  });

  it('anular un movimiento genera contra-asiento y marca el documento', async () => {
    const r = await post({
      date: '2026-08-07', kind: 'MOVEMENT', description: 'Se anula', categoryId: cat.ALQUILER,
      legs: [{ treasuryAccountId: tre['101.0002']!, amount: '-10' }],
    });
    await withTx(prisma, {}, (tx) => voidTreasuryMovement(tx, r.movement.id, {}));
    expect((await prisma.document.findUniqueOrThrow({ where: { id: r.document.id } })).status).toBe('VOIDED');
    const s = await prisma.journalLine.aggregate({ where: { entry: { documentId: r.document.id } }, _sum: { amountUsd: true } });
    expect(s._sum.amountUsd?.isZero()).toBe(true);
  });
});

describe('revaluación mensual (tenencia)', () => {
  it('lleva el saldo a saldo/tasa de cierre y es idempotente', async () => {
    await post({
      date: '2026-09-10', kind: 'MOVEMENT', description: 'Entrada EUR', categoryId: cat.VENTA_MINORISTA,
      legs: [{ treasuryAccountId: tre['101.0003']!, amount: '900', rate: '0.9' }],
    });
    await setRate('2026-09-30', 'EUR', 'IC', '0.8');
    const before = await balance('101.0003');
    expect(before).toEqual({ usd: '1000.0000', orig: '900.0000' });

    const r1 = await withTx(prisma, {}, (tx) => revalueMonth(tx, dm, 2026, 9));
    const eurLine = await prisma.fxRevaluationLine.findFirstOrThrow({ where: { runId: r1.run.id, accountId: acc['101.0003'] } });
    expect(eurLine.diffUsd.toFixed(4)).toBe('125.0000');
    expect(eurLine.closingRate.toString()).toBe('0.8');
    expect((await balance('101.0003')).usd).toBe('1125.0000');
    const gains = await prisma.journalLine.aggregate({ where: { entryId: r1.entry!.id, accountId: acc['925.0001'] }, _sum: { amountUsd: true } });
    const losses = await prisma.journalLine.aggregate({ where: { entryId: r1.entry!.id, accountId: acc['846.0001'] }, _sum: { amountUsd: true } });
    expect(gains._sum.amountUsd!.plus(losses._sum.amountUsd ?? 0).neg().toFixed(4)).toBe(r1.totalUsd);

    const r2 = await withTx(prisma, {}, (tx) => revalueMonth(tx, dm, 2026, 9));
    expect(r2.totalUsd).toBe(r1.totalUsd);
    expect((await balance('101.0003')).usd).toBe('1125.0000');
    expect(await prisma.fxRevaluationRun.count({ where: { companyId: dm, year: 2026, month: 9, status: 'POSTED' } })).toBe(1);

    // CUP también se revalúa con su tipo (IC) y el balance sigue cuadrado.
    const tb = await trialBalance(prisma, { companyIds: [dm], year: 2026, month: 9, books: ['BASE', 'REAL'] });
    expect(tb.summary.balanced).toBe(true);
    const cup = await balance('101.0001');
    const line = await prisma.fxRevaluationLine.findFirst({ where: { runId: r2.run.id, accountId: acc['101.0001'] } });
    expect(line!.revaluedUsd.toFixed(4)).toBe(cup.usd);
  });
});

describe('conciliación con el BC del Excel', () => {
  it('clasifica diferencias en OK, explicada y no explicada', async () => {
    const batch = await prisma.importBatch.create({ data: { sourceFile: 'test.xlsx', fileHash: 'x', tableName: 'BC:referencia', stats: {} } });
    const a3 = await prisma.account.findUniqueOrThrow({ where: { fullCode: '101.0003' } });
    const a2 = await prisma.account.findUniqueOrThrow({ where: { fullCode: '101.0002' } });
    // El BC es consolidado y la base la comparten otros ficheros de test: la referencia se toma del valor del sistema.
    const before = await compareWithBc(prisma, { year: 2026, month: 9, codePrefixes: ['101'] });
    const system3 = new Prisma.Decimal(before.rows.find((x) => x.displayCode === '101.0003')!.system);
    await prisma.bcReference.createMany({
      data: [
        { importId: batch.id, fullCode: '101.0003', excelRow: a3.sortOrder, label: 'Caja EUR', year: 2026, month: 9, valueUsd: system3.plus('0.004').toFixed(4) },
        { importId: batch.id, fullCode: '101.0002', excelRow: a2.sortOrder, label: 'Caja USD', year: 2026, month: 9, valueUsd: '999' },
      ],
    });
    let r = await compareWithBc(prisma, { year: 2026, month: 9, codePrefixes: ['101'] });
    expect(r.rows.find((x) => x.displayCode === '101.0003')?.status).toBe('OK');
    expect(r.rows.find((x) => x.displayCode === '101.0002')?.status).toBe('DIFF');
    await prisma.bcExplanation.create({ data: { fullCode: '101.0002', reason: 'Prueba' } });
    r = await compareWithBc(prisma, { year: 2026, month: 9, codePrefixes: ['101'] });
    expect(r.rows.find((x) => x.displayCode === '101.0002')).toMatchObject({ status: 'EXPLAINED', explanation: 'Prueba' });
  });
});
