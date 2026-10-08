'use client';

import { CURRENCIES, formatNumber, money } from '@kaluch/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AccountPicker } from '@/components/account-picker';
import { BalanceText, OpenItemsTable, RoleBadges } from '@/components/parties';
import { Alert, DateInput, DateText, PageHeader, Spinner, today } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PARTY_ROLE_LABELS, type Account, type PartyDetail, type PartyRole, type Statement } from '@/lib/types';

function StatementView({ partyId }: { partyId: string }) {
  const { companyId } = useSession();
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const { data, error, loading } = useApi<Statement>(`/parties/${partyId}/statement${qs({ companyId, from, to })}`);

  function exportCsv() {
    if (!data) return;
    const rows = [['Moneda', 'Fecha', 'Asiento', 'Concepto', 'Cuenta', 'Debe', 'Haber', 'Saldo', 'Saldo USD']];
    for (const c of data.currencies) {
      rows.push([c.currency, from, '', 'Saldo inicial', '', '', '', c.opening, c.openingUsd]);
      for (const l of c.lines) {
        const a = money(l.amount);
        rows.push([c.currency, l.date, l.entryNumber, l.memo, l.accountCode, a.gt(0) ? a.toFixed(2) : '', a.lt(0) ? a.neg().toFixed(2) : '', l.balance, l.balanceUsd]);
      }
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `estado-de-cuenta-${from}-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div><label className="label" htmlFor="from">Desde</label><DateInput id="from" value={from} onChange={setFrom} /></div>
        <div><label className="label" htmlFor="to">Hasta</label><DateInput id="to" value={to} onChange={setTo} /></div>
        <button className="btn-secondary" onClick={exportCsv} disabled={!data}>Exportar CSV</button>
      </div>
      {error && <Alert>{error.message}</Alert>}
      {loading && !data && <Spinner />}
      {data?.currencies.length === 0 && <Alert kind="info">Sin movimientos en el periodo.</Alert>}
      {data?.currencies.map((c) => (
        <div key={c.currency} className="card mb-4 overflow-x-auto">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-xs">
            <span className="font-bold">Estado de cuenta en {c.currency}</span>
            <span>Saldo final: <BalanceText value={c.closing} currency={c.currency} />{c.currency !== 'USD' && <span className="ml-2 text-muted">(USD {formatNumber(c.closingUsd)})</span>}</span>
          </div>
          <table className="table">
            <thead><tr><th>Fecha</th><th>Asiento</th><th>Concepto</th><th>Cuenta</th><th className="num">Debe</th><th className="num">Haber</th><th className="num">Saldo</th>{c.currency !== 'USD' && <th className="num">Saldo USD</th>}</tr></thead>
            <tbody>
              <tr className="bg-canvas"><td><DateText value={from} /></td><td /><td className="font-medium">Saldo inicial</td><td /><td /><td /><td className="num">{formatNumber(c.opening)}</td>{c.currency !== 'USD' && <td className="num">{formatNumber(c.openingUsd)}</td>}</tr>
              {c.lines.map((l, i) => {
                const a = money(l.amount);
                return (
                  <tr key={`${l.entryNumber}-${i}`}>
                    <td><DateText value={l.date} /></td>
                    <td className="font-mono text-[11px]">{l.entryNumber}</td>
                    <td className="max-w-96 truncate" title={l.memo}>{l.memo}</td>
                    <td className="font-mono text-[11px]">{l.accountCode}</td>
                    <td className="num">{a.gt(0) ? formatNumber(a) : ''}</td>
                    <td className="num">{a.lt(0) ? formatNumber(a.neg()) : ''}</td>
                    <td className="num">{formatNumber(l.balance)}</td>
                    {c.currency !== 'USD' && <td className="num">{formatNumber(l.balanceUsd)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function NewAccountForm({ partyId, onDone }: { partyId: string; onDone: () => void }) {
  const { me } = useSession();
  const { data: accounts } = useApi<Account[]>('/accounts?postable=true');
  const [companyId, setCompanyId] = useState(me?.companies[0]?.id ?? '');
  const [currency, setCurrency] = useState('USD');
  const [accountId, setAccountId] = useState('');
  const [oppositeAccountId, setOpposite] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/parties/${partyId}/accounts`, { method: 'POST', json: { companyId, currency, accountId, oppositeAccountId: oppositeAccountId || null } });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error');
    }
  }
  return (
    <form onSubmit={submit} className="card mb-4 grid gap-3 p-4 sm:grid-cols-4">
      {error && <div className="sm:col-span-4"><Alert>{error}</Alert></div>}
      <div>
        <label className="label" htmlFor="pa-company">Empresa</label>
        <select id="pa-company" className="input" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          {me?.companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.legalName}</option>)}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="pa-cur">Moneda</label>
        <select id="pa-cur" className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      <div className="sm:col-span-2">
        <span className="label">Cuenta contable (135, 405, 406, 455…)</span>
        <AccountPicker ariaLabel="Cuenta contable" accounts={accounts ?? []} value={accountId} onChange={setAccountId} />
      </div>
      <div className="sm:col-span-2">
        <span className="label">Cuenta opuesta por signo (opcional: 405.x para una 135.x)</span>
        <AccountPicker ariaLabel="Cuenta opuesta" accounts={accounts ?? []} value={oppositeAccountId} onChange={setOpposite} />
      </div>
      <div className="flex items-end sm:col-span-2"><button className="btn-primary" disabled={!accountId || !companyId}>Abrir cuenta corriente</button></div>
    </form>
  );
}

