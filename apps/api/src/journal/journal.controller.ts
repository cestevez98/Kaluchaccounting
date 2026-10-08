import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { postEntry, reverseEntry, toDate, withTx, type Prisma } from '@kaluch/db';
import { journalEntryInputSchema, paginationSchema, reverseEntryInputSchema } from '@kaluch/shared';
import { z } from 'zod';
import { assertCan, can, scopeCompanies, type AuthUser } from '../auth/access';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';

const listSchema = paginationSchema.extend({
  companyId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().max(100).optional(),
  accountId: z.string().uuid().optional(),
  kind: z.enum(['AUTO', 'MANUAL', 'REVAL', 'CLOSING', 'OPENING', 'REVERSAL']).optional(),
});

@ApiTags('Libro diario')
@Controller('journal')
export class JournalController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission('ledger:read')
  async list(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(listSchema, query);
    const companyIds = scopeCompanies(user, 'ledger:read', q.companyId);
    const where: Prisma.JournalEntryWhereInput = {
      companyId: { in: companyIds },
      ...(q.from || q.to ? { entryDate: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}),
      ...(q.q ? { OR: [{ memo: { contains: q.q, mode: 'insensitive' } }, { number: { contains: q.q.toUpperCase() } }] } : {}),
      ...(q.accountId ? { lines: { some: { accountId: q.accountId } } } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
    };
    const [total, entries] = await Promise.all([
      this.prisma.journalEntry.count({ where }),
      this.prisma.journalEntry.findMany({
        where,
        include: { company: { select: { code: true } } },
        orderBy: [{ entryDate: 'desc' }, { number: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    const totals = await this.prisma.journalLine.groupBy({
      by: ['entryId'],
      where: { entryId: { in: entries.map((e) => e.id) }, amountUsd: { gt: 0 } },
      _sum: { amountUsd: true },
    });
    const totalOf = new Map(totals.map((t) => [t.entryId, t._sum.amountUsd?.toFixed(4) ?? '0']));
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: entries.map((e) => ({ ...e, companyCode: e.company.code, totalUsd: totalOf.get(e.id) ?? '0' })),
    };
  }

  @Get(':id')
  @RequirePermission('ledger:read')
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id },
      include: {
        company: { select: { code: true, legalName: true } },
        lines: { orderBy: { lineNo: 'asc' }, include: { account: { select: { displayCode: true, name: true } } } },
        reverses: { select: { id: true, number: true } },
        reversedBy: { select: { id: true, number: true } },
      },
    });
    if (!entry || !can(user, 'ledger:read', entry.companyId)) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Asiento no encontrado' });
    }
    return entry;
  }

  /** Asiento manual. El motor convierte a USD, compensa el redondeo y valida el cuadre. */
  @Post()
  @RequirePermission('ledger:post')
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(journalEntryInputSchema, body);
    assertCan(user, 'ledger:post', input.companyId);
    const allowSoftClosed = can(user, 'ledger:post_soft_closed', input.companyId);
    const entry = await withTx(this.prisma, { userId: user.id, allowSoftClosed }, (tx) =>
      postEntry(tx, { ...input, kind: 'MANUAL', createdBy: user.id }),
    );
    return this.get(user, entry.id);
  }

  @Post(':id/reverse')
  @RequirePermission('ledger:reverse')
  async reverse(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(reverseEntryInputSchema, body ?? {});
    const original = await this.prisma.journalEntry.findUnique({ where: { id } });
    if (!original) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Asiento no encontrado' });
    assertCan(user, 'ledger:reverse', original.companyId);
    const allowSoftClosed = can(user, 'ledger:post_soft_closed', original.companyId);
    const rev = await withTx(this.prisma, { userId: user.id, allowSoftClosed }, (tx) =>
      reverseEntry(tx, id, { ...input, createdBy: user.id }),
    );
    return this.get(user, rev.id);
  }
}
