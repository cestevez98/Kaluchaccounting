import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { compareControls, compareWithBc, generalLedger, toDate, trialBalance } from '@kaluch/db';
import { BOOK_VIEWS, MONTH_NAMES, paginationSchema, trialBalanceQuerySchema } from '@kaluch/shared';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { z } from 'zod';
import { scopeCompanies, type AuthUser } from '../auth/access';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';

@ApiTags('Reportes')
@Controller('reports')
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  private async runTrialBalance(user: AuthUser, query: unknown) {
    const q = parse(trialBalanceQuerySchema, query);
    const companyIds = scopeCompanies(user, 'reports:financial', q.companyId);
    const segmentIds = q.segmentId ? await this.segmentSubtree(q.segmentId) : undefined;
    const tb = await trialBalance(this.prisma, {
      companyIds, year: q.year, month: q.month, books: [...BOOK_VIEWS[q.view]], segmentIds, includeZero: q.includeZero,
    });
    return { q, companyIds, tb };
  }

  private async segmentSubtree(id: string): Promise<string[]> {
    const all = await this.prisma.segment.findMany();
    const out = [id];
    for (let i = 0; i < out.length; i++) all.filter((s) => s.parentId === out[i]).forEach((s) => out.push(s.id));
    return out;
  }

  /** Balance de comprobación mensual (consolidado si no se indica empresa). */
  @Get('trial-balance')
  @RequirePermission('reports:financial')
  async trialBalance(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const { tb, companyIds } = await this.runTrialBalance(user, query);
    return { ...tb, companyIds };
  }

  @Get('trial-balance.xlsx')
  @RequirePermission('reports:financial')
  async trialBalanceXlsx(@CurrentUser() user: AuthUser, @Query() query: unknown, @Res() res: Response) {
    const { q, companyIds, tb } = await this.runTrialBalance(user, query);
    const companies = await this.prisma.company.findMany({ where: { id: { in: companyIds } }, orderBy: { code: 'asc' } });
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Kaluch ERP';
    const ws = wb.addWorksheet('BC');
    ws.addRow([`Balance de comprobación — ${MONTH_NAMES[q.month - 1]} ${q.year}`]).font = { bold: true, size: 14 };
    ws.addRow([`Empresas: ${companies.map((c) => c.code).join(', ')} · Vista: ${q.view === 'REAL' ? 'Real' : 'Fiscal/Presentado'} · Importes en USD`]);
    ws.addRow([]);
    const header = ws.addRow(['Cuenta', 'Descripción', 'Naturaleza', 'Clasificación', 'Saldo inicial', 'Debe', 'Haber', 'Saldo final', 'Valor BC']);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    for (const r of tb.rows) {
      const row = ws.addRow([
        r.displayCode, `${'  '.repeat(r.level)}${r.name}`, r.nature, r.classification,
        Number(r.opening), Number(r.debit), Number(r.credit), Number(r.closing), Number(r.bcValue),
      ]);
      if (!r.postable) row.font = { bold: true };
    }
    const total = ws.addRow(['', 'Totales', '', '', Number(tb.totals.opening), Number(tb.totals.debit), Number(tb.totals.credit), Number(tb.totals.closing)]);
    total.font = { bold: true };
    ws.addRow([]);
    ws.addRow(['', 'Activo', '', '', '', '', '', Number(tb.summary.assets)]);
    ws.addRow(['', 'Pasivo', '', '', '', '', '', Number(tb.summary.liabilities)]);
    ws.addRow(['', 'Patrimonio', '', '', '', '', '', Number(tb.summary.equity)]);
    ws.addRow(['', 'Resultado (ingresos − gastos)', '', '', '', '', '', Number(tb.summary.income) - Number(tb.summary.expenses)]);
    ws.addRow(['', 'Diferencia A − (P + PN + R)', '', '', '', '', '', Number(tb.summary.difference)]).font = { bold: true };
    ws.columns.forEach((c, i) => {
      c.width = i === 1 ? 55 : i < 4 ? 14 : 18;
      if (i >= 4) c.numFmt = '#,##0.00;[Red]-#,##0.00';
    });
    ws.views = [{ state: 'frozen', ySplit: 4 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="BC-${q.year}-${String(q.month).padStart(2, '0')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }

  /** Mayor de una cuenta (con subcuentas) entre dos fechas, paginado. */
  @Get('general-ledger')
  @RequirePermission('ledger:read')
  async generalLedger(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(
      paginationSchema.extend({
        accountId: z.string().uuid(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        companyId: z.string().uuid().optional(),
        view: z.enum(['REAL', 'FISCAL']).default('REAL'),
      }),
      query,
    );
    const companyIds = scopeCompanies(user, 'ledger:read', q.companyId);
    return generalLedger(this.prisma, {
      companyIds, accountId: q.accountId, from: toDate(q.from), to: toDate(q.to),
      books: [...BOOK_VIEWS[q.view]], page: q.page, pageSize: q.pageSize,
    });
  }

  /** Conciliación con el BC del Excel (consolidado, vista Real) para un mes. */
  @Get('bc-compare')
  @RequirePermission('reports:financial')
  async bcCompare(@Query() query: unknown) {
    const q = parse(
      z.object({
        year: z.coerce.number().int(),
        month: z.coerce.number().int().min(1).max(12),
        codes: z.string().optional(),
      }),
      query,
    );
    return compareWithBc(this.prisma, { year: q.year, month: q.month, codePrefixes: q.codes ? q.codes.split(',').map((c) => c.trim()).filter(Boolean) : undefined });
  }

  /** Totales de control del BC (ING/GAS/UT 777/888/999) del sistema frente al Excel. */
  @Get('bc-compare/controls')
  @RequirePermission('reports:financial')
  async bcControls(@Query() query: unknown) {
    const q = parse(z.object({ year: z.coerce.number().int(), month: z.coerce.number().int().min(1).max(12) }), query);
    return (await compareControls(this.prisma, { year: q.year, month: q.month })).filter((c) => /^(ING|GAS|UT) \d{3}$/.test(c.name));
  }
}
