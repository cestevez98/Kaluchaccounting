import type { CategoryKind } from '@kaluch/db';

/**
 * Normalización de "Referencia cruzada" → categoría de tesorería.
 * Solo se asigna cuenta contrapartida cuando el significado es inequívoco; el
 * resto de categorías se crean sin cuenta y sus movimientos van a la bandeja de
 * revisión (se reclasifican en bloque desde la UI o en la fase 3: contrapartes).
 *
 * La clave puede ir prefijada con la hoja ("Banco_Emp_Cuba|impuesto") cuando el
 * mismo texto significa cosas distintas según la hoja.
 */
export interface KnownCategory {
  code: string;
  name: string;
  kind: CategoryKind;
  /** Códigos de cuenta candidatos (se usa el primero que exista y sea de detalle). */
  accounts?: string[];
  segment?: string;
  flow?: 'OPER' | 'INV' | 'FIN';
  aliases: string[];
}

export const KNOWN_CATEGORIES: KnownCategory[] = [
  { code: 'VENTAS_DISTRIBUCION', name: 'Ventas Distribución (mayorista)', kind: 'INCOME', accounts: ['900.9990'], segment: '999', aliases: ['ventas distribución', 'venta distribución'] },
  { code: 'VENTAS_MINORISTAS', name: 'Ventas minoristas', kind: 'INCOME', accounts: ['900.9991'], segment: '999', aliases: ['ventas minoristas'] },
  { code: 'CAMBIO', name: 'Cambio de moneda', kind: 'EXCHANGE', aliases: ['cambio', 'cambio por transferencia', 'traspaso/cambio de moneda'] },
  { code: 'TRASPASO', name: 'Traspaso entre cuentas', kind: 'TRANSFER', aliases: ['traspaso'] },
  { code: 'SALDO_INICIAL', name: 'Saldo inicial', kind: 'OTHER', accounts: ['699.9997'], aliases: ['saldo inicial'] },
  { code: 'SALARIO_DIST', name: 'Salarios (Distribución)', kind: 'EXPENSE', accounts: ['826.9990'], segment: '999', aliases: ['salario', 'salario triciclo'] },
  { code: 'LIMPIEZA_DIST', name: 'Limpieza (Distribución)', kind: 'EXPENSE', accounts: ['834.9990'], segment: '999', aliases: ['limpieza', 'limpieza almacén'] },
  { code: 'SEGURIDAD_DIST', name: 'Seguridad (Distribución)', kind: 'EXPENSE', accounts: ['836.9990'], segment: '999', aliases: ['seguridad', 'seguridad almacén'] },
  { code: 'TRANSPORTE_DIST', name: 'Transporte (Distribución)', kind: 'EXPENSE', accounts: ['835.9990'], segment: '999', aliases: ['transporte', 'mensajería triciclo'] },
  { code: 'ALQUILER_DIST', name: 'Alquiler (Distribución)', kind: 'EXPENSE', accounts: ['837.9990'], segment: '999', aliases: ['alquiler'] },
  { code: 'SOFTWARE_DIST', name: 'Software de Distribución', kind: 'EXPENSE', accounts: ['832.9990'], segment: '999', aliases: ['software de distribución'] },
  { code: 'IMPUESTO_ONAT', name: 'Impuestos ONAT (Cuba)', kind: 'EXPENSE', accounts: ['829.9990'], segment: '999', aliases: ['banco_emp_cuba|impuesto'] },
  {
    code: 'IMPUESTO_DGII', name: 'Impuestos DGII (República Dominicana)', kind: 'EXPENSE', accounts: ['829.8881'], segment: '888',
    aliases: ['banco_emp_exterior|impuesto', 'impuesto r17', 'impuesto it1', 'impuesto i12', 'impuesto iva', 'tss', 'infotep'],
  },
];

/** Variantes que solo difieren en mayúsculas, espacios o plural. */
const SYNONYMS: Record<string, string> = {
  financiamiento: 'financiamientos',
  'transferencia devuelta': 'transferencia devuelta',
  'gastos varios (distribucion)': 'gastos varios (distribución)',
};

export function normalizeReference(ref: unknown): string | null {
  if (ref === null || ref === undefined) return null;
  const s = String(ref).trim().replace(/\s+/g, ' ').toLowerCase();
  if (!s || s === '?' || s === 'none') return null;
  return SYNONYMS[s] ?? s;
}

export function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

export function guessKind(normalized: string): CategoryKind {
  if (normalized.startsWith('deuda') || normalized.includes('financiamiento') || normalized.includes('remesa')) return 'DEBT';
  if (normalized.startsWith('venta') || normalized.startsWith('ingreso')) return 'INCOME';
  if (normalized.startsWith('cambio')) return 'EXCHANGE';
  if (normalized.startsWith('traspaso')) return 'TRANSFER';
  if (normalized.startsWith('gasto') || normalized.startsWith('comisi') || normalized.includes('salario')) return 'EXPENSE';
  return 'OTHER';
}

/** Categoría conocida para (hoja, referencia normalizada), si la hay. */
export function knownCategoryFor(sheet: string, normalized: string): KnownCategory | undefined {
  const sheetKey = `${sheet.toLowerCase()}|${normalized}`;
  return (
    KNOWN_CATEGORIES.find((c) => c.aliases.includes(sheetKey)) ??
    KNOWN_CATEGORIES.find((c) => c.aliases.includes(normalized))
  );
}
