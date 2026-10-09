/**
 * Migración de deudas, proveedores y nómina (fase 3), guiada por las fórmulas del BC.
 *
 * Para cada cuenta en alcance se linealiza su fórmula (ver linear.ts) y cada fila de las tablas
 * que suma se contabiliza como un documento de contraparte con el mismo importe que aporta al BC:
 *  - pares 135.x/405.x (y 146.0002/413): una cuenta corriente por contraparte; al cierre de mes el
 *    saldo se reclasifica por signo, como el IF(… > 0, …, 0) del Excel;
 *  - cuentas compartidas (406–409, 410, 411, 412, 455, 135.0024/405.0024): la contraparte sale de
 *    una columna de la fila (proveedor, vendedor, trabajador…).
 * La contrapartida es la cuenta puente 699.9995: el Excel no es de partida doble y la otra pata
 * (gasto, inventario, ingreso) llega con los módulos de las fases 4–6. Los pagos de esas deudas que
 * ya están en tesorería (bandeja de revisión, categorías Deuda*) se pasan también al puente, con su
 * contraparte, para no contarlos dos veces.
 */
import { endOfMonth, money, roundAmount } from '@kaluch/shared';
import {
  closeFxTransits, createLoan, createOpenItem, ensureSystemAccounts, nextNumber, postEntry, postPartyDocument, reclassifyBySign, reclassifyMovement,
  resolveMapping, revalueMonth, settleOpenItem, upsertParty, upsertPartyAccount, withTx,
  PARTY_BRIDGE_MAPPING, type PartyDocKind, type PartyRole, type PrismaClient,
} from '@kaluch/db';
import type ExcelJS from 'exceljs';
import { basename } from 'node:path';
import { slug } from './categories';
import { TREASURY_SHEETS } from './treasury-import';
import { criterionMatches, isNegationOf, isSameForm, linearize, normalize, ROW_PREFIX, UnsupportedFormula, type LinearForm, type LinearTerm } from './linear';
import { asIsoDate, asString, excelNumber, readCell, type loadWorkbook } from './workbook';

type Workbook = Awaited<ReturnType<typeof loadWorkbook>>;

export const DEBT_CODES = ['135', '146', '405', '406', '407', '408', '409', '410', '411', '412', '413', '455', '699', '845', '924'];

/**
 * Fase 4: exportación, distribución, inventario, ventas, costos y gastos e ingresos de operación (todas las
 * cuentas de resultados que suman los totales de control ING/GAS 777/888/999, salvo las de cambios y tenencia,
 * que ya migran tesorería y deudas).
 */
export const SALES_CODES = [
  '136', '137', '139', '180', '181', '1181', '430', '800', '814', '815', '816', '817', '818', '819', '820', '821', '822', '823', '824',
  '825', '826', '827', '828', '829', '830', '831', '832', '833', '834', '835', '836', '837', '838', '839', '840', '841', '842', '843',
  '844', '847', '848', '849', '900', '901', '920', '921', '926', '930', '1900', '1814', '1815', '1816', '1817', '2900', '2814', '2815', '2816',
];

export interface BcScope {
  /** Nombre del lote de importación (una sola vez por base). */
  name: string;
  codes: string[];
  /** Pasos propios de la migración de deudas (partidas abiertas, bandeja → puente, cierres mensuales). */
  debts: boolean;
}
export const DEBTS_SCOPE: BcScope = { name: 'Deudas', codes: DEBT_CODES, debts: true };
export const SALES_SCOPE: BcScope = { name: 'Ventas', codes: SALES_CODES, debts: false };

/** Fase 5: financiamientos dados (138), impuestos devengados por pagar (480) y capital (600, 630). */
export const FISCAL_CODES = ['138', '480', '600', '630'];
export const FISCAL_SCOPE: BcScope = { name: 'Fiscal y capital', codes: FISCAL_CODES, debts: false };

/**
 * Fórmula que es solo una celda de otra hoja (600 Capital = Capital!B26): el Excel calcula el saldo fuera de
 * las tablas (cuadre inicial más resultados capitalizados cada mes). Se migra su valor del BC mes a mes.
 */
const OTHER_SHEET_CELL = /^\+?(?:'[^']+'|[A-Za-z_À-ÿ][A-Za-z0-9_À-ÿ.]*)!\$?[A-Z]{1,3}\$?\d+$/;

/** Cuentas que se llevan por contraparte (cuenta corriente); el resto se contabiliza sin ella. */
const PARTY_CODE = /^(135|136|137|138|139|146|405|406|407|408|409|410|411|412|413|430|455|699)(\.|$)/;

/** Fecha para los términos del Excel sin fecha de corte (estado actual): la de la fila. */
const UNDATED_DATE: Record<string, string> = {
  Exportación_Facturas: 'Fecha de facturación',
  Deuda_Proveedores: 'Fecha',
  Deuda_Coprove: 'Fecha',
};

/** Empresa por defecto de las tablas sin columna Empresa. */
const TABLE_COMPANY: Record<string, string> = {
  Distribución_Facturación: 'GR', Distribución_Crédito: 'GR', Distribución_Costos: 'GR', Distribución_Comisiones: 'GR',
  Distribución_Inversionistas: 'GR', Distribución_Inv_Cobros: 'GR', Distribución_Inv_Pagos: 'GR', Distribución_Utilidad: 'GR',
  Deuda_Clientes_Jorge_Facturas: 'GR', Deuda_Clientes_Jorge_Pagos: 'GR', Proyectos_Facturación: 'GR',
  // Hoja Capital (filas de ingresos por inversión de los mercados de Distribución).
  Capital: 'GR',
};

/** Columna de la que sale la contraparte en las tablas de cuentas compartidas. */
const PARTY_COLUMNS: Record<string, Record<string, string>> = {
  Deuda_Proveedores: { '*': 'Proveedor' },
  Deuda_Proveedores_Pagos: { '*': 'PROVEEDOR' },
  Tabla51: { '*': 'Persona' },
  Distribución_Comisiones: { '*': 'VENDEDOR' },
  Financiamientos: { '*': 'Entidad' },
  Deuda_Financiamientos: { '*': 'Entidad' },
  Distribución_Inversionistas: { '*': 'INVERSIONISTA' },
  Distribución_Inv_Pagos: { '*': 'Inversionistas' },
  RRHH_Nómina: { '*': 'Nombre' },
  RRHH_Nómina_Pagos: { '*': '@nomina' },
  Deuda_CxC_generales: { 'A cobrar USD': 'Nombre', 'Cobrado USD': 'Nombre_2' },
  Deuda_CxP_generales: { 'A pagar USD': 'Nombre', 'Pagado USD': 'Nombre_2' },
  Exportación_Facturas: { '*': 'CLIENTE ' },
  Exportación_Cobros: { '*': 'Cliente' },
  Distribución_Crédito: { '*': 'Cliente ' },
  Distribución_Inv_Cobros: { '*': 'Inversionista' },
  Deuda_Clientes_Jorge_Facturas: { '*': 'NOMBRE' },
  Deuda_Clientes_Jorge_Pagos: { '*': 'CLIENTE' },
};

/** Contraparte fija de las cuentas dedicadas cuyo nombre no la deja clara. */
const FIXED_PARTY: Record<string, string> = {
  '407': 'Coprove', '413': 'UNIR', '146.0002': 'UNIR', '699.0002': 'Coprove', '699.0003': 'Coprove',
};

