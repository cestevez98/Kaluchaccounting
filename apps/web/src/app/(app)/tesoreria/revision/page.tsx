'use client';

import { formatNumber } from '@kaluch/shared';
import { useState } from 'react';
import { AccountPicker } from '@/components/account-picker';
import { Alert, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Account } from '@/lib/types';
import { MovementsTable } from '../movements-table';

interface Group { categoryId: string | null; name: string; count: number; usd: string }

function BulkRow({ g, accounts, onDone }: { g: Group; accounts: Account[]; onDone: (msg: string) => void }) {
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const { can } = useSession();
  return (
    <tr>
      <td>{g.name}</td>
      <td className="num">{formatNumber(g.count, 0)}</td>
      <td className="num">{formatNumber(g.usd)}</td>
      <td className="min-w-96">{g.categoryId && can('bank:reconcile') ? <AccountPicker accounts={accounts} value={accountId} onChange={(v) => setAccountId(v)} /> : <span className="text-xs text-gray-500">Sin referencia: clasifica uno a uno</span>}</td>
      <td>
        {g.categoryId && can('bank:reconcile') && (
          <button
            className="btn-primary"
            disabled={!accountId || busy}
            onClick={async () => {
              if (!confirm(`¿Reclasificar los ${g.count} movimientos de “${g.name}” a la cuenta elegida? Se registrará un asiento de ajuste por cada uno y la categoría quedará asociada a esa cuenta para el futuro.`)) return;
              setBusy(true);
              try {
                const r = await api<{ reclassified: number }>('/treasury/review/bulk', { method: 'POST', json: { categoryId: g.categoryId, accountId } });
                onDone(`${r.reclassified} movimientos de “${g.name}” clasificados`);
              } catch (e) {
                onDone(e instanceof ApiError ? `Error: ${e.message}` : 'Error');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Clasificando…' : 'Clasificar todos'}
          </button>
        )}
      </td>
    </tr>
  );
}

export default function ReviewPage() {
  const { companyId } = useSession();
  const { data, error, loading, reload } = useApi<Group[]>(`/treasury/review/summary${qs({ companyId })}`);
  const { data: accounts } = useApi<Account[]>('/accounts?postable=true');
  const [msg, setMsg] = useState<string | null>(null);
  const total = data?.reduce((s, g) => s + g.count, 0) ?? 0;

  return (
    <div>
      <PageHeader
        title="Bandeja de revisión"
        subtitle="Movimientos que la migración (o el usuario) no pudo asignar a una cuenta. Están contabilizados contra “Pendiente de clasificar” (699.9998) hasta que se clasifiquen."
      />
      {msg && <div className="mb-3"><Alert kind={msg.startsWith('Error') ? 'error' : 'success'}>{msg}</Alert></div>}
      {error && <Alert>{error.message}</Alert>}
      {data && total === 0 && <Alert kind="success">No hay movimientos pendientes de clasificar.</Alert>}
      {data && total > 0 && (
        <div className="card mb-6 overflow-x-auto">
          <table className="table">
            <thead><tr><th>Referencia del Excel / categoría</th><th className="num">Movimientos</th><th className="num">Importe USD</th><th>Clasificar todos a la cuenta…</th><th /></tr></thead>
            <tbody>
              {data.map((g) => <BulkRow key={g.categoryId ?? 'none'} g={g} accounts={accounts ?? []} onDone={(m) => { setMsg(m); void reload(); }} />)}
            </tbody>
          </table>
        </div>
      )}
      {loading && !data && <Spinner />}
      <h2 className="mb-2 text-base font-semibold">Pendientes uno a uno</h2>
      <MovementsTable needsReview />
    </div>
  );
}
