import { z } from 'zod';
import Decimal from 'decimal.js';

/**
 * Fórmulas de las líneas de los estados financieros.
 *
 * Gramática: números, referencias a otras líneas como [clave], + − * /, paréntesis y las funciones
 * MIN, MAX, ABS y SUM (SUM acepta rangos [a]:[b] en el orden de la plantilla).
 * Ejemplos: "[F4]+[F13]", "SUM([F3]:[F5])", "MIN(0, -[F50]*0.05*0.9)".
 */

type Token =
  | { t: 'num'; v: string }
  | { t: 'ref'; v: string }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '(' | ')' | ',' | ':' }
  | { t: 'fn'; v: 'MIN' | 'MAX' | 'ABS' | 'SUM' };

export type FormulaNode =
  | { k: 'num'; v: string }
  | { k: 'ref'; key: string }
  | { k: 'range'; from: string; to: string }
  | { k: 'neg'; e: FormulaNode }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: FormulaNode; b: FormulaNode }
  | { k: 'fn'; name: 'MIN' | 'MAX' | 'ABS' | 'SUM'; args: FormulaNode[] };

export class FormulaError extends Error {}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '[') {
      const end = src.indexOf(']', i);
      if (end < 0) throw new FormulaError('Falta cerrar un corchete');
      const key = src.slice(i + 1, end).trim();
      if (!key) throw new FormulaError('Referencia vacía []');
      out.push({ t: 'ref', v: key });
      i = end + 1;
    } else if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+|^[0-9]+\.?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
    } else if ('+-*/(),:'.includes(c)) {
      out.push({ t: 'op', v: c as '+' });
      i++;
    } else {
      const m = /^[A-Za-z]+/.exec(src.slice(i));
      const name = m?.[0].toUpperCase();
      if (name === 'MIN' || name === 'MAX' || name === 'ABS' || name === 'SUM') {
        out.push({ t: 'fn', v: name });
        i += m![0].length;
      } else {
        throw new FormulaError(`Carácter no válido en la fórmula: "${m?.[0] ?? c}"`);
      }
    }
  }
  return out;
}

export function parseFormula(src: string): FormulaNode {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`Se esperaba "${v}"`);
    p++;
  };
  const expr = (): FormulaNode => {
    let a = term();
    while (isOp('+') || isOp('-')) {
      const op = (toks[p++] as { v: '+' | '-' }).v;
      a = { k: 'bin', op, a, b: term() };
    }
    return a;
  };
  const term = (): FormulaNode => {
    let a = unary();
    while (isOp('*') || isOp('/')) {
      const op = (toks[p++] as { v: '*' | '/' }).v;
      a = { k: 'bin', op, a, b: unary() };
    }
    return a;
  };
  const unary = (): FormulaNode => {
    if (isOp('-')) {
      p++;
      return { k: 'neg', e: unary() };
    }
    if (isOp('+')) {
      p++;
      return unary();
    }
    return atom();
  };
  const atom = (): FormulaNode => {
    const tk = peek();
    if (!tk) throw new FormulaError('La fórmula está incompleta');
    if (tk.t === 'num') {
      p++;
      return { k: 'num', v: tk.v };
    }
    if (tk.t === 'ref') {
      p++;
      if (isOp(':')) {
        p++;
        const to = peek();
        if (to?.t !== 'ref') throw new FormulaError('Un rango es [desde]:[hasta]');
        p++;
        return { k: 'range', from: tk.v, to: to.v };
      }
      return { k: 'ref', key: tk.v };
    }
    if (tk.t === 'fn') {
      p++;
      expect('(');
      const args: FormulaNode[] = [];
      if (!isOp(')')) {
        args.push(expr());
        while (isOp(',')) {
          p++;
          args.push(expr());
        }
      }
      expect(')');
      if (args.length === 0) throw new FormulaError(`${tk.v} necesita argumentos`);
      if (tk.v === 'ABS' && args.length !== 1) throw new FormulaError('ABS lleva un argumento');
      return { k: 'fn', name: tk.v, args };
    }
    if (isOp('(')) {
      p++;
      const e = expr();
      expect(')');
      return e;
    }
    throw new FormulaError(`Símbolo inesperado "${tk.v}"`);
  };
  if (toks.length === 0) throw new FormulaError('La fórmula está vacía');
  const node = expr();
  if (p < toks.length) throw new FormulaError(`Sobra "${(toks[p] as { v: string }).v}" al final de la fórmula`);
  return node;
}

/** Claves de línea que cita la fórmula (los rangos se expanden con el orden de la plantilla). */
export function formulaRefs(node: FormulaNode, order: string[]): string[] {
  switch (node.k) {
    case 'num':
      return [];
    case 'ref':
      return [node.key];
    case 'range':
      return expandRange(node.from, node.to, order);
    case 'neg':
      return formulaRefs(node.e, order);
    case 'bin':
      return [...formulaRefs(node.a, order), ...formulaRefs(node.b, order)];
    case 'fn':
      return node.args.flatMap((a) => formulaRefs(a, order));
  }
}

