import { SEED_ROLES } from '@kaluch/shared';
import type { PrismaClient } from '@prisma/client';
import { PARAMETER_DEFAULTS } from '../params';

/**
 * Catálogos base, idempotentes. Se ejecutan tanto en producción (seed:base)
 * como en la demo. No contienen datos financieros reales.
 */
export const COMPANIES = [
  { code: 'DM', legalName: "MPM D'Milio S.U.R.L.", section: 'Distribución', country: 'CU', kind: 'LEGAL' },
  { code: 'GR', legalName: 'MPM Grupo Roca S.U.R.L.', section: 'Distribución', country: 'CU', kind: 'LEGAL' },
  { code: 'KEI', legalName: 'Kaluch Export & Import S.R.L.', section: 'Exportación', country: 'DO', kind: 'LEGAL' },
  { code: 'KTR', legalName: 'Kaluch Travel S.R.L.', section: 'Exportación', country: 'DO', kind: 'LEGAL' },
  { code: 'KGT', legalName: 'Kaluch Global Trading S.L.', section: 'Exportación', country: 'ES', kind: 'LEGAL' },
  { code: 'SOC', legalName: 'Tesorería de socios', section: 'Socios', country: null, kind: 'PARTNER_POOL' },
] as const;

export const CURRENCIES = [
  { code: 'USD', name: 'Dólar estadounidense' },
  { code: 'CUP', name: 'Peso cubano' },
  { code: 'MLC', name: 'Moneda libremente convertible' },
  { code: 'EUR', name: 'Euro' },
  { code: 'DOP', name: 'Peso dominicano' },
  { code: 'CAD', name: 'Dólar canadiense' },
  { code: 'GBP', name: 'Libra esterlina' },
];

export const RATE_TYPES = [
  { code: 'OC', name: 'Oficial (Cuba)' },
  { code: 'IC', name: 'Informal (Cuba)' },
  { code: 'OUE', name: 'Oficial Unión Europea' },
  { code: 'ORD', name: 'Oficial República Dominicana' },
];

const POS = [
  ['1RA-12', '1ra y 12'],
  ['SLZ-MAR', 'San Lázaro y Marina'],
  ['26-41', '26 y 41'],
  ['CERRO', 'Cerro'],
  ['AYESTARAN', 'Ayestarán'],
  ['WEB', 'Web'],
] as const;
const WAREHOUSES = [
  ['ITM', 'ITM'],
  ['100-PERLA', '100 y Perla'],
] as const;

export async function seedCatalogs(prisma: PrismaClient) {
  for (const c of CURRENCIES) {
    await prisma.currency.upsert({ where: { code: c.code }, update: { name: c.name }, create: c });
  }
  for (const r of RATE_TYPES) {
    await prisma.rateType.upsert({ where: { code: r.code }, update: { name: r.name }, create: r });
  }
  for (const c of COMPANIES) {
    await prisma.company.upsert({ where: { code: c.code }, update: { legalName: c.legalName }, create: { ...c } });
  }

  const s888 = await prisma.segment.upsert({ where: { code: '888' }, update: {}, create: { code: '888', name: 'Exportación' } });
  const s999 = await prisma.segment.upsert({ where: { code: '999' }, update: {}, create: { code: '999', name: 'Distribución' } });
  await prisma.segment.upsert({
    where: { code: '777' },
    update: { parentId: s999.id },
    create: { code: '777', name: 'Doping', parentId: s999.id },
  });
  await prisma.segment.upsert({
    where: { code: 'PRJ-IGLESIA' },
    update: { parentId: s999.id },
    create: { code: 'PRJ-IGLESIA', name: 'Proyecto Iglesia', parentId: s999.id },
  });
  void s888;

  for (const [code, name] of POS) {
    await prisma.dimensionValue.upsert({
      where: { dimension_code: { dimension: 'POS', code } },
      update: { name },
      create: { dimension: 'POS', code, name, segmentId: s999.id },
    });
  }
  for (const [code, name] of WAREHOUSES) {
    await prisma.dimensionValue.upsert({
      where: { dimension_code: { dimension: 'WAREHOUSE', code } },
      update: { name },
      create: { dimension: 'WAREHOUSE', code, name, segmentId: s999.id },
    });
  }

  for (const r of SEED_ROLES) {
    const role = await prisma.role.upsert({
      where: { name: r.name },
      update: { description: r.description, requires2fa: r.requires2fa, system: true },
      create: { name: r.name, description: r.description, requires2fa: r.requires2fa, system: true },
    });
    // Los roles de sistema se sincronizan con la definición del código.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({ data: r.permissions.map((permission) => ({ roleId: role.id, permission })) });
  }

  for (const [key, def] of Object.entries(PARAMETER_DEFAULTS)) {
    await prisma.parameter.upsert({ where: { key }, update: { description: def.description }, create: { key, description: def.description } });
    const validFrom = new Date(key.startsWith('onat.') ? '2026-01-01T00:00:00Z' : '2000-01-01T00:00:00Z');
    await prisma.parameterVersion.upsert({
      where: { key_validFrom: { key, validFrom } },
      update: {},
      create: { key, validFrom, value: def.value as object },
    });
  }
}

/** Periodos mensuales (1–12) de un año para todas las empresas. */
export async function seedPeriods(prisma: PrismaClient, year: number) {
  const companies = await prisma.company.findMany();
  for (const c of companies) {
    for (let month = 1; month <= 12; month++) {
      await prisma.fiscalPeriod.upsert({
        where: { companyId_year_month: { companyId: c.id, year, month } },
        update: {},
        create: { companyId: c.id, year, month },
      });
    }
  }
}
