/**
 * Intérprete de las fórmulas del BC para la migración de deudas (fase 3).
 *
 * Convierte una fórmula como
 *
 *   IF(SUMIFS(T[CxC],T[FECHA],"<="&EOMONTH(…)) > SUMIFS(T[CxP],…),
 *      SUMIFS(T[CxC],T[FECHA],"<="&EOMONTH(…)) − SUMIFS(T[CxP],…), 0) / SUMIFS(Tasas[EUR/USD (OUE)],…)
 *
 * en una forma lineal: Σ coef × SUMIFS(hoja[columna], fecha ≤ fin de mes, criterios), con:
 *  - `split`: la fórmula es IF(…, E, 0) → el BC muestra max(E, 0) (saldo partido por signo);
 *  - `rateColumn`: la forma se divide entre una tasa de cierre (cuenta en moneda extranjera);
 *  - referencias a otras celdas del BC (p. ej. "−G133−G134") sustituidas por su forma.
 * Cada término indica su propia columna de fecha (p. ej. "Diferencia de pago" por "última fecha de pago").
 */
import { excelCriterionMatches } from './formula';

export interface LinearTerm {
  coef: number;
  sheet: string;
  column: string;
  dateColumn: string | null;
  /** Solo el mes (criterio ">= primer día del mes"): no acumulado. */
  monthly: boolean;
  criteria: { column: string; value: string }[];
}

export interface LinearForm {
  terms: LinearTerm[];
  split: boolean;
  rateColumn: string | null;
}

export class UnsupportedFormula extends Error {}

type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'cell'; col: string; row: number }
  | { t: 'sref'; table: string; column: string }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'neg'; x: Node };

type Tok = { k: 'num' | 'str' | 'cell' | 'sref' | 'id' | 'op' | '(' | ')' | ','; v: string; table?: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let s = '';
      i++;
      while (i < src.length) {
        if (src[i] === '"' && src[i + 1] === '"') { s += '"'; i += 2; continue; }
        if (src[i] === '"') break;
        s += src[i++];
      }
      i++;
      out.push({ k: 'str', v: s });
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === '<' || c === '>') {
      const two = src.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '<>') { out.push({ k: 'op', v: two }); i += 2; continue; }
      out.push({ k: 'op', v: c }); i++; continue;
    }
    if ('+-*/&='.includes(c)) { out.push({ k: 'op', v: c }); i++; continue; }
    if (c === '(' || c === ')' || c === ',') { out.push({ k: c, v: c }); i++; continue; }
    // Identificador, referencia de celda o referencia estructurada Tabla[Columna].
    const m = /^[$]?[A-Za-z_À-ÿ\\][A-Za-z0-9_À-ÿ.\\]*[$]?[0-9]*/.exec(src.slice(i));
    if (!m) throw new UnsupportedFormula(`Carácter inesperado "${c}"`);
    let word = m[0];
    i += word.length;
    if (src[i] === '[') {
      // Referencia estructurada: lee los corchetes equilibrados.
      let depth = 0;
      let inner = '';
      for (; i < src.length; i++) {
        const ch = src[i]!;
        if (ch === '[') { depth++; if (depth === 1) continue; }
        if (ch === ']') { depth--; if (depth === 0) { i++; break; } }
        inner += ch;
      }
      const column = inner.startsWith('[') && inner.endsWith(']') ? inner.slice(1, -1) : inner;
      out.push({ k: 'sref', v: column, table: word });
      continue;
    }
    const cell = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(word);
    if (cell) { out.push({ k: 'cell', v: `${cell[1]}${cell[2]}` }); continue; }
    word = word.replace(/^_xlfn\./, '');
    out.push({ k: 'id', v: word.toUpperCase() });
  }
  return out;
}

