import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEMO_PASSWORD, PrismaClient, seedDemo } from '@kaluch/db';
import { authenticator } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/setup';

let app: INestApplication;
let prisma: PrismaClient;
let cookie = '';
const tre: Record<string, string> = {};
const cat: Record<string, string> = {};
const acc: Record<string, string> = {};
let dm = '';

async function login(email: string, totp?: string) {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: DEMO_PASSWORD, totp });
  return ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]?.split(';')[0] ?? '';
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.JWT_SECRET = 'test-secret';
  prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
  await seedDemo(prisma, { entries: false });
  for (const t of await prisma.treasuryAccount.findMany({ include: { glAccount: true } })) tre[t.glAccount.fullCode] = t.id;
  for (const c of await prisma.cashCategory.findMany()) cat[c.code] = c.id;
  for (const a of await prisma.account.findMany()) acc[a.fullCode] = a.id;
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

describe('tesorería (API)', () => {
  it('registra un movimiento y lo muestra con el saldo de la cuenta', async () => {
    const r = await request(app.getHttpServer()).post('/api/v1/treasury/movements').set('Cookie', cookie).send({
      companyId: dm, date: '2026-08-12', description: 'Venta E2E', categoryId: cat.VENTA_MINORISTA,
      legs: [{ treasuryAccountId: tre['101.0002'], amount: '250' }],
    });
    expect(r.status).toBe(201);
    expect(r.body.document.number).toMatch(/^DM-TES-2026-/);
    expect(r.body.entries).toHaveLength(1);
    const accounts = await request(app.getHttpServer()).get(`/api/v1/treasury/accounts?companyId=${dm}`).set('Cookie', cookie);
    const usd = accounts.body.find((a: { id: string }) => a.id === tre['101.0002']);
    expect(usd.balance).toBe('250.0000');
  });

  it('bandeja de revisión: resumen y reclasificación en bloque', async () => {
    for (const amount of ['-10', '-15']) {
      await request(app.getHttpServer()).post('/api/v1/treasury/movements').set('Cookie', cookie).send({
        companyId: dm, date: '2026-08-13', description: 'Pago a contraparte', categoryId: cat.DEUDA,
        legs: [{ treasuryAccountId: tre['101.0002'], amount }],
      }).expect(201);
    }
    const summary = await request(app.getHttpServer()).get('/api/v1/treasury/review/summary').set('Cookie', cookie);
    const deuda = summary.body.find((s: { categoryId: string }) => s.categoryId === cat.DEUDA);
    expect(deuda).toMatchObject({ count: 2, usd: '25.00' });
    const bulk = await request(app.getHttpServer()).post('/api/v1/treasury/review/bulk').set('Cookie', cookie)
      .send({ categoryId: cat.DEUDA, accountId: acc['405.0001'] });
    expect(bulk.body).toEqual({ reclassified: 2 });
    const cats = await request(app.getHttpServer()).get('/api/v1/treasury/categories').set('Cookie', cookie);
    expect(cats.body.find((c: { id: string }) => c.id === cat.DEUDA).accountId).toBe(acc['405.0001']);
  });

  it('importa un extracto CSV, no duplica al reimportar y concilia automáticamente', async () => {
    const r = await request(app.getHttpServer()).post('/api/v1/treasury/movements').set('Cookie', cookie).send({
      companyId: dm, date: '2026-08-14', description: 'Cobro por banco', categoryId: cat.VENTA_MINORISTA,
      legs: [{ treasuryAccountId: tre['101.0002'], amount: '1234.5' }],
    });
    expect(r.status).toBe(201);
    const csv = 'Fecha;Concepto;Importe\n15/08/2026;Transferencia recibida;1.234,50\n16/08/2026;Comisión;-2,00\n';
    const up = await request(app.getHttpServer()).post('/api/v1/treasury/statements').set('Cookie', cookie)
      .field('treasuryAccountId', tre['101.0002']!).attach('file', Buffer.from(csv), 'extracto.csv');
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ lines: 2, inserted: 2, duplicates: 0, matched: 1, pending: 1 });
    const again = await request(app.getHttpServer()).post('/api/v1/treasury/statements').set('Cookie', cookie)
      .field('treasuryAccountId', tre['101.0002']!).attach('file', Buffer.from(csv), 'extracto.csv');
    expect(again.body).toMatchObject({ inserted: 0, duplicates: 2 });

    const lines = await request(app.getHttpServer()).get(`/api/v1/treasury/statements/lines?treasuryAccountId=${tre['101.0002']}&status=UNMATCHED`).set('Cookie', cookie);
    const commission = lines.body.items[0];
    const created = await request(app.getHttpServer()).post(`/api/v1/treasury/statements/lines/${commission.id}`).set('Cookie', cookie)
      .send({ action: 'create', categoryId: cat.ALQUILER, description: 'Comisión bancaria' });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('MATCHED');
  });

  it('revaluación mensual desde la API', async () => {
    const r = await request(app.getHttpServer()).post('/api/v1/treasury/revaluations').set('Cookie', cookie).send({ year: 2026, month: 8, companyId: dm });
    expect(r.status).toBe(201);
    expect(r.body[0].companyId).toBe(dm);
    const list = await request(app.getHttpServer()).get(`/api/v1/treasury/revaluations?year=2026&companyId=${dm}`).set('Cookie', cookie);
    expect(list.body.some((x: { month: number }) => x.month === 8)).toBe(true);
  });

  it('un usuario de solo lectura no puede registrar movimientos', async () => {
    const ro = await login('lectura@kaluch.local');
    const r = await request(app.getHttpServer()).post('/api/v1/treasury/movements').set('Cookie', ro).send({
      companyId: dm, date: '2026-08-12', description: 'x', legs: [{ treasuryAccountId: tre['101.0002'], amount: '1' }],
    });
    expect(r.status).toBe(403);
  });
});

