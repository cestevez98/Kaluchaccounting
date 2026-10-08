/**
 * Mapeo documentado de las columnas de la hoja "Tasas" (cabecera "Tasa 1USD=").
 * Convención: 1 base = valor unidades de la moneda.
 */
export const RATE_COLUMNS: Record<string, { currency: string; rateType: string; base: string }> = {
  'CUP/USD (OC)': { currency: 'CUP', rateType: 'OC', base: 'USD' },
  'EUR/USD (OC)': { currency: 'EUR', rateType: 'OC', base: 'USD' },
  'CUP/USD (IC)': { currency: 'CUP', rateType: 'IC', base: 'USD' },
  'MLC/USD (IC)': { currency: 'MLC', rateType: 'IC', base: 'USD' },
  'EUR/USD (IC)': { currency: 'EUR', rateType: 'IC', base: 'USD' },
  'EUR/USD (OUE)': { currency: 'EUR', rateType: 'OUE', base: 'USD' },
  'GBP/USD (OUE)': { currency: 'GBP', rateType: 'OUE', base: 'USD' },
  'CAD/USD (OUE)': { currency: 'CAD', rateType: 'OUE', base: 'USD' },
  'DOP/USD (ORD)': { currency: 'DOP', rateType: 'ORD', base: 'USD' },
  'CUP/EUR (OC)': { currency: 'CUP', rateType: 'OC', base: 'EUR' },
};

/** Columnas de Tasas referenciadas en una fórmula: `Tasas[CUP/USD (IC)]` → ['CUP/USD (IC)']. */
export function rateColumnsInFormula(formula: string | null): string[] {
  if (!formula) return [];
  const found = new Set<string>();
  for (const m of formula.matchAll(/Tasas\[([^\]]+)\]/g)) {
    if (RATE_COLUMNS[m[1]!]) found.add(m[1]!);
  }
  return [...found];
}
