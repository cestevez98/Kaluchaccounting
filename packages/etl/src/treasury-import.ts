import { DEFAULT_RATE_TYPES, money, roundAmount } from '@kaluch/shared';
import {
  ensureSystemAccounts, postTreasuryMovement, revalueMonth, upsertAccounts, withTx,
  type PrismaClient, type TreasuryKind,
} from '@kaluch/db';
import type ExcelJS from 'exceljs';
import { basename } from 'node:path';
import { guessKind, knownCategoryFor, normalizeReference, slug } from './categories';
import { OMITTED_ACCOUNTS } from './coa';
import { parseSumifs, termMatchesRow, type SumTerm } from './formula';
import { asIsoDate, asString, excelNumber, readCell, type loadWorkbook } from './workbook';

type Workbook = Awaited<ReturnType<typeof loadWorkbook>>;

export const TREASURY_SHEETS = ['Efectivo_Caja', 'Banco_Emp_Exterior', 'Banco_Emp_Cuba', 'Banco_Pers_Exterior', 'Banco_Pers_Cuba'] as const;
const TREASURY_CODES = new Set(['101', '109', '110', '111', '112', '113', '114']);
const DATE_COLS = ['FECHA', 'Fecha'];
const DESC_COLS = ['DETALLE', 'Concepto', 'Concepto/Desc, Movimiento'];
const REF_COLS = ['Referencia Cruzada', 'Referencia cruzada'];
const EXTRA_COLS = ['Columna1', 'Columna2', 'Clasificación2', 'Clasificación3'];
/** Propietario (texto del Excel) → empresa. Las hojas de bancos personales van a SOC (decisión P1). */
const OWNER_COMPANY: Record<string, string> = {
  'kaluch export': 'KEI', 'kaluch travel': 'KTR', 'kaluch global': 'KGT', 'grupo roca': 'GR', dmilio: 'DM',
};
const HEADER_FALLBACK_COMPANY: Record<string, string> = { '109': 'KEI', '110': 'KGT', '111': 'GR' };
const WALLETS = /stripe|tropipay|zelle/i;

export interface TreasuryImportOptions {
  /** Fecha de los saldos de apertura (decisión P7). */
  openingDate: string;
  /** Empresa a la que pertenece la caja (Efectivo_Caja no indica propietario). */
  cashCompany: string;
  /** Último mes a revaluar (AAAA-MM); null = no revaluar. */
  revalueUntil: string | null;
  /** Fecha máxima admitida en los movimientos. */
  maxDate: string;
  log?: (msg: string) => void;
}

interface SheetRow {
  sheet: string;
  excelRow: number;
  date: string | null;
  values: Record<string, unknown>;
}

interface TAccount {
  id: string;
  companyId: string;
  companyCode: string;
  glCode: string;
  currency: string;
  sheet: string;
  terms: SumTerm[];
  createdByEtl: boolean;
}

function readSheet(ws: ExcelJS.Worksheet, sheet: string): SheetRow[] {
  const header: (string | null)[] = [];
  for (let c = 1; c <= ws.columnCount; c++) header.push(asString(readCell(ws, 1, c).value));
  const rows: SheetRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const values: Record<string, unknown> = {};
    let any = false;
    header.forEach((h, i) => {
      if (!h) return;
      const v = readCell(ws, r, i + 1).value;
      if (v !== null && v !== undefined && v !== '') any = true;
      values[h] = v;
    });
    if (!any) continue;
    const dateCol = DATE_COLS.find((c) => c in values);
    rows.push({ sheet, excelRow: r, date: dateCol ? asIsoDate(values[dateCol]) : null, values });
  }
  return rows;
}

const pick = (v: Record<string, unknown>, cols: string[]) => {
  for (const c of cols) {
    const s = asString(v[c]);
    if (s) return s;
  }
  return null;
};