/** Tablas cuya columna "Movimientos en USD" da la tasa con la que el Excel calcula la tenencia de CxC. */
const EXCEL_USD_COLUMN: Record<string, string> = {
  Deuda_Andrés_Tribe_EUR: 'Movimientos en USD',
  Deuda_César_EUR: 'Movimientos en USD',
  Deuda_Rubén_EUR: 'Movimiento en USD',
};

const COMPANY_ALIASES: Record<string, string> = { kei: 'KEI', kgt: 'KGT', gr: 'GR', dm: 'DM', ktr: 'KTR', logix: 'GR' };

/** Categorías de tesorería cuyos movimientos son los pagos/cobros de estas deudas. */
const DEBT_CATEGORY = /^(DEUDA|RRHH$|FINANCIAMIENTOS$|INVERSIONES$|COMISION_DISTRIBUCION$|COMISIONES_DISTRIBUCION$|DISTRIBUCION_COMISIONES$|COMISIONES_SEMANALES$|ENVIO_NELSON$|REMESAS$|PLAN_DE_PRESTAMOS$)/;

function roleFor(code: string): PartyRole {
  if (code.startsWith('455')) return 'EMPLOYEE';
  if (/^(136|137|430)/.test(code)) return 'CUSTOMER';
  if (code.startsWith('139')) return 'INVESTOR';
  if (code.startsWith('410')) return 'SELLER';
  if (code.startsWith('411')) return 'LENDER';
  if (code.startsWith('412')) return 'INVESTOR';
  if (/^(406|407|408|409|413|146)/.test(code)) return 'SUPPLIER';
  if (code.startsWith('138')) return 'OTHER';
  return 'OTHER';
}

function partyFromAccountName(name: string): string {
  return name
    .replace(/^Cuenta por (Cobrar|Pagar) a Corto Plazo\s*/i, '')
    .replace(/^(Oficina|Proveedores Exportación -|Pagos Anticipados)\s*/i, '')
    .replace(/\s*-\s*(USD|EUR|CUP|MLC|DOP)$/i, '')
    .trim();
}

const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim();

interface TableData {
  name: string;
  sheet: string;
  rows: { excelRow: number; values: Record<string, unknown> }[];
}

function tableIndex(wb: ExcelJS.Workbook) {
  const out = new Map<string, { ws: ExcelJS.Worksheet; ref: string; columns: string[]; totals: boolean }>();
  for (const ws of wb.worksheets) {
    for (const t of Object.values((ws as unknown as { tables?: Record<string, unknown> }).tables ?? {})) {
      const md = ((t as unknown as { table?: unknown; model?: unknown }).table ?? (t as unknown as { model?: unknown }).model ?? t) as {
        name: string; ref?: string; tableRef?: string; totalsRow?: boolean; columns?: { name: string }[];
      };
      out.set(md.name, { ws, ref: md.ref ?? md.tableRef ?? '', columns: (md.columns ?? []).map((c) => c.name), totals: !!md.totalsRow });
    }
  }
  return out;
}

function colNumber(letters: string) {
  return letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

/**
 * "Tabla" de una fila entera de una hoja (Capital!20): una fila por columna, con el valor de cada fila de la hoja
 * que citan los términos ("@fila:20", "@fila:1" con las fechas…).
 */
function readRowTable(wb: ExcelJS.Workbook, name: string, terms: LinearTerm[]): TableData | null {
  const [sheetName, row] = name.split('!') as [string, string];
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return null;
  const keys = new Set(terms.flatMap((t) => [t.column, t.dateColumn, ...t.criteria.map((c) => c.column)]).filter((k): k is string => !!k?.startsWith(ROW_PREFIX)));
  const sumKey = `${ROW_PREFIX}${row}`;
  const rows: TableData['rows'] = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    const values: Record<string, unknown> = {};
    for (const k of keys) values[k] = readCell(ws, Number(k.slice(ROW_PREFIX.length)), c).value;
    if (values[sumKey] === null || values[sumKey] === undefined || values[sumKey] === '') continue;
    rows.push({ excelRow: c, values });
  }
  return { name, sheet: name, rows };
}

function readTable(idx: ReturnType<typeof tableIndex>, name: string): TableData | null {
  const t = idx.get(name);
  if (!t) return null;
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(t.ref);
  if (!m) return null;
  const c0 = colNumber(m[1]!), r0 = Number(m[2]), r1 = Number(m[4]);
  // El modelo de tabla de exceljs omite las columnas calculadas: se lee la cabecera de la hoja, sin
  // recortar espacios (las referencias estructuradas los conservan: [FECHA ]).
  const columns: string[] = [];
  for (let c = c0, i = 0; c <= colNumber(m[3]!); c++, i++) {
    const v = readCell(t.ws, r0, c).value;
    columns.push(v === null || v === undefined ? t.columns[i] ?? `Columna${i + 1}` : String(v));
  }
  const rows: TableData['rows'] = [];
  for (let r = r0 + 1; r <= r1 - (t.totals ? 1 : 0); r++) {
    const values: Record<string, unknown> = {};
    let any = false;
    columns.forEach((col, i) => {
      const v = readCell(t.ws, r, c0 + i).value;
      if (v !== null && v !== undefined && v !== '') any = true;
      values[col] = v;
    });
    if (any) rows.push({ excelRow: r, values });
  }
  return { name, sheet: t.ws.name, rows };
}

interface Target {
  accountId: string;
  code: string;
  name: string;
  /** Cuenta opuesta del par (saldo partido por signo). */
  oppositeId: string | null;
  form: LinearForm;
  /** Signo para pasar la aportación al BC a importe contable (+ Debe). */
  sign: 1 | -1;
  currency: string;
  /** Contraparte fija (cuentas dedicadas) o null (sale de cada fila). */
  fixedParty: string | null;
  /** Cuenta de resultados (no arrastra saldo de meses anteriores a la apertura). */
  nominal: boolean;
  /** Sin contraparte (resultados, inventario): asiento de migración contra el puente. */
  plain: boolean;
  /**
   * Estado actual: todos los términos sin fecha de corte (facturas pendientes de cierre, facturas de proveedor
   * sin asignar). El Excel muestra el mismo valor en todos los meses; aquí cada fila va en su fecha y el saldo
   * se arrastra (también antes de la apertura), así que el acumulado coincide con el Excel.
   */
  state: boolean;
}

export interface DebtImportOptions {
  openingDate: string;
  /** Empresa por defecto de las deudas (las filas con columna Empresa usan la suya). */
  debtCompany: string;
  maxDate: string;
  revalueFrom: string;
  revalueUntil: string | null;
  log?: (msg: string) => void;
  /** Alcance (por defecto, deudas). */
  scope?: BcScope;
}

interface Contribution {
  target: Target;
  table: string;
  sheet: string;
  excelRow: number;
  date: string;
  companyCode: string;
  partyName: string;
  amount: ReturnType<typeof money>;
  /** USD según el Excel (solo cuentas en moneda extranjera con columna de USD por fila). */
  excelUsd: ReturnType<typeof money> | null;
  values: Record<string, unknown>;
}

/** Fase 4: exportación y distribución (tras la de deudas). */
export function importSales(prisma: PrismaClient, w: Workbook, file: string, opts: DebtImportOptions) {
  return importDebts(prisma, w, file, { ...opts, scope: SALES_SCOPE });
}

/** Fase 5: financiamientos, impuestos devengados y capital (tras la de ventas), y el registro de préstamos. */
export async function importFiscal(prisma: PrismaClient, w: Workbook, file: string, opts: DebtImportOptions) {
  const r = await importDebts(prisma, w, file, { ...opts, scope: FISCAL_SCOPE });
  const loans = await registerMigratedLoans(prisma, w, opts);
  return { ...r, stats: { ...r.stats, loans } };
}

