import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query,
  UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import {
  autoReconcile, closeFxTransits, importStatement, matchStatementLine, postTreasuryMovement, reclassifyBySign, reclassifyMovement, revalueMonth,
  setStatementLineStatus, toDate, voidTreasuryMovement, withTx, type Prisma,
} from '@kaluch/db';
import {
  categoryInputSchema, DEFAULT_RATE_TYPES, money, paginationSchema, reclassifyInputSchema, revaluationInputSchema,
  treasuryAccountInputSchema, treasuryMovementInputSchema,
} from '@kaluch/shared';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assertCan, can, scopeCompanies, type AuthUser } from '../auth/access';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';
import { parseStatement } from './statement-parser';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const queryBool = z.preprocess((v) => v === true || v === 'true' || v === '1', z.boolean());

@ApiTags('Tesorería')
@Controller('treasury')
export class TreasuryController {
  constructor(private readonly prisma: PrismaService) {}

  /** Cuentas de tesorería con su saldo (moneda original y USD) a una fecha. */
  @Get('accounts')
  @RequirePermission('ledger:read')
  async accounts(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional(), date: isoDate.optional(), includeInactive: queryBool.default(false) }), query);
    const companyIds = scopeCompanies(user, 'ledger:read', q.companyId);
    const accounts = await this.prisma.treasuryAccount.findMany({
      where: { companyId: { in: companyIds }, ...(q.includeInactive ? {} : { active: true }) },
      include: { company: { select: { code: true } }, glAccount: { select: { displayCode: true, revalRateType: true } } },
      orderBy: [{ company: { code: 'asc' } }, { glAccount: { sortOrder: 'asc' } }],
    });
    const date = q.date ? toDate(q.date) : new Date();
    const sums = await this.prisma.journalLine.groupBy({
      by: ['accountId'],
      where: { accountId: { in: accounts.map((a) => a.glAccountId) }, entryDate: { lte: date } },
      _sum: { amount: true, amountUsd: true },
    });
    const byGl = new Map(sums.map((s) => [s.accountId, s._sum]));
    const pending = await this.prisma.bankStatementLine.groupBy({
      by: ['treasuryAccountId'], where: { treasuryAccountId: { in: accounts.map((a) => a.id) }, status: 'UNMATCHED' }, _count: true,
    });
    const pendingBy = new Map(pending.map((p) => [p.treasuryAccountId, p._count]));
    return accounts.map((a) => ({
      ...a,
      balance: byGl.get(a.glAccountId)?.amount?.toFixed(4) ?? '0.0000',
      balanceUsd: byGl.get(a.glAccountId)?.amountUsd?.toFixed(4) ?? '0.0000',
      unmatchedStatementLines: pendingBy.get(a.id) ?? 0,
    }));
  }

  @Post('accounts')
  @RequirePermission('accounts:manage')
  async createAccount(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(treasuryAccountInputSchema, body);
    assertCan(user, 'accounts:manage', b.companyId);
    return withTx(this.prisma, { userId: user.id }, async (tx) => {
      let glAccountId = b.glAccountId;
      if (!glAccountId) {
        if (!b.groupCode || !b.subcode) {
          throw new BadRequestException({ code: 'VALIDATION', message: 'Indica una cuenta contable existente o el grupo (101, 109…) y la subcuenta' });
        }
        const group = await tx.account.findFirst({ where: { code: b.groupCode, subcode: null } });
        if (!group) throw new BadRequestException({ code: 'NO_PARENT', message: `No existe la cuenta de grupo ${b.groupCode}` });
        const subcode = b.subcode.padStart(4, '0');
        const acc = await tx.account.create({
          data: {
            parentId: group.id, code: b.groupCode, subcode, fullCode: `${b.groupCode}.${subcode}`, displayCode: `${b.groupCode}.${subcode}`,
            name: b.name, nature: 'DEUDORA', classification: 'AC', postable: true, currencyLock: b.currency,
            revalCurrency: b.currency, revalRateType: b.currency === 'USD' ? null : DEFAULT_RATE_TYPES[b.currency] ?? null, sortOrder: 100_000,
          },
        });
        if (group.postable) await tx.account.update({ where: { id: group.id }, data: { postable: false } });
        glAccountId = acc.id;
      }
      return tx.treasuryAccount.create({
        data: {
          companyId: b.companyId, glAccountId, kind: b.kind, name: b.name, currency: b.currency, bank: b.bank ?? null,
          ownerType: b.ownerType, ownerName: b.ownerName ?? null, country: b.country ?? null,
        },
      });
    });
  }

  // ─────────────── Movimientos ───────────────

  @Get('movements')
  @RequirePermission('ledger:read')
  async movements(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(
      paginationSchema.extend({
        companyId: z.string().uuid().optional(),
        treasuryAccountId: z.string().uuid().optional(),
        categoryId: z.string().uuid().optional(),
        needsReview: queryBool.optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        q: z.string().max(100).optional(),
      }),
      query,
    );
    const companyIds = scopeCompanies(user, 'ledger:read', q.companyId);
    const where: Prisma.TreasuryMovementWhereInput = {
      document: {
        companyId: { in: companyIds },
        ...(q.from || q.to ? { docDate: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}),
      },
      ...(q.treasuryAccountId ? { legs: { some: { treasuryAccountId: q.treasuryAccountId } } } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.needsReview !== undefined ? { needsReview: q.needsReview } : {}),
      ...(q.q ? { OR: [{ description: { contains: q.q, mode: 'insensitive' } }, { sourceReference: { contains: q.q, mode: 'insensitive' } }, { document: { number: { contains: q.q.toUpperCase() } } }] } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.treasuryMovement.count({ where }),
      this.prisma.treasuryMovement.findMany({
        where,
        include: {
          document: { include: { company: { select: { code: true } } } },
          category: { select: { id: true, code: true, name: true } },
          legs: { include: { treasuryAccount: { select: { id: true, name: true, currency: true } } } },
        },
        orderBy: [{ document: { docDate: 'desc' } }, { document: { number: 'desc' } }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items };
  }

  @Get('movements/:id')
  @RequirePermission('ledger:read')
  async movement(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const m = await this.prisma.treasuryMovement.findUnique({
      where: { id },
      include: {
        document: { include: { company: { select: { code: true, legalName: true } } } },
        category: true,
        legs: { include: { treasuryAccount: { include: { glAccount: { select: { displayCode: true } } } }, statementLine: true } },
      },
    });
    if (!m || !can(user, 'ledger:read', m.document.companyId)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Movimiento no encontrado' });
    const importRow = m.document.importRowId ? await this.prisma.importRow.findUnique({ where: { id: m.document.importRowId } }) : null;
    const entries = await this.prisma.journalEntry.findMany({ where: { documentId: id }, select: { id: true, number: true, kind: true, status: true }, orderBy: { createdAt: 'asc' } });
    return { ...m, entries, importRow };
  }

  @Post('movements')
  @RequirePermission('cash:operate')
  async createMovement(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(treasuryMovementInputSchema, body);
    assertCan(user, 'cash:operate', b.companyId);
    const r = await withTx(this.prisma, { userId: user.id, allowSoftClosed: can(user, 'ledger:post_soft_closed', b.companyId) }, (tx) =>
      postTreasuryMovement(tx, { ...b, createdBy: user.id }),
    );
    return this.movement(user, r.movement.id);
  }

  @Post('movements/:id/void')
  @RequirePermission('cash:operate')
  async voidMovement(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Movimiento no encontrado' });
    assertCan(user, 'cash:operate', doc.companyId);
    await withTx(this.prisma, { userId: user.id, allowSoftClosed: can(user, 'ledger:post_soft_closed', doc.companyId) }, (tx) =>
      voidTreasuryMovement(tx, id, { createdBy: user.id }),
    );
    return this.movement(user, id);
  }

  // ─────────────── Categorías y bandeja de revisión ───────────────

  @Get('categories')
  @RequirePermission('ledger:read')
  async categories() {
    const [cats, pending] = await Promise.all([
      this.prisma.cashCategory.findMany({ include: { account: { select: { id: true, displayCode: true, name: true } } }, orderBy: { name: 'asc' } }),
      this.prisma.treasuryMovement.groupBy({ by: ['categoryId'], where: { needsReview: true }, _count: true }),
    ]);
    const pendingBy = new Map(pending.map((p) => [p.categoryId, p._count]));
    return cats.map((c) => ({ ...c, pendingReview: pendingBy.get(c.id) ?? 0 }));
  }

  @Post('categories')
  @RequirePermission('accounts:manage')
  createCategory(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(categoryInputSchema, body);
    return withTx(this.prisma, { userId: user.id }, (tx) => tx.cashCategory.create({ data: { ...b, aliases: [b.name] } }));
  }

  @Patch('categories/:id')
  @RequirePermission('accounts:manage')
  updateCategory(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(categoryInputSchema.partial().omit({ code: true }), body);
    return withTx(this.prisma, { userId: user.id }, (tx) => tx.cashCategory.update({ where: { id }, data: b }));
  }

  /** Bandeja: movimientos pendientes de clasificar, agrupados por referencia original. */
  @Get('review/summary')
  @RequirePermission('ledger:read')
  async reviewSummary(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional() }), query);
    const companyIds = scopeCompanies(user, 'ledger:read', q.companyId);
    const rows = await this.prisma.$queryRaw<{ category_id: string | null; name: string | null; n: bigint; usd: Prisma.Decimal }[]>`
      SELECT tm.category_id, cc.name, count(*) AS n, coalesce(sum(abs(l.usd)), 0) AS usd
      FROM treasury_movement tm
      JOIN document d ON d.id = tm.id
      LEFT JOIN cash_category cc ON cc.id = tm.category_id
      LEFT JOIN LATERAL (SELECT sum(amount_usd) AS usd FROM treasury_leg WHERE movement_id = tm.id) l ON true
      WHERE tm.needs_review AND d.company_id = ANY(${companyIds}::uuid[]) AND d.status = 'POSTED'
      GROUP BY tm.category_id, cc.name ORDER BY count(*) DESC`;
    return rows.map((r) => ({ categoryId: r.category_id, name: r.name ?? '(sin referencia)', count: Number(r.n), usd: money(r.usd).toFixed(2) }));
  }

  @Post('review/:id/reclassify')
  @RequirePermission('bank:reconcile')
  async reclassify(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(reclassifyInputSchema, body);
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Movimiento no encontrado' });
    assertCan(user, 'bank:reconcile', doc.companyId);
    await withTx(this.prisma, { userId: user.id, allowSoftClosed: can(user, 'ledger:post_soft_closed', doc.companyId) }, (tx) =>
      reclassifyMovement(tx, id, { ...b, userId: user.id }),
    );
    return this.movement(user, id);
  }

  /** Reclasifica en bloque todos los pendientes de una categoría a la cuenta indicada (y la fija en la categoría). */
  @Post('review/bulk')
  @RequirePermission('bank:reconcile')
  async reclassifyBulk(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(z.object({ categoryId: z.string().uuid(), accountId: z.string().uuid(), setAsDefault: z.boolean().default(true) }), body);
    const companyIds = scopeCompanies(user, 'bank:reconcile');
    const pending = await this.prisma.treasuryMovement.findMany({
      where: { categoryId: b.categoryId, needsReview: true, document: { companyId: { in: companyIds }, status: 'POSTED' } },
      select: { id: true, document: { select: { companyId: true } } },
    });
    let done = 0;
    const byCompany = new Map<string, string[]>();
    for (const m of pending) byCompany.set(m.document.companyId, [...(byCompany.get(m.document.companyId) ?? []), m.id]);
    for (const [companyId, ids] of byCompany) {
      const allowSoftClosed = can(user, 'ledger:post_soft_closed', companyId);
      for (let i = 0; i < ids.length; i += 200) {
        await withTx(this.prisma, { userId: user.id, allowSoftClosed, timeoutMs: 300_000 }, async (tx) => {
          for (const id of ids.slice(i, i + 200)) {
            await reclassifyMovement(tx, id, { accountId: b.accountId, categoryId: b.categoryId, userId: user.id, note: 'Reclasificación en bloque' });
            done++;
          }
        });
      }
    }
    if (b.setAsDefault) {
      await withTx(this.prisma, { userId: user.id }, (tx) => tx.cashCategory.update({ where: { id: b.categoryId }, data: { accountId: b.accountId } }));
    }
    return { reclassified: done };
  }

  // ─────────────── Revaluación ───────────────

  @Get('revaluations')
  @RequirePermission('ledger:read')
  async revaluations(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({ year: z.coerce.number().int(), companyId: z.string().uuid().optional() }), query);
    const companyIds = scopeCompanies(user, 'ledger:read', q.companyId);
    return this.prisma.fxRevaluationRun.findMany({
      where: { companyId: { in: companyIds }, year: q.year, status: 'POSTED' },
      include: { lines: { where: { NOT: { diffUsd: 0 } } } },
      orderBy: [{ month: 'asc' }],
    });
  }

  @Post('revaluations')
  @RequirePermission('ledger:post')
  async revalue(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(revaluationInputSchema, body);
    const companyIds = b.companyId ? [b.companyId] : [...new Set([
      ...(await this.prisma.treasuryAccount.findMany({ distinct: ['companyId'], select: { companyId: true } })).map((t) => t.companyId),
      ...(await this.prisma.partyAccount.findMany({ distinct: ['companyId'], select: { companyId: true } })).map((t) => t.companyId),
    ])];
    const out = [];
    for (const companyId of companyIds) {
      if (!can(user, 'ledger:post', companyId)) continue;
      // Cierre de mes: revaluación, regularización de transitorias de tesorería y reclasificación por signo.
      const r = await withTx(this.prisma, { userId: user.id, allowSoftClosed: can(user, 'ledger:post_soft_closed', companyId), timeoutMs: 300_000 }, async (tx) => {
        const rv = await revalueMonth(tx, companyId, b.year, b.month, user.id);
        const tr = await closeFxTransits(tx, companyId, b.year, b.month, user.id);
        const rc = await reclassifyBySign(tx, companyId, b.year, b.month, user.id);
        return { rv, tr, rc };
      });
      out.push({
        companyId, runId: r.rv.run.id, entryId: r.rv.entry?.id ?? null, totalUsd: r.rv.totalUsd,
        transitsClosed: r.tr.result, reclassUsd: r.rc.movedUsd,
      });
    }
    return out;
  }

  // ─────────────── Extractos y conciliación bancaria ───────────────

  @Post('statements')
  @RequirePermission('bank:reconcile')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async uploadStatement(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('treasuryAccountId') treasuryAccountId: string,
  ) {
    if (!file) throw new BadRequestException({ code: 'NO_FILE', message: 'Adjunta el fichero del extracto' });
    const acc = await this.prisma.treasuryAccount.findUnique({ where: { id: parse(z.string().uuid(), treasuryAccountId) } });
    if (!acc) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Cuenta no encontrada' });
    assertCan(user, 'bank:reconcile', acc.companyId);
    const lines = await parseStatement(file.buffer, file.originalname);
    const hash = createHash('sha256').update(file.buffer).digest('hex');
    return withTx(this.prisma, { userId: user.id, timeoutMs: 120_000 }, async (tx) => {
      const r = await importStatement(tx, { treasuryAccountId: acc.id, fileName: file.originalname, fileHash: hash, lines, userId: user.id });
      const rec = await autoReconcile(tx, acc.id);
      return { statementId: r.statement.id, lines: lines.length, inserted: r.inserted, duplicates: r.duplicates, matched: rec.matched, pending: rec.pending };
    });
  }

  @Get('statements/lines')
  @RequirePermission('bank:reconcile')
  async statementLines(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(paginationSchema.extend({ treasuryAccountId: z.string().uuid(), status: z.enum(['UNMATCHED', 'MATCHED', 'IGNORED']).optional() }), query);
    const acc = await this.prisma.treasuryAccount.findUniqueOrThrow({ where: { id: q.treasuryAccountId } });
    assertCan(user, 'bank:reconcile', acc.companyId);
    const where = { treasuryAccountId: acc.id, ...(q.status ? { status: q.status } : {}) };
    const [total, items] = await Promise.all([
      this.prisma.bankStatementLine.count({ where }),
      this.prisma.bankStatementLine.findMany({
        where,
        include: { leg: { include: { movement: { include: { document: { select: { number: true } } } } } } },
        orderBy: { valueDate: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    // Sugerencias para las pendientes: mismos importes a ±10 días, sin conciliar.
    const suggestions: Record<string, { legId: string; date: string; number: string; description: string }[]> = {};
    for (const l of items.filter((i) => i.status === 'UNMATCHED')) {
      const legs = await this.prisma.treasuryLeg.findMany({
        where: {
          treasuryAccountId: acc.id, amount: l.amount, statementLine: null, movement: { document: { status: 'POSTED' } },
          valueDate: { gte: new Date(l.valueDate.getTime() - 10 * 86_400_000), lte: new Date(l.valueDate.getTime() + 10 * 86_400_000) },
        },
        include: { movement: { include: { document: { select: { number: true } } } } },
        take: 5,
      });
      suggestions[l.id] = legs.map((g) => ({ legId: g.id, date: g.valueDate.toISOString().slice(0, 10), number: g.movement.document.number, description: g.movement.description }));
    }
    return { total, page: q.page, pageSize: q.pageSize, items, suggestions };
  }

  @Post('statements/reconcile')
  @RequirePermission('bank:reconcile')
  async reconcile(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(z.object({ treasuryAccountId: z.string().uuid(), days: z.number().int().min(0).max(15).default(3) }), body);
    const acc = await this.prisma.treasuryAccount.findUniqueOrThrow({ where: { id: b.treasuryAccountId } });
    assertCan(user, 'bank:reconcile', acc.companyId);
    return withTx(this.prisma, { userId: user.id, timeoutMs: 120_000 }, (tx) => autoReconcile(tx, acc.id, b.days));
  }

  @Post('statements/lines/:id')
  @RequirePermission('bank:reconcile')
  async lineAction(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('match'), legId: z.string().uuid() }),
        z.object({ action: z.literal('unmatch') }),
        z.object({ action: z.literal('ignore') }),
        z.object({ action: z.literal('create'), categoryId: z.string().uuid().nullable().optional(), description: z.string().max(480).optional() }),
      ]),
      body,
    );
    const line = await this.prisma.bankStatementLine.findUnique({ where: { id }, include: { statement: { include: { treasuryAccount: true } } } });
    if (!line) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Línea no encontrada' });
    const acc = line.statement.treasuryAccount;
    assertCan(user, 'bank:reconcile', acc.companyId);
    return withTx(this.prisma, { userId: user.id, allowSoftClosed: can(user, 'ledger:post_soft_closed', acc.companyId) }, async (tx) => {
      if (b.action === 'match') return matchStatementLine(tx, id, b.legId);
      if (b.action === 'unmatch') return setStatementLineStatus(tx, id, 'UNMATCHED');
      if (b.action === 'ignore') return setStatementLineStatus(tx, id, 'IGNORED');
      // Crear el movimiento desde la línea del extracto y conciliarlo.
      const r = await postTreasuryMovement(tx, {
        companyId: acc.companyId, date: line.valueDate.toISOString().slice(0, 10), kind: 'MOVEMENT',
        description: b.description || line.description || 'Movimiento de extracto', categoryId: b.categoryId ?? null,
        legs: [{ treasuryAccountId: acc.id, amount: line.amount.toString() }], createdBy: user.id,
      });
      const leg = await tx.treasuryLeg.findFirstOrThrow({ where: { movementId: r.movement.id } });
      return matchStatementLine(tx, id, leg.id);
    });
  }
}