function expandRange(from: string, to: string, order: string[]): string[] {
  const i = order.indexOf(from);
  const j = order.indexOf(to);
  if (i < 0) throw new FormulaError(`No existe la línea [${from}]`);
  if (j < 0) throw new FormulaError(`No existe la línea [${to}]`);
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Evalúa la fórmula; las líneas sin valor cuentan como 0. División por 0 → 0 (como IFERROR). */
export function evalFormula(node: FormulaNode, value: (key: string) => Decimal, order: string[]): Decimal {
  const ev = (n: FormulaNode): Decimal[] => {
    switch (n.k) {
      case 'num':
        return [new Decimal(n.v)];
      case 'ref':
        return [value(n.key)];
      case 'range':
        return expandRange(n.from, n.to, order).map(value);
      case 'neg':
        return [one(n.e).neg()];
      case 'bin': {
        const a = one(n.a);
        const b = one(n.b);
        if (n.op === '+') return [a.plus(b)];
        if (n.op === '-') return [a.minus(b)];
        if (n.op === '*') return [a.times(b)];
        return [b.isZero() ? new Decimal(0) : a.div(b)];
      }
      case 'fn': {
        const xs = n.args.flatMap(ev);
        if (n.name === 'SUM') return [xs.reduce((s, x) => s.plus(x), new Decimal(0))];
        if (n.name === 'ABS') return [xs[0]!.abs()];
        if (n.name === 'MIN') return [Decimal.min(...xs)];
        return [Decimal.max(...xs)];
      }
    }
  };
  const one = (n: FormulaNode): Decimal => {
    const xs = ev(n);
    return xs.reduce((s, x) => s.plus(x), new Decimal(0));
  };
  return one(node);
}

/**
 * Ordena las líneas de fórmula para evaluarlas después de las que citan y detecta ciclos.
 * Devuelve las claves en orden de evaluación.
 */
export function formulaOrder(lines: { key: string; formula?: string | null }[]): string[] {
  const order = lines.map((l) => l.key);
  const deps = new Map<string, string[]>();
  for (const l of lines) {
    if (!l.formula) continue;
    const refs = formulaRefs(parseFormula(l.formula), order);
    for (const r of refs) if (!order.includes(r)) throw new FormulaError(`La línea [${l.key}] cita [${r}], que no existe`);
    deps.set(l.key, refs);
  }
  const out: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (k: string, path: string[]) => {
    if (state.get(k) === 2) return;
    if (state.get(k) === 1) throw new FormulaError(`Referencia circular: ${[...path, k].map((x) => `[${x}]`).join(' → ')}`);
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) visit(d, [...path, k]);
    state.set(k, 2);
    out.push(k);
  };
  for (const k of order) visit(k, []);
  return out;
}

// ───────────── Esquemas de la API ─────────────

export const REPORT_KINDS = ['BALANCE', 'INCOME', 'CASHFLOW'] as const;
export const REPORT_LINE_SOURCES = [
  'NONE', 'ACCOUNTS', 'FORMULA', 'RESULT_YTD', 'RESULT_PRIOR', 'UNMAPPED', 'CASH', 'CASH_BALANCE', 'CASH_FX',
] as const;
export type ReportLineSource = (typeof REPORT_LINE_SOURCES)[number];

export const REPORT_SOURCE_LABELS: Record<ReportLineSource, string> = {
  NONE: 'Título o línea en blanco',
  ACCOUNTS: 'Suma de cuentas',
  FORMULA: 'Fórmula sobre otras líneas',
  RESULT_YTD: 'Resultado del ejercicio',
  RESULT_PRIOR: 'Resultados de ejercicios sin cerrar',
  UNMAPPED: 'Cuentas sin línea',
  CASH: 'Flujo de caja por categorías',
  CASH_BALANCE: 'Saldo de caja y bancos',
  CASH_FX: 'Efecto de las tasas en la caja',
};

export const reportLineInputSchema = z
  .object({
    key: z.string().trim().min(1).max(40).regex(/^[^[\]]+$/, 'La clave no puede llevar corchetes'),
    label: z.string().max(200),
    source: z.enum(REPORT_LINE_SOURCES).default('NONE'),
    accounts: z.array(z.string().trim().min(1).max(40)).max(200).default([]),
    categories: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
    cashFlow: z.enum(['OPER', 'INV', 'FIN']).nullable().optional(),
    formula: z.string().max(2000).nullable().optional(),
    negate: z.boolean().default(false),
    indent: z.number().int().min(0).max(6).default(0),
    bold: z.boolean().default(false),
    option: z.string().max(40).nullable().optional(),
  })
  .superRefine((l, ctx) => {
    if (l.source === 'FORMULA') {
      if (!l.formula?.trim()) ctx.addIssue({ code: 'custom', path: ['formula'], message: 'Escribe la fórmula' });
      else {
        try {
          parseFormula(l.formula);
        } catch (e) {
          ctx.addIssue({ code: 'custom', path: ['formula'], message: (e as Error).message });
        }
      }
    }
    if (l.source === 'ACCOUNTS' && l.accounts.length === 0) ctx.addIssue({ code: 'custom', path: ['accounts'], message: 'Indica al menos una cuenta' });
  });
export type ReportLineInput = z.infer<typeof reportLineInputSchema>;

export const reportTemplateInputSchema = z.object({
  code: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9_ -]+$/),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(REPORT_KINDS),
  notes: z.string().max(2000).default(''),
  lines: z.array(reportLineInputSchema).max(400),
});
export type ReportTemplateInput = z.infer<typeof reportTemplateInputSchema>;

export const statementQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  year: z.coerce.number().int().min(2000).max(2100),
  /** Meses desde/hasta (1–12). */
  fromMonth: z.coerce.number().int().min(1).max(12).default(1),
  toMonth: z.coerce.number().int().min(1).max(12).default(12),
  view: z.enum(['REAL', 'FISCAL']).default('REAL'),
  segment: z.string().max(40).optional(),
  /** Consolidado: elimina las operaciones entre empresas del grupo. */
  eliminate: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
});
