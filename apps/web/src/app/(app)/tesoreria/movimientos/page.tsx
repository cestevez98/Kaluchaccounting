'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageHeader } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { TreasuryAccount } from '@/lib/types';
import { MovementsTable } from '../movements-table';

function Movements() {
  const { can } = useSession();
  const account = useSearchParams().get('account') ?? undefined;
  const { data: accounts } = useApi<TreasuryAccount[]>(account ? '/treasury/accounts?includeInactive=true' : null);
  const name = accounts?.find((a) => a.id === account)?.name;
  return (
    <div>
      <PageHeader
        title={name ? `Movimientos · ${name}` : 'Movimientos de tesorería'}
        subtitle={
          account ? <Link className="text-brand-600 hover:underline" href="/tesoreria/movimientos">Ver todas las cuentas</Link>
            : 'Entradas, salidas, cambios de moneda y traspasos de todas las cajas, bancos y monederos.'
        }
        actions={can('cash:operate') && <Link href="/tesoreria/nuevo" className="btn-primary">Nuevo movimiento</Link>}
      />
      <MovementsTable key={account ?? 'all'} treasuryAccountId={account} />
    </div>
  );
}

export default function MovementsPage() {
  return <Suspense><Movements /></Suspense>;
}
