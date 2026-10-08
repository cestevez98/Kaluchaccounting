import { compareWithBc, type BcCompareRow, type PrismaClient } from '@kaluch/db';
import { formatNumber } from '@kaluch/shared';
import ExcelJS from 'exceljs';

const STATUS_LABEL = { OK: 'Cuadra', EXPLAINED: 'Diferencia explicada', DIFF: 'Diferencia NO explicada', ONLY_SYSTEM: 'Solo en el sistema' };

/** Conciliación con el BC del Excel para un rango de meses; imprime resumen y opcionalmente genera un .xlsx. */
export async function runCompare(prisma: PrismaClient, p: { from: string; to: string; codes: string[]; out: string | null }) {
  const [fy, fm] = p.from.split('-').map(Number) as [number, number];
  const [ty, tm] = p.to.split('-').map(Number) as [number, number];
  const all: BcCompareRow[] = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) {
    const r = await compareWithBc(prisma, { year: y, month: m, codePrefixes: p.codes });
    all.push(...r.rows);
    console.log(`${String(m).padStart(2, '0')}/${y}: ${r.summary.OK} cuadran · ${r.summary.EXPLAINED} explicadas · ${r.summary.DIFF} con diferencia · ${r.summary.ONLY_SYSTEM} solo en el sistema`);
  }
  const bad = all.filter((r) => r.status === 'DIFF');
  if (bad.length) {
    console.log('\nDiferencias no explicadas:');
    for (const r of bad.slice(0, 80)) {
      console.log(`  ${String(r.month).padStart(2, '0')}/${r.year} ${r.displayCode.padEnd(10)} Excel ${formatNumber(r.excel).padStart(14)} · Sistema ${formatNumber(r.system).padStart(14)} · Dif ${formatNumber(r.diff).padStart(12)}  ${r.name.slice(0, 50)}`);
    }
  }
  if (p.out) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Conciliación BC');
    ws.addRow(['Mes', 'Cuenta', 'Descripción', 'Fila Excel', 'Excel (USD)', 'Sistema (USD)', 'Diferencia', 'Estado', 'Explicación']).font = { bold: true };
    for (const r of all) {
      ws.addRow([`${String(r.month).padStart(2, '0')}/${r.year}`, r.displayCode, r.name, r.excelRow, r.excel === null ? null : Number(r.excel), Number(r.system), Number(r.diff), STATUS_LABEL[r.status], r.explanation]);
    }
    ws.columns.forEach((c, i) => {
      c.width = [9, 12, 60, 10, 16, 16, 14, 22, 60][i];
      if (i >= 4 && i <= 6) c.numFmt = '#,##0.00;[Red]-#,##0.00';
    });
    await wb.xlsx.writeFile(p.out);
    console.log(`\nInforme guardado en ${p.out}`);
  }
  return all;
}
