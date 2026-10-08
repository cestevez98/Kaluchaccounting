import { FUNCTIONAL_CURRENCY } from '@kaluch/shared';
import type { Prisma } from '@prisma/client';
import type { Tx } from './client';
import { LedgerError } from './errors';
import { getParam } from './params';

export interface ResolvedRate {
  rate: Prisma.Decimal | string;
  rateType: string | null;
  rateDate: Date | null;
}

export function toDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Tasa vigente para (fecha, moneda, tipo): la del día o la última anterior,
 * con una antigüedad máxima configurable (`fx.max_rate_age_days`).
 */
export async function findRate(
  tx: Tx,
  date: Date,
  currency: string,
  rateType: string,
  base = 'USD',
): Promise<ResolvedRate> {
  if (currency === FUNCTIONAL_CURRENCY && base === 'USD') {
    return { rate: '1', rateType: null, rateDate: null };
  }
  const maxAge = Number(await getParam<number>(tx, 'fx.max_rate_age_days', date));
  const row = await tx.exchangeRate.findFirst({
    where: { currency, rateType, base, rateDate: { lte: date } },
    orderBy: { rateDate: 'desc' },
  });
  const ageDays = row ? Math.round((date.getTime() - row.rateDate.getTime()) / 86_400_000) : Infinity;
  if (!row || ageDays > maxAge) {
    throw new LedgerError(
      'MISSING_RATE',
      `Falta la tasa ${currency}/${base} (${rateType}) para el ${isoDate(date).split('-').reverse().join('/')}` +
        (row ? ` (la última es de hace ${ageDays} días)` : ''),
    );
  }
  return { rate: row.rate, rateType, rateDate: row.rateDate };
}

export async function defaultRateType(tx: Tx, currency: string, date: Date): Promise<string> {
  const map = await getParam<Record<string, string>>(tx, 'fx.default_rate_type', date);
  const t = map[currency];
  if (!t) {
    throw new LedgerError('MISSING_RATE', `No hay tipo de tasa por defecto para ${currency}; indícalo en la línea`);
  }
  return t;
}
