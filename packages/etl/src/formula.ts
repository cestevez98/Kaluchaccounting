/**
 * Intérprete mínimo de las fórmulas SUMIFS del BC para saber qué filas de qué
 * hoja suman en cada cuenta. Solo se usa en la migración.
 *
 *   =(SUMIFS(Banco_Emp_Cuba[Entradas CUP],Banco_Emp_Cuba[Propietario],"Dmilio",
 *            Banco_Emp_Cuba[Banco],"Metropolitano",Banco_Emp_Cuba[Fecha],"<="&EOMONTH(…))
 *     -SUMIFS(Banco_Emp_Cuba[Salidas CUP], …)) /SUMIFS(Tasas[CUP/USD (IC)], …)
 *
 * → términos: { sign: +1, sheet: Banco_Emp_Cuba, column: "Entradas CUP", criteria: [Propietario=Dmilio, Banco=Metropolitano] }
 *             { sign: −1, sheet: Banco_Emp_Cuba, column: "Salidas CUP", … }
 */
export interface Criterion {
  column: string;
  value: string;
}

export interface SumTerm {
  sign: 1 | -1;
  sheet: string;
  column: string;
  currency: string | null;
  criteria: Criterion[];
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') {
      // "" dentro de una cadena es una comilla escapada
      if (inStr && s[i + 1] === '"') {
        cur += '""';
        i++;
        continue;
      }
      inStr = !inStr;
    }
    if (!inStr) {
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Extrae los términos SUMIFS (excepto los de la hoja Tasas). */
export function parseSumifs(formula: string | null): SumTerm[] {
  if (!formula) return [];
  const terms: SumTerm[] = [];
  const re = /SUMIFS\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula))) {
    // Argumentos hasta el paréntesis de cierre correspondiente.
    let depth = 1;
    let i = m.index + m[0].length;
    let inStr = false;
    for (; i < formula.length && depth > 0; i++) {
      const ch = formula[i];
      if (ch === '"') inStr = !inStr;
      else if (!inStr && ch === '(') depth++;
      else if (!inStr && ch === ')') depth--;
    }
    const inner = formula.slice(m.index + m[0].length, i - 1);
    const args = splitArgs(inner);
    const sumRef = /^([A-Za-z_À-ÿ0-9]+)\[([^\]]+)\]$/.exec(args[0] ?? '');
    if (!sumRef || sumRef[1] === 'Tasas') continue;
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(formula[j]!)) j--;
    const sign: 1 | -1 = formula[j] === '-' ? -1 : 1;
    const criteria: Criterion[] = [];
    for (let k = 1; k + 1 < args.length; k += 2) {
      const col = /\[([^\]]+)\]$/.exec(args[k]!)?.[1];
      const raw = args[k + 1]!;
      if (!col || /EOMONTH|DATE\(/i.test(raw)) continue; // criterio de fecha
      const lit = /^"(.*)"$/.exec(raw);
      if (!lit) continue;
      criteria.push({ column: col, value: lit[1]!.replace(/""/g, '"') });
    }
    const column = sumRef[2]!;
    const currency = /\b(USD|CUP|EUR|DOP|MLC|CAD|GBP)\b/.exec(column)?.[1] ?? null;
    terms.push({ sign, sheet: sumRef[1]!, column, currency, criteria });
  }
  return terms;
}

/**
 * Criterio de texto de Excel (SUMIFS): sin distinguir mayúsculas, con comodines
 * `*` y `?` (`~` escapa). "" coincide con celdas vacías.
 */
export function excelCriterionMatches(cell: unknown, criterion: string): boolean {
  const text = cell === null || cell === undefined ? '' : String(cell);
  if (criterion === '') return text === '';
  let re = '^';
  for (let i = 0; i < criterion.length; i++) {
    const ch = criterion[i]!;
    if (ch === '~' && i + 1 < criterion.length) {
      re += criterion[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`, 'i').test(text);
}

export function termMatchesRow(term: SumTerm, row: Record<string, unknown>): boolean {
  return term.criteria.every((c) => excelCriterionMatches(row[c.column], c.value));
}