function parse(src: string): Node {
  const toks = tokenize(src.replace(/^=/, ''));
  let p = 0;
  const peek = () => toks[p];
  const eat = (k?: string, v?: string) => {
    const t = toks[p];
    if (!t || (k && t.k !== k) || (v && t.v !== v)) throw new UnsupportedFormula(`Se esperaba ${v ?? k} y hay ${t?.v ?? 'fin'}`);
    p++;
    return t;
  };
  const cmp = (): Node => {
    let l = concat();
    while (peek()?.k === 'op' && ['=', '<', '>', '<=', '>=', '<>'].includes(peek()!.v)) {
      const op = eat().v;
      l = { t: 'bin', op, l, r: concat() };
    }
    return l;
  };
  const concat = (): Node => {
    let l = add();
    while (peek()?.k === 'op' && peek()!.v === '&') { eat(); l = { t: 'bin', op: '&', l, r: add() }; }
    return l;
  };
  const add = (): Node => {
    let l = mul();
    while (peek()?.k === 'op' && (peek()!.v === '+' || peek()!.v === '-')) {
      const op = eat().v;
      l = { t: 'bin', op, l, r: mul() };
    }
    return l;
  };
  const mul = (): Node => {
    let l = unary();
    while (peek()?.k === 'op' && (peek()!.v === '*' || peek()!.v === '/')) {
      const op = eat().v;
      l = { t: 'bin', op, l, r: unary() };
    }
    return l;
  };
  const unary = (): Node => {
    if (peek()?.k === 'op' && peek()!.v === '-') { eat(); return { t: 'neg', x: unary() }; }
    if (peek()?.k === 'op' && peek()!.v === '+') { eat(); return unary(); }
    return primary();
  };
  const primary = (): Node => {
    const t = peek();
    if (!t) throw new UnsupportedFormula('Fórmula incompleta');
    if (t.k === 'num') { eat(); return { t: 'num', v: Number(t.v) }; }
    if (t.k === 'str') { eat(); return { t: 'str', v: t.v }; }
    if (t.k === 'cell') { eat(); const m = /^([A-Z]+)(\d+)$/.exec(t.v)!; return { t: 'cell', col: m[1]!, row: Number(m[2]) }; }
    if (t.k === 'sref') { eat(); return { t: 'sref', table: t.table!, column: t.v }; }
    if (t.k === '(') { eat(); const e = cmp(); eat(')'); return e; }
    if (t.k === 'id') {
      eat();
      eat('(');
      const args: Node[] = [];
      if (peek()?.k !== ')') {
        args.push(cmp());
        while (peek()?.k === ',') { eat(); args.push(cmp()); }
      }
      eat(')');
      return { t: 'call', name: t.v, args };
    }
    throw new UnsupportedFormula(`Elemento inesperado ${t.v}`);
  };
  const root = cmp();
  if (p !== toks.length) throw new UnsupportedFormula(`Sobra texto a partir de "${toks[p]!.v}"`);
  return root;
}

const isZero = (n: Node) => n.t === 'num' && n.v === 0;
const mentions = (n: Node, name: string): boolean =>
  n.t === 'call' ? n.name === name || n.args.some((a) => mentions(a, name))
    : n.t === 'bin' ? mentions(n.l, name) || mentions(n.r, name)
      : n.t === 'neg' ? mentions(n.x, name) : false;

function scale(f: LinearForm, k: number): LinearForm {
  return { ...f, terms: f.terms.map((t) => ({ ...t, coef: t.coef * k })) };
}

function combine(a: LinearForm, b: LinearForm): LinearForm {
  if (a.rateColumn && b.rateColumn && a.rateColumn !== b.rateColumn) throw new UnsupportedFormula('Mezcla de tasas distintas');
  return { terms: [...a.terms, ...b.terms], split: a.split || b.split, rateColumn: a.rateColumn ?? b.rateColumn };
}

const EMPTY: LinearForm = { terms: [], split: false, rateColumn: null };

/**
 * Linealiza la fórmula de una celda del BC. `cellFormula(row)` devuelve la fórmula de otra fila
 * en la misma columna (para resolver referencias como G133).
 */
