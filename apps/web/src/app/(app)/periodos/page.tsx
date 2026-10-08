'use client';

import { MONTH_NAMES } from '@kaluch/shared';
import { useState } from 'react';
import { Alert, Badge, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PERIOD_LABEL } from '@/lib/types';

interface Period { id: string; companyId: string; year: number; month: number; status: 'OPEN' | 'SOFT_CLOSED' | 'LOCKED'; company: { code: string }; _count: { entries: number } }
const TONE = { OPEN: 'green', SOFT_CLOSED: 'amber', LOCKED: 'red' } as const;

export default function PeriodsPage() {
  const { companyId, can } = useSession();
  const [year, setYear] = useState(new Date().getFullYear());
  const { data, error, loading, reload } = useApi<Period[]>(`/periods${qs({ year, companyId })}`);
  const [msg, setMsg] = useState<string | null>(null);

  async function change(p: Period, status: Period['status']) {
    setMsg(null);
    let reason: string | undefined;
    if (p.status === 'LOCKED') {
      reason = window.prompt(`Motivo para reabrir ${MONTH_NAMES[p.month - 1]} ${p.year} (${p.company.code}):`) ?? undefined;
      if (!reason) return;
    }
    try {
      await api(`/periods/${p.id}`, { method: 'PATCH', json: { status, reason } });
      void reload();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Error');
    }
  }

  const byCompany = new Map<string, Period[]>();
  for (const p of data ?? []) byCompany.set(p.company.code, [...(byCompany.get(p.company.code) ?? []), p]);

  return (
    <div>
      <PageHeader
        title="Periodos contables"
        subtitle="Abierto → En revisión (solo contador) → Bloqueado. Reabrir un mes bloqueado exige permiso y motivo, y queda auditado."
        actions={
          <>
            <input className="input w-24" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Año" />
            {can('period:close') && (
              <button className="btn-secondary" onClick={async () => { await api('/periods/generate', { method: 'POST', json: { year, ...(companyId ? { companyId } : {}) } }); void reload(); }}>
                Crear periodos {year}
              </button>
            )}
          </>
        }
      />
      {msg && <div className="mb-3"><Alert>{msg}</Alert></div>}
      {error && <Alert>{error.message}</Alert>}
      {loading && !data && <Spinner />}
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr><th>Empresa</th>{MONTH_NAMES.map((m) => <th key={m}>{m.slice(0, 3)}</th>)}</tr>
          </thead>
          <tbody>
            {[...byCompany.entries()].map(([code, periods]) => (
              <tr key={code}>
                <td className="font-medium">{code}</td>
                {Array.from({ length: 12 }, (_, i) => {
                  const p = periods.find((x) => x.month === i + 1);
                  if (!p) return <td key={i} className="text-gray-300">—</td>;
                  return (
                    <td key={i} className="align-top">
                      <Badge tone={TONE[p.status]}>{PERIOD_LABEL[p.status]}</Badge>
                      <div className="mt-1 text-xs text-gray-400">{p._count.entries} asientos</div>
                      <div className="mt-1 flex flex-col gap-0.5 text-xs">
                        {p.status === 'OPEN' && can('period:close', p.companyId) && <button className="text-left text-brand-600 hover:underline" onClick={() => change(p, 'SOFT_CLOSED')}>A revisión</button>}
                        {p.status === 'SOFT_CLOSED' && can('period:lock', p.companyId) && <button className="text-left text-red-700 hover:underline" onClick={() => change(p, 'LOCKED')}>Bloquear</button>}
                        {p.status === 'SOFT_CLOSED' && can('period:close', p.companyId) && <button className="text-left text-gray-600 hover:underline" onClick={() => change(p, 'OPEN')}>Reabrir</button>}
                        {p.status === 'LOCKED' && can('period:reopen', p.companyId) && <button className="text-left text-gray-600 hover:underline" onClick={() => change(p, 'SOFT_CLOSED')}>Reabrir…</button>}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
