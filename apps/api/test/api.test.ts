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
const ids: Record<string, string> = {};

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: DEMO_PASSWORD });
  expect(res.status).toBe(200);
  const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]!;
  expect(cookie).toMatch(/kaluch_session=.*HttpOnly/);
  return cookie.split(';')[0]!;
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.JWT_SECRET = 'test-secret';
  prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
  await seedDemo(prisma);
  for (const a of await prisma.account.findMany()) ids[a.fullCode] = a.id;
  for (const c of await prisma.company.findMany()) ids[c.code] = c.id;
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApp(mod.createNestApplication());
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

describe('autenticación', () => {
  it('rechaza credenciales incorrectas y peticiones sin sesión', async () => {
    const bad = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'admin@kaluch.local', password: 'x' });
    expect(bad.status).toBe(401);
    expect(bad.body).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Correo o contraseña incorrectos' });
    const anon = await request(app.getHttpServer()).get('/api/v1/accounts');
    expect(anon.status).toBe(401);
  });

  it('devuelve el perfil con permisos por empresa', async () => {
    const cookie = await login('lectura@kaluch.local');
    const me = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.companies.map((c: { code: string }) => c.code)).toEqual(['KEI']);
    expect(me.body.companies[0].roles).toEqual(['Solo lectura']);
  });

  it('flujo de verificación en dos pasos (TOTP)', async () => {
    const cookie = await login('contador@kaluch.local');
    const setup = await request(app.getHttpServer()).post('/api/v1/auth/totp/setup').set('Cookie', cookie);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const enable = await request(app.getHttpServer())
      .post('/api/v1/auth/totp/enable').set('Cookie', cookie).send({ code: authenticator.generate(setup.body.secret) });
    expect(enable.status).toBe(200);
    const step1 = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'contador@kaluch.local', password: DEMO_PASSWORD });
    expect(step1.body).toEqual({ requiresTotp: true });
    expect(step1.headers['set-cookie']).toBeUndefined();
    const step2 = await request(app.getHttpServer())
      .post('/api/v1/auth/login').send({ email: 'contador@kaluch.local', password: DEMO_PASSWORD, totp: authenticator.generate(setup.body.secret) });
    expect(step2.status).toBe(200);
    expect(step2.body.ok).toBe(true);
    await prisma.appUser.update({ where: { email: 'contador@kaluch.local' }, data: { totpEnabled: false } });
  });
});

describe('permisos por empresa', () => {
  it('un usuario de solo lectura no contabiliza y solo ve su empresa', async () => {
    const cookie = await login('lectura@kaluch.local');
    const post = await request(app.getHttpServer()).post('/api/v1/journal').set('Cookie', cookie).send({
      companyId: ids.KEI, entryDate: '2026-06-01', memo: 'x',
      lines: [
        { accountId: ids['101.0002'], currency: 'USD', amount: '1' },
        { accountId: ids['900.0002'], currency: 'USD', amount: '-1' },
      ],
    });
    expect(post.status).toBe(403);
    const otherCompany = await request(app.getHttpServer()).get(`/api/v1/journal?companyId=${ids.DM}`).set('Cookie', cookie);
    expect(otherCompany.status).toBe(403);
    const list = await request(app.getHttpServer()).get('/api/v1/journal').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.items.every((e: { companyCode: string }) => e.companyCode === 'KEI')).toBe(true);
  });
});

