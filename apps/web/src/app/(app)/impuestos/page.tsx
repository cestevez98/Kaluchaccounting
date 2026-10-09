'use client';

import { formatNumber, MONTH_NAMES } from '@kaluch/shared';
import { useState, type FormEvent } from 'react';
import { CompanySelect, Kpi, numEs } from '@/components/sales';
import { Alert, Amount, DateInput, DateText, PageHeader, Spinner, today } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { TaxSummary } from '@/lib/types';

const AGENCIES = [
  { key: 'ONAT', label: 'ONAT (Cuba)', hint: 'Distribución · cierre trimestral' },
  { key: 'HACIENDA', label: 'Hacienda (España)', hint: 'Exportación · cierre anual' },
] as const;

export default function TaxesPage() {
  const { companyId, can } = useSession();
  const [agency, setAgency] = useState<'ONAT' | 'HACIENDA'>('ONAT');
  const [year, setYear] = useState(Number(today().slice(0, 4)));
  const { data, error, loading, reload } = useApi<TaxSummary>(`/finance/taxes${qs({ companyId, agency, year })}`);
  const last = data?.months.at(-1);
  const sum = (k: 'accruedUsd' | 'paidUsd' | 'adjustmentUsd') => (data?.months ?? []).reduce((s, m) => s + Number(m[k]), 0).toFixed(4);
  return (
    <div>
      <PageHeader
        title="Impuestos"
        subtitle="Devengo de impuestos (gasto 830 contra Gastos acumulados por pagar 480), pagos desde Bancos y Caja con la categoría del organismo, y cierre del periodo: la diferencia entre lo declarado y lo devengado va a 848 (se debía más) o 920 (se debía menos)."
      />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="flex gap-1">
          {AGENCIES.map((a) => (
            <button key={a.key} className={agency === a.key ? 'btn-primary' : 'btn-secondary'} onClick={() => setAgency(a.key)} title={a.hint}>{a.label}</button>
          ))}
        </div>
        <div><label className="label" htmlFor="year">Año</label><input id="year" type="number" className="input w-24" value={year} onChange={(e) => setYear(Number(e.target.value))} /></div>
      </div>
      {error && <Alert>{error.message}</Alert>}
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Kpi label="Devengado en el año" value={data ? sum('accruedUsd') : '…'} />
        <Kpi label="Pagado en el año" value={data ? sum('paidUsd') : '…'} />
        <Kpi label="Ajustes de cierre" value={data ? sum('adjustmentUsd') : '…'} />
        <Kpi label="Por pagar a fin de año" value={last?.balanceUsd ?? '…'} tone="warn" />
      </div>
      {can('tax:manage') && (
        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <AccrueForm agency={agency} onDone={reload} />
          <CloseForm agency={agency} onDone={reload} />
        </div>
      )}
      <div className="mb-4 card overflow-x-auto">
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Mes</th><th className="num">Devengado</th><th className="num">Pagado</th><th className="num">Ajuste de cierre</th><th className="num">Por pagar</th></tr></thead>
            <tbody>
              {data?.months.map((m) => (
                <tr key={m.month}>
                  <td>{MONTH_NAMES[m.month - 1]}</td>
                  <td className="num"><Amount value={m.accruedUsd} muted={Number(m.accruedUsd) === 0} /></td>
                  <td className="num"><Amount value={m.paidUsd} muted={Number(m.paidUsd) === 0} /></td>
                  <td className="num"><Amount value={m.adjustmentUsd} muted={Number(m.adjustmentUsd) === 0} /></td>
                  <td className="num font-semibold"><Amount value={m.balanceUsd} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card overflow-x-auto">
        <div className="border-b border-line px-4 py-2.5 text-xs font-bold">Cierres del periodo fiscal</div>
        <table className="table">
          <thead><tr><th>Periodo</th><th>Documento</th><th className="num">Declarado</th><th className="num">Devengado</th><th className="num">Diferencia</th></tr></thead>
          <tbody>
            {data?.closings.map((c) => (
              <tr key={c.id}>
                <td><DateText value={c.periodFrom} /> – <DateText value={c.periodTo} /></td>
                <td className="text-xs">{c.number} · <DateText value={c.date} /></td>
                <td className="num"><Amount value={c.declaredUsd} /></td>
                <td className="num"><Amount value={c.accruedUsd} /></td>
                <td className="num font-semibold"><Amount value={c.adjustmentUsd} /> <span className="text-[10px] text-subtle">{Number(c.adjustmentUsd) > 0 ? '848' : Number(c.adjustmentUsd) < 0 ? '920' : ''}</span></td>
              </tr>
            ))}
            {data?.closings.length === 0 && <tr><td colSpan={5} className="py-4 text-center text-muted">Sin cierres en {year}.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AccrueForm({ agency, onDone }: { agency: 'ONAT' | 'HACIENDA'; onDone: () => void }) {
  const { companyId: sc } = useSession();
  const [companyId, setCompanyId] = useState(sc ?? '');
  const [date, setDate] = useState(today());
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await api<{ document: string }>('/finance/taxes/accrue', { method: 'POST', json: { companyId, agency, date, periodFrom: from, periodTo: to, amountUsd: numEs(amount), description } });
      setMsg({ kind: 'success', text: `Devengo ${r.document} contabilizado.` });
      setAmount(''); setDescription('');
      onDone();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Error' });
    }
  }
  return (
    <form onSubmit={submit} className="card space-y-3 p-4">
      <div className="text-xs font-bold">Devengar impuesto</div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="label" htmlFor="aco">Empresa</label><CompanySelect id="aco" value={companyId} onChange={setCompanyId} perm="tax:manage" /></div>
        <div><label className="label" htmlFor="adate">Fecha</label><DateInput id="adate" value={date} onChange={setDate} required /></div>
        <div><label className="label" htmlFor="afrom">Periodo desde</label><DateInput id="afrom" value={from} onChange={setFrom} required /></div>
        <div><label className="label" htmlFor="ato">Periodo hasta</label><DateInput id="ato" value={to} onChange={setTo} required /></div>
        <div><label className="label" htmlFor="aamount">Importe USD</label><input id="aamount" className="input num" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
        <div><label className="label" htmlFor="adesc">Concepto</label><input id="adesc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} required /></div>
      </div>
      <button className="btn-primary" disabled={!companyId}>Devengar</button>
    </form>
  );
}

function CloseForm({ agency, onDone }: { agency: 'ONAT' | 'HACIENDA'; onDone: () => void }) {
  const { companyId: sc } = useSession();
  const [companyId, setCompanyId] = useState(sc ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [date, setDate] = useState(today());
  const [declared, setDeclared] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await api<{ document: string; accruedUsd: string; adjustmentUsd: string }>('/finance/taxes/close', {
        method: 'POST', json: { companyId, agency, periodFrom: from, periodTo: to, date, declaredUsd: numEs(declared) },
      });
      setMsg({ kind: 'success', text: `Cierre ${r.document}: devengado ${formatNumber(r.accruedUsd)}, diferencia ${formatNumber(r.adjustmentUsd)} USD.` });
      setDeclared('');
      onDone();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Error' });
    }
  }
  return (
    <form onSubmit={submit} className="card space-y-3 p-4">
      <div className="text-xs font-bold">Cerrar el periodo ({agency === 'ONAT' ? 'trimestre' : 'año'})</div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="label" htmlFor="cco">Empresa</label><CompanySelect id="cco" value={companyId} onChange={setCompanyId} perm="tax:manage" /></div>
        <div><label className="label" htmlFor="cdate">Fecha del cierre</label><DateInput id="cdate" value={date} onChange={setDate} required /></div>
        <div><label className="label" htmlFor="cfrom">Periodo desde</label><DateInput id="cfrom" value={from} onChange={setFrom} required /></div>
        <div><label className="label" htmlFor="cto">Periodo hasta</label><DateInput id="cto" value={to} onChange={setTo} required /></div>
        <div><label className="label" htmlFor="cdecl">Declarado (USD)</label><input id="cdecl" className="input num" value={declared} onChange={(e) => setDeclared(e.target.value)} required /></div>
      </div>
      <button className="btn-primary" disabled={!companyId}>Cerrar periodo</button>
    </form>
  );
}
