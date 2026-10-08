import { ROUNDING_MAPPING_KEY, upsertAccounts, type PrismaClient } from '@kaluch/db';
import { basename } from 'node:path';
import { parseChartOfAccounts } from './coa';
import { parseRates } from './rates';
import { loadWorkbook } from './workbook';

type Workbook = Awaited<ReturnType<typeof loadWorkbook>>;

function sheet(w: Workbook, name: string) {
  const ws = w.wb.getWorksheet(name);
  if (!ws) throw new Error(`No se encuentra la hoja "${name}" en el Excel`);
  return ws;
}

/** Plan de cuentas desde la hoja BC (+ cuenta de sistema para redondeos). */
export async function importChartOfAccounts(prisma: PrismaClient, w: Workbook, file: string) {
  const parsed = parseChartOfAccounts(sheet(w, 'BC'));
  const result = await upsertAccounts(prisma, parsed.accounts);
  // Cuenta de sistema para ajustes de redondeo (no existe en el Excel).
  const transit = await prisma.account.findFirst({ where: { code: '699', subcode: null } });
  if (transit) {
    await upsertAccounts(prisma, [
      { code: '699', subcode: '9999', name: 'Redondeo del sistema', nature: 'MIXTA', classification: 'CC', sortOrder: 999_999, anomaly: 'Cuenta de sistema (no existe en el Excel)' },
    ]);
    const rounding = await prisma.account.findUniqueOrThrow({ where: { fullCode: '699.9999' } });
    // El 699 pasa a ser cuenta de grupo; sus filas de detalle del Excel siguen igual.
    await prisma.account.update({ where: { id: transit.id }, data: { postable: false } });
    await prisma.account.update({ where: { id: rounding.id }, data: { parentId: transit.id } });
    if (!(await prisma.accountMapping.findFirst({ where: { key: ROUNDING_MAPPING_KEY } }))) {
      await prisma.accountMapping.create({ data: { key: ROUNDING_MAPPING_KEY, accountId: rounding.id } });
    }
  }
  const stats = {
    accounts: parsed.accounts.length,
    created: result.created,
    updated: result.updated,
    duplicates: result.duplicates,
    anomalies: parsed.accounts.filter((a) => a.anomaly).map((a) => `${a.code}${a.subcode ? '.' + a.subcode : ''}: ${a.anomaly}`),
    withRevaluation: parsed.accounts.filter((a) => a.revalRateType).length,
  };
  await prisma.importBatch.create({ data: { sourceFile: basename(file), fileHash: w.hash, tableName: 'BC:plan', stats } });
  return { ...stats, issues: parsed.issues.filter((i) => !i.includes('error #')) };
}

/** Valores del BC por cuenta y mes (referencia para la conciliación de aceptación). */
export async function importBcReference(prisma: PrismaClient, w: Workbook, file: string) {
  const parsed = parseChartOfAccounts(sheet(w, 'BC'));
  const batch = await prisma.importBatch.create({
    data: {
      sourceFile: basename(file), fileHash: w.hash, tableName: 'BC:referencia',
      stats: { values: parsed.references.length, months: parsed.months.map((m) => `${m.month}/${m.year}`) },
    },
  });
  await prisma.bcReference.createMany({ data: parsed.references.map((r) => ({ ...r, importId: batch.id })) });
  const errors = parsed.issues.filter((i) => i.includes('error #'));
  return { importId: batch.id, values: parsed.references.length, months: parsed.months.length, excelErrors: errors };
}

/** Tasas diarias desde la hoja "Tasas". Con `overwrite` corrige valores existentes. */
export async function importRates(prisma: PrismaClient, w: Workbook, file: string, overwrite = false) {
  const parsed = parseRates(sheet(w, 'Tasas'));
  let inserted = 0;
  let updated = 0;
  if (overwrite) {
    for (const r of parsed.rows) {
      const where = { rateDate_currency_rateType_base: { rateDate: new Date(`${r.rateDate}T00:00:00Z`), currency: r.currency, rateType: r.rateType, base: r.base } };
      const exists = await prisma.exchangeRate.findUnique({ where });
      await prisma.exchangeRate.upsert({
        where,
        update: { rate: r.rate, source: 'excel' },
        create: { ...r, rateDate: new Date(`${r.rateDate}T00:00:00Z`), source: 'excel' },
      });
      exists ? updated++ : inserted++;
    }
  } else {
    const res = await prisma.exchangeRate.createMany({
      data: parsed.rows.map((r) => ({ ...r, rateDate: new Date(`${r.rateDate}T00:00:00Z`), source: 'excel' })),
      skipDuplicates: true,
    });
    inserted = res.count;
  }
  const stats = {
    rows: parsed.rows.length, inserted, updated, skippedZeroOrEmpty: parsed.skipped,
    unknownColumns: parsed.unknownColumns, duplicateDates: parsed.duplicateDates,
  };
  await prisma.importBatch.create({ data: { sourceFile: basename(file), fileHash: w.hash, tableName: 'Tasas', stats } });
  return stats;
}