export function linearize(formula: string, cellFormula: (row: number) => string | null, depth = 0): LinearForm {
  if (depth > 5) throw new UnsupportedFormula('Demasiadas referencias anidadas');
  const lin = (n: Node): LinearForm => {
    switch (n.t) {
      case 'num':
        if (n.v === 0) return EMPTY;
        throw new UnsupportedFormula(`Constante ${n.v} en la fórmula`);
      case 'neg':
        return scale(lin(n.x), -1);
      case 'cell': {
        if (n.row <= 2) throw new UnsupportedFormula('Referencia a la cabecera');
        const f = cellFormula(n.row);
        return f ? linearize(f, cellFormula, depth + 1) : EMPTY;
      }
      case 'bin':
        if (n.op === '+') return combine(lin(n.l), lin(n.r));
        if (n.op === '-') return combine(lin(n.l), scale(lin(n.r), -1));
        if (n.op === '/') {
          const d = n.r;
          if (d.t === 'call' && d.name === 'SUMIFS' && d.args[0]?.t === 'sref' && d.args[0].table === 'Tasas') {
            return { ...lin(n.l), rateColumn: d.args[0].column };
          }
          throw new UnsupportedFormula('División que no es por una tasa');
        }
        throw new UnsupportedFormula(`Operador ${n.op} no lineal`);
      case 'call':
        if (n.name === 'IF') {
          const [, a, b] = n.args;
          if (!a || !b) throw new UnsupportedFormula('IF incompleto');
          if (isZero(a)) return { ...lin(b), split: true };
          if (isZero(b)) return { ...lin(a), split: true };
          throw new UnsupportedFormula('IF sin rama 0');
        }
        if (n.name === 'IFERROR') return lin(n.args[0]!);
        if (n.name === 'SUMIFS') return { terms: [sumifsTerm(n)], split: false, rateColumn: null };
        throw new UnsupportedFormula(`Función ${n.name} no soportada`);
      default:
        throw new UnsupportedFormula(`Elemento ${n.t} no lineal`);
    }
  };
  return lin(parse(formula));
}

function sumifsTerm(n: Extract<Node, { t: 'call' }>): LinearTerm {
  const [sum, ...rest] = n.args;
  if (sum?.t !== 'sref') throw new UnsupportedFormula('SUMIFS sin columna de suma');
  if (sum.table === 'Tasas') throw new UnsupportedFormula('Tasa fuera de una división');
  const term: LinearTerm = { coef: 1, sheet: sum.table, column: sum.column, dateColumn: null, monthly: false, criteria: [] };
  for (let i = 0; i + 1 < rest.length; i += 2) {
    const range = rest[i]!;
    const crit = rest[i + 1]!;
    if (range.t !== 'sref') throw new UnsupportedFormula('Rango de criterio no estructurado');
    if (mentions(crit, 'EOMONTH') || mentions(crit, 'DATE')) {
      const op = crit.t === 'bin' && crit.op === '&' && crit.l.t === 'str' ? crit.l.v : '';
      if (op === '<=') term.dateColumn = range.column;
      else if (op === '>=') term.monthly = true;
      else throw new UnsupportedFormula(`Criterio de fecha "${op}" no soportado`);
      continue;
    }
    if (crit.t === 'str') term.criteria.push({ column: range.column, value: crit.v });
    else if (crit.t === 'num') term.criteria.push({ column: range.column, value: String(crit.v) });
    else throw new UnsupportedFormula('Criterio no literal');
  }
  if (!term.dateColumn) throw new UnsupportedFormula(`SUMIFS de ${sum.table}[${sum.column}] sin fecha de corte`);
  return term;
}

/** Criterio de SUMIFS con operadores de comparación de texto ("<>X"). */
export function criterionMatches(cell: unknown, criterion: string): boolean {
  if (criterion.startsWith('<>')) return !excelCriterionMatches(cell, criterion.slice(2));
  if (criterion.startsWith('=')) return excelCriterionMatches(cell, criterion.slice(1));
  return excelCriterionMatches(cell, criterion);
}

/** Igualdad de formas (para detectar pares 135.x / 405.x: una es la opuesta de la otra). */
export function termKey(t: LinearTerm): string {
  const crit = [...t.criteria].sort((a, b) => a.column.localeCompare(b.column)).map((c) => `${c.column}=${c.value}`).join('&');
  return `${t.sheet}|${t.column}|${t.dateColumn}|${t.monthly}|${crit}`;
}

/** Suma coeficientes de términos iguales y elimina los que se anulan. */
export function normalize(f: LinearForm): LinearForm {
  const map = new Map<string, LinearTerm>();
  for (const t of f.terms) {
    const k = termKey(t);
    const prev = map.get(k);
    map.set(k, prev ? { ...prev, coef: prev.coef + t.coef } : { ...t });
  }
  return { ...f, terms: [...map.values()].filter((t) => Math.abs(t.coef) > 1e-12) };
}

export function isNegationOf(a: LinearForm, b: LinearForm): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.terms.length !== nb.terms.length || na.rateColumn !== nb.rateColumn) return false;
  const mb = new Map(nb.terms.map((t) => [termKey(t), t.coef]));
  return na.terms.every((t) => Math.abs((mb.get(termKey(t)) ?? 0) + t.coef) < 1e-12);
}