/**
 * Registro de préstamos desde la tabla Financiamientos (una fila por operación): lo recibido ("A cobrar USD"), lo que
 * se devuelve ("A pagar USD") y su diferencia como interés. Los importes ya están contabilizados por las aportaciones
 * al BC (138/411 y gastos financieros): el préstamo queda marcado como migrado y no se vuelve a devengar.
 */
async function registerMigratedLoans(prisma: PrismaClient, w: Workbook, opts: DebtImportOptions) {
  const td = readTable(tableIndex(w.wb), 'Financiamientos');
  if (!td) return { registered: 0, closed: 0 };
  const company = await prisma.company.findUniqueOrThrow({ where: { code: opts.debtCompany } });
  const account = await prisma.account.findFirst({ where: { code: '411', postable: true }, orderBy: { sortOrder: 'asc' } });
  if (!account) return { registered: 0, closed: 0 };
  let registered = 0;
  let closed = 0;
  for (const row of td.rows) {
    const v = row.values;
    const entity = asString(v.Entidad);
    const reference = asString(v.Referencia);
    const start = asIsoDate(v['Fecha inicial']);
    const received = money(excelNumber(v['A cobrar USD']) ?? 0);
    if (!entity || !reference || !start || received.lte(0) || start > opts.maxDate) continue;
    const toRepay = money(excelNumber(v['A pagar USD']) ?? 0);
    const interest = toRepay.gt(received) ? toRepay.minus(received) : money(0);
    const name = cleanName(entity);
    const party = await upsertParty(prisma, { code: slug(name) || 'SIN_IDENTIFICAR', name, roles: ['LENDER'] });
    const pa = await upsertPartyAccount(prisma, { companyId: company.id, partyId: party.id, currency: 'USD', accountId: account.id, name: `${name} · 411` });
    if (await prisma.loan.findUnique({ where: { companyId_reference: { companyId: company.id, reference } } })) continue;
    const end = asIsoDate(v['Fecha final']);
    const pending = money(excelNumber(v['Pendiente a pagar2']) ?? 0).plus(money(excelNumber(v['Pendiente a cobrar2']) ?? 0));
    const loan = await withTx(prisma, {}, (tx) => createLoan(tx, {
      partyAccountId: pa.id, direction: 'RECEIVED', reference, description: `Financiamiento ${reference} (migrado del Excel)`,
      startDate: start, endDate: end && end >= start ? end : null, principalUsd: roundAmount(received).toFixed(4),
      ratePct: roundAmount(interest.div(received).times(100)).toFixed(4), migrated: true,
    }));
    registered++;
    // Sin nada pendiente en el Excel: devuelto.
    if (roundAmount(pending).isZero() && money(excelNumber(v['Pagado USD']) ?? 0).gte(roundAmount(toRepay))) {
      await prisma.loan.update({ where: { id: loan.id }, data: { status: 'CLOSED' } });
      closed++;
    }
  }
  return { registered, closed };
}

