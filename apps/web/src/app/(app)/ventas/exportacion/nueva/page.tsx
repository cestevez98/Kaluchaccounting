'use client';

import { formatNumber, money } from '@kaluch/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { numEs, PartyAccountSelect, usePartyAccounts } from '@/components/sales';
import { Alert, DateInput, PageHeader, today } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

const COSTS = [
  ['factoryUsd', 'Fábrica', 'Mercancía (180.8880 → 2814)'],
  ['logisticsUsd', 'Logística', 'Servicios (180.8881 → 2815)'],
  ['otherUsd', 'Otros costos', 'Otros (180.8882 → 2816)'],
  ['estimatedUsd', 'Costo estimado', 'Al cierre (817.8880)'],
  ['commissionUsd', 'Comisión', 'Al cierre, al vendedor'],
] as const;

export default function NewExportInvoicePage() {
  const customers = usePartyAccounts(['136']);
  const sellers = usePartyAccounts(['410.8880']);
  const [partyAccountId, setPa] = useState('');
  const [sellerId, setSeller] = useState('');
  const [number, setNumber] = useState('');
  const [invoiceDate, setDate] = useState(today());
  const [service, setService] = useState<'GOODS' | 'SERVICES'>('GOODS');
  const [internal, setInternal] = useState(false);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; document: string } | null>(null);
  const [busy, setBusy] = useState(false);

  let margin = '';
  try {
    margin = COSTS.reduce((m, [k]) => m.minus(money(numEs(costs[k] ?? ''))), money(numEs(amount || '0'))).toFixed(2);
  } catch { margin = ''; }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ id: string; document: string }>('/sales/export-invoices', {
        method: 'POST',
        json: {
          partyAccountId, number, invoiceDate, service, internal, description, amountUsd: numEs(amount),
          ...Object.fromEntries(COSTS.map(([k]) => [k, numEs(costs[k] ?? '')])), sellerPartyAccountId: sellerId || null,
        },
      });
      setDone(r);
      setNumber(''); setAmount(''); setCosts({}); setDescription('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl">
      <PageHeader title="Nueva factura de exportación" subtitle="Queda pendiente de cierre: cargo al cliente (136) contra Ventas pendientes (2900), y los costos ya conocidos pasan de mercancías pendientes de facturar (180.888x) a costos pendientes (2814–2816)." />
      {done && <div className="mb-3"><Alert kind="success">Factura emitida ({done.document}). <Link className="underline" href={`/ventas/exportacion/${done.id}`}>Ver factura</Link></Alert></div>}
      <form onSubmit={submit} className="card space-y-4 p-5">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="cust">Cliente</label>
            <PartyAccountSelect id="cust" value={partyAccountId} onChange={setPa} options={customers} required missing="No hay clientes con cuenta 136." />
          </div>
          <div><label className="label" htmlFor="number">Nº de factura</label><input id="number" className="input" value={number} onChange={(e) => setNumber(e.target.value)} required placeholder="KAL-2026-10001" /></div>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <div><label className="label" htmlFor="date">Fecha de factura</label><DateInput id="date" value={invoiceDate} onChange={setDate} required /></div>
          <div>
            <label className="label" htmlFor="service">Servicio</label>
            <select id="service" className="input" value={service} onChange={(e) => setService(e.target.value as 'GOODS')}>
              <option value="GOODS">Exportación de productos</option>
              <option value="SERVICES">Servicios</option>
            </select>
          </div>
          <div className="sm:col-span-2 flex items-end">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Cliente del grupo (ventas internas 1900 y costos 1814–1817)</label>
          </div>
        </div>
        <div><label className="label" htmlFor="desc">Descripción</label><input id="desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} required /></div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div><label className="label" htmlFor="amount">Importe facturado (USD)</label><input id="amount" className="input num" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="seller">Vendedor (comisión)</label>
            <PartyAccountSelect id="seller" value={sellerId} onChange={setSeller} options={sellers} empty="Sin comisión" />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-5">
          {COSTS.map(([k, label, hint]) => (
            <div key={k}>
              <label className="label" htmlFor={k}>{label}</label>
              <input id={k} className="input num" value={costs[k] ?? ''} onChange={(e) => setCosts({ ...costs, [k]: e.target.value })} placeholder="0,00" />
              <p className="mt-0.5 text-[10px] text-subtle">{hint}</p>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">Margen estimado: <span className="font-bold tabular-nums">{margin ? formatNumber(margin) : '—'} USD</span></span>
          <button className="btn-primary" disabled={busy || !partyAccountId}>{busy ? 'Emitiendo…' : 'Emitir factura'}</button>
        </div>
      </form>
    </div>
  );
}
