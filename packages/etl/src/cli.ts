/**
 * ETL desde "Balance de comprobación.xlsx".
 * Uso:  pnpm etl <comando> <ruta.xlsx> [opciones]
 *   coa       Plan de cuentas (hoja BC)
 *   rates     Tasas diarias (hoja Tasas)  [--overwrite]
 *   bc-ref    Valores del BC por cuenta y mes (referencia para conciliar)
 *   all       Los tres anteriores
 *   treasury  Caja y bancos: cuentas, saldos de apertura, movimientos y revaluaciones
 *             [--opening=2026-03-31] [--cash-company=GR] [--revalue-until=2026-10]
 *   compare   Conciliación con el BC  [--from=2026-04] [--to=2026-10] [--codes=101,109,...] [--out=data/conciliacion.xlsx]
 * El Excel nunca se sube al repositorio: colócalo en data/ (ignorado por git).
 */
import { PrismaClient } from '@kaluch/db';
import { importBcReference, importChartOfAccounts, importRates } from './importers';
import { runCompare } from './compare';
import { importTreasury } from './treasury-import';
import { loadWorkbook } from './workbook';

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const [cmd, file] = args.filter((a) => !a.startsWith('--'));
  const opt = (name: string, def: string) => flags.find((f) => f.startsWith(`--${name}=`))?.split('=')[1] ?? def;
  if (cmd === 'compare') {
    const prisma = new PrismaClient();
    try {
      await runCompare(prisma, {
        from: opt('from', '2026-04'), to: opt('to', '2026-10'),
        codes: opt('codes', '101,109,110,111,112,113,114').split(','),
        out: file ?? null,
      });
    } finally {
      await prisma.$disconnect();
    }
    return;
  }
  if (!cmd || !file || !['coa', 'rates', 'bc-ref', 'all', 'treasury'].includes(cmd)) {
    console.error('Uso: pnpm etl <coa|rates|bc-ref|all|treasury> <ruta.xlsx> [opciones] · pnpm etl compare [salida.xlsx] [opciones]');
    process.exit(2);
  }
  const t0 = Date.now();
  console.log(`Leyendo ${file}…`);
  const w = await loadWorkbook(file);
  console.log(`Excel cargado en ${((Date.now() - t0) / 1000).toFixed(1)} s (sha256 ${w.hash.slice(0, 12)}…)`);
  const prisma = new PrismaClient();
  try {
    if (cmd === 'coa' || cmd === 'all') {
      const r = await importChartOfAccounts(prisma, w, file);
      console.log(`\nPlan de cuentas: ${r.accounts} cuentas (${r.created} nuevas, ${r.updated} actualizadas), ${r.withRevaluation} con tasa de revaluación`);
      if (r.duplicates.length) console.log(`  Códigos duplicados (importados con sufijo #n): ${r.duplicates.join(', ')}`);
      if (r.anomalies.length) console.log(`  Anomalías marcadas:\n    - ${r.anomalies.join('\n    - ')}`);
      if (r.issues.length) console.log(`  Avisos:\n    - ${r.issues.join('\n    - ')}`);
    }
    if (cmd === 'rates' || cmd === 'all') {
      const r = await importRates(prisma, w, file, flags.includes('--overwrite'));
      console.log(`\nTasas: ${r.rows} valores válidos, ${r.inserted} insertados, ${r.updated} actualizados, ${r.skippedZeroOrEmpty} vacíos o 0 descartados`);
      if (r.unknownColumns.length) console.log(`  Columnas sin mapeo: ${r.unknownColumns.join(', ')}`);
      if (r.duplicateDates.length) console.log(`  Fechas repetidas en Tasas (se usa la primera fila): ${r.duplicateDates.join(', ')}`);
    }
    if (cmd === 'treasury') {
      const t0 = Date.now();
      const r = await importTreasury(prisma, w, file, {
        openingDate: opt('opening', '2026-03-31'),
        cashCompany: opt('cash-company', 'GR'),
        revalueUntil: opt('revalue-until', '2026-10') || null,
        maxDate: opt('max-date', '2026-12-31'),
        log: (m) => console.log(m),
      });
      console.log(`\nTesorería (${((Date.now() - t0) / 1000).toFixed(0)} s):`, r.stats);
      if (r.revaluations.length) console.log('Revaluaciones:', r.revaluations.filter((x) => x.totalUsd !== '0.0000').map((x) => `${x.company} ${x.month}: ${x.totalUsd}`).join(' · '));
      if (r.issues.length) console.log(`Avisos (${r.issues.length}):\n  - ${r.issues.slice(0, 60).join('\n  - ')}`);
    }
    if (cmd === 'bc-ref' || cmd === 'all') {
      const r = await importBcReference(prisma, w, file);
      console.log(`\nReferencia BC: ${r.values} valores (${r.months} meses), lote ${r.importId}`);
      if (r.excelErrors.length) console.log(`  Celdas con error en el Excel: ${r.excelErrors.length}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