export async function importDebts(prisma: PrismaClient, w: Workbook, file: string, opts: DebtImportOptions) {
  const log = opts.log ?? (() => {});
  const scope = opts.scope ?? DEBTS_SCOPE;
  if (await prisma.importBatch.findFirst({ where: { tableName: scope.name } })) {
    throw new Error(`La migración "${scope.name}" ya se hizo en esta base: se ejecuta una sola vez`);
  }
  if (scope.debts && (await prisma.partyDocument.count()) > 0) {
    throw new Error('Ya hay documentos de contrapartes en esta base: la migración de deudas se ejecuta una sola vez tras la de tesorería');
  }
  const issues: string[] = [];
  await ensureSystemAccounts(prisma);
  const companies = new Map((await prisma.company.findMany()).map((c) => [c.code, c]));
  const bridgeOf = new Map<string, string>();
  const bridge = async (companyId: string) => {
    if (!bridgeOf.has(companyId)) bridgeOf.set(companyId, await withTx(prisma, {}, (tx) => resolveMapping(tx, PARTY_BRIDGE_MAPPING, { companyId })));
    return bridgeOf.get(companyId)!;
  };

  // 1. Cuentas en alcance y sus fórmulas.
  const bc = w.wb.getWorksheet('BC');
  if (!bc) throw new Error('No se encuentra la hoja BC');
  let col = 7;
  for (let c = 7; c <= bc.columnCount; c++) if (Number(readCell(bc, 2, c).value) >= 1) { col = c; break; }
  const accounts = await prisma.account.findMany({ where: { code: { in: scope.codes }, postable: true } });
  /** Términos que suman filas de tesorería: sus movimientos ya existen (bandeja) y se reclasifican a la cuenta. */
  const trayRules: { accountId: string; code: string; terms: LinearTerm[] }[] = [];
  const byRow = new Map(accounts.map((a) => [a.sortOrder, a]));
  const forms: { acc: (typeof accounts)[number]; form: LinearForm }[] = [];
  /** Cuentas cuyo saldo calcula el Excel fuera de las tablas: se migra el valor del BC. */
  const bcValueAccounts: (typeof accounts)[number][] = [];
  for (let r = 3; r <= bc.rowCount; r++) {
    const acc = byRow.get(r);
    if (!acc) continue;
    const f = readCell(bc, r, col).formula;
    if (!f) continue;
    // En abril el capital es el cuadre del BC (suma de otras filas) y desde mayo una celda de la hoja Capital.
    if ([f, readCell(bc, r, col + 1).formula ?? ''].some((x) => OTHER_SHEET_CELL.test(x.trim()))) { bcValueAccounts.push(acc); continue; }
    try {
      const form = normalize(linearize(f, (row) => readCell(bc, row, col).formula ?? null, 0, (c, row) => readCell(bc, row, colNumber(c)).value));
      const isTreasury = (t: LinearTerm) => (TREASURY_SHEETS as readonly string[]).includes(t.sheet);
      if (form.terms.some(isTreasury)) {
        // Deudas: las 845/924 de cambios y traspasos ya salen de la migración de tesorería.
        if (scope.debts) continue;
        // Ventas y gastos: las filas de caja y bancos ya son movimientos; se reclasifican desde la bandeja.
        trayRules.push({ accountId: acc.id, code: acc.displayCode, terms: form.terms.filter(isTreasury) });
        form.terms = form.terms.filter((t) => !isTreasury(t));
      }
      const nominal = acc.classification === 'CND' || acc.classification === 'CNA';
      if (form.terms.some((t) => t.monthly) && !nominal) {
        issues.push(`${acc.displayCode}: fórmula de importes del mes en una cuenta de balance; no se migran filas`);
        continue;
      }
      if (form.terms.length) forms.push({ acc, form });
    } catch (e) {
      if (e instanceof UnsupportedFormula) issues.push(`${acc.displayCode}: fórmula no soportada (${e.message})`);
      else throw e;
    }
  }
  const targets: Target[] = [];
  const used = new Set<string>();
  for (const { acc, form } of forms) {
    if (used.has(acc.id)) continue;
    let opposite: (typeof forms)[number] | undefined;
    if (form.split) {
      const nominal = (a: { classification: string }) => a.classification === 'CND' || a.classification === 'CNA';
      opposite = forms.find((o) => o.acc.id !== acc.id && o.form.split && (
        isNegationOf(o.form, form)
        // Gasto/ingreso del Excel (845/924…): misma forma, uno muestra el neto negativo y el otro el positivo.
        || (nominal(acc) && nominal(o.acc) && isSameForm(o.form, form))));
      if (!opposite) {
        issues.push(`${acc.displayCode}: saldo partido por signo sin cuenta opuesta; se migra como cuenta simple`);
      }
    }
    // En un par la cuenta principal es la de activo (135.x, 146.0002); su forma da el importe. En un par de
    // resultados con formas opuestas (847.9991 "−S si S<0" / 926.9991 "S si S>0") manda la de ingresos: la de
    // gastos muestra el importe en positivo, con el signo contrario al del resto del BC.
    const nominalNegation = opposite && opposite.acc.classification === 'CNA' && acc.classification === 'CND' && isNegationOf(opposite.form, form);
    const main = opposite && ((acc.classification !== 'AC' && opposite.acc.classification === 'AC') || nominalNegation) ? opposite : { acc, form };
    const other = main.acc.id === acc.id ? opposite : { acc, form };
    used.add(acc.id);
    if (opposite) used.add(opposite.acc.id);
    const currency = /^([A-Z]{3})\//.exec(main.form.rateColumn ?? '')?.[1] ?? 'USD';
    const sharedByRow = main.form.terms.every((t) => PARTY_COLUMNS[t.sheet]);
    const state = main.form.terms.every((t) => !t.dateColumn);
    targets.push({
      accountId: main.acc.id, code: main.acc.displayCode, name: main.acc.name, oppositeId: other?.acc.id ?? null, form: main.form,
      sign: main.acc.classification === 'AC' ? 1 : -1, currency,
      nominal: !state && (main.acc.classification === 'CND' || main.acc.classification === 'CNA'),
      state,
      plain: main.acc.classification === 'CND' || main.acc.classification === 'CNA' || !PARTY_CODE.test(main.acc.displayCode),
      fixedParty: sharedByRow && !other ? null : FIXED_PARTY[main.acc.displayCode] ?? (main.acc.code === '699' ? null : partyFromAccountName(main.acc.name)),
    });
  }
  log(`Cuentas en alcance: ${targets.length} (${targets.filter((t) => t.oppositeId).length} pares por signo)`);

  // 2. Aportaciones de cada fila.
  const idx = tableIndex(w.wb);
  const tables = new Map<string, TableData>();
  const allTerms = targets.flatMap((t) => t.form.terms);
  for (const name of new Set(allTerms.map((x) => x.sheet))) {
    const td = name.includes('!') ? readRowTable(w.wb, name, allTerms.filter((x) => x.sheet === name)) : readTable(idx, name);
    if (!td) { issues.push(`No se encuentra la tabla ${name}`); continue; }
    tables.set(name, td);
    log(`  ${name} (${td.sheet}): ${td.rows.length} filas`);
  }
  // Nómina: referencia → trabajador (para atribuir los pagos).
  const payrollByRef = new Map<string, string>();
  for (const r of tables.get('RRHH_Nómina')?.rows ?? []) {
    const ref = asString(r.values.Referencia);
    const name = asString(r.values.Nombre);
    if (ref && name) payrollByRef.set(ref.toLowerCase(), cleanName(name));
  }

  const contributions: Contribution[] = [];
  let nonNumeric = 0;
  for (const target of targets) {
    for (const [table, terms] of groupBy(target.form.terms, (t) => t.sheet)) {
      const td = tables.get(table);
      if (!td) continue;
      for (const row of td.rows) {
        const byDate = new Map<string, { amount: ReturnType<typeof money>; partyCol: string | null }>();
        for (const term of terms) {
          if (!term.criteria.every((c) => criterionMatches(row.values[c.column], c.value))) continue;
          let date = term.dateColumn
            ? asIsoDate(row.values[term.dateColumn])
            : asIsoDate(row.values[UNDATED_DATE[table] ?? '']) ?? opts.openingDate;
          if (!date) continue;
          // Fecha 0 del Excel (30/12/1899) o anterior: en un acumulado cuenta como saldo anterior a la apertura.
          if (date < '2015-01-01' && !term.monthly) date = opts.openingDate;
          const raw = row.values[term.column];
          const v = excelNumber(raw);
          if (v === null) {
            if (raw !== null && raw !== undefined && raw !== '') nonNumeric++;
            continue;
          }
          if (v === 0) continue;
          const prev = byDate.get(date);
          const amount = money(v).times(term.coef * target.sign);
          byDate.set(date, { amount: prev ? prev.amount.plus(amount) : amount, partyCol: partyColumn(table, term) });
        }
        for (const [date, { amount, partyCol }] of byDate) {
          if (roundAmount(amount).isZero()) continue;
          if (date > opts.maxDate || date < '2015-01-01') {
            issues.push(`${td.sheet} fila ${row.excelRow}: fecha fuera de rango (${date}), no se migra`);
            continue;
          }
          let partyName = target.fixedParty;
          if (!partyName) {
            if (partyCol === '@nomina') partyName = payrollByRef.get((asString(row.values.Referencia) ?? '').toLowerCase()) ?? null;
            else if (partyCol) partyName = asString(row.values[partyCol]);
            partyName = partyName ? cleanName(partyName) : '(sin identificar)';
          }
          const empresa = (asString(row.values.Empresa) ?? '').toLowerCase();
          const companyCode = COMPANY_ALIASES[empresa] ?? TABLE_COMPANY[table] ?? TABLE_COMPANY[table.split('!')[0]!] ?? opts.debtCompany;
          const usdCol = target.currency !== 'USD' ? EXCEL_USD_COLUMN[table] : undefined;
          const ex = usdCol ? excelNumber(row.values[usdCol]) : null;
          contributions.push({
            target, table, sheet: td.sheet, excelRow: row.excelRow, date, companyCode, partyName: partyName ?? '(sin contraparte)', amount,
            excelUsd: ex !== null && ex !== 0 ? money(ex).abs().times(amount.s) : null, values: row.values,
          });
        }
      }
    }
  }
  if (nonNumeric) issues.push(`${nonNumeric} celdas con texto en columnas de importe: se ignoran, como en el Excel`);
  log(`Aportaciones: ${contributions.length}`);

  // 3. Contrapartes y cuentas corrientes.
  const partyAccounts = new Map<string, string>();
  const companyOfPa = new Map<string, string>();
  const partyAccountOf = async (c: Contribution) => {
    const company = companies.get(c.companyCode);
    if (!company) throw new Error(`Empresa ${c.companyCode} no existe`);
    const key = `${company.id}|${c.target.accountId}|${c.partyName.toLowerCase()}`;
    const cached = partyAccounts.get(key);
    if (cached) return cached;
    const party = await upsertParty(prisma, {
      code: slug(c.partyName) || 'SIN_IDENTIFICAR', name: c.partyName, roles: [roleFor(c.target.code)],
      kind: /S\.?L\.?|S\.?A\.?|LLC|S\.U\.R\.L|COMPANY|SANAYİ|LTD|MARÍTIMA/i.test(c.partyName) ? 'COMPANY' : 'PERSON',
    });
    const pa = await upsertPartyAccount(prisma, {
      companyId: company.id, partyId: party.id, currency: c.target.currency, accountId: c.target.accountId, oppositeAccountId: c.target.oppositeId,
      name: `${c.partyName} · ${c.target.code}${c.target.currency !== 'USD' ? ` ${c.target.currency}` : ''}`,
      sourceSheet: c.sheet, sourceFilter: { table: c.table, terms: c.target.form.terms as unknown as object[] } as unknown as object,
    });
    partyAccounts.set(key, pa.id);
    companyOfPa.set(pa.id, company.id);
    return pa.id;
  };

  const batch = await prisma.importBatch.create({ data: { sourceFile: basename(file), fileHash: w.hash, tableName: scope.name, stats: {} } });
  // Filas de importación (una por fila de tabla con aportación).
  const importRowIds = new Map<string, string>();
  const rowKeys = [...new Map(contributions.map((c) => [`${c.sheet}|${c.excelRow}`, c])).values()];
  for (let i = 0; i < rowKeys.length; i += 1000) {
    const chunk = rowKeys.slice(i, i + 1000);
    const created = await prisma.importRow.createManyAndReturn({
      data: chunk.map((c) => ({
        batchId: batch.id, sheet: c.sheet, excelRow: c.excelRow, raw: JSON.parse(JSON.stringify(c.values)), status: 'OK' as const,
        message: c.date <= opts.openingDate ? 'Incluida en saldo de apertura' : null,
      })),
      select: { id: true, sheet: true, excelRow: true },
    });
    for (const r of created) importRowIds.set(`${r.sheet}|${r.excelRow}`, r.id);
  }

  // 4. Saldos de apertura por cuenta corriente.
  const opening = new Map<string, { c: Contribution; amount: ReturnType<typeof money> }>();
  const after: Contribution[] = [];
  const plainOpening = new Map<string, { c: Contribution; amount: ReturnType<typeof money> }>();
  for (const c of contributions) {
    if (c.target.nominal && c.date <= opts.openingDate) continue; // resultados de meses anteriores a la apertura
    if (c.target.plain && c.date <= opts.openingDate) {
      const k = `${c.companyCode}|${c.target.accountId}`;
      const prev = plainOpening.get(k);
      plainOpening.set(k, { c, amount: prev ? prev.amount.plus(c.amount) : c.amount });
      continue;
    }
    if (c.date <= opts.openingDate) {
      const pa = await partyAccountOf(c);
      const prev = opening.get(pa);
      opening.set(pa, { c, amount: prev ? prev.amount.plus(c.amount) : c.amount });
    } else after.push(c);
  }
  const openingDocs = new Map<string, string>();
  for (const [paId, { c, amount }] of opening) {
    if (roundAmount(amount).isZero()) continue;
    const r = await withTx(prisma, { timeoutMs: 60_000 }, (tx) => postPartyDocument(tx, {
      partyAccountId: paId, date: opts.openingDate, kind: 'OPENING', amount: roundAmount(amount).toFixed(4),
      description: `Saldo de apertura al ${opts.openingDate.split('-').reverse().join('/')} (migración ${c.table})`,
    }));
    openingDocs.set(paId, r.document.id);
  }
  // Saldos de apertura de cuentas sin contraparte (inventario…): un asiento por empresa contra 699.9997.
  for (const [companyCode, items] of groupBy([...plainOpening.values()], (x) => x.c.companyCode)) {
    const company = companies.get(companyCode)!;
    const lines = items.filter((x) => !roundAmount(x.amount).isZero())
      .map((x) => ({ accountId: x.c.target.accountId, currency: 'USD', amount: roundAmount(x.amount).toFixed(4), amountUsd: roundAmount(x.amount).toFixed(4), memo: `Apertura ${x.c.target.code}` }));
    if (!lines.length) continue;
    const net = lines.reduce((sum, l) => sum.plus(money(l.amount)), money(0));
    await withTx(prisma, { timeoutMs: 60_000 }, async (tx) => {
      const openingId = await resolveMapping(tx, 'opening.balance', { companyId: company.id });
      await postEntry(tx, {
        companyId: company.id, entryDate: opts.openingDate, kind: 'OPENING',
        memo: `Saldos de apertura al ${opts.openingDate.split('-').reverse().join('/')} (migración ${scope.name})`,
        lines: [...lines, { accountId: openingId, currency: 'USD', amount: net.neg().toFixed(4), amountUsd: net.neg().toFixed(4), memo: 'Contrapartida de apertura' }],
      });
    });
  }
  log(`Saldos de apertura: ${openingDocs.size} cuentas corrientes, ${plainOpening.size} cuentas sin contraparte`);

  // 5. Documentos posteriores a la apertura (uno por fila, fecha y cuenta corriente).
  after.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.excelRow - b.excelRow));
  const rowDocs = new Map<string, string[]>();
  const docOfRow = (sheet: string, row: number) => rowDocs.get(`${sheet}|${row}`) ?? [];
  const groups = [...groupBy(after, (c) => `${c.sheet}|${c.excelRow}|${c.date}`).values()];
  const counters = { contributions: contributions.length, documents: 0, assignments: 0, openingAccounts: openingDocs.size, payroll: 0 };
  const BATCH = 100;
  // La referencia a la fila del Excel es única: solo la lleva el primer documento de cada fila.
  const usedImportRows = new Set<string>();
  const takeImportRow = (c: Contribution) => {
    const id = importRowIds.get(`${c.sheet}|${c.excelRow}`) ?? null;
    if (!id || usedImportRows.has(id)) return null;
    usedImportRows.add(id);
    return id;
  };
  for (let i = 0; i < groups.length; i += BATCH) {
    const chunk = groups.slice(i, i + BATCH);
    const paIds: string[][] = [];
    for (const g of chunk) { const ids: string[] = []; for (const c of g) ids.push(c.target.plain ? '' : await partyAccountOf(c)); paIds.push(ids); }
    await withTx(prisma, { timeoutMs: 300_000 }, async (tx) => {
      for (const [k, g] of chunk.entries()) {
        const ids = paIds[k]!;
        const first = g[0]!;
        const desc = describe(first);
        // Cesión de deuda: dos cuentas corrientes de la misma moneda con importes opuestos (zelle Invictus).
        if (g.length === 2 && !g[0]!.target.plain && !g[1]!.target.plain && g[0]!.target.currency === g[1]!.target.currency && roundAmount(g[0]!.amount.plus(g[1]!.amount)).isZero()) {
          const r = await postPartyDocument(tx, {
            partyAccountId: ids[0]!, counterPartyAccountId: ids[1]!, date: first.date, kind: 'ASSIGNMENT', amount: roundAmount(g[0]!.amount).toFixed(4),
            description: `Cesión de deuda: ${desc}`, importRowId: takeImportRow(first),
          });
          remember(rowDocs, first, r.document.id);
          counters.assignments++;
          continue;
        }
        // Cuentas sin contraparte de la fila (ventas, costos, inventario…): un asiento con todas sus líneas y
        // el puente solo por la diferencia (si las fórmulas del Excel de la fila cuadran, no hay puente).
        for (const [companyCode, plain] of groupBy(g.filter((c) => c.target.plain), (c) => c.companyCode)) {
          const company = companies.get(companyCode)!;
          const year = Number(first.date.slice(0, 4));
          const seq = await nextNumber(tx, company.id, year, 'MIG');
          const doc = await tx.document.create({
            data: {
              companyId: company.id, docType: 'MIGRATION', number: `${company.code}-MIG-${year}-${String(seq).padStart(6, '0')}`,
              docDate: new Date(`${first.date}T00:00:00Z`), memo: desc, importRowId: takeImportRow(plain[0]!),
            },
          });
          const lines = plain.filter((c) => !roundAmount(c.amount).isZero())
            .map((c) => ({ accountId: c.target.accountId, currency: 'USD', amount: roundAmount(c.amount).toFixed(4), memo: desc }));
          const net = lines.reduce((sum, l) => sum.plus(money(l.amount)), money(0));
          if (!net.isZero()) lines.push({ accountId: await bridge(company.id), currency: 'USD', amount: net.neg().toFixed(4), memo: desc });
          if (lines.length >= 2) {
            await postEntry(tx, { companyId: company.id, entryDate: first.date, kind: 'AUTO', memo: desc, documentId: doc.id, lines });
          }
          for (const c of plain) remember(rowDocs, c, doc.id);
          counters.documents++;
        }
        for (const [j, c] of g.entries()) {
          if (c.target.plain) continue; // van juntas en un asiento de migración (abajo)
          const paId = ids[j]!;
          const companyId = companyOfPa.get(paId)!;
          const kind: PartyDocKind = c.table === 'RRHH_Nómina' ? 'PAYROLL' : c.amount.gt(0) ? 'CHARGE' : 'CREDIT';
          const rate = c.excelUsd && !c.excelUsd.isZero() ? c.amount.div(c.excelUsd).abs().toFixed(10) : undefined;
          const r = await postPartyDocument(tx, {
            partyAccountId: paId, date: c.date, kind, amount: roundAmount(c.amount).toFixed(4), rate,
            counterAccountId: await bridge(companyId), description: desc, reference: referenceOf(c),
            importRowId: takeImportRow(c),
          });
          remember(rowDocs, c, r.document.id);
          if (kind === 'PAYROLL') {
            const v = c.values;
            const num = (x: unknown) => money(excelNumber(x) ?? 0);
            await tx.payrollLine.create({
              data: {
                id: r.document.id, period: c.date.slice(0, 7), employer: asString(v.Empresa) ?? '', concept: asString(v.Concepto) ?? '',
                gross: num(v.Salario).toFixed(4), attendanceDeduction: num(v['Descuento Asistencia']).toFixed(4),
                mipymeDeduction: num(v['Descuento Salario Mipyme']).toFixed(4),
                net: num(v.Salario).plus(num(v['Descuento Asistencia'])).plus(num(v['Descuento Salario Mipyme'])).toFixed(4),
                currency: asString(v.Moneda) ?? 'USD',
              },
            });
            counters.payroll++;
          }
          counters.documents++;
        }
      }
    });
    if ((i / BATCH) % 10 === 0) log(`  documentos ${Math.min(i + BATCH, groups.length)}/${groups.length}`);
  }

  // 5b. Saldos calculados por el Excel (capital): la variación de cada mes contra el puente.
  const bcValueDocs = bcValueAccounts.length ? await postBcValues(prisma, bcValueAccounts, {
    company: companies.get(opts.debtCompany)!, bridge, batchFile: basename(file), log,
  }) : 0;
  counters.documents += bcValueDocs;

  // 6. Filas sin aportación posterior a la apertura en tablas con importes fuera de alcance: nada que hacer.
  // 7. Partidas abiertas: facturas de proveedores, nómina y CxC/CxP generales con sus pagos.
  const openItems = !scope.debts ? {} : await buildOpenItems(prisma, { contributions, partyAccountOf, docOfRow, openingDocs, openingDate: opts.openingDate, maxDate: opts.maxDate, issues });

  // 8. Pagos de estas deudas en tesorería (bandeja de revisión) → cuenta puente, con contraparte.
  const trayStats = scope.debts
    ? await moveTreasuryDebtsToBridge(prisma, bridge, issues)
    : await applyTrayRules(prisma, trayRules, new Set(accounts.map((a) => a.id)), bridge, issues, log);

  // Las devoluciones son traspasos para el Excel (845/924.8881 suman "Traspaso" y "Devolución").
  const devol = scope.debts ? await prisma.cashCategory.findMany({ where: { code: { in: ['DEVOLUCION'] } } }) : [];
  for (const cat of devol) {
    await prisma.cashCategory.update({ where: { id: cat.id }, data: { kind: 'TRANSFER' } });
    const pending = await prisma.treasuryMovement.findMany({ where: { categoryId: cat.id, needsReview: true }, include: { document: true } });
    for (const mv of pending) {
      await withTx(prisma, {}, async (tx) => reclassifyMovement(tx, mv.id, {
        accountId: await resolveMapping(tx, 'treasury.transfer.transit', { companyId: mv.document.companyId }),
        note: 'Migración: devolución tratada como traspaso (como el Excel)',
      }));
    }
  }

  // 9. Revaluación, cierre de transitorias de tesorería y reclasificación por signo, mes a mes.
  const monthly: { company: string; month: string; revalUsd: string; reclassUsd: string }[] = [];
  if (opts.revalueUntil && scope.debts) {
    const companyIds = [...new Set([
      ...(await prisma.partyAccount.findMany({ select: { companyId: true } })).map((p) => p.companyId),
      ...(await prisma.treasuryAccount.findMany({ select: { companyId: true } })).map((t) => t.companyId),
    ])];
    const [fy, fm] = opts.revalueFrom.split('-').map(Number) as [number, number];
    const [uy, um] = opts.revalueUntil.split('-').map(Number) as [number, number];
    for (let y = fy, m = fm; y < uy || (y === uy && m <= um); m === 12 ? (y++, (m = 1)) : m++) {
      for (const companyId of companyIds) {
        const rv = await withTx(prisma, { timeoutMs: 300_000 }, (tx) => revalueMonth(tx, companyId, y, m));
        await withTx(prisma, { timeoutMs: 300_000 }, (tx) => closeFxTransits(tx, companyId, y, m));
        const rc = await withTx(prisma, { timeoutMs: 300_000 }, (tx) => reclassifyBySign(tx, companyId, y, m));
        const code = [...companies.values()].find((c) => c.id === companyId)!.code;
        monthly.push({ company: code, month: `${String(m).padStart(2, '0')}/${y}`, revalUsd: rv.totalUsd, reclassUsd: rc.movedUsd });
      }
    }
  }

  const stats = {
    ...counters, ...openItems, ...trayStats,
    stateAccounts: [...new Set(targets.filter((t) => t.state).flatMap((t) => [t.accountId, ...(t.oppositeId ? [t.oppositeId] : [])]))],
    parties: await prisma.party.count(), partyAccounts: await prisma.partyAccount.count(),
  };
  await prisma.importBatch.update({ where: { id: batch.id }, data: { stats: { ...stats, issues: issues.slice(0, 500) } } });
  return { stats, issues, monthly };
}

