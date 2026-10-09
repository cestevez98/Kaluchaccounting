'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AccountPicker } from '@/components/account-picker';
import { numEs, PartyAccountSelect, usePartyAccounts } from '@/components/sales';
import { Alert, DateInput, PageHeader, today } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import type { Account } from '@/lib/types';

export default function NewLoanPage() {
  const [direction, setDirection] = useState<'RECEIVED' | 'GIVEN'>('RECEIVED');
  const lenders = usePartyAccounts(['411']);
  const borrowers = usePartyAccounts(['138']);
  const { data: accounts } = useApi<Account[]>('/accounts?postable=true');
  const [pa, setPa] = useState('');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStart] = useState(today());
  const [endDate, setEnd] = useState('');
  const [principal, setPrincipal] = useState('');
  const [rate, setRate] = useState('');
  const [counter, setCounter] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  let interest = '';
  try { interest = principal && rate ? (Number(numEs(principal)) * Number(numEs(rate)) / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''; } catch { interest = ''; }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const r = await api<{ reference: string }>('/finance/loans', {
        method: 'POST',
        json: { partyAccountId: pa, direction, reference, description, startDate, endDate: endDate || null, principalUsd: numEs(principal), ratePct: numEs(rate), counterAccountId: counter || null },
      });
      setMsg({ kind: 'success', text: `Préstamo ${r.reference} registrado.` });
      setReference(''); setPrincipal(''); setRate(''); setDescription('');
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Error' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="max-w-3xl">
      <PageHeader title="Nuevo préstamo" subtitle="Con cuenta de desembolso se contabiliza el principal y se abre una partida por el total a devolver (principal + interés)." />
      {msg && <div className="mb-3"><Alert kind={msg.kind}>{msg.text} {msg.kind === 'success' && <Link className="underline" href="/financiamientos">Ver préstamos</Link>}</Alert></div>}
      <form onSubmit={submit} className="card space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="dir">Tipo</label>
            <select id="dir" className="input" value={direction} onChange={(e) => { setDirection(e.target.value as 'GIVEN'); setPa(''); }}>
              <option value="RECEIVED">Recibido (nos prestan)</option><option value="GIVEN">Dado (prestamos)</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="pa">{direction === 'RECEIVED' ? 'Prestamista' : 'Deudor'}</label>
            <PartyAccountSelect id="pa" value={pa} onChange={setPa} options={direction === 'RECEIVED' ? lenders : borrowers} required missing={`No hay contrapartes con cuenta ${direction === 'RECEIVED' ? '411' : '138'}.`} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div><label className="label" htmlFor="ref">Referencia</label><input id="ref" className="input" value={reference} onChange={(e) => setReference(e.target.value)} required placeholder="FI260301" /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="desc">Descripción</label><input id="desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} required /></div>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <div><label className="label" htmlFor="start">Inicio</label><DateInput id="start" value={startDate} onChange={setStart} required /></div>
          <div><label className="label" htmlFor="end">Vencimiento</label><DateInput id="end" value={endDate} onChange={setEnd} /></div>
          <div><label className="label" htmlFor="principal">Principal (USD)</label><input id="principal" className="input num" value={principal} onChange={(e) => setPrincipal(e.target.value)} required /></div>
          <div><label className="label" htmlFor="rate">Interés total (%)</label><input id="rate" className="input num" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0" /><p className="mt-0.5 text-[10px] text-subtle">{interest && `= ${interest} USD`}</p></div>
        </div>
        <div><span className="label">Cuenta del desembolso (caja o banco)</span><AccountPicker ariaLabel="Cuenta del desembolso" accounts={accounts ?? []} value={counter} onChange={setCounter} /></div>
        <button className="btn-primary" disabled={busy || !pa}>{busy ? 'Registrando…' : 'Registrar préstamo'}</button>
      </form>
    </div>
  );
}
