'use client';

import { formatNumber, parseNumberEs } from '@kaluch/shared';
import { useState, type FormEvent } from 'react';
import { Alert, DateInput, DateText, PageHeader, Pagination, Spinner, today } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Paged } from '@/lib/types';

interface Rate { id: string; rateDate: string; currency: string; rateType: string; base: string; rate: string; source: string | null }
const CURRENCIES = ['CUP', 'MLC', 'EUR', 'DOP', 'CAD', 'GBP'];
const TYPES = [['OC', 'Oficial'], ['IC', 'Informal'], ['OUE', 'Oficial UE'], ['ORD', 'Oficial RD']] as const;

function RateForm({ onSaved }: { onSaved: () => void }) {
  const [rateDate, setRateDate] = useState(today());
  const [currency, setCurrency] = useState('CUP');
  const [rateType, setRateType] = useState('IC');
  const [base, setBase] = useState('USD');
  const [rate, setRate] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/rates', { method: 'POST', json: { rateDate, currency, rateType, base, rate: parseNumberEs(rate) } });
      setMsg({ kind: 'success', text: `Tasa ${currency}/${base} (${rateType}) del ${rateDate.split('-').reverse().join('/')} guardada` });
      setRate('');
      onSaved();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Error' });
    }
  }
  return (
    <form onSubmit={submit} className="card mb-4 flex flex-wrap items-end gap-3 p-3">
      <div><label className="label">Fecha</label><DateInput value={rateDate} onChange={setRateDate} required /></div>
      <div><label className="label">Moneda</label><select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></div>
      <div><label className="label">Tipo</label><select className="input" value={rateType} onChange={(e) => setRateType(e.target.value)}>{TYPES.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}</select></div>
      <div><label className="label">Base</label><select className="input" value={base} onChange={(e) => setBase(e.target.value)}><option>USD</option><option>EUR</option></select></div>
      <div><label className="label">1 {base} = </label><input className="input num w-36" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="400,00" required inputMode="decimal" /></div>
      <button className="btn-primary">Guardar tasa</button>
      {msg && <div className="w-full"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
    </form>
  );
}

export default function RatesPage() {
  const { can } = useSession();
  const [page, setPage] = useState(1);
  const [currency, setCurrency] = useState('');
  const [rateType, setRateType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data, error, loading, reload } = useApi<Paged<Rate>>(`/rates${qs({ page, pageSize: 100, currency, rateType, from, to })}`);

  return (
    <div>
      <PageHeader title="Tasas de cambio" subtitle="Convención del Excel: 1 USD = X unidades (CUP/EUR con base EUR). Una tasa por día, moneda y tipo." />
      {can('fx:manage') && <RateForm onSaved={reload} />}
      <div className="card mb-3 flex flex-wrap items-end gap-3 p-3">
        <div><label className="label">Moneda</label><select className="input" value={currency} onChange={(e) => { setCurrency(e.target.value); setPage(1); }}><option value="">Todas</option>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></div>
        <div><label className="label">Tipo</label><select className="input" value={rateType} onChange={(e) => { setRateType(e.target.value); setPage(1); }}><option value="">Todos</option>{TYPES.map(([c]) => <option key={c}>{c}</option>)}</select></div>
        <div><label className="label">Desde</label><DateInput value={from} onChange={(v) => { setFrom(v); setPage(1); }} /></div>
        <div><label className="label">Hasta</label><DateInput value={to} onChange={(v) => { setTo(v); setPage(1); }} /></div>
      </div>
      {error && <Alert>{error.message}</Alert>}
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Fecha</th><th>Par</th><th>Tipo</th><th className="num">Tasa</th><th>Origen</th></tr></thead>
          <tbody>
            {data?.items.map((r) => (
              <tr key={r.id}>
                <td><DateText value={r.rateDate} /></td>
                <td>{r.currency}/{r.base}</td>
                <td>{r.rateType}</td>
                <td className="num">{formatNumber(r.rate, 4)}</td>
                <td className="text-gray-500">{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && !data && <Spinner />}
        {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </div>
    </div>
  );
}
