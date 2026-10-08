import { Prisma, PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient };
export type Tx = Prisma.TransactionClient;

export interface TxOptions {
  /** Usuario que firma la operación en la auditoría. */
  userId?: string | null;
  /** Permite contabilizar en periodos SOFT_CLOSED (rol contador). */
  allowSoftClosed?: boolean;
  timeoutMs?: number;
}

/**
 * Ejecuta `fn` en una transacción con el contexto de auditoría fijado
 * (`app.user_id`) y, opcionalmente, permiso para periodos en revisión de cierre.
 */
export async function withTx<T>(
  prisma: PrismaClient,
  opts: TxOptions,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${opts.userId ?? ''}, true)`;
      if (opts.allowSoftClosed) {
        await tx.$executeRaw`SELECT set_config('app.allow_soft_closed', 'on', true)`;
      }
      return fn(tx);
    },
    { timeout: opts.timeoutMs ?? 30_000, maxWait: 10_000 },
  );
}
