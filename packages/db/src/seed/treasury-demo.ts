import type { CategoryKind, PrismaClient, TreasuryKind } from '@prisma/client';

/** Cuentas de tesorería y categorías de DEMOSTRACIÓN (ficticias). */
const TREASURY: { gl: string; company: string; kind: TreasuryKind; name: string; currency: string; bank?: string; owner?: string; partner?: boolean }[] = [
  { gl: '101.0001', company: 'DM', kind: 'CASH', name: 'Caja CUP', currency: 'CUP' },
  { gl: '101.0002', company: 'DM', kind: 'CASH', name: 'Caja USD', currency: 'USD' },
  { gl: '101.0003', company: 'DM', kind: 'CASH', name: 'Caja EUR', currency: 'EUR' },
  { gl: '109.9001', company: 'KEI', kind: 'BANK', name: 'Banco Demo RD - USD', currency: 'USD', bank: 'Banco Demo' },
  { gl: '109.9002', company: 'KEI', kind: 'BANK', name: 'Banco Demo RD - DOP', currency: 'DOP', bank: 'Banco Demo' },
  { gl: '110.9003', company: 'KGT', kind: 'BANK', name: 'Banco Demo España - EUR', currency: 'EUR', bank: 'Banco Demo' },
  { gl: '111.9004', company: 'GR', kind: 'BANK', name: 'Banco Demo Cuba - CUP', currency: 'CUP', bank: 'Banco Demo' },
  { gl: '114.9005', company: 'SOC', kind: 'BANK', name: 'Tarjeta MLC - Socio demo', currency: 'MLC', bank: 'Banco Demo', owner: 'Socio demo', partner: true },
];

export const DEMO_CATEGORIES: { code: string; name: string; kind: CategoryKind; account?: string; segment?: string; flow?: string }[] = [
  { code: 'VENTA_MINORISTA', name: 'Ventas minoristas', kind: 'INCOME', account: '900.0001', segment: '999' },
  { code: 'ALQUILER', name: 'Alquiler', kind: 'EXPENSE', account: '837.0001', segment: '999' },
  { code: 'SALARIO', name: 'Salarios', kind: 'EXPENSE', account: '826.0001' },
  { code: 'CAMBIO', name: 'Cambio de moneda', kind: 'EXCHANGE' },
  { code: 'TRASPASO', name: 'Traspaso entre cuentas', kind: 'TRANSFER' },
  { code: 'DEUDA', name: 'Deudas con contrapartes (fase 3)', kind: 'DEBT' },
];

export async function seedDemoTreasury(prisma: PrismaClient) {
  for (const t of TREASURY) {
    const gl = await prisma.account.findUniqueOrThrow({ where: { fullCode: t.gl } });
    const company = await prisma.company.findUniqueOrThrow({ where: { code: t.company } });
    const exists = await prisma.treasuryAccount.findUnique({ where: { glAccountId: gl.id } });
    if (exists) continue;
    await prisma.treasuryAccount.create({
      data: {
        companyId: company.id, glAccountId: gl.id, kind: t.kind, name: t.name, currency: t.currency, bank: t.bank ?? null,
        ownerType: t.partner ? 'PARTNER' : 'COMPANY', ownerName: t.owner ?? company.legalName, last4: gl.subcode,
      },
    });
  }
  for (const c of DEMO_CATEGORIES) {
    const account = c.account ? await prisma.account.findUnique({ where: { fullCode: c.account } }) : null;
    const segment = c.segment ? await prisma.segment.findUnique({ where: { code: c.segment } }) : null;
    await prisma.cashCategory.upsert({
      where: { code: c.code },
      update: {},
      create: { code: c.code, name: c.name, kind: c.kind, accountId: account?.id ?? null, segmentId: segment?.id ?? null, aliases: [c.name] },
    });
  }
}
