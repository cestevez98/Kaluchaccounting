'use client';

import { formatNumber, money, parseNumberEs } from '@kaluch/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { AccountPicker } from '@/components/account-picker';
import { BalanceText } from '@/components/parties';
import { Alert, DateInput, PageHeader, today } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import type { Account, Paged, PartyDetail, PartyRow } from '@/lib/types';

/** Selector de contraparte + cuenta corriente. */
function PartyAccountSelect({ id, label, partyId, onParty, value, onChange }: {
  id: string; label: string; partyId: string; onParty: (id: string) => void; value: string; onChange: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const { data: list } = useApi<Paged<PartyRow>>(q.length >= 2 && !partyId ? `/parties${qs({ q, pageSize: 10 })}` : null);
  const { data: party } = useApi<PartyDetail>(partyId ? `/parties/${partyId}` : null);
  useEffect(() => {
    if (party && !party.accounts.some((a) => a.partyAccountId === value)) onChange(party.accounts[0]?.partyAccountId ?? '');
  }, [party, value, onChange]);
  return (
    <div className="space-y-2">
      <label className="label" htmlFor={id}>{label}</label>
      {!partyId ? (
        <>
          <input id={id} className="input" placeholder="Escribe al menos 2 letras del nombre" value={q} onChange={(e) => setQ(e.target.value)} />
          {list && (
            <ul className="card max-h-56 divide-y divide-line overflow-auto">
              {list.items.map((p) => <li key={p.id}><button type="button" className="w-full px-3 py-1.5 text-left text-xs hover:bg-canvas" onClick={() => onParty(p.id)}>{p.name} <span className="text-muted">· {p.code}</span></button></li>)}
              {list.items.length === 0 && <li className="px-3 py-2 text-xs text-muted">Sin resultados. <Link className="text-brand-600 underline" href="/terceros/nuevo">Crear contraparte</Link></li>}
            </ul>
          )}
        </>
      ) : (
        <div className="flex items-center gap-2 text-sm">
          <strong>{party?.name ?? '…'}</strong>
          <button type="button" className="text-[11px] text-brand-600 hover:underline" onClick={() => { onParty(''); onChange(''); }}>cambiar</button>
        </div>
      )}
      {party && (
        party.accounts.length === 0 ? <Alert kind="warning">Esta contraparte no tiene cuentas corrientes. <Link className="underline" href={`/terceros/${party.id}`}>Ábrele una</Link>.</Alert> : (
          <select aria-label={`${label}: cuenta corriente`} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
            {party.accounts.map((a) => <option key={a.partyAccountId} value={a.partyAccountId}>{a.companyCode} · {a.currency} · {a.accountCode} — saldo {formatNumber(a.balance)}</option>)}
          </select>
        )
      )}
      {party && value && (() => { const a = party.accounts.find((x) => x.partyAccountId === value); return a ? <div className="text-xs">Saldo actual: <BalanceText value={a.balance} currency={a.currency} /></div> : null; })()}
    </div>
  );
}

function DocumentForm() {
  const params = useSearchParams();
  const invoice = params.get('tipo') === 'factura';
  const [partyId, setPartyId] = useState(params.get('party') ?? '');
  const [partyAccountId, setPartyAccountId] = useState('');
  const [kind, setKind] = useState<'CHARGE' | 'CREDIT' | 'ASSIGNMENT'>(invoice ? 'CREDIT' : 'CHARGE');
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [counterAccountId, setCounter] = useState('');
  const [toPartyId, setToPartyId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [openItem, setOpenItem] = useState(invoice);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ number: string; partyId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: accounts } = useApi<Account[]>('/accounts?postable=true');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let value: string;
    try { value = parseNumberEs(amount); } catch { setError('Importe no válido'); return; }
    if (money(value).lte(0)) { setError('Indica un importe mayor que 0'); return; }
    setBusy(true);
    try {
      const r = await api<{ document: { number: string } }>('/parties/documents', {
        method: 'POST',
        json: {
          partyAccountId, date, kind, amount: money(value).toFixed(4), description, reference: reference || null, dueDate: dueDate || null,
          openItem: kind !== 'ASSIGNMENT' && openItem, counterAccountId: kind === 'ASSIGNMENT' ? null : counterAccountId || null,
          counterPartyAccountId: kind === 'ASSIGNMENT' ? toAccountId || null : null,
        },
      });
      setDone({ number: r.document.number, partyId });
      setAmount(''); setDescription(''); setReference(''); setDueDate('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={invoice ? 'Registrar factura de proveedor' : 'Cargo, abono o cesión de deuda'}
        subtitle="Se contabiliza en la cuenta corriente de la contraparte con la contrapartida que elijas. Para cobros y pagos con dinero usa Bancos y Caja con la categoría de la contraparte."
      />
      {done && <div className="mb-3"><Alert kind="success">Documento {done.number} contabilizado. <Link className="underline" href={`/terceros/${done.partyId}`}>Ver estado de cuenta</Link></Alert></div>}
      <form onSubmit={submit} className="card space-y-4 p-5">
        {error && <Alert>{error}</Alert>}
        <PartyAccountSelect id="party" label="Contraparte" partyId={partyId} onParty={setPartyId} value={partyAccountId} onChange={setPartyAccountId} />
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="kind">Tipo</label>
            <select id="kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as 'CHARGE')}>
              <option value="CHARGE">Cargo (nos debe más / le debemos menos)</option>
              <option value="CREDIT">Abono (le debemos más / nos debe menos)</option>
              <option value="ASSIGNMENT">Cesión de deuda a otra contraparte</option>
            </select>
          </div>
          <div><label className="label" htmlFor="date">Fecha</label><DateInput id="date" value={date} onChange={setDate} required /></div>
          <div><label className="label" htmlFor="amount">Importe (moneda de la cuenta)</label><input id="amount" className="input num" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" required /></div>
        </div>
        {kind === 'ASSIGNMENT' ? (
          <PartyAccountSelect id="to-party" label="Recibe la deuda" partyId={toPartyId} onParty={setToPartyId} value={toAccountId} onChange={setToAccountId} />
        ) : (
          <div>
            <span className="label">Contrapartida (gasto, ingreso, inventario…)</span>
            <AccountPicker ariaLabel="Contrapartida" accounts={accounts ?? []} value={counterAccountId} onChange={setCounter} />
          </div>
        )}
        <div><label className="label" htmlFor="desc">Concepto</label><input id="desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={480} /></div>
        {kind !== 'ASSIGNMENT' && (
          <div className="grid gap-4 sm:grid-cols-3">
            <div><label className="label" htmlFor="ref">Referencia / nº de factura</label><input id="ref" className="input" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
            <div><label className="label" htmlFor="due">Vencimiento</label><DateInput id="due" value={dueDate} onChange={setDueDate} /></div>
            <label className="mt-5 flex items-center gap-2 text-xs"><input type="checkbox" checked={openItem} onChange={(e) => setOpenItem(e.target.checked)} /> Crear partida abierta (para casarla con sus pagos)</label>
          </div>
        )}
        <button className="btn-primary" disabled={busy || !partyAccountId || (kind === 'ASSIGNMENT' ? !toAccountId : !counterAccountId)}>{busy ? 'Contabilizando…' : 'Contabilizar'}</button>
      </form>
    </div>
  );
}

export default function PartyDocumentPage() {
  return <Suspense><DocumentForm /></Suspense>;
}
