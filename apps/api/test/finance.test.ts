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
let kei = "";
let dm = "";
const acc: Record<string, string> = {};

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
  kei = (await prisma.company.findUniqueOrThrow({ where: { code: 'KEI' } })).id;
  dm = (await prisma.company.findUniqueOrThrow({ where: { code: 'DM' } })).id;
  for (const a of await prisma.account.findMany()) acc[a.fullCode] = a.id;
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApp(mod.createNestApplication());
  await app.init();
  cookie = await login('admin@kaluch.local');
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

describe('financiamientos, impuestos, capital y cierres (API)', () => {
  it('alta de préstamo, devengo del mes y listado', async () => {
    const ref = `API-FI-${Date.now()}`;
    const r = await http().post('/api/v1/finance/loans').set('Cookie', cookie).send({
      partyAccountId: pa['PRESTAMISTA_DEMO:411'], direction: 'RECEIVED', reference: ref, description: 'Préstamo API', startDate: '2026-09-01',
      endDate: '2026-09-30', principalUsd: '5000', ratePct: '3', counterAccountId: acc['109.9001'],
    });
    expect(r.status).toBe(201);
    const a = await http().post('/api/v1/finance/loans/accrue').set('Cookie', cookie).send({ companyId: kei, year: 2026, month: 9 });
    expect(a.body.find((x: { reference: string }) => x.reference === ref)).toMatchObject({ amountUsd: '150.0000' });
    const list = await http().get(`/api/v1/finance/loans?q=${ref}`).set('Cookie', cookie);
    expect(list.body.items[0]).toMatchObject({ reference: ref, interestUsd: '150.0000', accruedUsd: '150.0000', openUsd: '5150.0000' });
  });

  it('devengo y cierre de ONAT, y resumen del año', async () => {
    const accrue = await http().post('/api/v1/finance/taxes/accrue').set('Cookie', cookie).send({
      companyId: dm, agency: 'ONAT', date: '2026-09-30', periodFrom: '2026-09-01', periodTo: '2026-09-30', amountUsd: '400', description: 'Ventas septiembre',
    });
    expect(accrue.status).toBe(201);
    const close = await http().post('/api/v1/finance/taxes/close').set('Cookie', cookie).send({
      companyId: dm, agency: 'ONAT', periodFrom: '2026-07-01', periodTo: '2026-09-30', date: '2026-10-15', declaredUsd: '350',
    });
    expect(close.body).toMatchObject({ accruedUsd: '400.0000', adjustmentUsd: '-50.0000' });
    const sum = await http().get(`/api/v1/finance/taxes?companyId=${dm}&agency=ONAT&year=2026`).set('Cookie', cookie);
    expect(sum.body.months[8]).toMatchObject({ accruedUsd: '400.0000' });
    expect(sum.body.closings.at(-1)).toMatchObject({ declaredUsd: '350.0000', adjustmentUsd: '-50.0000' });
  });

  it('aporte de un socio, capital por socio y lista de cierre del mes', async () => {
    const partner = await prisma.party.findUniqueOrThrow({ where: { code: 'SOCIO_DEMO_A' } });
    const capitalOf = async () => {
      const cap = await http().get(`/api/v1/finance/capital?companyId=${kei}`).set('Cookie', cookie);
      return Number(cap.body.partners.find((p: { partyId: string }) => p.partyId === partner.id)?.capitalUsd ?? 0);
    };
    const before = await capitalOf();
    const r = await http().post('/api/v1/finance/capital').set('Cookie', cookie).send({
      companyId: kei, partyId: partner.id, kind: 'CONTRIBUTION', date: '2026-09-10', amountUsd: '2500', counterAccountId: acc['109.9001'], description: 'Aporte API',
    });
    expect(r.status).toBe(201);
    expect(await capitalOf()).toBeCloseTo(before + 2500, 2);
    const close = await http().get(`/api/v1/finance/close/month?companyId=${kei}&year=2026&month=9`).set('Cookie', cookie);
    expect(close.body.checks.map((c: { key: string }) => c.key)).toContain('loans');
  });

  it('solo lectura no puede crear préstamos ni cerrar el ejercicio', async () => {
    const ro = await login('lectura@kaluch.local');
    expect((await http().get('/api/v1/finance/loans').set('Cookie', ro)).status).toBe(200);
    expect((await http().post('/api/v1/finance/close/year').set('Cookie', ro).send({ companyId: kei, year: 2026 })).status).toBe(403);
  });
});