describe('administración de usuarios y 2FA obligatorio', () => {
  it('crea un usuario con rol por empresa y puede acceder', async () => {
    const roles = await request(app.getHttpServer()).get('/api/v1/admin/roles').set('Cookie', cookie);
    const cajero = roles.body.roles.find((r: { name: string }) => r.name === 'Cajero');
    const r = await request(app.getHttpServer()).post('/api/v1/admin/users').set('Cookie', cookie).send({
      email: 'cajera@kaluch.local', name: 'Cajera', password: 'Una-clave-larga-1', assignments: [{ companyId: dm, roleId: cajero.id }],
    });
    expect(r.status).toBe(201);
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'cajera@kaluch.local', password: 'Una-clave-larga-1' });
    expect(res.status).toBe(200);
    const short = await request(app.getHttpServer()).post('/api/v1/admin/users').set('Cookie', cookie).send({ email: 'x@kaluch.local', name: 'x', password: 'corta' });
    expect(short.status).toBe(400);
  });

  it('con AUTH_ENFORCE_2FA, un rol que exige 2FA solo accede a /auth hasta activarlo', async () => {
    process.env.AUTH_ENFORCE_2FA = 'true';
    try {
      const c = await login('contador@kaluch.local');
      const blocked = await request(app.getHttpServer()).get('/api/v1/accounts').set('Cookie', c);
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('TOTP_REQUIRED');
      const setup = await request(app.getHttpServer()).post('/api/v1/auth/totp/setup').set('Cookie', c);
      await request(app.getHttpServer()).post('/api/v1/auth/totp/enable').set('Cookie', c).send({ code: authenticator.generate(setup.body.secret) }).expect(200);
      const ok = await request(app.getHttpServer()).get('/api/v1/accounts').set('Cookie', c);
      expect(ok.status).toBe(200);
    } finally {
      delete process.env.AUTH_ENFORCE_2FA;
      await prisma.appUser.update({ where: { email: 'contador@kaluch.local' }, data: { totpEnabled: false, totpSecret: null } });
    }
  });
});
