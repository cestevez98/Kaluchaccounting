'use client';

import { formatNumber, MONTH_NAMES } from '@kaluch/shared';
import { useState } from 'react';
import { Alert, DateText, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Run { id: string; companyId: string; year: number; month: number; entryId: string | null; movedUsd: string; createdAt: string }

export default function SignReclassPage() {
  const { me, companyId, can } = useSession();
  const now = new Date();
  const [company, setCompany] = useState(companyId ?? me?.companies[0]?.id ?? '');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, loading, reload } = useApi<Run[]>(`/parties/reclass${qs({ companyId })}`);
  const code = (id: string) => me?.companies.find((c) => c.id === id)?.code ?? '';
  return (
    <div>
      <PageHeader
        title="Reclasificación por signo"
        subtitle="Al cierre de cada mes, el saldo neto de cada cuenta corriente se deja en la cuenta que corresponde a su signo: por cobrar (135.x) si nos debe, por pagar (405.x) si le debemos. Igual que el BC del Excel. Repetirla es seguro: solo mueve lo que falte."
      />
      {msg && <div className="mb-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {can('parties:manage') && (
        <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
          <div>
            <label className="label" htmlFor="rc-company">Empresa</label>
            <select id="rc-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
              {me?.companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.legalName}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="rc-month">Mes</label>
            <select id="rc-month" className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="rc-year">Año</label>
            <input id="rc-year" className="input w-24" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </div>
          <button className="btn-primary" disabled={busy || !company} onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              const r = await api<{ movedUsd: string; entry: { number: string } | null }>('/parties/reclass', { method: 'POST', json: { companyId: company, year, month } });
              setMsg({ kind: 'success', text: r.entry ? `Asiento ${r.entry.number}: ${formatNumber(r.movedUsd)} USD reclasificados` : 'No había nada que reclasificar' });
              void reload();
            } catch (e) {
              setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : 'Error' });
            } finally {
              setBusy(false);
            }
          }}>{busy ? 'Reclasificando…' : 'Reclasificar'}</button>
        </div>
      )}
      <div className="card overflow-x-auto">
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Empresa</th><th>Mes</th><th className="num">USD movidos</th><th>Ejecutada</th></tr></thead>
            <tbody>
              {data?.map((r) => (
                <tr key={r.id}><td>{code(r.companyId)}</td><td>{MONTH_NAMES[r.month - 1]} {r.year}</td><td className="num">{r.entryId ? formatNumber(r.movedUsd) : 'sin cambios'}</td><td><DateText value={r.createdAt} /></td></tr>
              ))}
              {data?.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-muted">Aún no se ha ejecutado.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
