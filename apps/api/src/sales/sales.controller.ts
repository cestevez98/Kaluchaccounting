import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  closeExportInvoice, commissionsBySeller, containerUtility, exportMargin, issueExportInvoice, lotBalance, postContainerCost, postSalesInvoice,
  productKardex, receiveContainer, toDate, withTx, type Prisma,
} from '@kaluch/db';
import {
  containerCostInputSchema, containerInputSchema, containerInvestorInputSchema, containerReceiptInputSchema, exportCloseInputSchema,
  exportInvoiceInputSchema, money, paginationSchema, productInputSchema, salesInvoiceInputSchema,
} from '@kaluch/shared';
import { z } from 'zod';
import { assertCan, scopeCompanies, type AuthUser } from '../auth/access';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const d = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : null);
const usd = (v: unknown) => money(String(v ?? 0)).toFixed(4);

@ApiTags('Ventas e inventario')
@Controller('sales')
export class SalesController {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────── Facturas de exportación ─────────────

  @Get('export-invoices')
  @RequirePermission('sales:read')
  async exportInvoices(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(paginationSchema.extend({
      companyId: z.string().uuid().optional(), status: z.enum(['PENDING', 'CLOSED']).optional(), q: z.string().max(100).optional(),
    }), query);
    const where: Prisma.ExportInvoiceWhereInput = {
      companyId: { in: scopeCompanies(user, 'sales:read', q.companyId) },
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ number: { contains: q.q, mode: 'insensitive' } }, { partyAccount: { party: { name: { contains: q.q, mode: 'insensitive' } } } }] } : {}),
    };
    const [total, rows, pending] = await Promise.all([
      this.prisma.exportInvoice.count({ where }),
      this.prisma.exportInvoice.findMany({
        where, orderBy: [{ invoiceDate: 'desc' }, { number: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { company: true, partyAccount: { include: { party: true } }, sellerPartyAccount: { include: { party: true } } },
      }),
      this.prisma.exportInvoice.aggregate({ where: { ...where, status: 'PENDING' }, _sum: { amountUsd: true }, _count: true }),
    ]);
    return {
      total, page: q.page, pageSize: q.pageSize,
      pending: { count: pending._count, amountUsd: usd(pending._sum.amountUsd) },
      items: rows.map((r) => this.exportView(r)),
    };
  }

  @Get('export-invoices/:id')
  @RequirePermission('sales:read')
  async exportInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.prisma.exportInvoice.findUnique({
      where: { id },
      include: {
        company: true, partyAccount: { include: { party: true } }, sellerPartyAccount: { include: { party: true } },
        issueDocument: true, closeDocument: true,
      },
    });
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Factura no encontrada' });
    assertCan(user, 'sales:read', r.companyId);
    const docIds = [r.issueDocumentId, ...(r.closeDocumentId ? [r.closeDocumentId] : [])];
    const lines = await this.prisma.journalLine.findMany({
      where: { entry: { documentId: { in: docIds } } }, include: { account: true, entry: true }, orderBy: [{ entryDate: 'asc' }, { lineNo: 'asc' }],
    });
    return {
      ...this.exportView(r),
      issueDocument: r.issueDocument.number, closeDocument: r.closeDocument?.number ?? null,
      lines: lines.map((l) => ({ date: d(l.entryDate), entry: l.entry.number, account: l.account.fullCode, accountName: l.account.name, amountUsd: usd(l.amountUsd), memo: l.memo })),
    };
  }

  @Post('export-invoices')
  @RequirePermission('sales:operate')
  async issueExport(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(exportInvoiceInputSchema, body);
    const pa = await this.prisma.partyAccount.findUnique({ where: { id: b.partyAccountId } });
    if (!pa) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Cuenta corriente del cliente no encontrada' });
    assertCan(user, 'sales:operate', pa.companyId);
    const r = await withTx(this.prisma, { userId: user.id }, (tx) => issueExportInvoice(tx, { ...b, createdBy: user.id }));
    return { id: r.invoice.id, document: r.document.number };
  }

  @Post('export-invoices/:id/close')
  @RequirePermission('sales:operate')
  async closeExport(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(exportCloseInputSchema, body);
    const inv = await this.prisma.exportInvoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Factura no encontrada' });
    assertCan(user, 'sales:operate', inv.companyId);
    const r = await withTx(this.prisma, { userId: user.id }, (tx) => closeExportInvoice(tx, { id, closeDate: b.closeDate, createdBy: user.id }));
    return { id, status: r.invoice.status, document: r.document.number };
  }

  private exportView(r: Prisma.ExportInvoiceGetPayload<{ include: { company: true; partyAccount: { include: { party: true } }; sellerPartyAccount: { include: { party: true } } } }>) {
    return {
      id: r.id, companyId: r.companyId, companyCode: r.company.code, number: r.number, invoiceDate: d(r.invoiceDate), closeDate: d(r.closeDate),
      service: r.service, internal: r.internal, description: r.description, status: r.status,
      partyId: r.partyAccount.partyId, partyName: r.partyAccount.party.name, partyAccountId: r.partyAccountId,
      sellerName: r.sellerPartyAccount?.party.name ?? null,
      amountUsd: usd(r.amountUsd), factoryUsd: usd(r.factoryUsd), logisticsUsd: usd(r.logisticsUsd), otherUsd: usd(r.otherUsd),
      estimatedUsd: usd(r.estimatedUsd), commissionUsd: usd(r.commissionUsd), marginUsd: exportMargin(r).toFixed(4),
    };
  }

  // ───────────── Productos, contenedores e inventario ─────────────

  @Get('products')
  @RequirePermission('sales:read')
  async products() {
    const products = await this.prisma.product.findMany({ orderBy: { name: 'asc' } });
    const stock = await this.prisma.inventoryMovement.groupBy({ by: ['productId'], where: { location: 'WAREHOUSE' }, _sum: { quantity: true, amountUsd: true } });
    return products.map((p) => {
      const s = stock.find((x) => x.productId === p.id);
      return { ...p, stockQuantity: usd(s?._sum.quantity), stockUsd: usd(s?._sum.amountUsd) };
    });
  }

  @Post('products')
  @RequirePermission('inventory:operate')
  async createProduct(@Body() body: unknown) {
    const b = parse(productInputSchema, body);
    if (await this.prisma.product.findUnique({ where: { code: b.code } })) {
      throw new BadRequestException({ code: 'VALIDATION', message: `Ya existe el producto ${b.code}` });
    }
    return this.prisma.product.create({ data: b });
  }

  @Get('products/:id/kardex')
  @RequirePermission('sales:read')
  async kardex(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    const q = parse(z.object({ containerId: z.string().uuid().optional() }), query);
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Producto no encontrado' });
    const companies = scopeCompanies(user, 'sales:read');
    const rows = await productKardex(this.prisma, { productId: id, containerId: q.containerId ?? null });
    const visible = new Set((await this.prisma.container.findMany({ where: { companyId: { in: companies } }, select: { code: true } })).map((c) => c.code));
    return { product, rows: rows.filter((r) => visible.has(r.container)) };
  }

  /** Existencias por lote (contenedor × producto) en almacén: para facturar. */
  @Get('stock')
  @RequirePermission('sales:read')
  async stock(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional() }), query);
    const companies = scopeCompanies(user, 'sales:read', q.companyId);
    const groups = await this.prisma.inventoryMovement.groupBy({
      by: ['containerId', 'productId'], where: { location: 'WAREHOUSE', companyId: { in: companies }, productId: { not: null } }, _sum: { quantity: true, amountUsd: true },
    });
    const containers = new Map((await this.prisma.container.findMany({ where: { id: { in: groups.map((g) => g.containerId) } } })).map((c) => [c.id, c]));
    const products = new Map((await this.prisma.product.findMany({ where: { id: { in: groups.map((g) => g.productId!) } } })).map((p) => [p.id, p]));
    return groups
      .filter((g) => money(String(g._sum.quantity ?? 0)).gt(0))
      .map((g) => {
        const qty = money(String(g._sum.quantity ?? 0));
        const value = money(String(g._sum.amountUsd ?? 0));
        const c = containers.get(g.containerId)!;
        const p = products.get(g.productId!)!;
        return {
          containerId: c.id, containerCode: c.code, companyId: c.companyId, productId: p.id, productCode: p.code, productName: p.name, unit: p.unit,
          quantity: qty.toFixed(4), valueUsd: value.toFixed(4), unitCostUsd: value.div(qty).toFixed(4),
        };
      })
      .sort((a, b) => a.productName.localeCompare(b.productName) || a.containerCode.localeCompare(b.containerCode));
  }

  @Get('containers')
  @RequirePermission('sales:read')
  async containers(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional() }), query);
    const companies = scopeCompanies(user, 'sales:read', q.companyId);
    const all = [];
    for (const companyId of companies) all.push(...(await containerUtility(this.prisma, { companyId })));
    return all.sort((a, b) => a.code.localeCompare(b.code));
  }

  @Get('containers/:id')
  @RequirePermission('sales:read')
  async container(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.prisma.container.findUnique({ where: { id }, include: { company: true } });
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Contenedor no encontrado' });
    assertCan(user, 'sales:read', c.companyId);
    const [utility] = await containerUtility(this.prisma, { containerId: id });
    const movements = await this.prisma.inventoryMovement.findMany({
      where: { containerId: id }, include: { product: true, document: true }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
    const lots = await this.prisma.inventoryMovement.groupBy({ by: ['productId'], where: { containerId: id, location: 'WAREHOUSE', productId: { not: null } }, _sum: { quantity: true, amountUsd: true } });
    const transit = await lotBalance(this.prisma, { containerId: id, productId: null, location: 'TRANSIT' });
    const products = new Map((await this.prisma.product.findMany()).map((p) => [p.id, p]));
    return {
      ...utility, companyId: c.companyId, companyCode: c.company.code, transitUsd: transit.amountUsd.toFixed(4),
      lots: lots.map((l) => ({ productId: l.productId, productName: products.get(l.productId!)?.name ?? '', quantity: usd(l._sum.quantity), valueUsd: usd(l._sum.amountUsd) })),
      movements: movements.map((m) => ({
        id: m.id, date: d(m.date), kind: m.kind, location: m.location, product: m.product?.name ?? null, quantity: usd(m.quantity), amountUsd: usd(m.amountUsd),
        description: m.description, document: m.document.number,
      })),
    };
  }

  @Post('containers')
  @RequirePermission('inventory:operate')
  async createContainer(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(containerInputSchema, body);
    assertCan(user, 'inventory:operate', b.companyId);
    if (await this.prisma.container.findUnique({ where: { companyId_code: { companyId: b.companyId, code: b.code } } })) {
      throw new BadRequestException({ code: 'VALIDATION', message: `Ya existe el contenedor ${b.code}` });
    }
    return this.prisma.container.create({ data: b });
  }

  @Post('containers/:id/costs')
  @RequirePermission('inventory:operate')
  async containerCost(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(containerCostInputSchema, body);
    await this.assertContainer(user, id, 'inventory:operate');
    const r = await withTx(this.prisma, { userId: user.id }, (tx) => postContainerCost(tx, { ...b, containerId: id, createdBy: user.id }));
    return { document: r.document.number };
  }

  @Post('containers/:id/receipt')
  @RequirePermission('inventory:operate')
  async receipt(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(containerReceiptInputSchema, body);
    await this.assertContainer(user, id, 'inventory:operate');
    const r = await withTx(this.prisma, { userId: user.id }, (tx) => receiveContainer(tx, { ...b, containerId: id, createdBy: user.id }));
    return { document: r.document.number, status: r.container.status };
  }

  @Post('containers/:id/investors')
  @RequirePermission('sales:operate')
  async investor(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(containerInvestorInputSchema, body);
    const c = await this.assertContainer(user, id, 'sales:operate');
    const pa = await this.prisma.partyAccount.findUnique({ where: { id: b.partyAccountId } });
    if (!pa || pa.companyId !== c.companyId) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Cuenta corriente del inversionista no encontrada en la empresa del contenedor' });
    const others = await this.prisma.containerInvestor.aggregate({ where: { containerId: id, partyAccountId: { not: b.partyAccountId } }, _sum: { profitPct: true } });
    if (money(String(others._sum.profitPct ?? 0)).plus(money(b.profitPct)).gt(100)) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'La suma de los % de utilidad de los inversionistas supera el 100 %' });
    }
    return this.prisma.containerInvestor.upsert({
      where: { containerId_partyAccountId: { containerId: id, partyAccountId: b.partyAccountId } },
      update: { investedUsd: b.investedUsd, profitPct: b.profitPct },
      create: { containerId: id, partyAccountId: b.partyAccountId, investedUsd: b.investedUsd, profitPct: b.profitPct },
    });
  }

  private async assertContainer(user: AuthUser, id: string, perm: 'inventory:operate' | 'sales:operate') {
    const c = await this.prisma.container.findUnique({ where: { id } });
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Contenedor no encontrado' });
    assertCan(user, perm, c.companyId);
    return c;
  }

  // ───────────── Facturas de distribución y comisiones ─────────────

  @Get('invoices')
  @RequirePermission('sales:read')
  async invoices(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(paginationSchema.extend({ companyId: z.string().uuid().optional(), from: isoDate.optional(), to: isoDate.optional() }), query);
    const where: Prisma.SalesInvoiceWhereInput = {
      document: {
        companyId: { in: scopeCompanies(user, 'sales:read', q.companyId) },
        ...(q.from || q.to ? { docDate: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}),
      },
    };
    const [total, rows, sums] = await Promise.all([
      this.prisma.salesInvoice.count({ where }),
      this.prisma.salesInvoice.findMany({
        where, orderBy: { document: { docDate: 'desc' } }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { document: { include: { company: true } }, partyAccount: { include: { party: true } }, _count: { select: { lines: true } } },
      }),
      this.prisma.salesInvoice.aggregate({ where, _sum: { totalUsd: true, costUsd: true, commissionUsd: true, onatUsd: true } }),
    ]);
    return {
      total, page: q.page, pageSize: q.pageSize,
      totals: { totalUsd: usd(sums._sum.totalUsd), costUsd: usd(sums._sum.costUsd), commissionUsd: usd(sums._sum.commissionUsd), onatUsd: usd(sums._sum.onatUsd) },
      items: rows.map((r) => ({
        id: r.id, number: r.document.number, date: d(r.document.docDate), companyCode: r.document.company.code, description: r.document.memo,
        customer: r.partyAccount?.party.name ?? null, partyId: r.partyAccount?.partyId ?? null, lines: r._count.lines,
        totalUsd: usd(r.totalUsd), costUsd: usd(r.costUsd), commissionUsd: usd(r.commissionUsd), onatUsd: usd(r.onatUsd),
        marginUsd: money(String(r.totalUsd)).minus(money(String(r.costUsd))).minus(money(String(r.commissionUsd))).minus(money(String(r.onatUsd))).toFixed(4),
        status: r.status,
      })),
    };
  }

  @Get('invoices/:id')
  @RequirePermission('sales:read')
  async invoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.prisma.salesInvoice.findUnique({
      where: { id },
      include: {
        document: { include: { company: true } }, partyAccount: { include: { party: true } },
        lines: { include: { product: true, container: true, sellerPartyAccount: { include: { party: true } } } },
      },
    });
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Factura no encontrada' });
    assertCan(user, 'sales:read', r.document.companyId);
    return {
      id: r.id, number: r.document.number, date: d(r.document.docDate), companyCode: r.document.company.code, description: r.document.memo,
      customer: r.partyAccount?.party.name ?? null, partyId: r.partyAccount?.partyId ?? null, onatRate: money(String(r.onatRate)).toFixed(4),
      totalUsd: usd(r.totalUsd), costUsd: usd(r.costUsd), commissionUsd: usd(r.commissionUsd), onatUsd: usd(r.onatUsd),
      lines: r.lines.map((l) => ({
        id: l.id, product: l.product.name, unit: l.product.unit, container: l.container.code, containerId: l.containerId, quantity: usd(l.quantity),
        unitPriceUsd: usd(l.unitPriceUsd), amountUsd: usd(l.amountUsd), costUsd: usd(l.costUsd), commissionUsd: usd(l.commissionUsd), onatUsd: usd(l.onatUsd),
        seller: l.sellerPartyAccount?.party.name ?? null,
      })),
    };
  }

  @Post('invoices')
  @RequirePermission('sales:operate')
  async postInvoice(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(salesInvoiceInputSchema, body);
    assertCan(user, 'sales:operate', b.companyId);
    const r = await withTx(this.prisma, { userId: user.id }, (tx) => postSalesInvoice(tx, { ...b, createdBy: user.id }));
    return { id: r.invoice.id, document: r.document.number, totalUsd: usd(r.invoice.totalUsd) };
  }

  @Get('commissions')
  @RequirePermission('sales:read')
  async commissions(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional(), from: isoDate, to: isoDate }), query);
    const out = [];
    for (const companyId of scopeCompanies(user, 'sales:read', q.companyId)) {
      out.push(...(await commissionsBySeller(this.prisma, { from: q.from, to: q.to, companyId })));
    }
    return out;
  }
}
