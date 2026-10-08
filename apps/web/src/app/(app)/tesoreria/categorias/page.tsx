'use client';

import { useState } from 'react';
import { AccountPicker } from '@/components/account-picker';
import { Alert, Badge, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CATEGORY_KIND_LABEL, type Account, type CashCategory } from '@/lib/types';

function Row({ c, accounts, canEdit, onSaved }: { c: CashCategory; accounts: Account[]; canEdit: boolean; onSaved: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [accountId, setAccountId] = useState(c.accountId ?? '');
  return (
    <tr>
      <td className="font-medium">{c.name}</td>
      <td><Badge tone={c.kind === 'DEBT' ? 'amber' : c.kind === 'INCOME' ? 'green' : 'gray'}>{CATEGORY_KIND_LABEL[c.kind]}</Badge></td>
      <td className="min-w-80">
        {editing ? (
          <div className="flex gap-1">
            <AccountPicker accounts={accounts} value={accountId} onChange={(v) => setAccountId(v)} />
            <button
              className="btn-primary"
              onClick={async () => {
                try {
                  await api(`/treasury/categories/${c.id}`, { method: 'PATCH', json: { accountId: accountId || null } });
                  setEditing(false);
                  onSaved(`Categoría “${c.name}” actualizada. Los movimientos nuevos usarán esa cuenta; los pendientes se clasifican desde la bandeja.`);
                } catch (e) {
                  onSaved(e instanceof ApiError ? `Error: ${e.message}` : 'Error');
                }
              }}
            >
              Guardar
            </button>
          </div>
        ) : c.account ? (
          <span><span className="font-mono">{c.account.displayCode}</span> {c.account.name}</span>
        ) : c.kind === 'EXCHANGE' || c.kind === 'TRANSFER' ? (
          <span className="text-muted">Automática (diferencia de cambio / transitoria)</span>
        ) : (
          <span className="text-warn">Sin cuenta: va a la bandeja de revisión</span>
        )}
      </td>
      <td className="text-[11px] text-muted">{c.aliases.slice(0, 4).join(' · ')}</td>
      <td className="num">{c.pendingReview > 0 ? c.pendingReview : ''}</td>
      <td>{canEdit && !editing && <button className="text-xs text-brand-600 hover:underline" onClick={() => setEditing(true)}>cambiar cuenta</button>}</td>
    </tr>
  );
}

export default function CategoriesPage() {
  const { can } = useSession();
  const { data, error, loading, reload } = useApi<CashCategory[]>('/treasury/categories');
  const { data: accounts } = useApi<Account[]>('/accounts?postable=true');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div>
      <PageHeader
        title="Categorías de tesorería"
        subtitle="Sustituyen a la “Referencia cruzada” del Excel. Cada categoría lleva su cuenta contrapartida; sin cuenta, el movimiento queda en la bandeja de revisión."
      />
      {msg && <div className="mb-3"><Alert kind={msg.startsWith('Error') ? 'error' : 'success'}>{msg}</Alert></div>}
      {error && <Alert>{error.message}</Alert>}
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Categoría</th><th>Tipo</th><th>Cuenta contrapartida</th><th>Textos del Excel</th><th className="num">Pendientes</th><th /></tr></thead>
          <tbody>
            {data?.map((c) => <Row key={c.id} c={c} accounts={accounts ?? []} canEdit={can('accounts:manage')} onSaved={(m) => { setMsg(m); void reload(); }} />)}
          </tbody>
        </table>
        {loading && !data && <Spinner />}
      </div>
    </div>
  );
}
