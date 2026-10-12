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
let admin = '';

async function login(email: string) {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: DEMO_PASSWORD });
  return ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]?.split(';')[0] ?? '';
}
const http = () => request(app.getHttpServer());
const line = (key: string, label: string, extra: Record<string, unknown> = {}) => ({ key, label, source: 'NONE', ...extra });

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.JWT_SECRET = 'test-secret';
  prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
  await seedDemo(prisma, { entries: false });
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApp(mod.createNestApplication());
  await app.init();
  admin = await login('admin@kaluch.local');
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

describe('estados financieros (API)', () => {
  it('plantillas predeterminadas y estados que cuadran (ES y EFE) en el consolidado', async () => {
    const list = await http().get('/api/v1/statements/templates').set('Cookie', admin).expect(200);
    expect(list.body.map((t: { code: string }) => t.code)).toEqual(expect.arrayContaining(['ES', 'ER', 'EFE']));
    for (const code of ['ES', 'EFE']) {
      const r = await http().get(`/api/v1/statements/${code}?year=2026&fromMonth=1&toMonth=10`).set('Cookie', admin).expect(200);
      const control = r.body.lines.find((l: { key: string }) => l.key === 'CONTROL');
      expect(control.values.every((v: string) => Math.abs(Number(v)) < 0.01)).toBe(true);
    }
    const er = await http().get('/api/v1/statements/ER?year=2026&fromMonth=1&toMonth=10&view=FISCAL').set('Cookie', admin).expect(200);
    expect(er.body.columns.at(-1).label).toMatch(/^Total/);
    await http().get('/api/v1/statements/NOPE?year=2026').set('Cookie', admin).expect(404);
  });

  it('diseñador: permisos, validación de fórmulas y una plantilla nueva con su Excel', async () => {
    const body = {
      code: 'TEST_API', name: 'Prueba API', kind: 'INCOME', notes: '',
      lines: [
        line('V', 'Ventas', { source: 'ACCOUNTS', accounts: ['900'] }),
        line('G', 'Gastos', { source: 'UNMAPPED', accounts: ['CND'] }),
        line('R', 'Resultado', { source: 'FORMULA', formula: '[V]+[G]', bold: true }),
      ],
    };
    const lectura = await login('lectura@kaluch.local');
    await http().put('/api/v1/statements/templates/TEST_API').set('Cookie', lectura).send(body).expect(403);
    const bad = await http().put('/api/v1/statements/templates/TEST_API').set('Cookie', admin)
      .send({ ...body, lines: [...body.lines, line('X', 'Mal', { source: 'FORMULA', formula: '[R]+' })] });
    expect(bad.status).toBe(400);
    const cycle = await http().put('/api/v1/statements/templates/TEST_API').set('Cookie', admin)
      .send({ ...body, lines: [line('A', 'a', { source: 'FORMULA', formula: '[B]' }), line('B', 'b', { source: 'FORMULA', formula: '[A]' })] });
    expect(cycle.status).toBe(400);
    expect(cycle.body.message).toMatch(/circular/);
    const contador = await login('contador@kaluch.local');
    const ok = await http().put('/api/v1/statements/templates/TEST_API').set('Cookie', contador).send(body).expect(200);
    expect(ok.body).toMatchObject({ code: 'TEST_API', origin: 'SISTEMA', lines: 3 });
    const detail = await http().get('/api/v1/statements/templates/TEST_API').set('Cookie', lectura).expect(200);
    expect(detail.body.lines.map((l: { key: string }) => l.key)).toEqual(['V', 'G', 'R']);
    const xlsx = await http().get('/api/v1/statements/TEST_API/xlsx?year=2026&fromMonth=1&toMonth=3').set('Cookie', lectura).expect(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
  });

  it('alertas y panel de dirección', async () => {
    const alerts = await http().get('/api/v1/statements/alerts?year=2026&month=10').set('Cookie', admin).expect(200);
    expect(Array.isArray(alerts.body)).toBe(true);
    const d = await http().get('/api/v1/dashboard?year=2026&month=10').set('Cookie', admin).expect(200);
    expect(d.body.monthly).toHaveLength(10);
    expect(d.body.aging.payable).toHaveLength(4);
    expect(d.body).toHaveProperty('containers.top');
    expect(d.body).toHaveProperty('markets');
  });
});
