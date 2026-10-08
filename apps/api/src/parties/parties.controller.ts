import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  openItemAging, partyBalances, partyStatement, postPartyDocument, postPayroll, reclassifyBySign, settleOpenItem, toDate,
  upsertParty, voidSettlement, withTx, type Prisma,
} from '@kaluch/db';
import {
  money, paginationSchema, PARTY_ROLES, partyAccountInputSchema, partyDocumentInputSchema, partyInputSchema, payrollInputSchema,
  settlementInputSchema, signReclassInputSchema,
} from '@kaluch/shared';
import { z } from 'zod';
import { assertCan, scopeCompanies, type AuthUser } from '../auth/access';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const today = () => new Date().toISOString().slice(0, 10);

function slugCode(name: string) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'CONTRAPARTE';
}

@ApiTags('Contrapartes')
@Controller('parties')
export class PartiesController {
  constructor(private readonly prisma: PrismaService) {}

  /** Contrapartes con su saldo neto (USD) en las empresas visibles. */
  @Get()
  @RequirePermission('parties:read')
  async list(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(paginationSchema.extend({
      companyId: z.string().uuid().optional(), q: z.string().max(100).optional(), role: z.enum(PARTY_ROLES).optional(),
      asOf: isoDate.optional(), withBalance: z.preprocess((v) => v === 'true' || v === '1', z.boolean()).optional(),
    }), query);
    const companyIds = scopeCompanies(user, 'parties:read', q.companyId);
    const where: Prisma.PartyWhereInput = {
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { code: { contains: q.q.toUpperCase() } }, { taxId: { contains: q.q } }] } : {}),
      ...(q.role ? { roles: { has: q.role } } : {}),
    };
    const [total, parties] = await Promise.all([
      this.prisma.party.count({ where }),
      this.prisma.party.findMany({ where, orderBy: { name: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const balances = await partyBalances(this.prisma, { companyIds, asOf: q.asOf ?? today() });
    const byParty = new Map<string, { usd: ReturnType<typeof money>; accounts: number; openItems: number }>();
    for (const b of balances) {
      const e = byParty.get(b.partyId) ?? { usd: money(0), accounts: 0, openItems: 0 };
      e.usd = e.usd.plus(money(b.balanceUsd));
      e.accounts++;
      e.openItems += b.openItems;
      byParty.set(b.partyId, e);
    }
    return {
      total, page: q.page, pageSize: q.pageSize,
      items: parties.map((p) => ({
        ...p, balanceUsd: byParty.get(p.id)?.usd.toFixed(4) ?? '0.0000', accounts: byParty.get(p.id)?.accounts ?? 0, openItems: byParty.get(p.id)?.openItems ?? 0,
      })),
    };
  }

  /** Saldos de las cuentas corrientes (cuentas por cobrar / por pagar). */
  @Get('balances')
  @RequirePermission('parties:read')
  async balances(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({
      companyId: z.string().uuid().optional(), asOf: isoDate.optional(), side: z.enum(['receivable', 'payable', 'all']).default('all'),
      role: z.enum(PARTY_ROLES).optional(), hideZero: z.preprocess((v) => v !== 'false' && v !== '0', z.boolean()).default(true),
    }), query);
    const companyIds = scopeCompanies(user, 'parties:read', q.companyId);
    const rows = await partyBalances(this.prisma, { companyIds, asOf: q.asOf ?? today() });
    return rows.filter((r) => {
      const usd = money(r.balanceUsd);
      const orig = money(r.balance);
      if (q.hideZero && usd.abs().lt(0.005) && orig.abs().lt(0.005)) return false;
      if (q.role && !r.roles.includes(q.role)) return false;
      if (q.side === 'receivable') return orig.gt(0) || (orig.isZero() && usd.gt(0));
      if (q.side === 'payable') return orig.lt(0) || (orig.isZero() && usd.lt(0));
      return true;
    });
  }

  @Get('aging')
  @RequirePermission('parties:read')
  async aging(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional(), asOf: isoDate.optional(), side: z.enum(['RECEIVABLE', 'PAYABLE']) }), query);
    const companyIds = scopeCompanies(user, 'parties:read', q.companyId);
    return openItemAging(this.prisma, { companyIds, side: q.side, asOf: q.asOf ?? today() });
  }

  @Get('open-items')
  @RequirePermission('parties:read')
  async openItems(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(paginationSchema.extend({
      companyId: z.string().uuid().optional(), partyId: z.string().uuid().optional(), side: z.enum(['RECEIVABLE', 'PAYABLE']).optional(),
      status: z.enum(['open', 'closed', 'all']).default('open'), q: z.string().max(100).optional(),
    }), query);
    const companyIds = scopeCompanies(user, 'parties:read', q.companyId);
    const where: Prisma.OpenItemWhereInput = {
      companyId: { in: companyIds },
      ...(q.partyId ? { partyId: q.partyId } : {}),
      ...(q.side ? { side: q.side } : {}),
      ...(q.status === 'open' ? { status: { in: ['OPEN', 'PARTIAL'] } } : q.status === 'closed' ? { status: { in: ['SETTLED', 'CANCELLED'] } } : {}),
      ...(q.q ? { OR: [{ reference: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.openItem.count({ where }),
      this.prisma.openItem.findMany({
        where, include: { party: { select: { id: true, name: true, code: true } }, settlements: { where: { voided: false }, orderBy: { date: 'asc' } } },
        orderBy: [{ docDate: 'asc' }, { reference: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
    ]);
    const companies = new Map((await this.prisma.company.findMany({ select: { id: true, code: true } })).map((c) => [c.id, c.code]));
    return { total, page: q.page, pageSize: q.pageSize, items: items.map((i) => ({ ...i, companyCode: companies.get(i.companyId) })) };
  }

  @Get('payroll')
  @RequirePermission('parties:read')
  async payroll(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional(), period: z.string().regex(/^\d{4}-\d{2}$/).optional() }), query);
    const companyIds = scopeCompanies(user, 'parties:read', q.companyId);
    const lines = await this.prisma.payrollLine.findMany({
      where: { ...(q.period ? { period: q.period } : {}), partyDocument: { document: { companyId: { in: companyIds }, status: 'POSTED' } } },
      include: { partyDocument: { include: { document: true, partyAccount: { include: { party: true } } } } },
      orderBy: [{ period: 'desc' }, { employer: 'asc' }],
      take: 2000,
    });
    const items = await this.prisma.openItem.findMany({ where: { documentId: { in: lines.map((l) => l.id) } } });
    const openBy = new Map(items.map((i) => [i.documentId, i]));
    return lines.map((l) => ({
      id: l.id, period: l.period, employer: l.employer, concept: l.concept, currency: l.currency,
      gross: l.gross.toFixed(4), attendanceDeduction: l.attendanceDeduction.toFixed(4), mipymeDeduction: l.mipymeDeduction.toFixed(4), net: l.net.toFixed(4),
      number: l.partyDocument.document.number, date: l.partyDocument.document.docDate.toISOString().slice(0, 10),
      partyId: l.partyDocument.partyAccount.partyId, partyName: l.partyDocument.partyAccount.party.name,
      reference: l.partyDocument.reference, openAmount: openBy.get(l.id)?.openAmount.toFixed(4) ?? null, status: openBy.get(l.id)?.status ?? null,
    }));
  }

  @Get('reclass')
  @RequirePermission('parties:read')
  async reclassRuns(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional() }), query);
    const companyIds = scopeCompanies(user, 'parties:read', q.companyId);
    return this.prisma.signReclassRun.findMany({ where: { companyId: { in: companyIds } }, orderBy: [{ year: 'desc' }, { month: 'desc' }, { createdAt: 'desc' }], take: 100 });
  }

  @Post('reclass')
  @RequirePermission('parties:manage')
  async reclass(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(signReclassInputSchema, body);
    assertCan(user, 'parties:manage', b.companyId);
    return withTx(this.prisma, { userId: user.id, timeoutMs: 120_000 }, (tx) => reclassifyBySign(tx, b.companyId, b.year, b.month, user.id));
  }

  @Get(':id')
  @RequirePermission('parties:read')
  async detail(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional(), asOf: isoDate.optional() }), query);
    const companyIds = scopeCompanies(user, 'parties:read', q.companyId);
    const party = await this.prisma.party.findUnique({ where: { id } });
    if (!party) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Contraparte no encontrada' });
    const accounts = await partyBalances(this.prisma, { companyIds, asOf: q.asOf ?? today(), partyId: id });
    const categories = await this.prisma.cashCategory.findMany({ where: { partyAccount: { partyId: id } }, select: { id: true, code: true, name: true, partyAccountId: true } });
    return { ...party, accounts, categories };
  }

  @Get(':id/statement')
  @RequirePermission('parties:read')
  async statement(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional(), from: isoDate, to: isoDate, currency: z.string().length(3).optional() }), query);
    if (q.from > q.to) throw new BadRequestException({ code: 'VALIDATION', message: 'La fecha inicial es posterior a la final' });
    const companyIds = scopeCompanies(user, 'parties:read', q.companyId);
    return partyStatement(this.prisma, { partyId: id, companyIds, from: q.from, to: q.to, currency: q.currency ?? null });
  }

  @Post()
  @RequirePermission('parties:manage')
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(partyInputSchema, body);
    return withTx(this.prisma, { userId: user.id }, async (tx) => {
      let code = slugCode(b.name);
      for (let n = 2; await tx.party.findUnique({ where: { code } }); n++) code = `${slugCode(b.name)}_${n}`;
      const party = await upsertParty(tx, { code, name: b.name.trim(), kind: b.kind, roles: b.roles });
      return tx.party.update({
        where: { id: party.id },
        data: { taxId: b.taxId ?? null, email: b.email || null, phone: b.phone ?? null, notes: b.notes ?? null },
      });
    });
  }

  @Patch(':id')
  @RequirePermission('parties:manage')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(partyInputSchema.partial(), body);
    return withTx(this.prisma, { userId: user.id }, (tx) => tx.party.update({
      where: { id },
      data: {
        ...(b.name !== undefined ? { name: b.name.trim() } : {}), ...(b.kind ? { kind: b.kind } : {}), ...(b.roles ? { roles: b.roles } : {}),
        ...(b.taxId !== undefined ? { taxId: b.taxId } : {}), ...(b.email !== undefined ? { email: b.email || null } : {}),
        ...(b.phone !== undefined ? { phone: b.phone } : {}), ...(b.notes !== undefined ? { notes: b.notes } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
      },
    }));
  }

  @Post(':id/accounts')
  @RequirePermission('parties:manage')
  async createAccount(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(partyAccountInputSchema, body);
    assertCan(user, 'parties:manage', b.companyId);
    return withTx(this.prisma, { userId: user.id }, async (tx) => {
      const party = await tx.party.findUnique({ where: { id } });
      if (!party) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Contraparte no encontrada' });
      const acc = await tx.account.findUnique({ where: { id: b.accountId } });
      if (!acc?.postable) throw new BadRequestException({ code: 'VALIDATION', message: 'Elige una cuenta contable de detalle' });
      if (acc.currencyLock && acc.currencyLock !== b.currency) {
        throw new BadRequestException({ code: 'VALIDATION', message: `La cuenta ${acc.displayCode} solo admite ${acc.currencyLock}` });
      }
      const exists = await tx.partyAccount.findFirst({ where: { companyId: b.companyId, partyId: id, currency: b.currency, accountId: b.accountId } });
      if (exists) throw new BadRequestException({ code: 'DUPLICATE', message: 'Esa cuenta corriente ya existe' });
      return tx.partyAccount.create({
        data: {
          companyId: b.companyId, partyId: id, currency: b.currency, accountId: b.accountId, oppositeAccountId: b.oppositeAccountId ?? null,
          name: `${party.name} · ${acc.displayCode}${b.currency !== 'USD' ? ` ${b.currency}` : ''}`,
        },
      });
    });
  }

  @Post('documents')
  @RequirePermission('parties:manage')
  async postDocument(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(partyDocumentInputSchema, body);
    const pa = await this.prisma.partyAccount.findUnique({ where: { id: b.partyAccountId } });
    if (!pa) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Cuenta corriente no encontrada' });
    assertCan(user, 'parties:manage', pa.companyId);
    let amount = money(b.amount);
    if (b.kind === 'CREDIT') amount = amount.neg();
    if (b.kind === 'ASSIGNMENT') {
      if (!b.counterPartyAccountId) throw new BadRequestException({ code: 'VALIDATION', message: 'Indica la contraparte que recibe la deuda' });
      // Se cede lo que la contraparte nos debe (saldo deudor) o lo que le debemos (saldo acreedor).
      const [bal] = await partyBalances(this.prisma, { companyIds: [pa.companyId], asOf: b.date, partyId: pa.partyId });
      const current = money(bal && bal.partyAccountId === pa.id ? bal.balance : 0);
      amount = current.lt(0) ? amount : amount.neg();
    } else if (!b.counterAccountId) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Indica la cuenta de contrapartida' });
    }
    return withTx(this.prisma, { userId: user.id }, (tx) => postPartyDocument(tx, {
      partyAccountId: b.partyAccountId, date: b.date, kind: b.kind, amount: amount.toFixed(4),
      counterAccountId: b.kind === 'ASSIGNMENT' ? null : b.counterAccountId, counterPartyAccountId: b.kind === 'ASSIGNMENT' ? b.counterPartyAccountId : null,
      description: b.description, reference: b.reference ?? null, dueDate: b.dueDate ?? null, openItem: b.openItem,
      segmentId: b.segmentId ?? null, createdBy: user.id,
    }));
  }

  @Post('settlements')
  @RequirePermission('parties:manage')
  async settle(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(settlementInputSchema, body);
    const item = await this.prisma.openItem.findUnique({ where: { id: b.openItemId } });
    if (!item) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Partida abierta no encontrada' });
    assertCan(user, 'parties:manage', item.companyId);
    return withTx(this.prisma, { userId: user.id }, (tx) => settleOpenItem(tx, {
      openItemId: b.openItemId, amount: b.amount, date: b.date, kind: b.kind, paymentDocumentId: b.paymentDocumentId ?? null,
      note: b.note ?? null, createdBy: user.id,
    }));
  }

  @Post('settlements/:id/void')
  @RequirePermission('parties:manage')
  async voidSettle(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const s = await this.prisma.settlement.findUnique({ where: { id }, include: { openItem: true } });
    if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Liquidación no encontrada' });
    assertCan(user, 'parties:manage', s.openItem.companyId);
    return withTx(this.prisma, { userId: user.id }, (tx) => voidSettlement(tx, id));
  }

  @Post('payroll')
  @RequirePermission('payroll:manage')
  async postPayroll(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(payrollInputSchema, body);
    const pa = await this.prisma.partyAccount.findUnique({ where: { id: b.partyAccountId } });
    if (!pa) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Cuenta corriente no encontrada' });
    assertCan(user, 'payroll:manage', pa.companyId);
    return withTx(this.prisma, { userId: user.id }, (tx) => postPayroll(tx, {
      partyAccountId: b.partyAccountId, date: b.date, period: b.period, employer: b.employer, concept: b.concept, gross: b.gross,
      attendanceDeduction: b.attendanceDeduction, mipymeDeduction: b.mipymeDeduction, segmentId: b.segmentId ?? null,
      expenseAccountId: b.expenseAccountId ?? null, createdBy: user.id,
    }));
  }

  /** Movimientos de tesorería que se pueden aplicar a una partida (de la misma contraparte o cuenta corriente). */
  @Get('open-items/:id/candidates')
  @RequirePermission('parties:read')
  async candidates(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const item = await this.prisma.openItem.findUnique({ where: { id }, include: { partyAccount: true } });
    if (!item) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Partida abierta no encontrada' });
    assertCan(user, 'parties:read', item.companyId);
    const lines = await this.prisma.journalLine.findMany({
      where: {
        partyId: item.partyId, companyId: item.companyId, entryDate: { gte: item.docDate },
        accountId: { in: [item.partyAccount.accountId, ...(item.partyAccount.oppositeAccountId ? [item.partyAccount.oppositeAccountId] : [])] },
        amount: item.side === 'RECEIVABLE' ? { lt: 0 } : { gt: 0 },
        entry: { kind: { notIn: ['RECLASS', 'REVAL', 'REVERSAL'] }, status: 'POSTED', documentId: { not: null } },
      },
      include: { entry: true },
      orderBy: { entryDate: 'asc' },
      take: 50,
    });
    const docs = await this.prisma.document.findMany({ where: { id: { in: lines.map((l) => l.entry.documentId!) } } });
    const used = await this.prisma.settlement.groupBy({ by: ['paymentDocumentId'], where: { paymentDocumentId: { in: docs.map((d) => d.id) }, voided: false }, _sum: { amount: true } });
    return lines.map((l) => {
      const doc = docs.find((d) => d.id === l.entry.documentId);
      return {
        documentId: l.entry.documentId, number: doc?.number ?? l.entry.number, date: l.entryDate.toISOString().slice(0, 10), memo: l.memo ?? l.entry.memo,
        amount: money(l.amount).abs().toFixed(4), currency: l.currency,
        applied: used.find((u) => u.paymentDocumentId === l.entry.documentId)?._sum.amount?.toFixed(4) ?? '0.0000',
      };
    });
  }

  @Get('documents/:id')
  @RequirePermission('parties:read')
  async document(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const d = await this.prisma.partyDocument.findUnique({
      where: { id }, include: { document: true, partyAccount: { include: { party: true, account: true } }, payroll: true },
    });
    if (!d) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Documento no encontrado' });
    assertCan(user, 'parties:read', d.document.companyId);
    const lines = d.entryId ? await this.prisma.journalLine.findMany({ where: { entryId: d.entryId }, include: { account: true }, orderBy: { lineNo: 'asc' } }) : [];
    const openItems = await this.prisma.openItem.findMany({ where: { documentId: id }, include: { settlements: true } });
    return { ...d, lines, openItems, date: toDate(d.document.docDate.toISOString().slice(0, 10)) };
  }
}
