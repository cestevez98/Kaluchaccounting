'use client';

import { formatNumber } from '@kaluch/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AccountPicker } from '@/components/account-picker';
import { Alert, Badge, DateText, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { KIND_LABEL, MOVEMENT_KIND_LABEL, type Account, type CashCategory, type Movement } from '@/lib/types';

interface MovementDetail extends Movement {
  entries: { id: string; number: string; kind: string; status: string }[];
  importRow: { sheet: string; excelRow: number; raw: Record<string, unknown>; status: string; message: string | null } | null;
}

export default function MovementPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data: m, error, loading, reload } = useApi<MovementDetail>(`/treasury/movements/${id}`);
  const { data: accounts } = useApi<Account[]>('/accounts?postable=true');
  const { data: categories } = useApi<CashCategory[]>('/treasury/categories');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  if (loading && !m) return <Spinner />;
  if (error) return <Alert>{error.message}</Alert>;
  if (!m) return null;

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'success', text: ok });
      void reload();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : 'Error' });
    }
  }

  return (
    <div>
      <PageHeader
        title={`Movimiento ${m.document.number}`}
        subtitle={<>{m.document.company.code} · <DateText value={m.document.docDate} /> · {MOVEMENT_KIND_LABEL[m.kind]}</>}
        actions={
          <>
            <Link href="/tesoreria" className="btn-secondary">Tesorería</Link>
            {m.document.status === 'POSTED' && m.kind !== 'OPENING' && can('cash:operate', m.document.companyId) && (
              <button className="btn-danger" onClick={() => confirm('¿Anular el movimiento? Se generará un contra-asiento.') && act(() => api(`/treasury/movements/${id}/void`, { method: 'POST' }), 'Movimiento anulado')}>
                Anular
              </button>
            )}
          </>
        }
      />
      {msg && <div className="mb-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      <div className="card mb-4 grid gap-3 p-4 text-sm sm:grid-cols-4">
        <div className="sm:col-span-2"><div className="label">Concepto</div>{m.description}</div>
        <div><div className="label">Categoría</div>{m.category?.name ?? '—'}{m.sourceReference && <div className="text-xs text-gray-500">Excel: “{m.sourceReference}”</div>}</div>
        <div>
          <div className="label">Estado</div>
          {m.document.status === 'VOIDED' ? <Badge tone="red">Anulado</Badge> : m.needsReview ? <Badge tone="amber">Pendiente de clasificar</Badge> : <Badge tone="green">Contabilizado</Badge>}
          {m.reviewNote && <div className="text-xs text-gray-500">{m.reviewNote}</div>}
        </div>
      </div>

      <div className="card mb-4 overflow-x-auto">
        <table className="table">
          <thead><tr><th>Cuenta de tesorería</th><th className="num">Importe</th><th>Mon.</th><th className="num">Tasa</th><th className="num">USD</th></tr></thead>
          <tbody>
            {m.legs.map((l) => (
              <tr key={l.id}>
                <td><span className="font-mono text-xs">{l.treasuryAccount.glAccount?.displayCode}</span> {l.treasuryAccount.name}</td>
                <td className={`num ${Number(l.amount) < 0 ? 'text-red-700' : ''}`}>{formatNumber(l.amount)}</td>
                <td>{l.currency}</td>
                <td className="num text-gray-500">{l.currency === 'USD' ? '' : formatNumber(l.rate, 4)}</td>
                <td className="num">{formatNumber(l.amountUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {m.needsReview && m.document.status === 'POSTED' && can('bank:reconcile', m.document.companyId) && (
        <div className="card mb-4 space-y-3 border-amber-200 p-4">
          <div className="font-medium">Clasificar este movimiento</div>
          <p className="text-sm text-gray-600">Se registrará un asiento de ajuste que lleva el importe desde “Pendiente de clasificar” a la cuenta elegida.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2"><label className="label">Cuenta contrapartida</label><AccountPicker accounts={accounts ?? []} value={accountId} onChange={(v) => setAccountId(v)} /></div>
            <div>
              <label className="label">Categoría</label>
              <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">(sin cambiar)</option>
                {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="sm:col-span-3"><label className="label">Nota</label><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          </div>
          <button className="btn-primary" disabled={!accountId} onClick={() => act(() => api(`/treasury/review/${id}/reclassify`, { method: 'POST', json: { accountId, categoryId: categoryId || null, note: note || undefined } }), 'Movimiento clasificado')}>
            Clasificar
          </button>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-4 text-sm">
          <div className="mb-2 font-medium">Asientos</div>
          <ul className="space-y-1">
            {m.entries.map((e) => (
              <li key={e.id}><Link className="font-mono text-xs text-brand-600 underline" href={`/diario/${e.id}`}>{e.number}</Link> · {KIND_LABEL[e.kind]} {e.status === 'REVERSED' && <Badge tone="red">anulado</Badge>}</li>
            ))}
          </ul>
        </div>
        {m.importRow && (
          <div className="card p-4 text-sm">
            <div className="mb-2 font-medium">Origen en el Excel: hoja {m.importRow.sheet}, fila {m.importRow.excelRow}</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              {Object.entries(m.importRow.raw).filter(([, v]) => v !== null && v !== '').map(([k, v]) => (
                <div key={k} className="contents"><dt className="text-gray-500">{k}</dt><dd className="break-all">{String(v)}</dd></div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
