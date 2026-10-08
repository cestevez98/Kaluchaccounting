import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEMO_PASSWORD, PrismaClient, seedDemo } from '@kaluch/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/setup';

let app: INestApplication;
let prisma: PrismaClient;
let cookie = '';
const pa: Record<string, string> = {};
let gr = '';

async function login(email: string) {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: DEMO_PASSWORD });
  return ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]?.split(';')[0] ?? '';
}
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.JWT_SECRET = 'test-secret';
  prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
  await seedDemo(prisma, { entries: false });
  for (const p of await prisma.partyAccount.findMany({ include: { party: true, account: true } })) pa[`${p.party.code}:${p.account.fullCode}`] = p.id;
  gr = (await prisma.company.findUniqueOrThrow({ where: { code: 'GR' } })).id;
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApp(mod.createNestApplication());
  await app.init();
  cookie = await login('admin@kaluch.local');
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

describe('ventas e inventario (API)', () => {
  it('factura de exportación: emisión, listado de pendientes y cierre', async () => {
    const number = `API-${Date.now()}`;
    const r = await http().post('/api/v1/sales/export-invoices').set('Cookie', cookie).send({
      partyAccountId: pa['CLIENTE_EXPORTACION_DEMO:136'], number, invoiceDate: '2026-08-01', service: 'GOODS', description: 'Contenedor API',
      amountUsd: '7000', factoryUsd: '5000', logisticsUsd: '800',
    });
    expect(r.status).toBe(201);
    const list = await http().get('/api/v1/sales/export-invoices?status=PENDING').set('Cookie', cookie);
    expect(list.body.items.find((i: { number: string }) => i.number === number)).toMatchObject({ marginUsd: '1200.0000', status: 'PENDING' });
    const c = await http().post(`/api/v1/sales/export-invoices/${r.body.id}/close`).set('Cookie', cookie).send({ closeDate: '2026-08-31' });
    expect(c.status).toBe(201);
    const det = await http().get(`/api/v1/sales/export-invoices/${r.body.id}`).set('Cookie', cookie);
    expect(det.body.status).toBe('CLOSED');
    expect(det.body.lines.map((l: { account: string }) => l.account)).toContain('900.8880');
  });

  it('contenedor: alta, costo, recepción, inversionista, venta y utilidad', async () => {
    const code = `API-C-${Date.now()}`;
    const c = await http().post('/api/v1/sales/containers').set('Cookie', cookie).send({ companyId: gr, code, description: 'API' });
    expect(c.status).toBe(201);
    const product = await http().post('/api/v1/sales/products').set('Cookie', cookie).send({ code: `p-${Date.now()}`, name: 'Producto API', unit: 'caja' });
    expect(product.body.code).toMatch(/^P-/);
    expect((await http().post(`/api/v1/sales/containers/${c.body.id}/costs`).set('Cookie', cookie).send({
      date: '2026-08-01', amountUsd: '1000', description: 'Mercancía', partyAccountId: pa['PROVEEDOR_DISTRIBUCION_DEMO:406'],
    })).status).toBe(201);
    const rec = await http().post(`/api/v1/sales/containers/${c.body.id}/receipt`).set('Cookie', cookie).send({
      date: '2026-08-05', lines: [{ productId: product.body.id, quantity: '10', amountUsd: '1000' }],
    });
    expect(rec.body.status).toBe('WAREHOUSE');
    const inv = await http().post(`/api/v1/sales/containers/${c.body.id}/investors`).set('Cookie', cookie).send({ partyAccountId: pa['INVERSIONISTA_DEMO:412'], investedUsd: '500', profitPct: '50' });
    expect(inv.status).toBe(201);
    const stock = await http().get(`/api/v1/sales/stock?companyId=${gr}`).set('Cookie', cookie);
    expect(stock.body.find((s: { containerCode: string }) => s.containerCode === code)).toMatchObject({ quantity: '10.0000', unitCostUsd: '100.0000' });
    const sale = await http().post('/api/v1/sales/invoices').set('Cookie', cookie).send({
      companyId: gr, date: '2026-08-10', description: 'Venta API', partyAccountId: pa['CLIENTE_DISTRIBUCION_DEMO:137'], fiscal: false,
      lines: [{ productId: product.body.id, containerId: c.body.id, quantity: '4', unitPriceUsd: '150', commissionPerUnitUsd: '5', sellerPartyAccountId: pa['VENDEDOR_DEMO:410.9990'] }],
    });
    expect(sale.status).toBe(201);
    const det = await http().get(`/api/v1/sales/containers/${c.body.id}`).set('Cookie', cookie);
    expect(det.body).toMatchObject({ revenueUsd: '600.0000', costOfSalesUsd: '400.0000', commissionUsd: '20.0000', utilityUsd: '180.0000', stockQuantity: '6.0000' });
    expect(det.body.investors[0]).toMatchObject({ shareUsd: '90.0000' });
    const com = await http().get('/api/v1/sales/commissions?from=2026-08-01&to=2026-08-31').set('Cookie', cookie);
    expect(com.body.some((r: { commissionUsd: string }) => r.commissionUsd === '20.0000')).toBe(true);
    const kardex = await http().get(`/api/v1/sales/products/${product.body.id}/kardex`).set('Cookie', cookie);
    expect(kardex.body.rows.map((r: { balanceQuantity: string }) => r.balanceQuantity)).toEqual(['10.0000', '6.0000']);
  });

  it('el usuario de solo lectura (KEI) no ve los contenedores de GR ni puede facturar', async () => {
    const ro = await login('lectura@kaluch.local');
    const list = await http().get('/api/v1/sales/containers').set('Cookie', ro);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    const post = await http().post('/api/v1/sales/invoices').set('Cookie', ro).send({
      companyId: gr, date: '2026-08-10', description: 'x', counterAccountId: pa['VENDEDOR_DEMO:410.9990'], lines: [],
    });
    expect(post.status).toBe(403);
  });
});
