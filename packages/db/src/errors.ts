export type LedgerErrorCode =
  | 'NOT_FOUND'
  | 'MISSING_RATE'
  | 'UNBALANCED'
  | 'PERIOD_CLOSED'
  | 'IMMUTABLE'
  | 'INVALID_ACCOUNT'
  | 'INVALID_INPUT'
  | 'ALREADY_REVERSED'
  | 'MISSING_MAPPING';

/** Error de negocio del libro mayor, con mensaje en español apto para la UI. */
export class LedgerError extends Error {
  constructor(
    public readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

const DB_TAGS = new Set<LedgerErrorCode>(['INVALID_INPUT', 'PERIOD_CLOSED', 'IMMUTABLE', 'INVALID_ACCOUNT', 'UNBALANCED']);

/**
 * Traduce los errores lanzados por los triggers de la base de datos a LedgerError.
 * Los mensajes de los triggers llevan una etiqueta "[CODIGO] mensaje" porque
 * Prisma no siempre propaga el SQLSTATE (p. ej. errores en el COMMIT).
 * Devuelve el error original si no es uno de los nuestros.
 */
export function translateDbError(e: unknown): unknown {
  if (e instanceof LedgerError) return e;
  const err = e as { message?: string; meta?: { message?: string } };
  const text = `${err?.meta?.message ?? ''}\n${err?.message ?? ''}`;
  const m = /\[([A-Z_]+)\]\s*([^\n`"]+)/.exec(text);
  if (m && DB_TAGS.has(m[1] as LedgerErrorCode)) {
    return new LedgerError(m[1] as LedgerErrorCode, m[2]!.trim());
  }
  return e;
}
