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
const acc: Record<string, string> = {};
let kei = '';
let dm = '';

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
  for (const a of await prisma.account.findMany()) acc[a.fullCode] = a.id;
  kei = (await prisma.company.findUniqueOrThrow({ where: { code: 'KEI' } })).id;
  dm = (await prisma.company.findUniqueOrThrow({ where: { code: 'DM' } })).id;
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApp(mod.createNestApplication());
  await app.init();
  cookie = await login('admin@kaluch.local');
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

describe('contrapartes (API)', () => {
  let partyId = '';
  let paId = '';

  it('crea una contraparte y le abre una cuenta corriente', async () => {
    const p = await http().post('/api/v1/parties').set('Cookie', cookie).send({ name: 'Naviera API S.L.', kind: 'COMPANY', roles: ['SUPPLIER'], taxId: 'B12345678' });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ code: 'NAVIERA_API_S_L', roles: ['SUPPLIER'] });
    partyId = p.body.id;
    const a = await http().post(`/api/v1/parties/${partyId}/accounts`).set('Cookie', cookie).send({ companyId: kei, currency: 'USD', accountId: acc['406'] });
    expect(a.status).toBe(201);
    paId = a.body.id;
    const dup = await http().post(`/api/v1/parties/${partyId}/accounts`).set('Cookie', cookie).send({ companyId: kei, currency: 'USD', accountId: acc['406'] });
    expect(dup.status).toBe(400);
  });

  it('registra una factura con partida abierta, la liquida y aparece en cuentas por pagar', async () => {
    const f = await http().post('/api/v1/parties/documents').set('Cookie', cookie).send({
      partyAccountId: paId, date: '2026-09-01', kind: 'CREDIT', amount: '1500', counterAccountId: acc['814.0001'],
      description: 'Flete contenedor', reference: 'NAV-77', openItem: true, dueDate: '2026-09-30',
    });
    expect(f.status).toBe(201);
    expect(f.body.openItem).toMatchObject({ side: 'PAYABLE', reference: 'NAV-77' });

    const pay = await http().post('/api/v1/parties/documents').set('Cookie', cookie).send({
      partyAccountId: paId, date: '2026-09-10', kind: 'CHARGE', amount: '1000', counterAccountId: acc['699.9995'], description: 'Pago parcial',
    });
    expect(pay.status).toBe(201);
    const cands = await http().get(`/api/v1/parties/open-items/${f.body.openItem.id}/candidates`).set('Cookie', cookie);
    expect(cands.body.map((c: { documentId: string }) => c.documentId)).toContain(pay.body.document.id);
    const s = await http().post('/api/v1/parties/settlements').set('Cookie', cookie).send({
      openItemId: f.body.openItem.id, amount: '1000', date: '2026-09-10', paymentDocumentId: pay.body.document.id,
    });
    expect(s.status).toBe(201);

    const bal = await http().get(`/api/v1/parties/balances?side=payable&asOf=2026-09-30&companyId=${kei}`).set('Cookie', cookie);
    expect(bal.body.find((b: { partyId: string }) => b.partyId === partyId)).toMatchObject({ balance: '-500.0000', openItems: 1 });
    const aging = await http().get(`/api/v1/parties/aging?side=PAYABLE&asOf=2026-10-15&companyId=${kei}`).set('Cookie', cookie);
    expect(aging.body.find((r: { partyId: string }) => r.partyId === partyId)).toMatchObject({ total: '500.0000', buckets: { current: '500.0000' } });
    const st = await http().get(`/api/v1/parties/${partyId}/statement?from=2026-09-01&to=2026-09-30`).set('Cookie', cookie);
    expect(st.body.currencies[0]).toMatchObject({ currency: 'USD', opening: '0.0000', closing: '-500.0000' });
  });

  it('una cesión de deuda mueve el saldo entre contrapartes', async () => {
    const parties = await prisma.partyAccount.findMany({ where: { party: { code: { in: ['CONTRAPARTE_DEMO'] } } } });
    const from = parties[0]!;
    await http().post('/api/v1/parties/documents').set('Cookie', cookie).send({
      partyAccountId: from.id, date: '2026-09-05', kind: 'CHARGE', amount: '200', counterAccountId: acc['699.9995'], description: 'Deuda',
    }).expect(201);
    const other = await http().post('/api/v1/parties').set('Cookie', cookie).send({ name: 'Cesionario API', roles: ['CUSTOMER'] });
    const oa = await http().post(`/api/v1/parties/${other.body.id}/accounts`).set('Cookie', cookie)
      .send({ companyId: dm, currency: 'USD', accountId: acc['135.0001'], oppositeAccountId: acc['405.0001'] });
    const r = await http().post('/api/v1/parties/documents').set('Cookie', cookie).send({
      partyAccountId: from.id, date: '2026-09-06', kind: 'ASSIGNMENT', amount: '200', counterPartyAccountId: oa.body.id, description: 'Cesión',
    });
    expect(r.status).toBe(201);
    const det = await http().get(`/api/v1/parties/${other.body.id}?asOf=2026-09-30`).set('Cookie', cookie);
    expect(det.body.accounts[0].balance).toBe('200.0000');
  });

  it('nómina y listado de nóminas', async () => {
    const pa = await prisma.partyAccount.findFirstOrThrow({ where: { party: { code: 'TRABAJADORA_DEMO' } } });
    const r = await http().post('/api/v1/parties/payroll').set('Cookie', cookie).send({
      partyAccountId: pa.id, date: '2026-09-30', period: '2026-09', employer: 'KALUCH', concept: 'Salario', gross: '400', attendanceDeduction: '-10',
    });
    expect(r.status).toBe(201);
    const list = await http().get('/api/v1/parties/payroll?period=2026-09').set('Cookie', cookie);
    expect(list.body[0]).toMatchObject({ partyName: 'Trabajadora demo', net: '390.0000', status: 'OPEN' });
  });

  it('el usuario de solo lectura (KEI) ve las contrapartes pero no puede contabilizar', async () => {
    const ro = await login('lectura@kaluch.local');
    const list = await http().get('/api/v1/parties').set('Cookie', ro);
    expect(list.status).toBe(200);
    const post = await http().post('/api/v1/parties/documents').set('Cookie', ro).send({
      partyAccountId: paId, date: '2026-09-01', kind: 'CREDIT', amount: '1', counterAccountId: acc['814.0001'], description: 'x',
    });
    expect(post.status).toBe(403);
  });

  it('reclasificación por signo vía API', async () => {
    const r = await http().post('/api/v1/parties/reclass').set('Cookie', cookie).send({ companyId: dm, year: 2026, month: 9 });
    expect(r.status).toBe(201);
    const runs = await http().get(`/api/v1/parties/reclass?companyId=${dm}`).set('Cookie', cookie);
    expect(runs.body[0]).toMatchObject({ year: 2026, month: 9 });
  });
});