describe('libro diario y reportes', () => {
  it('crea un asiento, valida errores en español y lo anula', async () => {
    const cookie = await login('admin@kaluch.local');
    const invalid = await request(app.getHttpServer()).post('/api/v1/journal').set('Cookie', cookie).send({
      companyId: ids.GR, entryDate: '2026-06-05', memo: 'Descuadre',
      lines: [
        { accountId: ids['101.0002'], currency: 'USD', amount: '10' },
        { accountId: ids['900.0001'], currency: 'USD', amount: '-9' },
      ],
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body).toEqual({ code: 'UNBALANCED', message: 'El asiento no cuadra: diferencia de 1.0000 USD entre Debe y Haber' });

    const validation = await request(app.getHttpServer()).post('/api/v1/journal').set('Cookie', cookie).send({ companyId: ids.GR, lines: [] });
    expect(validation.status).toBe(400);
    expect(validation.body.code).toBe('VALIDATION');

    const created = await request(app.getHttpServer()).post('/api/v1/journal').set('Cookie', cookie).send({
      companyId: ids.GR, entryDate: '2026-06-05', memo: 'Venta CUP',
      lines: [
        { accountId: ids['101.0001'], currency: 'CUP', amount: '80000' },
        { accountId: ids['900.0001'], currency: 'CUP', amount: '-80000' },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.number).toMatch(/^GR-2026-\d{6}$/);
    expect(created.body.lines).toHaveLength(2);
    expect(created.body.lines[0].rateType).toBe('IC');

    const rev = await request(app.getHttpServer()).post(`/api/v1/journal/${created.body.id}/reverse`).set('Cookie', cookie).send({});
    expect(rev.status).toBe(201);
    expect(rev.body.kind).toBe('REVERSAL');
    expect(rev.body.reverses.number).toBe(created.body.number);
    const again = await request(app.getHttpServer()).post(`/api/v1/journal/${created.body.id}/reverse`).set('Cookie', cookie).send({});
    expect(again.status).toBe(409);
  });

  it('balance de comprobación consolidado y exportación a Excel', async () => {
    const cookie = await login('admin@kaluch.local');
    const tb = await request(app.getHttpServer()).get('/api/v1/reports/trial-balance?year=2026&month=5').set('Cookie', cookie);
    expect(tb.status).toBe(200);
    expect(tb.body.summary.balanced).toBe(true);
    const bank = tb.body.rows.find((r: { displayCode: string }) => r.displayCode === '109.9001');
    expect(bank).toMatchObject({ opening: '25000.0000', debit: '8000.0000', closing: '33000.0000' });

    const xlsx = await request(app.getHttpServer())
      .get('/api/v1/reports/trial-balance.xlsx?year=2026&month=5').set('Cookie', cookie)
      .buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
  });

  it('periodos: no se bloquea sin revisión previa y la reapertura exige motivo', async () => {
    const cookie = await login('admin@kaluch.local');
    const p = await prisma.fiscalPeriod.findFirstOrThrow({ where: { companyId: ids.KTR, year: 2026, month: 1 } });
    const direct = await request(app.getHttpServer()).patch(`/api/v1/periods/${p.id}`).set('Cookie', cookie).send({ status: 'LOCKED' });
    expect(direct.status).toBe(400);
    await request(app.getHttpServer()).patch(`/api/v1/periods/${p.id}`).set('Cookie', cookie).send({ status: 'SOFT_CLOSED' }).expect(200);
    await request(app.getHttpServer()).patch(`/api/v1/periods/${p.id}`).set('Cookie', cookie).send({ status: 'LOCKED' }).expect(200);
    const noReason = await request(app.getHttpServer()).patch(`/api/v1/periods/${p.id}`).set('Cookie', cookie).send({ status: 'OPEN' });
    expect(noReason.status).toBe(400);
    await request(app.getHttpServer()).patch(`/api/v1/periods/${p.id}`).set('Cookie', cookie).send({ status: 'OPEN', reason: 'Corrección de tasa' }).expect(200);
    const log = await prisma.auditLog.findFirst({ where: { tableName: 'fiscal_period', recordId: p.id }, orderBy: { id: 'desc' } });
    expect((log?.after as { _reason?: string })._reason).toBe('Corrección de tasa');
  });

  it('expone la documentación OpenAPI', async () => {
    const res = await request(app.getHttpServer()).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.info.title).toBe('Kaluch ERP API');
    expect(Object.keys(res.body.paths)).toContain('/api/v1/journal');
  });
});