export async function importTreasury(prisma: PrismaClient, w: Workbook, file: string, opts: TreasuryImportOptions) {
  const log = opts.log ?? (() => {});
  if ((await prisma.treasuryMovement.count()) > 0) {
    throw new Error('Ya hay movimientos de tesorería en esta base: la migración de tesorería se ejecuta sobre una base recién importada');
  }
  const issues: string[] = [];
  const { missing } = await ensureSystemAccounts(prisma);
  if (missing.length) issues.push(`Mapeos contables sin cuenta: ${missing.join(', ')}`);
  const companies = new Map((await prisma.company.findMany()).map((c) => [c.code, c]));
  const companyOf = (code: string) => {
    const c = companies.get(code);
    if (!c) throw new Error(`Empresa ${code} no existe`);
    return c;
  };

  // 1. Cuentas de tesorería a partir de las fórmulas del BC.
  const bc = w.wb.getWorksheet('BC');
  if (!bc) throw new Error('No se encuentra la hoja BC');
  let firstMonthCol = 7;
  for (let c = 7; c <= bc.columnCount; c++) {
    if (Number(readCell(bc, 2, c).value) >= 1) { firstMonthCol = c; break; }
  }
  const glAccounts = await prisma.account.findMany({ where: { code: { in: [...TREASURY_CODES] } } });
  const byRow = new Map(glAccounts.map((a) => [a.sortOrder, a]));
  const details: TAccount[] = [];
  const headers: { code: string; glId: string; terms: SumTerm[] }[] = [];

  for (let r = 3; r <= bc.rowCount; r++) {
    const gl = byRow.get(r);
    if (!gl) continue;
    const terms = parseSumifs(readCell(bc, r, firstMonthCol).formula);
    if (!gl.subcode) {
      headers.push({ code: gl.code, glId: gl.id, terms });
      continue;
    }
    if (OMITTED_ACCOUNTS[gl.displayCode]) continue;
    if (terms.length === 0) {
      issues.push(`${gl.displayCode}: la fórmula del BC no tiene SUMIFS reconocibles`);
      continue;
    }
    const sheets = new Set(terms.map((t) => t.sheet));
    const currencies = new Set(terms.map((t) => t.currency));
    if (sheets.size > 1 || currencies.size > 1) issues.push(`${gl.displayCode}: la fórmula mezcla hojas o monedas`);
    const t0 = terms[0]!;
    const crit = Object.fromEntries(t0.criteria.map((c) => [c.column, c.value]));
    const owner = crit.Propietario ?? null;
    const bank = crit.Banco ?? null;
    const companyCode =
      t0.sheet === 'Efectivo_Caja' ? opts.cashCompany
        : t0.sheet.startsWith('Banco_Pers') ? 'SOC'
          : OWNER_COMPANY[(owner ?? '').toLowerCase()] ?? HEADER_FALLBACK_COMPANY[gl.code] ?? 'SOC';
    const company = companyOf(companyCode);
    const kind: TreasuryKind = t0.sheet === 'Efectivo_Caja' ? 'CASH' : WALLETS.test(bank ?? '') ? 'WALLET' : 'BANK';
    const ta = await prisma.treasuryAccount.upsert({
      where: { glAccountId: gl.id },
      update: {},
      create: {
        companyId: company.id, glAccountId: gl.id, kind, name: gl.name, currency: t0.currency ?? 'USD',
        ownerType: t0.sheet.startsWith('Banco_Pers') ? 'PARTNER' : 'COMPANY', ownerName: owner,
        country: crit['País'] ?? null, bank, last4: gl.subcode, sourceSheet: t0.sheet,
        sourceFilter: terms as unknown as object,
      },
    });
    details.push({ id: ta.id, companyId: company.id, companyCode, glCode: gl.displayCode, currency: ta.currency, sheet: t0.sheet, terms, createdByEtl: false });
  }
  log(`Cuentas de tesorería desde fórmulas del BC: ${details.length}`);

  // 2. Asignación fila → cuenta, con los mismos criterios que SUMIFS.
  const autoAccounts = new Map<string, TAccount>();
  async function autoAccount(header: { code: string; glId: string }, sheet: string, column: string, currency: string, row: Record<string, unknown>, outsideBc: boolean) {
    const owner = asString(row.Propietario);
    const bank = asString(row.Banco);
    const key = `${header.code}|${sheet}|${(owner ?? '').toLowerCase()}|${(bank ?? '').toLowerCase()}|${currency}`;
    const existing = autoAccounts.get(key);
    if (existing) return existing;
    const siblings = await prisma.account.findMany({ where: { code: header.code } });
    const used = new Set(siblings.map((s) => s.subcode));
    let n = 9101;
    while (used.has(String(n))) n++;
    const sameCur = siblings.find((s) => s.currencyLock === currency && s.revalRateType);
    const rateType = currency === 'USD' ? null : sameCur?.revalRateType ?? DEFAULT_RATE_TYPES[currency] ?? null;
    const name = `Efectivo en Banco ${currency} - ${bank ?? 'sin banco'} ${owner ?? 'sin propietario'} (creada en migración)`;
    await upsertAccounts(prisma, [{
      code: header.code, subcode: String(n), name, nature: 'DEUDORA', classification: 'AC', currencyLock: currency,
      revalRateType: rateType, sortOrder: 900_000 + n,
      anomaly: outsideBc
        ? `Creada en la migración: el BC no incluye estos movimientos de ${sheet} en ninguna cuenta`
        : `Creada en la migración: el BC solo incluye estos movimientos de ${sheet} en el total ${header.code}`,
    }]);
    const gl = await prisma.account.findUniqueOrThrow({ where: { fullCode: `${header.code}.${n}` } });
    await prisma.account.update({ where: { id: gl.id }, data: { parentId: header.glId } });
    const companyCode = sheet === 'Efectivo_Caja' ? opts.cashCompany
      : sheet.startsWith('Banco_Pers') ? 'SOC'
        : OWNER_COMPANY[(owner ?? '').toLowerCase()] ?? HEADER_FALLBACK_COMPANY[header.code] ?? 'SOC';
    const company = companyOf(companyCode);
    const ta = await prisma.treasuryAccount.create({
      data: {
        companyId: company.id, glAccountId: gl.id, kind: WALLETS.test(bank ?? '') ? 'WALLET' : 'BANK', name, currency,
        ownerType: sheet.startsWith('Banco_Pers') ? 'PARTNER' : 'COMPANY', ownerName: owner, bank, last4: String(n),
        sourceSheet: sheet, sourceFilter: { owner, bank, column, outsideBc }, createdByEtl: true,
      },
    });
    const acc: TAccount = { id: ta.id, companyId: company.id, companyCode, glCode: gl.displayCode, currency, sheet, terms: [], createdByEtl: true };
    autoAccounts.set(key, acc);
    issues.push(`Cuenta creada ${gl.displayCode}: ${name}${outsideBc ? ' — fuera del BC' : ''}`);
    return acc;
  }

  const allRows: SheetRow[] = [];
  for (const sheet of TREASURY_SHEETS) {
    const ws = w.wb.getWorksheet(sheet);
    if (!ws) {
      issues.push(`No se encuentra la hoja ${sheet}`);
      continue;
    }
    const rows = readSheet(ws, sheet);
    allRows.push(...rows);
    log(`${sheet}: ${rows.length} filas`);
  }

  const batch = await prisma.importBatch.create({
    data: { sourceFile: basename(file), fileHash: w.hash, tableName: 'Tesoreria', stats: {} },
  });

  interface Leg { account: TAccount; amount: ReturnType<typeof money> }
  interface Prepared { row: SheetRow; legs: Leg[]; omitted: string[]; error?: string }
  const prepared: Prepared[] = [];
  for (const row of allRows) {
    const legs = new Map<string, Leg>();
    const omitted: string[] = [];
    let error: string | undefined;
    for (const [column, raw] of Object.entries(row.values)) {
      if (!/^(Entradas?|Salidas?) [A-Z]{3}$/.test(column)) continue;
      if (raw === null || raw === undefined || raw === '' || raw === 0) continue;
      // SUMIFS solo suma celdas numéricas: el texto (aunque parezca un número) se ignora.
      const value = excelNumber(raw) ?? Number.NaN;
      if (typeof raw === 'string' && raw.trim() === '') continue;
      if (!Number.isFinite(value)) {
        // SUMIFS ignora las celdas con texto: se ignora el valor y se avisa.
        issues.push(`${row.sheet} fila ${row.excelRow}: valor no numérico en ${column} ("${String(raw)}"), ignorado como en el Excel`);
        continue;
      }
      const currency = column.slice(-3);
      const matches = details.filter((d) => d.sheet === row.sheet && d.terms.some((t) => t.column === column && termMatchesRow(t, row.values)));
      let account: TAccount | undefined;
      let sign: 1 | -1 | undefined;
      if (matches.length > 0) {
        if (matches.length > 1) issues.push(`${row.sheet} fila ${row.excelRow}: coincide con varias cuentas (${matches.map((m) => m.glCode).join(', ')}); se usa ${matches[0]!.glCode}`);
        account = matches[0]!;
        sign = account.terms.find((t) => t.column === column && termMatchesRow(t, row.values))!.sign;
      } else {
        if (row.sheet === 'Efectivo_Caja' && currency === 'CAD') {
          omitted.push(`${column} ${value}`);
          continue;
        }
        const hdrs = headers.filter((h) => h.terms.some((t) => t.sheet === row.sheet && t.column === column));
        const hit = hdrs.find((h) => h.terms.some((t) => t.sheet === row.sheet && t.column === column && termMatchesRow(t, row.values)));
        const header = hit ?? hdrs[0];
        if (!header) {
          error = `No hay cuenta del BC para ${row.sheet}[${column}]`;
          continue;
        }
        const term = header.terms.find((t) => t.sheet === row.sheet && t.column === column)!;
        sign = term.sign;
        account = await autoAccount(header, row.sheet, column, currency, row.values, !hit);
      }
      const prev = legs.get(account.id);
      const amount = money(value).times(sign!);
      legs.set(account.id, { account, amount: prev ? prev.amount.plus(amount) : amount });
    }
    const nonZero = [...legs.values()].filter((l) => !roundAmount(l.amount).isZero());
    if (!row.date && nonZero.length) error = error ?? 'Fila sin fecha';
    else if (row.date && (row.date > opts.maxDate || row.date < '2020-01-01')) error = error ?? `Fecha fuera de rango: ${row.date}`;
    prepared.push({ row, legs: nonZero, omitted, error });
  }

  // 3. Saldos de apertura (todo lo anterior o igual a la fecha de apertura).
  const opening = new Map<string, Leg>();
  const toPost: Prepared[] = [];
  const counters = { rows: prepared.length, opening: 0, movements: 0, review: 0, skipped: 0, errors: 0, omittedCad: 0 };
  for (const p of prepared) {
    if (p.omitted.length) counters.omittedCad++;
    if (p.error) continue;
    if (p.legs.length === 0) continue;
    if (p.row.date! <= opts.openingDate) {
      counters.opening++;
      for (const l of p.legs) {
        const prev = opening.get(l.account.id);
        opening.set(l.account.id, { account: l.account, amount: prev ? prev.amount.plus(l.amount) : l.amount });
      }
    } else {
      toPost.push(p);
    }
  }

  // Filas de importación (trazabilidad); los ids se enlazan a los documentos.
  const importRowIds = new Map<SheetRow, string>();
  for (let i = 0; i < prepared.length; i += 1000) {
    const chunk = prepared.slice(i, i + 1000);
    const created = await prisma.importRow.createManyAndReturn({
      data: chunk.map((p) => ({
        batchId: batch.id, sheet: p.row.sheet, excelRow: p.row.excelRow,
        raw: JSON.parse(JSON.stringify(p.row.values)),
        status: p.error ? 'ERROR' : p.legs.length === 0 ? 'SKIPPED' : 'OK',
        message: p.error ?? (p.omitted.length ? `Omitido (caja CAD): ${p.omitted.join(', ')}` : p.legs.length === 0 ? 'Sin importes' : p.row.date! <= opts.openingDate ? 'Incluida en saldo de apertura' : null),
      })),
      select: { id: true, sheet: true, excelRow: true },
    });
    const byKey = new Map(created.map((c) => [`${c.sheet}|${c.excelRow}`, c.id]));
    for (const p of chunk) importRowIds.set(p.row, byKey.get(`${p.row.sheet}|${p.row.excelRow}`)!);
  }
  counters.errors = prepared.filter((p) => p.error).length;
  counters.skipped = prepared.filter((p) => !p.error && p.legs.length === 0).length;

  const byCompany = new Map<string, Leg[]>();
  for (const l of opening.values()) {
    if (roundAmount(l.amount).isZero()) continue;
    byCompany.set(l.account.companyId, [...(byCompany.get(l.account.companyId) ?? []), l]);
  }
  for (const [companyId, legs] of byCompany) {
    await withTx(prisma, { timeoutMs: 120_000 }, (tx) =>
      postTreasuryMovement(tx, {
        companyId, date: opts.openingDate, kind: 'OPENING',
        description: `Saldos de apertura de tesorería al ${opts.openingDate.split('-').reverse().join('/')} (migración)`,
        legs: legs.map((l) => ({ treasuryAccountId: l.account.id, amount: roundAmount(l.amount).toFixed(4) })),
      }),
    );
  }
  log(`Saldos de apertura: ${byCompany.size} empresas, ${opening.size} cuentas`);

  // 4. Categorías.
  const categoryIds = new Map<string, string>();
  async function categoryFor(sheet: string, ref: string | null): Promise<string | null> {
    const norm = normalizeReference(ref);
    if (!norm) return null;
    const known = knownCategoryFor(sheet, norm);
    const code = known?.code ?? slug(norm);
    const cached = categoryIds.get(code);
    if (cached) return cached;
    let accountId: string | null = null;
    for (const c of known?.accounts ?? []) {
      const a = await prisma.account.findFirst({ where: { fullCode: c, postable: true } });
      if (a) { accountId = a.id; break; }
    }
    const segment = known?.segment ? await prisma.segment.findUnique({ where: { code: known.segment } }) : null;
    const original = String(ref).trim();
    const cat = await prisma.cashCategory.upsert({
      where: { code },
      update: {},
      create: {
        code, name: known?.name ?? original, kind: known?.kind ?? guessKind(norm), accountId,
        segmentId: segment?.id ?? null, cashFlowCategory: known?.flow ?? 'OPER', aliases: [original],
      },
    });
    if (!cat.aliases.includes(original)) {
      await prisma.cashCategory.update({ where: { id: cat.id }, data: { aliases: [...cat.aliases, original] } });
    }
    categoryIds.set(code, cat.id);
    return cat.id;
  }

  // 5. Movimientos posteriores a la apertura.
  toPost.sort((a, b) => (a.row.date! < b.row.date! ? -1 : a.row.date! > b.row.date! ? 1 : a.row.excelRow - b.row.excelRow));
  const BATCH = 150;
  for (let i = 0; i < toPost.length; i += BATCH) {
    const chunk = toPost.slice(i, i + BATCH);
    // Secuencial: varias filas pueden crear la misma categoría.
    const cats: (string | null)[] = [];
    for (const p of chunk) cats.push(await categoryFor(p.row.sheet, pick(p.row.values, REF_COLS)));
    const results = await withTx(prisma, { timeoutMs: 300_000 }, async (tx) => {
      const out: boolean[] = [];
      for (const [k, p] of chunk.entries()) {
        const companies = new Set(p.legs.map((l) => l.account.companyId));
        const categoryId = cats[k] ?? null;
        const category = categoryId ? await tx.cashCategory.findUnique({ where: { id: categoryId } }) : null;
        const extras = EXTRA_COLS.map((c) => asString(p.row.values[c])).filter(Boolean);
        const description = [pick(p.row.values, DESC_COLS) ?? '(sin concepto)', ...extras.map((e) => `[${e}]`)].join(' ').slice(0, 480);
        for (const companyId of companies) {
          const legs = p.legs.filter((l) => l.account.companyId === companyId);
          const isExchange = category?.kind === 'EXCHANGE' && legs.length > 1;
          const isTransfer = category?.kind === 'TRANSFER' && legs.length > 1;
          const r = await postTreasuryMovement(tx, {
            companyId, date: p.row.date!, kind: isExchange ? 'EXCHANGE' : isTransfer ? 'TRANSFER' : 'MOVEMENT',
            description, categoryId, sourceReference: pick(p.row.values, REF_COLS),
            importRowId: companies.size === 1 ? importRowIds.get(p.row) : null,
            legs: legs.map((l) => ({ treasuryAccountId: l.account.id, amount: roundAmount(l.amount).toFixed(4) })),
          });
          out.push(r.movement.needsReview);
        }
      }
      return out;
    });
    counters.movements += results.length;
    counters.review += results.filter(Boolean).length;
    if ((i / BATCH) % 10 === 0) log(`  movimientos ${Math.min(i + BATCH, toPost.length)}/${toPost.length}`);
  }

  // Marca en la bandeja las filas cuyos movimientos quedaron pendientes de clasificar.
  await prisma.$executeRaw`
    UPDATE import_row ir SET status = 'REVIEW', message = 'Pendiente de clasificar (bandeja de revisión)'
    FROM document d JOIN treasury_movement tm ON tm.id = d.id
    WHERE d.import_row_id = ir.id AND tm.needs_review AND ir.batch_id = ${batch.id}::uuid`;

  // 6. Revaluaciones mensuales.
  const revaluations: { company: string; month: string; totalUsd: string }[] = [];
  if (opts.revalueUntil) {
    const [uy, um] = opts.revalueUntil.split('-').map(Number) as [number, number];
    const [oy, om] = opts.openingDate.split('-').map(Number) as [number, number];
    const companyIds = [...new Set([...details, ...autoAccounts.values()].map((d) => d.companyId))];
    for (let y = oy, m = om + 1; y < uy || (y === uy && m <= um); m === 12 ? (y++, (m = 1)) : m++) {
      for (const companyId of companyIds) {
        const r = await withTx(prisma, { timeoutMs: 120_000 }, (tx) => revalueMonth(tx, companyId, y, m));
        const code = [...companies.values()].find((c) => c.id === companyId)!.code;
        revaluations.push({ company: code, month: `${String(m).padStart(2, '0')}/${y}`, totalUsd: r.totalUsd });
      }
    }
  }

  // 7. Explicaciones automáticas para la conciliación.
  await prisma.bcExplanation.deleteMany({ where: { reason: { startsWith: '[auto]' } } });
  await prisma.bcExplanation.createMany({
    data: [
      { fullCode: '101.0004', reason: '[auto] Caja CAD omitida por decisión P3 (el Excel la convertía con la tasa MLC)', approved: true },
      { fullCode: '101', reason: '[auto] El total de caja del Excel incluye la caja CAD, omitida por decisión P3', approved: true },
    ],
  });

  const stats = { ...counters, treasuryAccounts: details.length, createdAccounts: autoAccounts.size, categories: categoryIds.size };
  await prisma.importBatch.update({ where: { id: batch.id }, data: { stats: { ...stats, issues: issues.slice(0, 500) } } });
  return { stats, issues, revaluations };
}
