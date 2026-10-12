import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeStatement, dashboardData, ensureDefaultStatements, postEntry, postTreasuryMovement, seedDemo, seedPeriods, statementAlerts, withTx,
} from '../src';

/** Año reservado a estos tests: ningún otro test contabiliza en 2024. */
const Y = 2024;
const prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
const acc: Record<string, string> = {};
let kei = '';
let bank = '';
const run = <T>(fn: Parameters<typeof withTx<T>>[2]) => withTx(prisma, {}, fn);
const value = (r: Awaited<ReturnType<typeof computeStatement>>, key: string, col = -1) => {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`No existe la línea ${key}`);
  return Number(l.values.at(col));
};

beforeAll(async () => {
  await seedDemo(prisma, { entries: false });
  await seedPeriods(prisma, Y);
  await ensureDefaultStatements(prisma);
  for (const a of await prisma.account.findMany()) acc[a.fullCode] = a.id;
  kei = (await prisma.company.findUniqueOrThrow({ where: { code: 'KEI' } })).id;
  bank = (await prisma.treasuryAccount.findFirstOrThrow({ where: { glAccount: { fullCode: '109.9001' } } })).id;
  if (await prisma.journalEntry.findFirst({ where: { companyId: kei, memo: 'Estados: venta interna (test)' } })) return;
  const sale = await prisma.cashCategory.findUniqueOrThrow({ where: { code: 'VENTA_MINORISTA' } });
  const rent = await prisma.cashCategory.findUniqueOrThrow({ where: { code: 'ALQUILER' } });
  const capital = await prisma.cashCategory.upsert({
    where: { code: 'APORTE_TEST' }, update: {},
    create: { code: 'APORTE_TEST', name: 'Aporte del socio (test)', kind: 'OTHER', accountId: acc['600.0001']!, cashFlowCategory: 'FIN', aliases: ['Aporte del socio'] },
  });
  await run(async (tx) => {
    await postTreasuryMovement(tx, { companyId: kei, date: `${Y}-01-10`, kind: 'MOVEMENT', description: 'Venta', categoryId: sale.id, legs: [{ treasuryAccountId: bank, amount: '1000' }] });
    await postTreasuryMovement(tx, { companyId: kei, date: `${Y}-02-05`, kind: 'MOVEMENT', description: 'Alquiler', categoryId: rent.id, legs: [{ treasuryAccountId: bank, amount: '-300' }] });
    await postTreasuryMovement(tx, { companyId: kei, date: `${Y}-02-20`, kind: 'MOVEMENT', description: 'Aporte', categoryId: capital.id, legs: [{ treasuryAccountId: bank, amount: '5000' }] });
    // Venta a otra empresa del grupo: se elimina del resultado consolidado.
    await postEntry(tx, {
      companyId: kei, entryDate: `${Y}-03-15`, kind: 'MANUAL', memo: 'Estados: venta interna (test)',
      lines: [{ accountId: acc['135.0001']!, currency: 'USD', amount: '1000' }, { accountId: acc['1900']!, currency: 'USD', amount: '-1000' }],
    });
    // Partida en el puente sin asignar desde enero.
    await postEntry(tx, {
      companyId: kei, entryDate: `${Y}-01-31`, kind: 'MANUAL', memo: 'Estados: puente (test)',
      lines: [{ accountId: acc['135.0001']!, currency: 'USD', amount: '50' }, { accountId: acc['699.9998']!, currency: 'USD', amount: '-50' }],
    });
  });
});

afterAll(() => prisma.$disconnect());

