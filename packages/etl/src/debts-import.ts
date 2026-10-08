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
import { money, roundAmount } from '@kaluch/shared';
import {
  createOpenItem, ensureSystemAccounts, postPartyDocument, reclassifyBySign, reclassifyMovement,
  resolveMapping, revalueMonth, settleOpenItem, upsertParty, upsertPartyAccount, withTx,
  PARTY_BRIDGE_MAPPING, type PartyDocKind, type PartyRole, type PrismaClient,
} from '@kaluch/db';
import type ExcelJS from 'exceljs';
import { basename } from 'node:path';
import { slug } from './categories';
import { criterionMatches, isNegationOf, linearize, normalize, UnsupportedFormula, type LinearForm, type LinearTerm } from './linear';
import { asIsoDate, asString, excelNumber, readCell, type loadWorkbook } from './workbook';

type Workbook = Awaited<ReturnType<typeof loadWorkbook>>;

export const DEBT_CODES = ['135', '146', '405', '406', '407', '408', '409', '410', '411', '412', '413', '455', '699'];

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
  if (code.startsWith('410')) return 'SELLER';
  if (code.startsWith('411')) return 'LENDER';
  if (code.startsWith('412')) return 'INVESTOR';
  if (/^(406|407|408|409|413|146)/.test(code)) return 'SUPPLIER';
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

function readTable(idx: ReturnType<typeof tableIndex>, name: string): TableData | null {
  const t = idx.get(name);
  if (!t) return null;
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(t.ref);
  if (!m) return null;
  const c0 = colNumber(m[1]!), r0 = Number(m[2]), r1 = Number(m[4]);
  const columns = t.columns.length ? t.columns : [];
  if (!columns.length) for (let c = c0; c <= colNumber(m[3]!); c++) columns.push(asString(readCell(t.ws, r0, c).value) ?? `Col${c}`);
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
}