/**
 * Migra mes a mes el valor del BC de cuentas que el Excel calcula fuera de las tablas (600 Capital: cuadre de
 * abril y después capital anterior + resultado consolidado + ingresos por inversión). Un asiento a fin de mes por
 * la variación, contra la cuenta puente.
 */
async function postBcValues(
  prisma: PrismaClient,
  accounts: { id: string; displayCode: string; classification: string; sortOrder: number; name: string }[],
  p: { company: { id: string; code: string }; bridge: (companyId: string) => Promise<string>; batchFile: string; log: (m: string) => void },
) {
  const ref = await prisma.importBatch.findFirst({ where: { tableName: 'BC:referencia' }, orderBy: { createdAt: 'desc' } });
  if (!ref) throw new Error('Falta la referencia del BC: ejecuta antes "all" o "bc-ref"');
  let docs = 0;
  for (const acc of accounts) {
    const values = await prisma.bcReference.findMany({ where: { importId: ref.id, excelRow: acc.sortOrder }, orderBy: [{ year: 'asc' }, { month: 'asc' }] });
    let prev = money(0);
    for (const v of values) {
      const value = money(v.valueUsd);
      // Signo del Excel → importe contable (+ Debe): activo tal cual; pasivo, capital y resultados al revés.
      const delta = roundAmount(value.minus(prev).times(acc.classification === 'AC' ? 1 : -1));
      prev = value;
      if (delta.isZero()) continue;
      const date = endOfMonth(v.year, v.month);
      const memo = `${acc.displayCode} ${acc.name}: saldo calculado por el Excel a ${date.split('-').reverse().join('/')} (${value.toFixed(2)})`;
      await withTx(prisma, {}, async (tx) => {
        const seq = await nextNumber(tx, p.company.id, v.year, 'MIG');
        const doc = await tx.document.create({
          data: { companyId: p.company.id, docType: 'MIGRATION', number: `${p.company.code}-MIG-${v.year}-${String(seq).padStart(6, '0')}`, docDate: new Date(`${date}T00:00:00Z`), memo },
        });
        await postEntry(tx, {
          companyId: p.company.id, entryDate: date, kind: 'AUTO', memo, documentId: doc.id,
          lines: [
            { accountId: acc.id, currency: 'USD', amount: delta.toFixed(4), memo },
            { accountId: await p.bridge(p.company.id), currency: 'USD', amount: delta.neg().toFixed(4), memo },
          ],
        });
      });
      docs++;
    }
    p.log(`  ${acc.displayCode}: ${values.length} meses desde el BC del Excel`);
  }
  return docs;
}

