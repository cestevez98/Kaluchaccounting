import { Body, Controller, Get, NotFoundException, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  accrueLoanInterest, accrueTax, capitalByPartner, closeTaxPeriod, closeYear, createLoan, monthCloseStatus, postCapitalMovement,
  reclassifyLoanTerm, taxSummary, withTx, type Prisma,
} from '@kaluch/db';
import {
  capitalMovementInputSchema, loanInputSchema, loanTermInputSchema, money, monthInputSchema, paginationSchema, TAX_AGENCIES,
  taxAccrualInputSchema, taxCloseInputSchema, yearCloseInputSchema,
} from '@kaluch/shared';
import { z } from 'zod';
import { assertCan, scopeCompanies, type AuthUser } from '../auth/access';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const d = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : null);
const usd = (v: unknown) => money(String(v ?? 0)).toFixed(4);
const today = () => new Date().toISOString().slice(0, 10);

@ApiTags('Financiamientos, impuestos, capital y cierres')
@Controller('finance')
export class FinanceController {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────── Préstamos ─────────────

  @Get('loans')
  @RequirePermission('ledger:read')
  async loans(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(paginationSchema.extend({
      companyId: z.string().uuid().optional(), status: z.enum(['ACTIVE', 'CLOSED']).optional(), direction: z.enum(['GIVEN', 'RECEIVED']).optional(),
      q: z.string().max(100).optional(),
    }), query);
    const where: Prisma.LoanWhereInput = {
      companyId: { in: scopeCompanies(user, 'ledger:read', q.companyId) },
      ...(q.status ? { status: q.status } : {}),
      ...(q.direction ? { direction: q.direction } : {}),
      ...(q.q ? { OR: [{ reference: { contains: q.q, mode: 'insensitive' } }, { partyAccount: { party: { name: { contains: q.q, mode: 'insensitive' } } } }] } : {}),
    };
    const [total, rows, active] = await Promise.all([
      this.prisma.loan.count({ where }),
      this.prisma.loan.findMany({
        where, orderBy: [{ startDate: 'desc' }, { reference: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { company: true, partyAccount: { include: { party: true, account: true } }, accruals: true },
      }),
      this.prisma.loan.groupBy({ by: ['direction'], where: { ...where, status: 'ACTIVE' }, _sum: { principalUsd: true, interestUsd: true }, _count: true }),
    ]);
    const items = await Promise.all(rows.map(async (l) => {
      const item = l.documentId ? await this.prisma.openItem.findFirst({ where: { documentId: l.documentId } }) : null;
      return {
        id: l.id, companyCode: l.company.code, reference: l.reference, description: l.description, direction: l.direction, status: l.status, migrated: l.migrated,
        partyId: l.partyAccount.partyId, partyName: l.partyAccount.party.name, accountCode: l.partyAccount.account.fullCode,
        startDate: d(l.startDate), endDate: d(l.endDate), principalUsd: usd(l.principalUsd), ratePct: money(String(l.ratePct)).toFixed(2),
        interestUsd: usd(l.interestUsd), accruedUsd: l.accruals.reduce((s, a) => s.plus(money(String(a.amountUsd))), money(0)).toFixed(4),
        longTermUsd: usd(l.longTermUsd), openUsd: item ? usd(item.openAmount) : null,
      };
    }));
    return {
      total, page: q.page, pageSize: q.pageSize, items,
      active: active.map((a) => ({ direction: a.direction, count: a._count, principalUsd: usd(a._sum.principalUsd), interestUsd: usd(a._sum.interestUsd) })),
    };
  }

  @Post('loans')
  @RequirePermission('finance:manage')
  async createLoan(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(loanInputSchema, body);
    const pa = await this.prisma.partyAccount.findUnique({ where: { id: b.partyAccountId } });
    if (!pa) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Cuenta corriente no encontrada' });
    assertCan(user, 'finance:manage', pa.companyId);
    const loan = await withTx(this.prisma, { userId: user.id }, (tx) => createLoan(tx, { ...b, createdBy: user.id }));
    return { id: loan.id, reference: loan.reference };
  }

  @Post('loans/accrue')
  @RequirePermission('finance:manage')
  async accrue(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(monthInputSchema, body);
    assertCan(user, 'finance:manage', b.companyId);
    return withTx(this.prisma, { userId: user.id }, (tx) => accrueLoanInterest(tx, { ...b, createdBy: user.id }));
  }

  @Post('loans/term')
  @RequirePermission('finance:manage')
  async term(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(loanTermInputSchema, body);
    assertCan(user, 'finance:manage', b.companyId);
    return withTx(this.prisma, { userId: user.id }, (tx) => reclassifyLoanTerm(tx, { ...b, createdBy: user.id }));
  }

  // ───────────── Impuestos ─────────────

  @Get('taxes')
  @RequirePermission('ledger:read')
  async taxes(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({
      companyId: z.string().uuid().optional(), agency: z.enum(TAX_AGENCIES).default('ONAT'),
      year: z.coerce.number().int().default(new Date().getUTCFullYear()),
    }), query);
    return taxSummary(this.prisma, { companyIds: scopeCompanies(user, 'ledger:read', q.companyId), agency: q.agency, year: q.year });
  }

  @Get('taxes/documents')
  @RequirePermission('ledger:read')
  async taxDocuments(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional(), agency: z.enum(TAX_AGENCIES).optional() }), query);
    const rows = await this.prisma.taxDocument.findMany({
      where: { companyId: { in: scopeCompanies(user, 'ledger:read', q.companyId) }, ...(q.agency ? { agency: q.agency } : {}) },
      include: { document: { include: { company: true } } }, orderBy: { document: { docDate: 'desc' } }, take: 200,
    });
    return rows.map((r) => ({
      id: r.id, number: r.document.number, companyCode: r.document.company.code, date: d(r.document.docDate), memo: r.document.memo, agency: r.agency,
      kind: r.kind, periodFrom: d(r.periodFrom), periodTo: d(r.periodTo), amountUsd: usd(r.amountUsd),
      declaredUsd: r.declaredUsd === null ? null : usd(r.declaredUsd), accruedUsd: r.accruedUsd === null ? null : usd(r.accruedUsd),
    }));
  }

  @Post('taxes/accrue')
  @RequirePermission('tax:manage')
  async accrueTax(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(taxAccrualInputSchema, body);
    assertCan(user, 'tax:manage', b.companyId);
    const r = await withTx(this.prisma, { userId: user.id }, (tx) => accrueTax(tx, { ...b, createdBy: user.id }));
    return { document: r.document.number };
  }

  @Post('taxes/close')
  @RequirePermission('tax:manage')
  async closeTax(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(taxCloseInputSchema, body);
    assertCan(user, 'tax:manage', b.companyId);
    const r = await withTx(this.prisma, { userId: user.id }, (tx) => closeTaxPeriod(tx, { ...b, createdBy: user.id }));
    return { document: r.document.number, accruedUsd: r.accruedUsd, adjustmentUsd: r.adjustmentUsd };
  }

  // ───────────── Capital ─────────────

  @Get('capital')
  @RequirePermission('ledger:read')
  async capital(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional(), asOf: isoDate.optional() }), query);
    const companyIds = scopeCompanies(user, 'ledger:read', q.companyId);
    const [partners, movements] = await Promise.all([
      capitalByPartner(this.prisma, { companyIds, asOf: q.asOf ?? today() }),
      this.prisma.capitalMovement.findMany({
        where: { companyId: { in: companyIds } }, include: { party: true, document: { include: { company: true } } },
        orderBy: { document: { docDate: 'desc' } }, take: 100,
      }),
    ]);
    return {
      partners,
      movements: movements.map((m) => ({
        id: m.id, number: m.document.number, companyCode: m.document.company.code, date: d(m.document.docDate), partyId: m.partyId,
        partyName: m.party.name, kind: m.kind, amountUsd: usd(m.amountUsd), description: m.description,
      })),
    };
  }

  @Post('capital')
  @RequirePermission('capital:manage')
  async capitalMovement(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(capitalMovementInputSchema, body);
    assertCan(user, 'capital:manage', b.companyId);
    const r = await withTx(this.prisma, { userId: user.id }, (tx) => postCapitalMovement(tx, { ...b, createdBy: user.id }));
    return { document: r.document.number };
  }

  // ───────────── Cierres ─────────────

  @Get('close/month')
  @RequirePermission('ledger:read')
  async monthClose(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(monthInputSchema, query);
    assertCan(user, 'ledger:read', q.companyId);
    return monthCloseStatus(this.prisma, q);
  }

  @Get('close/year')
  @RequirePermission('ledger:read')
  async yearCloses(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional() }), query);
    const rows = await this.prisma.yearClose.findMany({
      where: { companyId: { in: scopeCompanies(user, 'ledger:read', q.companyId) } }, include: { company: true }, orderBy: [{ year: 'desc' }],
    });
    return rows.map((r) => ({ id: r.id, companyCode: r.company.code, year: r.year, resultUsd: usd(r.resultUsd), entries: r.entryIds.length, createdAt: r.createdAt }));
  }

  @Post('close/year')
  @RequirePermission('year:close')
  async closeYear(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(yearCloseInputSchema, body);
    assertCan(user, 'year:close', b.companyId);
    const r = await withTx(this.prisma, { userId: user.id }, (tx) => closeYear(tx, { ...b, createdBy: user.id }));
    return { year: r.year, resultUsd: usd(r.resultUsd), entries: r.entryIds.length };
  }
}
