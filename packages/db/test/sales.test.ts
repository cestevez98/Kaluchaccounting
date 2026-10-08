import { money } from '@kaluch/shared';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeExportInvoice, commissionsBySeller, containerUtility, issueExportInvoice, partyBalances, postContainerCost, postSalesInvoice,
  productKardex, receiveContainer, seedDemo, withTx,
} from '../src';

const prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
const acc: Record<string, string> = {};
const pa: Record<string, string> = {};
let gr = '';
let kei = '';
let oil = '';
let rice = '';
const run = <T>(fn: Parameters<typeof withTx<T>>[2]) => withTx(prisma, {}, fn);

async function entryLines(entryId: string) {
  const lines = await prisma.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: { lineNo: 'asc' } });
  return lines.map((l) => [l.account.fullCode, l.amountUsd.toFixed(2)]);
}

async function balance(fullCode: string, where: Record<string, unknown> = {}) {
  const s = await prisma.journalLine.aggregate({ where: { accountId: acc[fullCode], ...where }, _sum: { amountUsd: true } });
  return s._sum.amountUsd?.toFixed(2) ?? '0.00';
}

beforeAll(async () => {
  await seedDemo(prisma, { entries: false });
  for (const a of await prisma.account.findMany()) acc[a.fullCode] = a.id;
  for (const p of await prisma.partyAccount.findMany({ include: { party: true, account: true } })) pa[`${p.party.code}:${p.account.fullCode}`] = p.id;
  gr = (await prisma.company.findUniqueOrThrow({ where: { code: 'GR' } })).id;
  kei = (await prisma.company.findUniqueOrThrow({ where: { code: 'KEI' } })).id;
  oil = (await prisma.product.findUniqueOrThrow({ where: { code: 'ACEITE_1L' } })).id;
  rice = (await prisma.product.findUniqueOrThrow({ where: { code: 'ARROZ_25KG' } })).id;
});

afterAll(() => prisma.$disconnect());

describe('facturas de exportación', () => {
  it('al emitirla queda pendiente (2900/2814–2815) con partida abierta; al cerrarla pasa a ventas, costos y comisión', async () => {
    const number = `KAL-T-${Date.now()}`;
    const r = await run((tx) => issueExportInvoice(tx, {
      partyAccountId: pa['CLIENTE_EXPORTACION_DEMO:136']!, number, invoiceDate: '2026-07-01', service: 'GOODS', description: 'Contenedor de prueba',
      amountUsd: '10000', factoryUsd: '6000', logisticsUsd: '1500', estimatedUsd: '200', commissionUsd: '300', sellerPartyAccountId: pa['VENDEDOR_DEMO:410.8880']!,
    }));
    expect(r.document.number).toMatch(/^KEI-FEX-2026-\d{6}$/);
    expect(await entryLines(r.entry.id)).toEqual([
      ['136', '10000.00'], ['2900', '-10000.00'], ['2814', '6000.00'], ['180.8880', '-6000.00'], ['2815', '1500.00'], ['180.8881', '-1500.00'],
    ]);
    expect(r.openItem).toMatchObject({ side: 'RECEIVABLE', reference: number });
    await expect(run((tx) => issueExportInvoice(tx, {
      partyAccountId: pa['CLIENTE_EXPORTACION_DEMO:136']!, number, invoiceDate: '2026-07-01', service: 'GOODS', description: 'x', amountUsd: '1',
    }))).rejects.toThrow(/Ya existe/);

    await expect(run((tx) => closeExportInvoice(tx, { id: r.invoice.id, closeDate: '2026-06-30' }))).rejects.toThrow(/anterior/);
    const c = await run((tx) => closeExportInvoice(tx, { id: r.invoice.id, closeDate: '2026-07-31' }));
    expect(c.invoice.status).toBe('CLOSED');
    expect(await entryLines(c.entry.id)).toEqual([
      ['2900', '10000.00'], ['900.8880', '-10000.00'], ['814.8880', '6000.00'], ['2814', '-6000.00'], ['815.8880', '1500.00'], ['2815', '-1500.00'],
      ['817.8880', '200.00'], ['180.8883', '-200.00'], ['824.8880', '300.00'], ['410.8880', '-300.00'],
    ]);
    await expect(run((tx) => closeExportInvoice(tx, { id: r.invoice.id, closeDate: '2026-07-31' }))).rejects.toThrow(/no está pendiente/);
    // La comisión queda por pagar al vendedor con su partida abierta.
    const sellerItems = await prisma.openItem.findMany({ where: { partyAccountId: pa['VENDEDOR_DEMO:410.8880'], reference: `COM-${number}` } });
    expect(sellerItems.map((i) => [i.side, i.amount.toFixed(2)])).toEqual([['PAYABLE', '300.00']]);
  });

  it('un cliente interno cierra contra ventas internas (1900) y costos 18xx', async () => {
    const r = await run((tx) => issueExportInvoice(tx, {
      partyAccountId: pa['CLIENTE_EXPORTACION_DEMO:136']!, number: `KAL-I-${Date.now()}`, invoiceDate: '2026-08-01', service: 'GOODS', internal: true,
      description: 'Venta a empresa del grupo', amountUsd: '5000', factoryUsd: '4000',
    }));
    const c = await run((tx) => closeExportInvoice(tx, { id: r.invoice.id, closeDate: '2026-08-15' }));
    expect(await entryLines(c.entry.id)).toEqual([['2900', '5000.00'], ['1900', '-5000.00'], ['1814.8880', '4000.00'], ['2814', '-4000.00']]);
  });

  it('valida comisión sin vendedor e importes', async () => {
    await expect(run((tx) => issueExportInvoice(tx, {
      partyAccountId: pa['CLIENTE_EXPORTACION_DEMO:136']!, number: 'X-1', invoiceDate: '2026-08-01', service: 'GOODS', description: 'x', amountUsd: '100', commissionUsd: '5',
    }))).rejects.toThrow(/vendedor/);
    await expect(run((tx) => issueExportInvoice(tx, {
      partyAccountId: pa['CLIENTE_EXPORTACION_DEMO:136']!, number: 'X-2', invoiceDate: '2026-08-01', service: 'GOODS', description: 'x', amountUsd: '0',
    }))).rejects.toThrow(/positivo/);
  });
});

