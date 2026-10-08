'use client';

import { formatNumber } from '@kaluch/shared';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, DateText, PageHeader, Pagination, Spinner } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { CashCategory, Paged, TreasuryAccount } from '@/lib/types';

interface Line {
  id: string;
  valueDate: string;
  description: string;
  amount: string;
  status: 'UNMATCHED' | 'MATCHED' | 'IGNORED';
  leg: { movement: { id: string; document: { number: string } } } | null;
}
interface LinesResponse extends Paged<Line> {
  suggestions: Record<string, { legId: string; date: string; number: string; description: string }[]>;
}

function Statements() {
  const params = useSearchParams();
  const { companyId } = useSession();
  const { data: accounts } = useApi<TreasuryAccount[]>(`/treasury/accounts${qs({ companyId })}`);
  const { data: categories } = useApi<CashCategory[]>('/treasury/categories');
  const [accountId, setAccountId] = useState(params.get('account') ?? '');
  const [status, setStatus] = useState<'UNMATCHED' | 'MATCHED' | 'IGNORED' | ''>('UNMATCHED');
  const [page, setPage] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [createFor, setCreateFor] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState('');
  useEffect(() => setPage(1), [accountId, status]);
  const { data, error, loading, reload } = useApi<LinesResponse>(accountId ? `/treasury/statements/lines${qs({ treasuryAccountId: accountId, status, page, pageSize: 50 })}` : null);

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file || !accountId) return;
    const fd = new FormData();
    fd.append('treasuryAccountId', accountId);
    fd.append('file', file);
    try {
      const r = await api<{ lines: number; inserted: number; duplicates: number; matched: number; pending: number }>('/treasury/statements', { method: 'POST', body: fd });
      setMsg({ kind: 'success', text: `Extracto leído: ${r.lines} líneas, ${r.inserted} nuevas, ${r.duplicates} ya importadas. Conciliadas automáticamente: ${r.matched}. Pendientes: ${r.pending}.` });
      void reload();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Error al subir el extracto' });
    }
  }

  async function action(lineId: string, body: object) {
    try {
      await api(`/treasury/statements/lines/${lineId}`, { method: 'POST', json: body });
      setCreateFor(null);
      void reload();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Error' });
    }
  }

  return (
    <div>
      <PageHeader title="Extractos y conciliación bancaria" subtitle="Sube el extracto (CSV o Excel con Fecha, Concepto e Importe, o Cargo y Abono). Las líneas que ya existan no se duplican." />
      <div className="card mb-4 grid gap-3 p-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="st-account">Cuenta</label>
          <select id="st-account" className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Elige una cuenta…</option>
            {accounts?.filter((a) => a.kind !== 'CASH').map((a) => <option key={a.id} value={a.id}>{a.company.code} · {a.name} ({a.currency})</option>)}
          </select>
        </div>
        <form onSubmit={upload} className="sm:col-span-2 flex items-end gap-2">
          <div className="flex-1">
            <label className="label" htmlFor="st-file">Fichero del extracto</label>
            <input id="st-file" type="file" accept=".csv,.xlsx" className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <button className="btn-primary" disabled={!file || !accountId}>Subir y conciliar</button>
          {accountId && (
            <button type="button" className="btn-secondary" onClick={async () => {
              const r = await api<{ matched: number; pending: number }>('/treasury/statements/reconcile', { method: 'POST', json: { treasuryAccountId: accountId } });
              setMsg({ kind: 'info', text: `Conciliación automática: ${r.matched} casadas, ${r.pending} pendientes` });
              void reload();
            }}>Conciliar de nuevo</button>
          )}
        </form>
      </div>
      {msg && <div className="mb-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {error && <Alert>{error.message}</Alert>}
      {accountId && (
        <div className="mb-2 flex gap-2">
          {(['UNMATCHED', 'MATCHED', 'IGNORED', ''] as const).map((s) => (
            <button key={s} className={status === s ? 'btn-primary' : 'btn-secondary'} onClick={() => setStatus(s)}>
              {s === 'UNMATCHED' ? 'Pendientes' : s === 'MATCHED' ? 'Conciliadas' : s === 'IGNORED' ? 'Ignoradas' : 'Todas'}
            </button>
          ))}
        </div>
      )}
      {data && (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Fecha</th><th>Concepto del banco</th><th className="num">Importe</th><th>Estado</th><th>Conciliación</th></tr></thead>
            <tbody>
              {data.items.map((l) => (
                <tr key={l.id}>
                  <td><DateText value={l.valueDate} /></td>
                  <td className="max-w-md truncate" title={l.description}>{l.description}</td>
                  <td className={`num ${Number(l.amount) < 0 ? 'text-red-700' : ''}`}>{formatNumber(l.amount)}</td>
                  <td>{l.status === 'MATCHED' ? <Badge tone="green">Conciliada</Badge> : l.status === 'IGNORED' ? <Badge>Ignorada</Badge> : <Badge tone="amber">Pendiente</Badge>}</td>
                  <td className="text-xs">
                    {l.status === 'MATCHED' && l.leg && (
                      <span>
                        <a className="font-mono text-brand-600 underline" href={`/tesoreria/movimientos/${l.leg.movement.id}`}>{l.leg.movement.document.number}</a>
                        <button className="ml-2 text-gray-500 hover:underline" onClick={() => action(l.id, { action: 'unmatch' })}>deshacer</button>
                      </span>
                    )}
                    {l.status === 'IGNORED' && <button className="text-gray-500 hover:underline" onClick={() => action(l.id, { action: 'unmatch' })}>recuperar</button>}
                    {l.status === 'UNMATCHED' && (
                      <div className="space-y-1">
                        {(data.suggestions[l.id] ?? []).map((s) => (
                          <button key={s.legId} className="block text-left text-brand-600 hover:underline" onClick={() => action(l.id, { action: 'match', legId: s.legId })}>
                            Casar con {s.number} ({s.date.split('-').reverse().join('/')}) {s.description.slice(0, 40)}
                          </button>
                        ))}
                        {createFor === l.id ? (
                          <div className="flex gap-1">
                            <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                              <option value="">Sin clasificar</option>
                              {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                            <button className="btn-primary" onClick={() => action(l.id, { action: 'create', categoryId: categoryId || null })}>Crear</button>
                          </div>
                        ) : (
                          <span className="space-x-2">
                            <button className="text-brand-600 hover:underline" onClick={() => { setCreateFor(l.id); setCategoryId(''); }}>crear movimiento</button>
                            <button className="text-gray-500 hover:underline" onClick={() => action(l.id, { action: 'ignore' })}>ignorar</button>
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </div>
      )}
      {loading && !data && <Spinner />}
    </div>
  );
}

export default function StatementsPage() {
  return <Suspense><Statements /></Suspense>;
}
