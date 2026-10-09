'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { CompanySelect, Kpi } from '@/components/sales';
import { Alert, Amount, Badge, DateInput, DateText, PageHeader, Pagination, Spinner, today } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { LoanRow, Paged } from '@/lib/types';

type Result = Paged<LoanRow> & { active: { direction: 'GIVEN' | 'RECEIVED'; count: number; principalUsd: string; interestUsd: string }[] };

export default function LoansPage() {
  const { companyId, can } = useSession();
  const [status, setStatus] = useState('ACTIVE');
  const [direction, setDirection] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useApi<Result>(
    `/finance/loans${qs({ companyId, status: status || undefined, direction: direction || undefined, q: q || undefined, page, pageSize: 50 })}`,
  );
  const received = data?.active.find((a) => a.direction === 'RECEIVED');
  const given = data?.active.find((a) => a.direction === 'GIVEN');
  return (
    <div>
      <PageHeader
        title="Préstamos"
        subtitle="Financiamientos recibidos (411; la parte a más de un año, 520) y dados (138). El interés es un % fijo sobre el principal y se devenga por días hasta el vencimiento (gasto 842 / ingreso 921)."
        actions={can('finance:manage') ? <Link className="btn-primary" href="/financiamientos/nuevo">Nuevo préstamo</Link> : null}
      />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="status">Estado</label>
          <select id="status" className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="ACTIVE">Vigentes</option><option value="CLOSED">Devueltos</option><option value="">Todos</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="dir">Tipo</label>
          <select id="dir" className="input" value={direction} onChange={(e) => { setDirection(e.target.value); setPage(1); }}>
            <option value="">Recibidos y dados</option><option value="RECEIVED">Recibidos</option><option value="GIVEN">Dados</option>
          </select>
        </div>
        <div><label className="label" htmlFor="q">Buscar</label><input id="q" className="input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Referencia o entidad" /></div>
      </div>
      {error && <Alert>{error.message}</Alert>}
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Kpi label="Recibidos vigentes" value={received?.principalUsd ?? (data ? '0.0000' : '…')} hint={`${received?.count ?? 0} préstamos · interés ${received?.interestUsd ?? '0'}`} />
        <Kpi label="Dados vigentes" value={given?.principalUsd ?? (data ? '0.0000' : '…')} hint={`${given?.count ?? 0} préstamos`} />
      </div>
      {can('finance:manage') && <MonthActions onDone={reload} />}
      <div className="card overflow-x-auto">
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Préstamo</th><th>Entidad</th><th>Tipo</th><th>Plazo</th><th className="num">Principal</th><th className="num">%</th><th className="num">Interés</th><th className="num">Devengado</th><th className="num">Pendiente</th><th>Estado</th></tr></thead>
            <tbody>
              {data?.items.map((l) => (
                <tr key={l.id}>
                  <td className="font-semibold">{l.reference}<div className="text-[10px] font-normal text-subtle">{l.companyCode} · {l.description}</div></td>
                  <td><Link className="hover:underline" href={`/terceros/${l.partyId}`}>{l.partyName}</Link></td>
                  <td>{l.direction === 'RECEIVED' ? 'Recibido' : 'Dado'}{Number(l.longTermUsd) > 0 && <div><Badge tone="blue">Largo plazo</Badge></div>}</td>
                  <td className="text-xs"><DateText value={l.startDate} />{l.endDate ? <> → <DateText value={l.endDate} /></> : ''}</td>
                  <td className="num"><Amount value={l.principalUsd} /></td>
                  <td className="num">{l.ratePct}</td>
                  <td className="num"><Amount value={l.interestUsd} muted /></td>
                  <td className="num">{l.migrated ? <span className="text-[10px] text-subtle">en el Excel</span> : <Amount value={l.accruedUsd} muted />}</td>
                  <td className="num">{l.openUsd === null ? '' : <Amount value={l.openUsd} />}</td>
                  <td>{l.status === 'ACTIVE' ? <Badge tone="amber">Vigente</Badge> : <Badge tone="green">Devuelto</Badge>}{l.migrated && <div className="text-[10px] text-subtle">migrado</div>}</td>
                </tr>
              ))}
              {data?.items.length === 0 && <tr><td colSpan={10} className="py-6 text-center text-muted">No hay préstamos.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </div>
  );
}

function MonthActions({ onDone }: { onDone: () => void }) {
  const { companyId: sessionCompany } = useSession();
  const [companyId, setCompanyId] = useState(sessionCompany ?? '');
  const [month, setMonth] = useState(today().slice(0, 7));
  const [asOf, setAsOf] = useState(today());
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  async function accrue(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const [year, m] = month.split('-').map(Number);
      const r = await api<{ reference: string; amountUsd: string }[]>('/finance/loans/accrue', { method: 'POST', json: { companyId, year, month: m } });
      setMsg({ kind: 'success', text: r.length ? `Interés devengado en ${r.length} préstamos.` : 'No había interés pendiente de devengar ese mes.' });
      onDone();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Error' });
    }
  }
  async function term() {
    setMsg(null);
    try {
      const r = await api<unknown[]>('/finance/loans/term', { method: 'POST', json: { companyId, asOf } });
      setMsg({ kind: 'success', text: r.length ? `Corto/largo plazo actualizado en ${r.length} préstamos.` : 'No había cambios de plazo.' });
      onDone();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Error' });
    }
  }
  return (
    <form onSubmit={accrue} className="card mb-4 flex flex-wrap items-end gap-3 p-4">
      {msg && <div className="w-full"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      <div><label className="label" htmlFor="lco">Empresa</label><CompanySelect id="lco" value={companyId} onChange={setCompanyId} perm="finance:manage" /></div>
      <div><label className="label" htmlFor="lmonth">Mes (AAAA-MM)</label><input id="lmonth" className="input" value={month} onChange={(e) => setMonth(e.target.value)} pattern="\d{4}-\d{2}" required /></div>
      <button className="btn-primary" disabled={!companyId}>Devengar intereses del mes</button>
      <div><label className="label" htmlFor="asof">Plazo al</label><DateInput id="asof" value={asOf} onChange={setAsOf} /></div>
      <button type="button" className="btn-secondary" disabled={!companyId} onClick={term}>Reclasificar corto/largo plazo</button>
    </form>
  );
}
