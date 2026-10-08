import { DEFAULT_RATE_TYPES } from '@kaluch/shared';
import type { Tx } from './client';

/** Parámetros con vigencia por fecha y sus valores por defecto (semilla). */
export const PARAMETER_DEFAULTS: Record<string, { description: string; value: unknown }> = {
  'fx.max_rate_age_days': {
    description: 'Antigüedad máxima (días) de la última tasa disponible antes de exigir una nueva',
    value: 7,
  },
  'fx.default_rate_type': {
    description: 'Tipo de tasa por defecto por moneda cuando la línea no indica uno',
    value: DEFAULT_RATE_TYPES,
  },
  'ledger.rounding_tolerance_usd': {
    description: 'Diferencia máxima de redondeo (USD) que se compensa automáticamente en un asiento',
    value: '0.01',
  },
  'onat.sales_rate': { description: 'ONAT: tasa sobre ventas fiscales (Distribución)', value: '0.11' },
  'onat.profit_rate': { description: 'ONAT: tasa sobre utilidad fiscal (Distribución)', value: '0.35' },
};

/** Valor vigente en `date` (la versión con valid_from <= date más reciente). */
export async function getParam<T>(tx: Tx, key: string, date: Date): Promise<T> {
  const v = await tx.parameterVersion.findFirst({
    where: { key, validFrom: { lte: date } },
    orderBy: { validFrom: 'desc' },
  });
  if (v) return v.value as T;
  const def = PARAMETER_DEFAULTS[key];
  if (!def) throw new Error(`Parámetro desconocido: ${key}`);
  return def.value as T;
}