function partyColumn(table: string, term: LinearTerm): string | null {
  const m = PARTY_COLUMNS[table];
  if (!m) return null;
  return m[term.column] ?? m['*'] ?? null;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = out.get(k);
    if (arr) arr.push(it);
    else out.set(k, [it]);
  }
  return out;
}

function remember(map: Map<string, string[]>, c: Contribution, docId: string) {
  const k = `${c.sheet}|${c.excelRow}`;
  map.set(k, [...(map.get(k) ?? []), docId]);
}

const DESC_COLUMNS = ['DESCRIPCIÓN', 'DESCRIPCION', 'Descripción', 'Concepto', 'DETALLE', 'NOMBRE', 'Nombre', 'CLIENTE ', 'Columna1', 'Producto', 'Observaciones'];

function describe(c: Contribution): string {
  const parts = DESC_COLUMNS.map((k) => asString(c.values[k])).filter(Boolean).slice(0, 2);
  const where = c.sheet.includes('!') ? `${c.sheet.replace('!', ' fila ')} columna ${c.excelRow}` : `${c.sheet} fila ${c.excelRow}`;
  return `${c.partyName}: ${parts.join(' · ') || c.table} [${where}]`.slice(0, 480);
}

function referenceOf(c: Contribution): string | null {
  const v = c.values;
  return asString(v['No. de Factura']) ?? asString(v.REFERENCIA) ?? asString(v.Referencia) ?? asString(v.Factura) ?? null;
}