export default function PartyPage() {
  const { id } = useParams<{ id: string }>();
  const { companyId, can } = useSession();
  const { data, error, loading, reload } = useApi<PartyDetail>(`/parties/${id}${qs({ companyId })}`);
  const [tab, setTab] = useState<'statement' | 'items' | 'data'>('statement');
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const total = (data?.accounts ?? []).reduce((s, a) => s.plus(money(a.balanceUsd)), money(0));

  if (loading && !data) return <Spinner />;
  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return null;
  return (
    <div>
      <PageHeader
        title={data.name}
        subtitle={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{data.code}</span>{data.taxId && <span>· {data.taxId}</span>}<RoleBadges roles={data.roles} />{!data.active && <span className="text-bad">· inactiva</span>}</span>}
        actions={can('parties:manage') ? <Link className="btn-primary" href={`/terceros/documento${qs({ party: data.id })}`}>Cargo / abono</Link> : null}
      />
      {msg && <div className="mb-3"><Alert kind="success">{msg}</Alert></div>}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card px-4 py-3">
          <div className="text-[10px] font-semibold tracking-wide text-subtle uppercase">Saldo neto</div>
          <div className="mt-1 text-xl font-bold tabular-nums"><BalanceText value={total.toFixed(4)} /></div>
          <div className="text-[11px] text-muted">USD, todas las cuentas</div>
        </div>
        {data.accounts.map((a) => (
          <div key={a.partyAccountId} className="card px-4 py-3">
            <div className="flex justify-between text-[10px] font-semibold tracking-wide text-subtle uppercase"><span>{a.companyCode} · {a.currency}</span><span className="font-mono normal-case">{a.accountCode}{a.oppositeCode ? ` ↔ ${a.oppositeCode}` : ''}</span></div>
            <div className="mt-1 text-lg font-bold tabular-nums"><BalanceText value={a.balance} currency={a.currency} /></div>
            <div className="text-[11px] text-muted">{a.currency !== 'USD' ? `USD ${formatNumber(a.balanceUsd)} · ` : ''}{a.openItems ? `${a.openItems} partidas abiertas` : 'sin partidas abiertas'}</div>
          </div>
        ))}
      </div>
      {can('parties:manage') && (
        <div className="mb-4">
          <button className="btn-secondary" onClick={() => setAdding(!adding)}>{adding ? 'Cancelar' : 'Añadir cuenta corriente'}</button>
        </div>
      )}
      {adding && <NewAccountForm partyId={data.id} onDone={() => { setAdding(false); setMsg('Cuenta corriente abierta'); void reload(); }} />}
      {data.categories.length > 0 && (
        <p className="mb-3 text-xs text-muted">Categorías de tesorería que se contabilizan en su cuenta corriente: {data.categories.map((c) => c.name).join(', ')}.</p>
      )}
      <div className="mb-3 flex gap-1 border-b border-line">
        {([['statement', 'Estado de cuenta'], ['items', 'Partidas abiertas'], ['data', 'Datos']] as const).map(([k, l]) => (
          <button key={k} className={`-mb-px border-b-2 px-3 py-1.5 text-xs font-medium ${tab === k ? 'border-brand-600 text-brand-600' : 'border-transparent text-muted hover:text-ink'}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'statement' && <StatementView partyId={data.id} />}
      {tab === 'items' && <OpenItemsTable partyId={data.id} />}
      {tab === 'data' && <PartyDataForm party={data} onSaved={() => { setMsg('Datos guardados'); void reload(); }} />}
    </div>
  );
}

function PartyDataForm({ party, onSaved }: { party: PartyDetail; onSaved: () => void }) {
  const { can } = useSession();
  const [form, setForm] = useState({ name: party.name, kind: party.kind, roles: party.roles, taxId: party.taxId ?? '', email: party.email ?? '', phone: party.phone ?? '', notes: party.notes ?? '', active: party.active });
  const [error, setError] = useState<string | null>(null);
  const editable = can('parties:manage');
  return (
    <form className="card max-w-2xl space-y-4 p-5" onSubmit={async (e) => {
      e.preventDefault();
      setError(null);
      try { await api(`/parties/${party.id}`, { method: 'PATCH', json: { ...form, taxId: form.taxId || null, email: form.email || null, phone: form.phone || null, notes: form.notes || null } }); onSaved(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Error'); }
    }}>
      {error && <Alert>{error}</Alert>}
      <fieldset disabled={!editable} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2"><label className="label" htmlFor="pd-name">Nombre</label><input id="pd-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label className="label" htmlFor="pd-kind">Tipo</label>
            <select id="pd-kind" className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'PERSON' })}><option value="PERSON">Persona</option><option value="COMPANY">Empresa</option></select>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          {(Object.entries(PARTY_ROLE_LABELS) as [PartyRole, string][]).map(([k, v]) => (
            <label key={k} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={form.roles.includes(k)} onChange={(e) => setForm({ ...form, roles: e.target.checked ? [...form.roles, k] : form.roles.filter((r) => r !== k) })} /> {v}</label>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div><label className="label" htmlFor="pd-tax">NIF</label><input id="pd-tax" className="input" value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} /></div>
          <div><label className="label" htmlFor="pd-email">Correo</label><input id="pd-email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div><label className="label" htmlFor="pd-phone">Teléfono</label><input id="pd-phone" className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
        </div>
        <div><label className="label" htmlFor="pd-notes">Notas</label><textarea id="pd-notes" className="input min-h-20" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Activa</label>
        {editable && <button className="btn-primary">Guardar</button>}
      </fieldset>
    </form>
  );
}
