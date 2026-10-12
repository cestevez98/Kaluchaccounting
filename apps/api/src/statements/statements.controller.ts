import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { computeStatement, dashboardData, statementAlerts, type StatementResult } from '@kaluch/db';
import { FormulaError, formulaOrder, reportTemplateInputSchema, statementQuerySchema } from '@kaluch/shared';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { z } from 'zod';
import { assertCan, scopeCompanies, type AuthUser } from '../auth/access';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';

const periodSchema = z.object({
  companyId: z.string().uuid().optional(),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

@ApiTags('Estados financieros')
@Controller()
export class StatementsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Empresas del informe: la pedida o, en consolidado, las que consolidan y el usuario puede ver. */
  private async companies(user: AuthUser, companyId?: string) {
    const ids = scopeCompanies(user, 'reports:financial', companyId);
    if (companyId) return ids;
    const consolidating = await this.prisma.company.findMany({ where: { id: { in: ids }, consolidates: true }, select: { id: true } });
    return consolidating.map((c) => c.id);
  }

  private async segmentIds(code?: string) {
    if (!code) return undefined;
    const all = await this.prisma.segment.findMany();
    const root = all.find((s) => s.code === code || s.id === code);
    if (!root) throw new BadRequestException({ code: 'VALIDATION', message: `No existe el segmento ${code}` });
    const out = [root.id];
    for (let i = 0; i < out.length; i++) all.filter((s) => s.parentId === out[i]).forEach((s) => out.push(s.id));
    return out;
  }

  // ───────────── Plantillas ─────────────

  @Get('statements/templates')
  @RequirePermission('reports:financial')
  async templates() {
    const rows = await this.prisma.reportTemplate.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], include: { _count: { select: { lines: true, references: true } } } });
    return rows.map((t) => ({
      id: t.id, code: t.code, name: t.name, kind: t.kind, origin: t.origin, sheetName: t.sheetName, active: t.active, notes: t.notes,
      checkCoverage: t.checkCoverage, lines: t._count.lines, references: t._count.references, updatedAt: t.updatedAt,
    }));
  }

  @Get('statements/templates/:code')
  @RequirePermission('reports:financial')
  async template(@Param('code') code: string) {
    const t = await this.prisma.reportTemplate.findUnique({ where: { code }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Plantilla no encontrada' });
    return {
      id: t.id, code: t.code, name: t.name, kind: t.kind, origin: t.origin, notes: t.notes, active: t.active, checkCoverage: t.checkCoverage,
      lines: t.lines.map((l) => ({
        key: l.key, label: l.label, source: l.source, accounts: l.accounts, categories: l.categories, cashFlow: l.cashFlow,
        formula: l.formula, negate: l.negate, indent: l.indent, bold: l.bold, option: l.option, excelRow: l.excelRow,
      })),
    };
  }

  /** Crea o sustituye una plantilla (diseñador de estados). */
  @Put('statements/templates/:code')
  @RequirePermission('reports:design')
  async saveTemplate(@CurrentUser() user: AuthUser, @Param('code') code: string, @Body() body: unknown) {
    assertCan(user, 'reports:design');
    const b = parse(reportTemplateInputSchema.extend({ active: z.boolean().default(true), checkCoverage: z.boolean().default(false) }), body);
    if (b.code !== code) throw new BadRequestException({ code: 'VALIDATION', message: 'El código no coincide con la URL' });
    const keys = b.lines.map((l) => l.key);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) throw new BadRequestException({ code: 'VALIDATION', message: `La clave [${dup}] está repetida` });
    try {
      formulaOrder(b.lines);
    } catch (e) {
      if (e instanceof FormulaError) throw new BadRequestException({ code: 'VALIDATION', message: e.message });
      throw e;
    }
    const existing = await this.prisma.reportTemplate.findUnique({ where: { code } });
    const origin = existing ? (existing.origin === 'EXCEL' ? 'EXCEL_MODIFICADA' : existing.origin) : 'SISTEMA';
    const t = await this.prisma.$transaction(async (tx) => {
      const data = { name: b.name, kind: b.kind, notes: b.notes, active: b.active, checkCoverage: b.checkCoverage, origin };
      const tpl = existing
        ? await tx.reportTemplate.update({ where: { id: existing.id }, data })
        : await tx.reportTemplate.create({ data: { ...data, code, sortOrder: 100 } });
      await tx.reportLine.deleteMany({ where: { templateId: tpl.id } });
      await tx.reportLine.createMany({
        data: b.lines.map((l, i) => ({
          templateId: tpl.id, sortOrder: (i + 1) * 10, key: l.key, label: l.label, source: l.source, accounts: l.accounts, categories: l.categories,
          cashFlow: l.cashFlow ?? null, formula: l.formula?.trim() || null, negate: l.negate, indent: l.indent, bold: l.bold, option: l.option ?? null,
          excelRow: /^F\d+$/.test(l.key) ? Number(l.key.slice(1)) : null,
        })),
      });
      return tpl;
    });
    return { id: t.id, code: t.code, origin: t.origin, lines: b.lines.length };
  }

  // ───────────── Estados ─────────────

  private async run(user: AuthUser, code: string, query: unknown): Promise<StatementResult> {
    const q = parse(statementQuerySchema, query);
    const companyIds = await this.companies(user, q.companyId);
    if (!(await this.prisma.reportTemplate.findUnique({ where: { code } }))) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `No existe el estado ${code}` });
    }
    return computeStatement(this.prisma, {
      templateCode: code, companyIds, year: q.year, fromMonth: q.fromMonth, toMonth: q.toMonth, view: q.view,
      segmentIds: await this.segmentIds(q.segment), eliminate: q.eliminate,
    });
  }

  @Get('statements/alerts')
  @RequirePermission('reports:financial')
  async alerts(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(periodSchema, query);
    return statementAlerts(this.prisma, { companyIds: await this.companies(user, q.companyId), year: q.year, month: q.month });
  }

  @Get('statements/:code')
  @RequirePermission('reports:financial')
  async statement(@CurrentUser() user: AuthUser, @Param('code') code: string, @Query() query: unknown) {
    return this.run(user, code, query);
  }

  @Get('statements/:code/xlsx')
  @RequirePermission('reports:financial')
  async statementXlsx(@CurrentUser() user: AuthUser, @Param('code') code: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(statementQuerySchema, query);
    const r = await this.run(user, code, query);
    const companies = await this.prisma.company.findMany({ where: { id: { in: await this.companies(user, q.companyId) } }, orderBy: { code: 'asc' } });
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Kaluch ERP';
    const ws = wb.addWorksheet(r.template.code.slice(0, 31));
    ws.addRow([r.template.name]).font = { bold: true, size: 14 };
    ws.addRow([
      `${companies.length === 1 ? `${companies[0]!.code} · ${companies[0]!.legalName}` : `Consolidado: ${companies.map((c) => c.code).join(', ')}`}`
      + ` · Vista ${q.view === 'REAL' ? 'Real' : 'Fiscal/Presentado'}${q.segment ? ` · Segmento ${q.segment}` : ''} · Importes en USD`,
    ]);
    ws.addRow([]);
    const withExcel = r.lines.some((l) => l.excel);
    const head = ws.addRow(['', ...r.columns.map((c) => c.label), ...(withExcel ? r.columns.filter((c) => c.month).map((c) => `Excel ${c.label}`) : [])]);
    head.font = { bold: true };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    for (const l of r.lines) {
      const row = ws.addRow([
        `${'   '.repeat(l.indent)}${l.label}`,
        ...l.values.map((v) => (l.source === 'NONE' && !l.label ? null : Number(v))),
        ...(withExcel ? r.columns.filter((c) => c.month).map((_, i) => (l.excel?.[i] ? Number(l.excel[i]) : null)) : []),
      ]);
      if (l.bold) row.font = { bold: true };
    }
    if (r.warnings.length || r.template.notes) {
      ws.addRow([]);
      for (const n of [...r.warnings, ...r.template.notes.split('\n').filter(Boolean)]) ws.addRow([n]).font = { italic: true, color: { argb: 'FF6B7280' } };
    }
    ws.columns.forEach((c, i) => {
      c.width = i === 0 ? 55 : 16;
      if (i > 0) c.numFmt = '#,##0.00;[Red]-#,##0.00';
    });
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 4 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${r.template.code}-${q.year}-${String(q.fromMonth).padStart(2, '0')}-${String(q.toMonth).padStart(2, '0')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }

  // ───────────── Panel de dirección ─────────────

  @Get('dashboard')
  @RequirePermission('reports:financial')
  async dashboard(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(periodSchema, query);
    return dashboardData(this.prisma, { companyIds: await this.companies(user, q.companyId), year: q.year, month: q.month });
  }
}
