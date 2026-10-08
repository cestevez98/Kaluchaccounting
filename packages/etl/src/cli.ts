/**
 * ETL desde "Balance de comprobación.xlsx".
 * Uso:  pnpm etl <comando> <ruta.xlsx> [--overwrite]
 *   coa      Plan de cuentas (hoja BC)
 *   rates    Tasas diarias (hoja Tasas)
 *   bc-ref   Valores del BC por cuenta y mes (referencia para conciliar)
 *   all      Los tres anteriores
 * El Excel nunca se sube al repositorio: colócalo en data/ (ignorado por git).
 */
import { PrismaClient } from '@kaluch/db';
import { importBcReference, importChartOfAccounts, importRates } from './importers';
import { loadWorkbook } from './workbook';

async function main() {
  const [cmd, file, ...flags] = process.argv.slice(2);
  if (!cmd || !file || !['coa', 'rates', 'bc-ref', 'all'].includes(cmd)) {
    console.error('Uso: pnpm etl <coa|rates|bc-ref|all> <ruta.xlsx> [--overwrite]');
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
