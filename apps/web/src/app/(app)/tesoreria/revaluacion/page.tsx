'use client';

import { formatNumber, MONTH_NAMES } from '@kaluch/shared';
import { Fragment, useState } from 'react';
import { Alert, Amount, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Run {
  id: string; companyId: string; year: number; month: number; totalUsd: string; entryId: string | null; createdAt: string;
  lines: { id: string; accountId: string; currency: string; rateType: string; balanceOrig: string; bookedUsd: string; closingRate: string; revaluedUsd: string; diffUsd: string }[];
}

export default function RevaluationPage() {
  const { me, companyId, can } = useSession();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() === 0 ? 12 : now.getMonth());
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useApi<Run[]>(`/treasury/revaluations${qs({ year, companyId })}`);
  const code = (id: string) => me?.companies.find((c) => c.id === id)?.code ?? id.slice(0, 6);

  return (
    <div>
      <PageHeader
        title="Revaluación de fin de mes (tenencia)"
        subtitle="Cierre de mes: lleva el saldo en USD de cada cuenta en moneda extranjera (caja, bancos y cuentas corrientes) a saldo / tasa de cierre, con la diferencia en 846/925; regulariza las transitorias de cambios y traspasos con una sola pata (845/924) y reclasifica por signo las cuentas corrientes (135 ↔ 405). Repetir un mes recalcula."
      />
      {can('ledger:post') && (
        <div className="card mb-4 flex flex-wrap items-end gap-3 p-3">
          <div>
            <label className="label" htmlFor="rv-month">Mes</label>
            <select id="rv-month" className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="rv-year">Año</label><input id="rv-year" className="input w-24" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} /></div>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setMsg(null);
              try {
                const r = await api<{ totalUsd: string }[]>('/treasury/revaluations', { method: 'POST', json: { year, month, ...(companyId ? { companyId } : {}) } });
                setMsg({ kind: 'success', text: `Revaluación de ${MONTH_NAMES[month - 1]} ${year} registrada (${r.length} empresas)` });
                void reload();
              } catch (e) {
                setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : 'Error' });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Cerrando…' : `Revaluar y cerrar ${MONTH_NAMES[month - 1]} ${year}`}
          </button>
        </div>
      )}
      {msg && <div className="mb-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {error && <Alert>{error.message}</Alert>}
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Mes</th><th>Empresa</th><th className="num">Cuentas revaluadas</th><th className="num">Efecto USD (+ ingreso / − gasto)</th><th>Asiento</th></tr></thead>
          <tbody>
            {data?.map((r) => (
              <Fragment key={r.id}>
                <tr className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <td>{MONTH_NAMES[r.month - 1]} {r.year}</td>
                  <td>{code(r.companyId)}</td>
                  <td className="num">{r.lines.length}</td>
                  <td className="num"><Amount value={r.totalUsd} /></td>
                  <td>{r.entryId ? <a className="text-brand-600 underline" href={`/diario/${r.entryId}`}>ver asiento</a> : <span className="text-gray-400">sin diferencias</span>}</td>
                </tr>
                {open === r.id && r.lines.map((l) => (
                  <tr key={l.id} className="text-xs text-gray-600">
                    <td />
                    <td colSpan={2}>{l.currency} ({l.rateType}) · saldo {formatNumber(l.balanceOrig)} / tasa {formatNumber(l.closingRate, 4)}</td>
                    <td className="num">{formatNumber(l.bookedUsd)} → {formatNumber(l.revaluedUsd)} ({formatNumber(l.diffUsd)})</td>
                    <td />
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
        {loading && !data && <Spinner />}
        {data && data.length === 0 && <div className="p-4 text-sm text-gray-500">No hay revaluaciones en {year}.</div>}
      </div>
    </div>
  );
}