export interface DebtImportOptions {
  openingDate: string;
  /** Empresa por defecto de las deudas (las filas con columna Empresa usan la suya). */
  debtCompany: string;
  maxDate: string;
  revalueFrom: string;
  revalueUntil: string | null;
  log?: (msg: string) => void;
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

export async function importDebts(prisma: PrismaClient, w: Workbook, file: string, opts: DebtImportOptions) {
  const log = opts.log ?? (() => {});
  if ((await prisma.partyDocument.count()) > 0) {
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
  const accounts = await prisma.account.findMany({ where: { code: { in: DEBT_CODES }, postable: true } });
  const byRow = new Map(accounts.map((a) => [a.sortOrder, a]));
  const forms: { acc: (typeof accounts)[number]; form: LinearForm }[] = [];
  for (let r = 3; r <= bc.rowCount; r++) {
    const acc = byRow.get(r);
    if (!acc) continue;
    const f = readCell(bc, r, col).formula;
    if (!f) continue;
    try {
      const form = normalize(linearize(f, (row) => readCell(bc, row, col).formula ?? null));
      if (form.terms.some((t) => t.monthly)) {
        issues.push(`${acc.displayCode}: fórmula de importes del mes (no acumulada); no se migran filas`);
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
      opposite = forms.find((o) => o.acc.id !== acc.id && o.form.split && isNegationOf(o.form, form));
      if (!opposite) {
        issues.push(`${acc.displayCode}: saldo partido por signo sin cuenta opuesta; se migra como cuenta simple`);
      }
    }
    // En un par la cuenta principal es la de activo (135.x, 146.0002); su forma da el importe.
    const main = opposite && acc.classification !== 'AC' && opposite.acc.classification === 'AC' ? opposite : { acc, form };
    const other = main.acc.id === acc.id ? opposite : { acc, form };
    used.add(acc.id);
    if (opposite) used.add(opposite.acc.id);
    const currency = /^([A-Z]{3})\//.exec(main.form.rateColumn ?? '')?.[1] ?? 'USD';
    const sharedByRow = main.form.terms.every((t) => PARTY_COLUMNS[t.sheet]);
    targets.push({
      accountId: main.acc.id, code: main.acc.displayCode, name: main.acc.name, oppositeId: other?.acc.id ?? null, form: main.form,
      sign: main.acc.classification === 'AC' ? 1 : -1, currency,
      fixedParty: sharedByRow && !other ? null : FIXED_PARTY[main.acc.displayCode] ?? (main.acc.code === '699' ? null : partyFromAccountName(main.acc.name)),
    });
  }
  log(`Cuentas en alcance: ${targets.length} (${targets.filter((t) => t.oppositeId).length} pares por signo)`);

  // 2. Aportaciones de cada fila.
  const idx = tableIndex(w.wb);
  const tables = new Map<string, TableData>();
  for (const name of new Set(targets.flatMap((t) => t.form.terms.map((x) => x.sheet)))) {
    const td = readTable(idx, name);
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
          const date = asIsoDate(row.values[term.dateColumn!]);
          if (!date) continue;
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
          const companyCode = COMPANY_ALIASES[empresa] ?? opts.debtCompany;
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

  const batch = await prisma.importBatch.create({ data: { sourceFile: basename(file), fileHash: w.hash, tableName: 'Deudas', stats: {} } });
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
  for (const c of contributions) {
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
  log(`Saldos de apertura: ${openingDocs.size} cuentas corrientes`);

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
    for (const g of chunk) { const ids: string[] = []; for (const c of g) ids.push(await partyAccountOf(c)); paIds.push(ids); }
    await withTx(prisma, { timeoutMs: 300_000 }, async (tx) => {
      for (const [k, g] of chunk.entries()) {
        const ids = paIds[k]!;
        const first = g[0]!;
        const desc = describe(first);
        // Cesión de deuda: dos cuentas corrientes de la misma moneda con importes opuestos (zelle Invictus).
        if (g.length === 2 && g[0]!.target.currency === g[1]!.target.currency && roundAmount(g[0]!.amount.plus(g[1]!.amount)).isZero()) {
          const r = await postPartyDocument(tx, {
            partyAccountId: ids[0]!, counterPartyAccountId: ids[1]!, date: first.date, kind: 'ASSIGNMENT', amount: roundAmount(g[0]!.amount).toFixed(4),
            description: `Cesión de deuda: ${desc}`, importRowId: takeImportRow(first),
          });
          remember(rowDocs, first, r.document.id);
          counters.assignments++;
          continue;
        }
        for (const [j, c] of g.entries()) {
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

  // 6. Filas sin aportación posterior a la apertura en tablas con importes fuera de alcance: nada que hacer.
  // 7. Partidas abiertas: facturas de proveedores, nómina y CxC/CxP generales con sus pagos.
  const openItems = await buildOpenItems(prisma, { contributions, partyAccountOf, docOfRow, openingDocs, openingDate: opts.openingDate, maxDate: opts.maxDate, issues });

  // 8. Pagos de estas deudas en tesorería (bandeja de revisión) → cuenta puente, con contraparte.
  const trayStats = await moveTreasuryDebtsToBridge(prisma, bridge, issues);

  // 9. Revaluación (efectivo y cuentas corrientes) y reclasificación por signo, mes a mes.
  const monthly: { company: string; month: string; revalUsd: string; reclassUsd: string }[] = [];
  if (opts.revalueUntil) {
    const companyIds = [...new Set([
      ...(await prisma.partyAccount.findMany({ select: { companyId: true } })).map((p) => p.companyId),
      ...(await prisma.treasuryAccount.findMany({ select: { companyId: true } })).map((t) => t.companyId),
    ])];
    const [fy, fm] = opts.revalueFrom.split('-').map(Number) as [number, number];
    const [uy, um] = opts.revalueUntil.split('-').map(Number) as [number, number];
    for (let y = fy, m = fm; y < uy || (y === uy && m <= um); m === 12 ? (y++, (m = 1)) : m++) {
      for (const companyId of companyIds) {
        const rv = await withTx(prisma, { timeoutMs: 300_000 }, (tx) => revalueMonth(tx, companyId, y, m));
        const rc = await withTx(prisma, { timeoutMs: 300_000 }, (tx) => reclassifyBySign(tx, companyId, y, m));
        const code = [...companies.values()].find((c) => c.id === companyId)!.code;
        monthly.push({ company: code, month: `${String(m).padStart(2, '0')}/${y}`, revalUsd: rv.totalUsd, reclassUsd: rc.movedUsd });
      }
    }
  }

  const stats = {
    ...counters, ...openItems, ...trayStats, parties: await prisma.party.count(), partyAccounts: await prisma.partyAccount.count(),
  };
  await prisma.importBatch.update({ where: { id: batch.id }, data: { stats: { ...stats, issues: issues.slice(0, 500) } } });
  return { stats, issues, monthly };
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
  return `${c.partyName}: ${parts.join(' · ') || c.table} [${c.sheet} fila ${c.excelRow}]`.slice(0, 480);
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
