import { computeStatement, type PrismaClient } from '@kaluch/db';

/**
 * Compara los estados del sistema (consolidado, vista Real) con las cifras de las hojas del Excel,
 * línea a línea y mes a mes. Devuelve false si queda alguna diferencia sin explicar.
 */
export async function checkStatements(prisma: PrismaClient, p: { year: number; from: number; to: number; verbose?: boolean; today?: string }) {
  const companies = await prisma.company.findMany({ where: { consolidates: true } });
  const templates = await prisma.reportTemplate.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
  let ok = true;
  for (const t of templates) {
    const r = await computeStatement(prisma, {
      templateCode: t.code, companyIds: companies.map((c) => c.id), year: p.year, fromMonth: p.from, toMonth: p.to,
      today: p.today || undefined,
    });
    const c = r.comparison;
    console.log(`\n${t.code} · ${t.name}` + (c ? `: ${c.OK} cuadran, ${c.EXPLAINED} explicadas, ${c.DIFF} sin explicar, ${c.NO_REF} sin cifra en el Excel` : ' (sin cifras del Excel)'));
    for (const w of r.warnings) console.log(`  ! ${w}`);
    if (r.unmapped.length) console.log(`  Cuentas sin línea: ${r.unmapped.map((u) => `${u.code} (${u.value})`).join(', ')}`);
    if (r.eliminated.length) console.log(`  Eliminadas (intercompañía): ${r.eliminated.map((u) => `${u.code} (${u.value})`).join(', ')}`);
    for (const l of r.lines) {
      if (!l.status) continue;
      l.status.forEach((s, i) => {
        if (s === 'DIFF') ok = false;
        if (s === 'DIFF' || (p.verbose && s === 'EXPLAINED')) {
          console.log(`  ${s === 'DIFF' ? '✗' : '~'} ${r.columns[i]!.label} ${l.key} ${l.label}: sistema ${Number(l.values[i]).toFixed(2)} · Excel ${Number(l.excel![i]).toFixed(2)}${l.explanations?.[i] ? ` — ${l.explanations[i]}` : ''}`);
        }
      });
    }
    if (t.kind !== 'INCOME') {
      const last = r.columns.length - 1;
      const show = r.lines.filter((l) => l.bold || ['CONTROL', 'SALDO_FINAL', 'SALDO_INICIAL', 'FX'].includes(l.key));
      for (const l of show) console.log(`    ${l.label.padEnd(50)} ${Number(l.values[last]).toFixed(2).padStart(15)}`);
    }
  }
  return ok;
}
