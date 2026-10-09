'use client';

import { formatNumber } from '@kaluch/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AccountPicker } from '@/components/account-picker';
import { CompanySelect, numEs } from '@/components/sales';
import { Alert, Amount, DateInput, DateText, PageHeader, Spinner, today } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CAPITAL_KIND_LABEL, type Account, type CapitalMovementRow, type CapitalPartner, type Paged } from '@/lib/types';

export default function CapitalPage() {
  const { companyId, can } = useSession();
  const [asOf, setAsOf] = useState(today());
  const { data, error, loading, reload } = useApi<{ partners: CapitalPartner[]; movements: CapitalMovementRow[] }>(`/finance/capital${qs({ companyId, asOf })}`);
  return (
    <div>
      <PageHeader
        title="Capital por socio"
        subtitle="Capital (600) y utilidades retenidas (630) por socio. Lo migrado del Excel y los cierres de ejercicio no tienen socio asignado: el Excel calcula el capital como un único saldo."
      />
      <div className="mb-3"><label className="label" htmlFor="asof">A la fecha</label><DateInput id="asof" value={asOf} onChange={setAsOf} /></div>
      {error && <Alert>{error.message}</Alert>}
      <div className="mb-4 card overflow-x-auto">
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Socio</th><th className="num">Capital</th><th className="num">% del capital de socios</th><th className="num">Utilidades retenidas</th></tr></thead>
            <tbody>
              {data?.partners.map((p) => (
                <tr key={p.partyId ?? 'none'}>
                  <td>{p.partyId ? <Link className="hover:underline" href={`/terceros/${p.partyId}`}>{p.name}</Link> : <span className="text-muted">{p.name}</span>}</td>
                  <td className="num font-semibold"><Amount value={p.capitalUsd} /></td>
                  <td className="num">{p.sharePct === null ? '' : `${formatNumber(p.sharePct)} %`}</td>
                  <td className="num"><Amount value={p.retainedUsd} /></td>
                </tr>
              ))}
              {data?.partners.length === 0 && <tr><td colSpan={4} className="py-4 text-center text-muted">Sin movimientos de capital.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {can('capital:manage') && <MovementForm onDone={reload} />}
      <div className="card overflow-x-auto">
        <div className="border-b border-line px-4 py-2.5 text-xs font-bold">Movimientos</div>
        <table className="table">
          <thead><tr><th>Fecha</th><th>Documento</th><th>Socio</th><th>Tipo</th><th>Concepto</th><th className="num">Importe</th></tr></thead>
          <tbody>
            {data?.movements.map((m) => (
              <tr key={m.id}>
                <td><DateText value={m.date} /></td>
                <td className="text-xs">{m.number}</td>
                <td><Link className="hover:underline" href={`/terceros/${m.partyId}`}>{m.partyName}</Link></td>
                <td>{CAPITAL_KIND_LABEL[m.kind]}</td>
                <td>{m.description}</td>
                <td className="num"><Amount value={m.kind === 'CONTRIBUTION' ? m.amountUsd : String(-Number(m.amountUsd))} /></td>
              </tr>
            ))}
            {data?.movements.length === 0 && <tr><td colSpan={6} className="py-4 text-center text-muted">Sin movimientos.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MovementForm({ onDone }: { onDone: () => void }) {
  const { companyId: sc } = useSession();
  const { data: partners } = useApi<Paged<{ id: string; name: string }>>('/parties?role=PARTNER&pageSize=200');
  const { data: accounts } = useApi<Account[]>('/accounts?postable=true');
  const [companyId, setCompanyId] = useState(sc ?? '');
  const [partyId, setPartyId] = useState('');
  const [kind, setKind] = useState('CONTRIBUTION');
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [counter, setCounter] = useState('');
  const [description, setDescription] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await api<{ document: string }>('/finance/capital', { method: 'POST', json: { companyId, partyId, kind, date, amountUsd: numEs(amount), counterAccountId: counter, description } });
      setMsg({ kind: 'success', text: `Movimiento ${r.document} contabilizado.` });
      setAmount(''); setDescription('');
      onDone();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Error' });
    }
  }
  return (
    <form onSubmit={submit} className="card mb-4 space-y-3 p-4">
      <div className="text-xs font-bold">Aporte, retiro o reparto de utilidades</div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="grid gap-3 sm:grid-cols-4">
        <div><label className="label" htmlFor="mco">Empresa</label><CompanySelect id="mco" value={companyId} onChange={setCompanyId} perm="capital:manage" /></div>
        <div>
          <label className="label" htmlFor="partner">Socio</label>
          <select id="partner" className="input" value={partyId} onChange={(e) => setPartyId(e.target.value)} required>
            <option value="">Elige…</option>
            {partners?.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {partners?.items.length === 0 && <p className="mt-1 text-[11px] text-muted"><Link className="underline" href="/terceros/nuevo">Crea la contraparte</Link> con el rol Socio.</p>}
        </div>
        <div>
          <label className="label" htmlFor="kind">Tipo</label>
          <select id="kind" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(CAPITAL_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div><label className="label" htmlFor="mdate">Fecha</label><DateInput id="mdate" value={date} onChange={setDate} required /></div>
        <div><label className="label" htmlFor="mamount">Importe USD</label><input id="mamount" className="input num" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
        <div className="sm:col-span-2"><span className="label">Cuenta (caja, banco o cuenta por pagar al socio)</span><AccountPicker ariaLabel="Cuenta de contrapartida" accounts={accounts ?? []} value={counter} onChange={setCounter} /></div>
        <div><label className="label" htmlFor="mdesc">Concepto</label><input id="mdesc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} required /></div>
      </div>
      <button className="btn-primary" disabled={!companyId || !partyId || !counter}>Contabilizar</button>
    </form>
  );
}
