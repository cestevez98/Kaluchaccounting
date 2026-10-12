import type { PrismaClient } from '@prisma/client';
import type { ReportLineInput } from '@kaluch/shared';
import type { Tx } from '../client';

type Db = PrismaClient | Tx;

/** Origen de las plantillas generadas desde el plan de cuentas: la importación del Excel las sustituye. */
export const DEFAULT_TEMPLATE_ORIGIN = 'PREDETERMINADA';

const line = (key: string, label: string, extra: Partial<ReportLineInput> = {}): ReportLineInput => ({
  key, label, source: 'NONE', accounts: [], categories: [], cashFlow: null, formula: null, negate: false, indent: 1, bold: false, option: null, ...extra,
});

/**
 * Plantillas ES, ER y EFE generadas desde el plan de cuentas (una línea por cuenta de primer nivel),
 * para bases sin las hojas del Excel importadas. Solo se crean si no hay ninguna plantilla.
 */
export async function ensureDefaultStatements(db: Db) {
  if (await db.reportTemplate.count()) return { created: 0 };
  const top = await db.account.findMany({ where: { parentId: null, active: true }, orderBy: [{ sortOrder: 'asc' }, { fullCode: 'asc' }] });
  const byClass = (c: string, opts: { intercompany?: boolean } = {}) =>
    top.filter((a) => a.classification === c && (opts.intercompany ?? true ? true : !a.isIntercompany))
      .map((a) => line(`C${a.displayCode.replace(/[^\w-]/g, '_')}`, `${a.displayCode} ${a.name}`, { source: 'ACCOUNTS', accounts: [a.displayCode] }));
  const sumOf = (ls: ReportLineInput[]) => (ls.length ? ls.map((l) => `[${l.key}]`).join('+') : '0');

  const assets = [...byClass('AC'), line('ACT_OTROS', 'Otros activos', { source: 'UNMAPPED', accounts: ['AC'] })];
  const liabilities = [...byClass('PC'), line('PAS_OTROS', 'Otros pasivos', { source: 'UNMAPPED', accounts: ['PC'] })];
  const equity = [
    ...byClass('CC'), line('PN_OTRAS', 'Otras cuentas de patrimonio', { source: 'UNMAPPED', accounts: ['CC'] }),
    line('PN_SIN_CERRAR', 'Resultados de ejercicios anteriores sin cerrar', { source: 'RESULT_PRIOR' }),
    line('PN_RESULTADO', 'Resultado del período', { source: 'RESULT_YTD', option: 'REALIZADO' }),
    line('PN_PENDIENTE', 'Exportación pendiente de cierre (ventas − costos de facturas sin cerrar)', { source: 'RESULT_YTD', option: 'PENDIENTE' }),
  ];
  const es: ReportLineInput[] = [
    line('ACTIVOS', 'ACTIVOS', { source: 'FORMULA', formula: sumOf(assets), bold: true, indent: 0 }), ...assets, line('B1', ''),
    line('PYPN', 'PATRIMONIO + PASIVO', { source: 'FORMULA', formula: '[PASIVOS]+[PATRIMONIO]', bold: true, indent: 0 }),
    line('PASIVOS', 'PASIVOS', { source: 'FORMULA', formula: sumOf(liabilities), bold: true, indent: 0 }), ...liabilities,
    line('PATRIMONIO', 'PATRIMONIO', { source: 'FORMULA', formula: sumOf(equity), bold: true, indent: 0 }), ...equity, line('B2', ''),
    line('CONTROL', 'Diferencia ACTIVOS − (PASIVOS + PATRIMONIO)', { source: 'FORMULA', formula: '[ACTIVOS]-[PYPN]', bold: true, indent: 0 }),
  ];
  const income = [...byClass('CNA', { intercompany: false }), line('ING_OTROS', 'Otros ingresos', { source: 'UNMAPPED', accounts: ['CNA'] })];
  const expenses = [...byClass('CND', { intercompany: false }), line('GAS_OTROS', 'Otros gastos', { source: 'UNMAPPED', accounts: ['CND'] })];
  const er: ReportLineInput[] = [
    line('INGRESOS', 'INGRESOS', { source: 'FORMULA', formula: sumOf(income), bold: true, indent: 0 }), ...income, line('B1', ''),
    line('GASTOS', 'GASTOS', { source: 'FORMULA', formula: sumOf(expenses), bold: true, indent: 0 }), ...expenses, line('B2', ''),
    line('RESULTADO', 'RESULTADO DEL PERÍODO', { source: 'FORMULA', formula: '[INGRESOS]+[GASTOS]', bold: true, indent: 0 }),
  ];
  const efe: ReportLineInput[] = [
    line('SALDO_INICIAL', 'Saldo inicial de caja y bancos', { source: 'CASH_BALANCE', option: 'OPENING', bold: true, indent: 0 }),
    line('OPER', 'Actividades de explotación', { source: 'CASH', cashFlow: 'OPER' }),
    line('INV', 'Actividades de inversión', { source: 'CASH', cashFlow: 'INV' }),
    line('FIN', 'Actividades de financiación', { source: 'CASH', cashFlow: 'FIN' }),
    line('FX', 'Diferencias de cambio y cambios entre cuentas propias', { source: 'CASH_FX' }),
    line('SALDO_CALCULADO', 'Saldo final calculado', { source: 'FORMULA', formula: '[SALDO_INICIAL]+[OPER]+[INV]+[FIN]+[FX]', bold: true, indent: 0 }),
    line('SALDO_FINAL', 'Saldo final de caja y bancos', { source: 'CASH_BALANCE', option: 'CLOSING', bold: true, indent: 0 }),
    line('CONTROL', 'Diferencia (debe ser 0)', { source: 'FORMULA', formula: '[SALDO_CALCULADO]-[SALDO_FINAL]', indent: 0 }),
  ];
  const templates = [
    { code: 'ES', name: 'Estado de situación', kind: 'BALANCE' as const, checkCoverage: true, sortOrder: 10, lines: es },
    { code: 'ER', name: 'Estado de resultados', kind: 'INCOME' as const, checkCoverage: true, sortOrder: 20, lines: er },
    { code: 'EFE', name: 'Estado de flujo de efectivo', kind: 'CASHFLOW' as const, checkCoverage: false, sortOrder: 60, lines: efe },
  ];
  for (const t of templates) {
    await db.reportTemplate.create({
      data: {
        code: t.code, name: t.name, kind: t.kind, checkCoverage: t.checkCoverage, sortOrder: t.sortOrder, origin: DEFAULT_TEMPLATE_ORIGIN,
        notes: 'Plantilla generada desde el plan de cuentas (una línea por cuenta de primer nivel). Al importar las hojas del Excel se sustituye por su estructura.',
        lines: {
          create: t.lines.map((l, i) => ({
            sortOrder: (i + 1) * 10, key: l.key, label: l.label, source: l.source, accounts: l.accounts, categories: l.categories,
            cashFlow: l.cashFlow ?? null, formula: l.formula ?? null, negate: l.negate, indent: l.indent, bold: l.bold, option: l.option ?? null,
          })),
        },
      },
    });
  }
  return { created: templates.length };
}