interface OpenItemSource {
  invoices: string;
  ref: string;
  amount: string[];
  date: string;
  payments: { table: string; ref: string; amount: string; date: string };
  writeOff?: { amount: string; date: string };
}

/** Tablas con referencia de factura y pagos que la citan. */
const OPEN_ITEM_SOURCES: OpenItemSource[] = [
  {
    invoices: 'Deuda_Proveedores', ref: 'No. de Factura', amount: ['A pagar USD'], date: 'Fecha',
    payments: { table: 'Deuda_Proveedores_Pagos', ref: 'REFERENCIA', amount: 'Pagado USD', date: 'FECHA' },
    writeOff: { amount: 'Diferencia de pago', date: 'última fecha de pago' },
  },
  {
    invoices: 'RRHH_Nómina', ref: 'Referencia', amount: ['Salario', 'Descuento Asistencia', 'Descuento Salario Mipyme'], date: 'Fecha',
    payments: { table: 'RRHH_Nómina_Pagos', ref: 'Referencia', amount: 'Pagado USD', date: 'Fecha' },
  },
  {
    invoices: 'Deuda_CxC_generales', ref: 'Referencia', amount: ['A cobrar USD'], date: 'Fecha',
    payments: { table: 'Deuda_CxC_generales', ref: 'Referencia_3', amount: 'Cobrado USD', date: 'Fecha_1' },
  },
  {
    invoices: 'Deuda_CxP_generales', ref: 'Referencia', amount: ['A pagar USD'], date: 'Fecha',
    payments: { table: 'Deuda_CxP_generales', ref: 'Referencia_3', amount: 'Pagado USD', date: 'Fecha_1' },
  },
];

/**
 * Partidas abiertas a partir de las tablas con referencia (facturas de proveedores, nómina y CxC/CxP
 * generales) y su liquidación con los pagos que las citan. Es información de casación: los importes
 * ya están contabilizados por las aportaciones al BC.
 */
async function buildOpenItems(
  prisma: PrismaClient,
  p: {
    contributions: Contribution[];
    partyAccountOf: (c: Contribution) => Promise<string>;
    docOfRow: (sheet: string, row: number) => string[];
    openingDocs: Map<string, string>;
    openingDate: string;
    maxDate: string;
    issues: string[];
  },
) {
  const stats = { openItems: 0, settlements: 0, writeOffs: 0, paymentsWithoutInvoice: 0 };
  const byRow = groupBy(p.contributions, (c) => `${c.table}|${c.excelRow}`);
  for (const src of OPEN_ITEM_SOURCES) {
    const items = new Map<string, { id: string; open: ReturnType<typeof money>; currency: string }>();
    const invoiceRows = [...byRow.entries()].filter(([k]) => k.startsWith(`${src.invoices}|`)).map(([, cs]) => cs);
    for (const cs of invoiceRows) {
      const c = cs[0]!;
      const ref = asString(c.values[src.ref]);
      const date = asIsoDate(c.values[src.date]);
      if (!ref || !date || date > p.maxDate) continue;
      const total = src.amount.reduce((s, col) => s.plus(money(excelNumber(c.values[col]) ?? 0)), money(0));
      if (roundAmount(total).isZero()) continue;
      // Signo contable: la factura de proveedor o la nómina es un abono (−); la CxC es un cargo (+).
      const signed = c.target.sign === 1 && src.invoices === 'Deuda_CxC_generales' ? total : total.neg();
      const paId = await p.partyAccountOf(c);
      const docId = date <= p.openingDate ? p.openingDocs.get(paId) : p.docOfRow(c.sheet, c.excelRow)[0];
      if (!docId) continue;
      const item = await withTx(prisma, {}, (tx) => createOpenItem(tx, {
        partyAccountId: paId, documentId: docId, date, amount: roundAmount(signed).toFixed(4), amountUsd: roundAmount(signed).toFixed(4),
        reference: ref, description: describe(c),
      }));
      items.set(ref.toLowerCase(), { id: item.id, open: roundAmount(total).abs(), currency: item.currency });
      stats.openItems++;
    }
    // Pagos (y diferencias de cierre) en orden de fecha.
    const events: { ref: string; amount: ReturnType<typeof money>; date: string; kind: 'PAYMENT' | 'WRITE_OFF'; docId: string | null; note: string }[] = [];
    for (const [k, cs] of byRow) {
      const c = cs[0]!;
      if (k.startsWith(`${src.payments.table}|`)) {
        const ref = asString(c.values[src.payments.ref]);
        const date = asIsoDate(c.values[src.payments.date]);
        const amount = money(excelNumber(c.values[src.payments.amount]) ?? 0).abs();
        if (ref && date && !amount.isZero()) {
          const docs = p.docOfRow(c.sheet, c.excelRow);
          events.push({ ref, amount, date, kind: 'PAYMENT', docId: date > p.openingDate ? docs[docs.length - 1] ?? null : null, note: `Migración: ${c.sheet} fila ${c.excelRow}` });
        }
      }
      if (src.writeOff && k.startsWith(`${src.invoices}|`)) {
        const ref = asString(c.values[src.ref]);
        const date = asIsoDate(c.values[src.writeOff.date]);
        const amount = money(excelNumber(c.values[src.writeOff.amount]) ?? 0).abs();
        if (ref && date && !amount.isZero()) events.push({ ref, amount, date, kind: 'WRITE_OFF', docId: null, note: `Diferencia de pago al cierre (${c.sheet} fila ${c.excelRow})` });
      }
    }
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const e of events) {
      if (e.date > p.maxDate) continue;
      const item = items.get(e.ref.toLowerCase());
      if (!item) { stats.paymentsWithoutInvoice++; continue; }
      const apply = e.amount.gt(item.open) ? item.open : e.amount;
      if (roundAmount(apply).lte(0)) continue;
      try {
        await withTx(prisma, {}, (tx) => settleOpenItem(tx, {
          openItemId: item.id, amount: roundAmount(apply).toFixed(4), date: e.date, kind: e.kind, paymentDocumentId: e.docId, note: e.note,
        }));
        item.open = item.open.minus(roundAmount(apply));
        if (e.kind === 'WRITE_OFF') stats.writeOffs++;
        else stats.settlements++;
      } catch (err) {
        p.issues.push(`Liquidación de ${e.ref}: ${(err as Error).message}`);
      }
    }
  }
  return stats;
}