describe('distribución: contenedor, inventario y venta', () => {
  let container = '';

  it('los costos van a mercancías en tránsito y la recepción los reparte por producto en almacén', async () => {
    container = (await prisma.container.create({ data: { companyId: gr, code: `CONT-T-${Date.now()}` } })).id;
    await prisma.containerInvestor.create({ data: { containerId: container, partyAccountId: pa['INVERSIONISTA_DEMO:412']!, investedUsd: '5000', profitPct: '25' } });
    const cost = await run((tx) => postContainerCost(tx, {
      containerId: container, date: '2026-07-01', amountUsd: '8000', description: 'Mercancía', partyAccountId: pa['PROVEEDOR_DISTRIBUCION_DEMO:406']!,
    }));
    expect(await entryLines(cost.entry.id)).toEqual([['181.9991', '8000.00'], ['406', '-8000.00']]);
    await run((tx) => postContainerCost(tx, { containerId: container, date: '2026-07-05', amountUsd: '2000', description: 'Flete', counterAccountId: acc['699.9995']! }));
    await expect(run((tx) => receiveContainer(tx, {
      containerId: container, date: '2026-07-10', lines: [{ productId: oil, quantity: '100', amountUsd: '7000' }],
    }))).rejects.toThrow(/no coincide/);
    const rec = await run((tx) => receiveContainer(tx, {
      containerId: container, date: '2026-07-10',
      lines: [{ productId: oil, quantity: '100', amountUsd: '7000' }, { productId: rice, quantity: '30', amountUsd: '3000' }],
    }));
    expect(rec.container.status).toBe('WAREHOUSE');
    expect(await entryLines(rec.entry!.id)).toEqual([['181.9990', '10000.00'], ['181.9991', '-10000.00']]);
    expect(await balance('181.9991', { containerId: container })).toBe('0.00');
    // Ya en almacén, un costo adicional se carga a un producto.
    await expect(run((tx) => postContainerCost(tx, { containerId: container, date: '2026-07-11', amountUsd: '30', description: 'Estiba', counterAccountId: acc['699.9995']! })))
      .rejects.toThrow(/producto/);
    await run((tx) => postContainerCost(tx, { containerId: container, date: '2026-07-11', amountUsd: '300', description: 'Estiba', productId: rice, counterAccountId: acc['699.9995']! }));
  });

  it('la venta registra ingreso, costo medio del lote, comisión por unidad y ONAT, y descuenta existencias', async () => {
    const seller = pa['VENDEDOR_DEMO:410.9990']!;
    const r = await run((tx) => postSalesInvoice(tx, {
      companyId: gr, date: '2026-07-15', description: 'Venta mayorista', partyAccountId: pa['CLIENTE_DISTRIBUCION_DEMO:137']!,
      lines: [
        { productId: oil, containerId: container, quantity: '40', unitPriceUsd: '100', commissionPerUnitUsd: '2.5', sellerPartyAccountId: seller },
        { productId: rice, containerId: container, quantity: '30', unitPriceUsd: '150' },
      ],
    }));
    expect(r.document.number).toMatch(/^GR-FAC-2026-\d{6}$/);
    // Aceite: 7000/100 × 40 = 2800. Arroz: todo el lote (3000 + 300 de estiba). ONAT 11 % de cada venta.
    expect(await entryLines(r.entry.id)).toEqual([
      ['137', '8500.00'],
      ['900.9990', '-4000.00'], ['814.9990', '2800.00'], ['181.9990', '-2800.00'], ['824.9990', '100.00'], ['410.9990', '-100.00'], ['830.9990', '440.00'], ['480.9990', '-440.00'],
      ['900.9990', '-4500.00'], ['814.9990', '3300.00'], ['181.9990', '-3300.00'], ['830.9990', '495.00'], ['480.9990', '-495.00'],
    ]);
    expect(r.invoice.costUsd.toFixed(2)).toBe('6100.00');
    expect(r.openItem).toMatchObject({ side: 'RECEIVABLE' });
    await expect(run((tx) => postSalesInvoice(tx, {
      companyId: gr, date: '2026-07-16', description: 'Sin existencias', counterAccountId: acc['699.9995']!,
      lines: [{ productId: rice, containerId: container, quantity: '1', unitPriceUsd: '150' }],
    }))).rejects.toThrow(/existencias/);

    const kardex = await productKardex(prisma, { productId: oil, containerId: container });
    expect(kardex.map((k) => [k.kind, k.quantity, k.balanceQuantity, k.balanceUsd])).toEqual([
      ['RECEIPT', '100.0000', '100.0000', '7000.0000'], ['SALE', '-40.0000', '60.0000', '4200.0000'],
    ]);
    const [u] = await containerUtility(prisma, { containerId: container });
    expect(u).toMatchObject({
      totalCostUsd: '10300.0000', revenueUsd: '8500.0000', costOfSalesUsd: '6100.0000', commissionUsd: '100.0000', onatUsd: '935.0000',
      utilityUsd: '1365.0000', stockQuantity: '60.0000', stockUsd: '4200.0000',
    });
    expect(u!.investors[0]).toMatchObject({ profitPct: '25.0000', shareUsd: '341.2500' });
    const com = await commissionsBySeller(prisma, { from: '2026-07-01', to: '2026-07-31', companyId: gr });
    expect(com.find((c) => c.sellerPartyAccountId === seller)).toMatchObject({ week: '2026-07-13', units: '40.0000', commissionUsd: '100.0000' });
    // El cliente aparece en cuentas por cobrar con el total de la factura.
    const bal = await partyBalances(prisma, { companyIds: [gr], asOf: '2026-07-31' });
    expect(bal.find((b) => b.partyAccountId === pa['CLIENTE_DISTRIBUCION_DEMO:137'])).toMatchObject({ balance: '8500.0000', openItems: 1 });
  });
});

describe('fase 4 con la empresa de exportación', () => {
  it('el saldo pendiente 2900 de KEI es el de las facturas sin cerrar', async () => {
    const pending = await prisma.exportInvoice.aggregate({ where: { companyId: kei, status: 'PENDING' }, _sum: { amountUsd: true } });
    const ledger = await balance('2900', { companyId: kei });
    expect(money(ledger).neg().toFixed(2)).toBe(money(pending._sum.amountUsd ?? 0).toFixed(2));
  });
});
