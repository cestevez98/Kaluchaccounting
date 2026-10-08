import fc from 'fast-check';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generalLedger, LedgerError, postEntry, reverseEntry, seedDemo, translateDbError, trialBalance, withTx,
  type PostEntryInput,
} from '../src';

const prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
const ids: Record<string, string> = {};
let userId = '';

async function post(input: Omit<PostEntryInput, 'kind'> & { kind?: PostEntryInput['kind'] }, opts: { allowSoftClosed?: boolean } = {}) {
  try {
    return await withTx(prisma, { userId, ...opts }, (tx) => postEntry(tx, { kind: 'MANUAL', ...input }));
  } catch (e) {
    throw translateDbError(e);
  }
}

async function expectLedgerError(p: Promise<unknown>, code: LedgerError['code'], msg?: RegExp) {
  const err = await p.then(() => null, (e) => e);
  expect(err, 'se esperaba un error').toBeInstanceOf(LedgerError);
  expect((err as LedgerError).code).toBe(code);
  if (msg) expect((err as LedgerError).message).toMatch(msg);
}

beforeAll(async () => {
  await seedDemo(prisma, { entries: false });
  for (const a of await prisma.account.findMany()) ids[a.fullCode] = a.id;
  for (const c of await prisma.company.findMany()) ids[c.code] = c.id;
  userId = (await prisma.appUser.findUniqueOrThrow({ where: { email: 'contador@kaluch.local' } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('motor de asientos', () => {
  it('contabiliza un asiento multimoneda con la tasa vigente y actualiza saldos', async () => {
    const rate = await prisma.exchangeRate.findFirstOrThrow({
      where: { currency: 'CUP', rateType: 'IC', rateDate: new Date('2026-06-10T00:00:00Z') },
    });
    const entry = await post({
      companyId: ids.GR!, entryDate: '2026-06-10', memo: 'Venta CUP',
      lines: [
        { accountId: ids['101.0001']!, currency: 'CUP', amount: '40000' },
        { accountId: ids['900.0001']!, currency: 'CUP', amount: '-40000' },
      ],
    });
    expect(entry.number).toBe('GR-2026-000001');
    const lines = await prisma.journalLine.findMany({ where: { entryId: entry.id }, orderBy: { lineNo: 'asc' } });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.rateType).toBe('IC'); // tomado de reval_rate_type de la cuenta
    expect(lines[0]!.rate.toString()).toBe(rate.rate.toString());
    expect(lines[0]!.amountUsd.toFixed(4)).toBe(rate.rate.toDecimalPlaces(10).pow(-1).times(40000).toDecimalPlaces(4).toFixed(4));
    expect(lines[0]!.companyId).toBe(ids.GR); // desnormalizado por trigger
    const bal = await prisma.ledgerBalance.findMany({ where: { companyId: ids.GR, accountId: ids['101.0001'] } });
    expect(bal[0]!.debitUsd.toFixed(4)).toBe(lines[0]!.amountUsd.toFixed(4));
    expect(bal[0]!.amountOrig.toFixed(4)).toBe('40000.0000');
  });

  it('usa la tasa indicada en la línea y compensa el redondeo dentro de la tolerancia', async () => {
    const entry = await post({
      companyId: ids.GR!, entryDate: '2026-06-11', memo: 'Cambio con redondeo',
      lines: [
        { accountId: ids['101.0001']!, currency: 'CUP', amount: '100', rate: '3' },
        { accountId: ids['101.0002']!, currency: 'USD', amount: '-33.33' },
      ],
    });
    const lines = await prisma.journalLine.findMany({ where: { entryId: entry.id }, orderBy: { lineNo: 'asc' } });
    expect(lines).toHaveLength(3);
    expect(lines[2]!.accountId).toBe(ids['699.9999']);
    expect(lines[2]!.amountUsd.toFixed(4)).toBe('-0.0033');
  });

  it('rechaza un asiento descuadrado', async () => {
    await expectLedgerError(
      post({
        companyId: ids.GR!, entryDate: '2026-06-12', memo: 'Descuadre',
        lines: [
          { accountId: ids['101.0002']!, currency: 'USD', amount: '100' },
          { accountId: ids['900.0001']!, currency: 'USD', amount: '-99' },
        ],
      }),
      'UNBALANCED',
      /diferencia de 1\.0000 USD/,
    );
  });

  it('la base de datos rechaza un descuadre aunque se salte la API', async () => {
    const err = await withTx(prisma, {}, async (tx) => {
      const period = await tx.fiscalPeriod.findFirstOrThrow({ where: { companyId: ids.GR, year: 2026, month: 6 } });
      const e = await tx.journalEntry.create({
        data: { companyId: ids.GR!, periodId: period.id, number: 'X-1', entryDate: new Date('2026-06-12'), kind: 'MANUAL', memo: 'x' },
      });
      await tx.journalLine.createMany({
        data: [
          { entryId: e.id, lineNo: 1, companyId: ids.GR!, entryDate: new Date('2026-06-12'), accountId: ids['101.0002']!, currency: 'USD', amount: '10', rate: '1', amountUsd: '10' },
          { entryId: e.id, lineNo: 2, companyId: ids.GR!, entryDate: new Date('2026-06-12'), accountId: ids['900.0001']!, currency: 'USD', amount: '-9', rate: '1', amountUsd: '-9' },
        ],
      });
    }).then(() => null, (e) => translateDbError(e));
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe('UNBALANCED');
    expect(await prisma.journalEntry.count({ where: { number: 'X-1' } })).toBe(0);
  });

  it('exige tasa y rechaza tasas demasiado antiguas', async () => {
    await expectLedgerError(
      post({
        companyId: ids.GR!, entryDate: '2026-11-20', memo: 'Sin tasa',
        lines: [
          { accountId: ids['101.0001']!, currency: 'CUP', amount: '100' },
          { accountId: ids['900.0001']!, currency: 'CUP', amount: '-100' },
        ],
      }),
      'MISSING_RATE',
      /Falta la tasa CUP\/USD \(IC\) para el 20\/11\/2026 \(la última es de hace 20 días\)/,
    );
  });

  it('no admite cuentas de grupo ni monedas distintas a la de la cuenta', async () => {
    await expectLedgerError(
      post({
        companyId: ids.GR!, entryDate: '2026-06-13', memo: 'Cuenta de grupo',
        lines: [
          { accountId: ids['101']!, currency: 'USD', amount: '1' },
          { accountId: ids['900.0001']!, currency: 'USD', amount: '-1' },
        ],
      }),
      'INVALID_ACCOUNT',
      /no admite movimientos/,
    );
    await expectLedgerError(
      post({
        companyId: ids.GR!, entryDate: '2026-06-13', memo: 'Moneda',
        lines: [
          { accountId: ids['101.0002']!, currency: 'EUR', amount: '1', rate: '0.9' },
          { accountId: ids['900.0001']!, currency: 'EUR', amount: '-1', rate: '0.9' },
        ],
      }),
      'INVALID_ACCOUNT',
      /solo admite moneda USD/,
    );
  });

  it('los asientos contabilizados son inmutables', async () => {
    const entry = await post({
      companyId: ids.GR!, entryDate: '2026-06-14', memo: 'Inmutable',
      lines: [
        { accountId: ids['101.0002']!, currency: 'USD', amount: '5' },
        { accountId: ids['900.0001']!, currency: 'USD', amount: '-5' },
      ],
    });
    const updLine = prisma.journalLine.updateMany({ where: { entryId: entry.id }, data: { memo: 'cambio' } }).catch(translateDbError);
    expect(((await updLine) as LedgerError).code).toBe('IMMUTABLE');
    const del = prisma.journalEntry.delete({ where: { id: entry.id } }).catch(translateDbError);
    expect(((await del) as LedgerError).code).toBe('IMMUTABLE');
    const memo = prisma.journalEntry.update({ where: { id: entry.id }, data: { memo: 'otro' } }).catch(translateDbError);
    expect(((await memo) as LedgerError).code).toBe('IMMUTABLE');
  });

  it('respeta el estado del periodo', async () => {
    await prisma.fiscalPeriod.update({ where: { companyId_year_month: { companyId: ids.KTR!, year: 2026, month: 3 } }, data: { status: 'LOCKED' } });
    await prisma.fiscalPeriod.update({ where: { companyId_year_month: { companyId: ids.KTR!, year: 2026, month: 4 } }, data: { status: 'SOFT_CLOSED' } });
    const lines = [
      { accountId: ids['101.0002']!, currency: 'USD', amount: '1' },
      { accountId: ids['900.0002']!, currency: 'USD', amount: '-1' },
    ];
    await expectLedgerError(post({ companyId: ids.KTR!, entryDate: '2026-03-10', memo: 'x', lines }), 'PERIOD_CLOSED', /bloqueado/);
    await expectLedgerError(post({ companyId: ids.KTR!, entryDate: '2026-04-10', memo: 'x', lines }), 'PERIOD_CLOSED', /revisión de cierre/);
    const ok = await post({ companyId: ids.KTR!, entryDate: '2026-04-10', memo: 'Contador en revisión', lines }, { allowSoftClosed: true });
    expect(ok.number).toMatch(/^KTR-2026-/);
  });

  it('anula con contra-asiento y lo lleva al primer periodo abierto si el original está bloqueado', async () => {
    const entry = await post({
      companyId: ids.KTR!, entryDate: '2026-05-10', memo: 'A anular',
      lines: [
        { accountId: ids['101.0003']!, currency: 'EUR', amount: '90', rate: '0.9' },
        { accountId: ids['900.0002']!, currency: 'EUR', amount: '-90', rate: '0.9' },
      ],
    });
    await prisma.fiscalPeriod.update({ where: { companyId_year_month: { companyId: ids.KTR!, year: 2026, month: 5 } }, data: { status: 'LOCKED' } });
    const rev = await withTx(prisma, { userId }, (tx) => reverseEntry(tx, entry.id, {}));
    expect(rev.entryDate.toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(rev.reversesId).toBe(entry.id);
    const revLines = await prisma.journalLine.findMany({ where: { entryId: rev.id }, orderBy: { lineNo: 'asc' } });
    expect(revLines.map((l) => l.amountUsd.toFixed(4))).toEqual(['-100.0000', '100.0000']);
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('REVERSED');
    const again = withTx(prisma, { userId }, (tx) => reverseEntry(tx, entry.id, {}));
    await expectLedgerError(again, 'ALREADY_REVERSED');
  });

  it('registra el usuario en la auditoría', async () => {
    const entry = await post({
      companyId: ids.GR!, entryDate: '2026-06-15', memo: 'Auditado',
      lines: [
        { accountId: ids['101.0002']!, currency: 'USD', amount: '7' },
        { accountId: ids['900.0001']!, currency: 'USD', amount: '-7' },
      ],
    });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { tableName: 'journal_entry', recordId: entry.id } });
    expect(log.userId).toBe(userId);
    expect(log.action).toBe('INSERT');
    const userLog = await prisma.auditLog.findFirst({ where: { tableName: 'app_user' } });
    expect(JSON.stringify(userLog?.after)).not.toContain('password_hash');
  });

  it('propiedad: cualquier asiento multimoneda generado cuadra en USD', async () => {
    const currencies = [
      { acc: '101.0001', cur: 'CUP' },
      { acc: '101.0003', cur: 'EUR' },
      { acc: '101.0002', cur: 'USD' },
      { acc: '109.9002', cur: 'DOP' },
    ];
    let day = 1;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ i: fc.integer({ min: 0, max: 3 }), cents: fc.integer({ min: 1, max: 1_000_000_000 }), sign: fc.boolean() }),
          { minLength: 1, maxLength: 6 },
        ),
        async (raw) => {
          const date = `2026-07-${String((day++ % 28) + 1).padStart(2, '0')}`;
          const lines = raw.map((r) => ({
            accountId: ids[currencies[r.i]!.acc]!,
            currency: currencies[r.i]!.cur,
            amount: ((r.sign ? 1 : -1) * r.cents / 100).toFixed(2),
          }));
          // Contrapartida en USD por el total convertido (con un error de redondeo posible).
          const tmp = await prisma.$transaction(async (tx) => {
            let total = 0n;
            for (const l of lines) {
              const rate = l.currency === 'USD' ? null : await tx.exchangeRate.findFirst({
                where: { currency: l.currency, rateType: l.currency === 'DOP' ? 'ORD' : 'IC', rateDate: { lte: new Date(`${date}T00:00:00Z`) } },
                orderBy: { rateDate: 'desc' },
              });
              const usd = rate ? Number(l.amount) / Number(rate.rate) : Number(l.amount);
              total += BigInt(Math.round(usd * 10000));
            }
            return total;
          });
          const counter = (-Number(tmp) / 10000).toFixed(4);
          if (Number(counter) === 0) return;
          const entry = await post({
            companyId: ids.KEI!, entryDate: date, memo: 'propiedad',
            lines: [...lines, { accountId: ids['900.0002']!, currency: 'USD', amount: counter }],
          });
          const s = await prisma.journalLine.aggregate({ where: { entryId: entry.id }, _sum: { amountUsd: true } });
          expect(s._sum.amountUsd?.isZero()).toBe(true);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('reportes', () => {
  it('balance de comprobación: saldos, movimiento del mes, consolidación y control A = P + PN + R', async () => {
    const kgt = ids.KGT!;
    await post({
      companyId: kgt, entryDate: '2026-08-01', memo: 'Capital',
      lines: [
        { accountId: ids['110.9003']!, currency: 'EUR', amount: '900', rate: '0.9' },
        { accountId: ids['600.0001']!, currency: 'USD', amount: '-1000' },
      ],
    });
    await post({
      companyId: kgt, entryDate: '2026-09-03', memo: 'Venta',
      lines: [
        { accountId: ids['110.9003']!, currency: 'EUR', amount: '450', rate: '0.9' },
        { accountId: ids['900.0002']!, currency: 'EUR', amount: '-450', rate: '0.9' },
      ],
    });
    await post({
      companyId: kgt, entryDate: '2026-09-04', memo: 'Alquiler',
      lines: [
        { accountId: ids['837.0001']!, currency: 'USD', amount: '200' },
        { accountId: ids['110.9003']!, currency: 'EUR', amount: '-180', rate: '0.9' },
      ],
    });

    const tb = await trialBalance(prisma, { companyIds: [kgt], year: 2026, month: 9, books: ['BASE', 'REAL'] });
    const row = (code: string) => tb.rows.find((r) => r.displayCode === code)!;
    expect(row('110.9003').opening).toBe('1000.0000');
    expect(row('110.9003').debit).toBe('500.0000');
    expect(row('110.9003').credit).toBe('200.0000');
    expect(row('110.9003').closing).toBe('1300.0000');
    expect(row('110.9003').byCurrency).toEqual([{ currency: 'EUR', closingOrig: '1170.0000', closingUsd: '1300.0000' }]);
    expect(row('110').closing).toBe('1300.0000'); // cuenta padre acumula
    expect(row('900.0002').bcValue).toBe('-500.0000'); // nominal: movimiento del mes
    expect(row('600.0001').bcValue).toBe('-1000.0000'); // balance: saldo
    expect(tb.summary).toMatchObject({ assets: '1300.0000', equity: '1000.0000', income: '500.0000', expenses: '200.0000', balanced: true });
    expect(tb.totals.debit).toBe(tb.totals.credit);

    const consolidated = await trialBalance(prisma, {
      companyIds: (await prisma.company.findMany()).map((c) => c.id), year: 2026, month: 9, books: ['BASE', 'REAL'],
    });
    expect(consolidated.summary.balanced).toBe(true);
    expect(Number(consolidated.rows.find((r) => r.displayCode === '110.9003')!.closing)).toBe(1300);
  });

  it('mayor con saldo acumulado paginado', async () => {
    const gl = await generalLedger(prisma, {
      companyIds: [ids.KGT!], accountId: ids['110']!, from: new Date('2026-09-01'), to: new Date('2026-09-30'),
      books: ['BASE', 'REAL'], page: 2, pageSize: 1,
    });
    expect(gl.opening).toBe('1000.0000');
    expect(gl.total).toBe(2);
    expect(gl.lines[0]!.balance).toBe('1300.0000');
  });
});