/** Mueve a la cuenta puente los movimientos de la bandeja cuyas categorías son pagos de deudas. */
async function moveTreasuryDebtsToBridge(prisma: PrismaClient, bridge: (companyId: string) => Promise<string>, issues: string[]) {
  const cats = (await prisma.cashCategory.findMany()).filter((c) => DEBT_CATEGORY.test(c.code));
  const parties = await prisma.party.findMany({ include: { accounts: true } });
  const partyFor = (code: string) => {
    const name = code.replace(/^(DEUDA_?|ENVIO_)/, '');
    if (!name) return null;
    return parties.find((p) => p.code === name) ?? parties.find((p) => p.code.startsWith(`${name}_`)) ?? null;
  };
  let moved = 0;
  let withParty = 0;
  for (const cat of cats) {
    const party = partyFor(cat.code);
    // Para los movimientos nuevos, la categoría apunta a la cuenta corriente USD de la contraparte (si es única).
    const usd = party?.accounts.filter((a) => a.currency === 'USD') ?? [];
    if (usd.length === 1 && !cat.partyAccountId) {
      await prisma.cashCategory.update({ where: { id: cat.id }, data: { partyAccountId: usd[0]!.id, kind: 'DEBT' } });
    }
    const pending = await prisma.treasuryMovement.findMany({ where: { categoryId: cat.id, needsReview: true }, include: { document: true } });
    for (let i = 0; i < pending.length; i += 200) {
      const chunk = pending.slice(i, i + 200);
      await withTx(prisma, { timeoutMs: 300_000 }, async (tx) => {
        for (const m of chunk) {
          await reclassifyMovement(tx, m.id, {
            accountId: await bridge(m.document.companyId), partyId: party?.id ?? null,
            note: `Migración: pago de deuda (${cat.name}) a la cuenta puente; ya consta en la hoja de deudas del Excel`,
          });
        }
      });
      moved += chunk.length;
      if (party) withParty += chunk.length;
    }
  }
  if (!cats.length) issues.push('No hay categorías de deudas en tesorería');
  return { trayToBridge: moved, trayToBridgeWithParty: withParty };
}

/** Fila guardada en import_row.raw → valores como los da exceljs (las fechas y los números con formato de fecha). */
function hydrate(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ? new Date(v) : v]));
}

/**
 * Movimientos de caja y bancos frente a las cuentas de ventas y gastos:
 * - los que el BC suma en una de estas cuentas (p. ej. 828 Asesoría = filas de Banco_Emp_Exterior con
 *   referencia "Asesoría") se llevan a ella (desde la bandeja o desde otra cuenta). Se evalúan los mismos
 *   criterios de la fórmula sobre la fila original del Excel;
 * - los que la migración de tesorería llevó por su categoría a una cuenta que el Excel calcula desde otras
 *   hojas (ventas de distribución, salarios, impuestos…) pasan a la cuenta puente: el ingreso o gasto ya lo
 *   contabilizan las filas de esas hojas y el cobro o pago queda en el puente, como las deudas de la fase 3.
 */
async function applyTrayRules(
  prisma: PrismaClient,
  rules: { accountId: string; code: string; terms: LinearTerm[] }[],
  scopeAccountIds: Set<string>,
  bridge: (companyId: string) => Promise<string>,
  issues: string[],
  log: (m: string) => void,
) {
  // La bandeja y todos los movimientos menos los que la fase 3 dejó en cuentas corrientes de deudas. Los que dejó en
  // la cuenta puente por su categoría sí entran: si el BC suma la fila en una cuenta de gastos (831.9990 "Comisión
  // Distribución" del banco), manda la fórmula del BC.
  const debtAccounts = (await prisma.account.findMany({
    where: { code: { in: DEBT_CODES }, NOT: { fullCode: { in: ['699.9995', '699.9998'] } } }, select: { id: true },
  })).map((a) => a.id);
  const candidates = await prisma.treasuryMovement.findMany({
    where: { OR: [{ needsReview: true }, { counterAccountId: null }, { counterAccountId: { notIn: debtAccounts } }] },
    include: { document: true },
  });
  const rows = await prisma.importRow.findMany({
    where: { id: { in: candidates.map((m) => m.document.importRowId).filter((x): x is string => !!x) } },
    select: { id: true, sheet: true, raw: true },
  });
  const rowById = new Map(rows.map((r) => [r.id, r]));
  let moved = 0;
  let toBridge = 0;
  const byAccount = new Map<string, number>();
  for (let i = 0; i < candidates.length; i += 200) {
    const chunk = candidates.slice(i, i + 200);
    await withTx(prisma, { timeoutMs: 300_000 }, async (tx) => {
      for (const m of chunk) {
        const row = m.document.importRowId ? rowById.get(m.document.importRowId) : undefined;
        const raw = hydrate((row?.raw ?? {}) as Record<string, unknown>);
        const hits = row ? rules.filter((r) => r.terms.some((t) => t.sheet === row.sheet && t.criteria.every((c) => criterionMatches(raw[c.column], c.value)))) : [];
        const accounts = [...new Set(hits.map((h) => h.accountId))];
        if (accounts.length > 1) {
          issues.push(`${row!.sheet}: movimiento ${m.document.number} coincide con varias cuentas (${hits.map((h) => h.code).join(', ')}); no se reclasifica`);
          continue;
        }
        if (accounts.length === 1) {
          if (accounts[0] === m.counterAccountId) continue;
          await reclassifyMovement(tx, m.id, { accountId: accounts[0]!, allowResolved: true, note: `Migración: el BC del Excel suma esta fila en ${hits[0]!.code}` });
          byAccount.set(hits[0]!.code, (byAccount.get(hits[0]!.code) ?? 0) + 1);
          moved++;
          continue;
        }
        if (m.needsReview || !m.counterAccountId || !scopeAccountIds.has(m.counterAccountId)) continue;
        await reclassifyMovement(tx, m.id, {
          accountId: await bridge(m.document.companyId), allowResolved: true,
          note: 'Migración: el Excel calcula esta cuenta desde las hojas de ventas, nómina o impuestos; el cobro o pago queda en la cuenta puente',
        });
        toBridge++;
      }
    });
  }
  log(`Tesorería → cuentas de ventas y gastos: ${moved} (${[...byAccount].map(([k, v]) => `${k}: ${v}`).join(', ')}); → cuenta puente: ${toBridge}`);
  return { trayToAccounts: moved, treasuryToBridge: toBridge };
}
