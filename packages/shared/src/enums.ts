export const NATURES = { DEUDORA: 'Deudora', ACREEDORA: 'Acreedora', MIXTA: 'Mixta' } as const;
export type Nature = keyof typeof NATURES;

/** Clasificación del BC: activo, pasivo, capital, cuentas nominales deudoras/acreedoras. */
export const CLASSIFICATIONS = {
  AC: 'Activo',
  PC: 'Pasivo',
  CC: 'Capital',
  CND: 'Cuenta nominal deudora (gasto)',
  CNA: 'Cuenta nominal acreedora (ingreso)',
} as const;
export type Classification = keyof typeof CLASSIFICATIONS;

/** Las cuentas nominales muestran movimiento del periodo; las de balance, saldo acumulado. */
export function isNominal(c: Classification): boolean {
  return c === 'CND' || c === 'CNA';
}

export const BOOKS = { BASE: 'Común', REAL: 'Solo real', FISCAL: 'Solo fiscal' } as const;
export type Book = keyof typeof BOOKS;

/** Vistas de reporte: Real = BASE + REAL; Fiscal/Presentado = BASE + FISCAL. */
export const BOOK_VIEWS = { REAL: ['BASE', 'REAL'], FISCAL: ['BASE', 'FISCAL'] } as const;
export type BookView = keyof typeof BOOK_VIEWS;

export const PERIOD_STATUS = {
  OPEN: 'Abierto',
  SOFT_CLOSED: 'En revisión de cierre',
  LOCKED: 'Bloqueado',
} as const;
export type PeriodStatus = keyof typeof PERIOD_STATUS;

export const ENTRY_KINDS = {
  AUTO: 'Automático',
  MANUAL: 'Manual',
  REVAL: 'Revaluación',
  CLOSING: 'Cierre',
  OPENING: 'Apertura',
  REVERSAL: 'Anulación',
} as const;
export type EntryKind = keyof typeof ENTRY_KINDS;

export const DIMENSIONS = {
  CONTAINER: 'Contenedor',
  PROJECT: 'Proyecto',
  POS: 'Punto de venta',
  WAREHOUSE: 'Almacén',
} as const;
export type Dimension = keyof typeof DIMENSIONS;