describe('estados financieros', () => {
  it('estado de situación: cuadra todos los meses y presenta el resultado del ejercicio', async () => {
    const es = await computeStatement(prisma, { templateCode: 'ES', companyIds: [kei], year: Y, fromMonth: 1, toMonth: 3 });
    expect(es.columns.map((c) => c.label)).toEqual(['Ene 2024', 'Feb 2024', 'Mar 2024', 'Saldo a Mar']);
    for (let c = 0; c < es.columns.length; c++) expect(value(es, 'CONTROL', c)).toBe(0);
    // Banco 5.700 + CxC 1.050 = 6.750; capital 5.000; resultado 1.000 − 300 + 1.000 (venta interna) = 1.700; puente 50.
    expect(value(es, 'ACTIVOS')).toBe(6750);
    expect(value(es, 'PN_RESULTADO')).toBe(1700);
    expect(value(es, 'PN_RESULTADO', 0)).toBe(1000);
    const capital = es.lines.find((l) => l.key === 'C600')!;
    expect(Number(capital.values.at(-1))).toBe(5000);
    expect(capital.accounts.map((a) => a.code)).toEqual(['600.0001']);
    expect(es.warnings).toEqual([]);
  });

  it('estado de resultados: movimiento del mes, total del periodo y eliminación intercompañía en el consolidado', async () => {
    const er = await computeStatement(prisma, { templateCode: 'ER', companyIds: [kei], year: Y, fromMonth: 1, toMonth: 3 });
    expect([0, 1, 2, 3].map((c) => value(er, 'RESULTADO', c))).toEqual([1000, -300, 1000, 1700]);
    const all = (await prisma.company.findMany({ where: { consolidates: true } })).map((c) => c.id);
    const consolidated = await computeStatement(prisma, { templateCode: 'ER', companyIds: all, year: Y, fromMonth: 1, toMonth: 3 });
    expect(value(consolidated, 'RESULTADO')).toBe(700);
    expect(consolidated.eliminated).toEqual([{ code: '1900', name: 'Ventas de Bienes Internas', value: '1000.00' }]);
    const without = await computeStatement(prisma, { templateCode: 'ER', companyIds: all, year: Y, fromMonth: 1, toMonth: 3, eliminate: false });
    expect(value(without, 'RESULTADO')).toBe(1700);
  });

  it('flujo de efectivo directo: por actividad y categoría, y concilia con el saldo de caja y bancos', async () => {
    const efe = await computeStatement(prisma, { templateCode: 'EFE', companyIds: [kei], year: Y, fromMonth: 1, toMonth: 3 });
    expect(value(efe, 'SALDO_INICIAL', 0)).toBe(0);
    expect(value(efe, 'OPER')).toBe(700);
    expect(value(efe, 'FIN')).toBe(5000);
    expect(value(efe, 'SALDO_FINAL')).toBe(5700);
    for (let c = 0; c < efe.columns.length; c++) expect(value(efe, 'CONTROL', c)).toBe(0);
    expect(efe.lines.find((l) => l.key === 'OPER')!.categories.map((c) => c.name).sort()).toEqual(['Alquiler', 'Ventas minoristas']);
    // Febrero empieza con el saldo de enero.
    expect(value(efe, 'SALDO_INICIAL', 1)).toBe(1000);
  });

  it('plantilla propia: grupos de cuentas, códigos sin ceros, fórmulas con MIN y categorías de caja por nombre', async () => {
    await prisma.reportTemplate.deleteMany({ where: { code: 'TEST_F6' } });
    await prisma.reportTemplate.create({
      data: {
        code: 'TEST_F6', name: 'Prueba', kind: 'INCOME', origin: 'SISTEMA',
        lines: {
          create: [
            { sortOrder: 1, key: 'V', label: 'Ventas', source: 'ACCOUNTS', accounts: ['900'] },
            { sortOrder: 2, key: 'A', label: 'Alquiler', source: 'ACCOUNTS', accounts: ['837.0001'] },
            { sortOrder: 3, key: 'UN', label: 'Utilidad', source: 'FORMULA', formula: 'SUM([V]:[A])' },
            { sortOrder: 4, key: 'P', label: 'Participación 5 %', source: 'FORMULA', formula: 'MIN(0, -[UN]*0.05)' },
            { sortOrder: 5, key: 'X', label: 'Cuenta inexistente', source: 'ACCOUNTS', accounts: ['999.1234'] },
          ],
        },
      },
    });
    const r = await computeStatement(prisma, { templateCode: 'TEST_F6', companyIds: [kei], year: Y, fromMonth: 1, toMonth: 2 });
    expect([0, 1].map((c) => value(r, 'UN', c))).toEqual([1000, -300]);
    expect([0, 1].map((c) => value(r, 'P', c))).toEqual([-50, 0]);
    expect(r.warnings.some((w) => w.includes('999.1234'))).toBe(true);
  });

  it('comparación con las cifras del Excel: cuadra, diferencia, importe a mano y totales con líneas que el Excel no tiene', async () => {
    const t = await prisma.reportTemplate.findUniqueOrThrow({ where: { code: 'ER' } });
    const ing = (await prisma.reportLine.findMany({ where: { templateId: t.id, source: 'ACCOUNTS' } })).find((l) => l.accounts.includes('900'))!;
    await prisma.reportReference.deleteMany({ where: { templateId: t.id } });
    await prisma.reportReference.createMany({
      data: [
        { templateId: t.id, lineKey: ing.key, year: Y, month: 1, valueUsd: '1000' },
        { templateId: t.id, lineKey: ing.key, year: Y, month: 2, valueUsd: '12' },
        { templateId: t.id, lineKey: ing.key, year: Y, month: 3, valueUsd: '7', manual: true },
        { templateId: t.id, lineKey: 'INGRESOS', year: Y, month: 1, valueUsd: '1000' },
        { templateId: t.id, lineKey: 'INGRESOS', year: Y, month: 2, valueUsd: null, error: '#REF!' },
      ],
    });
    try {
      const er = await computeStatement(prisma, { templateCode: 'ER', companyIds: [kei], year: Y, fromMonth: 1, toMonth: 3 });
      const line = er.lines.find((l) => l.key === ing.key)!;
      expect(line.status!.slice(0, 3)).toEqual(['OK', 'DIFF', 'EXPLAINED']);
      expect(line.explanations![2]).toMatch(/escrito a mano/);
      const total = er.lines.find((l) => l.key === 'INGRESOS')!;
      expect(total.status!.slice(0, 2)).toEqual(['OK', 'NO_REF']);
      expect(er.comparison).toEqual({ OK: 2, DIFF: 1, EXPLAINED: 1, NO_REF: 1 });
    } finally {
      await prisma.reportReference.deleteMany({ where: { templateId: t.id } });
    }
  });

  it('no calcula meses que aún no han terminado', async () => {
    const r = await computeStatement(prisma, { templateCode: 'ER', companyIds: [kei], year: Y, fromMonth: 1, toMonth: 12, today: `${Y}-03-20` });
    expect(r.columns.at(-2)!.label).toBe('Mar 2024');
    expect(r.warnings[0]).toMatch(/hasta Mar 2024/);
  });
});

describe('alertas y panel de dirección', () => {
  it('avisa del puente con saldo antiguo', async () => {
    const alerts = await statementAlerts(prisma, { companyIds: [kei], year: Y, month: 4 });
    const bridge = alerts.find((a) => a.key.startsWith('bridge-') && a.title.includes('699.9998'));
    expect(bridge?.detail).toMatch(/Saldo -50\.00 USD/);
    expect(alerts.some((a) => a.key.startsWith('balance-'))).toBe(false);
  });

  it('panel: resultado mensual, inventario y antigüedad', async () => {
    const d = await dashboardData(prisma, { companyIds: [kei], year: Y, month: 3 });
    expect(d.monthly.map((m) => m.resultUsd)).toEqual(['1000.00', '-300.00', '1000.00']);
    expect(d.ytd.resultUsd).toBe('1700.00');
    expect(d.aging.receivable.map((b) => b.key)).toEqual(['current', 'd60', 'd90', 'older']);
  });
});
