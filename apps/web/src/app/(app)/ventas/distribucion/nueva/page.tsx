'use client';

import { formatNumber, money } from '@kaluch/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AccountPicker } from '@/components/account-picker';
import { CompanySelect, numEs, PartyAccountSelect, usePartyAccounts } from '@/components/sales';
import { Alert, DateInput, PageHeader, today } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Account, StockRow } from '@/lib/types';

interface Line { lot: string; quantity: string; price: string; commission: string; seller: string }
const emptyLine = (): Line => ({ lot: '', quantity: '', price: '', commission: '', seller: '' });

export default function NewDistributionInvoicePage() {
  const session = useSession();
  const [companyId, setCompanyId] = useState(session.companyId ?? '');
  const { data: stock } = useApi<StockRow[]>(companyId ? `/sales/stock${qs({ companyId })}` : null);
  const { data: accounts } = useApi<Account[]>('/accounts?postable=true');
  const customers = usePartyAccounts(['137'], companyId || null);
  const sellers = usePartyAccounts(['410.9990'], companyId || null);
  const [credit, setCredit] = useState(true);
  const [partyAccountId, setPa] = useState('');
  const [counterAccountId, setCounter] = useState('');
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [fiscal, setFiscal] = useState(true);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; document: string; totalUsd: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const lotOf = (key: string) => stock?.find((s) => `${s.containerId}|${s.productId}` === key);
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  let total = money(0);
  try { total = lines.reduce((s, l) => s.plus(money(numEs(l.quantity)).times(money(numEs(l.price)))), money(0)); } catch { /* importe a medio escribir */ }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ id: string; document: string; totalUsd: string }>('/sales/invoices', {
        method: 'POST',
        json: {
          companyId, date, description, fiscal,
          partyAccountId: credit ? partyAccountId : null, counterAccountId: credit ? null : counterAccountId,
          lines: lines.filter((l) => l.lot).map((l) => {
            const lot = lotOf(l.lot)!;
            return {
              productId: lot.productId, containerId: lot.containerId, quantity: numEs(l.quantity), unitPriceUsd: numEs(l.price),
              commissionPerUnitUsd: numEs(l.commission), sellerPartyAccountId: l.seller || null,
            };
          }),
        },
      });
      setDone(r);
      setLines([emptyLine()]);
      setDescription('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-6xl">
      <PageHeader title="Nueva factura de distribución" subtitle="Elige el lote (producto y contenedor) de cada línea: el costo es el costo medio del lote y se descuenta de sus existencias." />
      {done && <div className="mb-3"><Alert kind="success">Factura {done.document} contabilizada por {formatNumber(done.totalUsd)} USD. <Link className="underline" href={`/ventas/distribucion/${done.id}`}>Ver factura</Link></Alert></div>}
      <form onSubmit={submit} className="card space-y-4 p-5">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-4">
          <div><label className="label" htmlFor="company">Empresa</label><CompanySelect id="company" value={companyId} onChange={(v) => { setCompanyId(v); setLines([emptyLine()]); setPa(''); }} perm="sales:operate" /></div>
          <div><label className="label" htmlFor="date">Fecha</label><DateInput id="date" value={date} onChange={setDate} required /></div>
          <div>
            <label className="label" htmlFor="pay">Cobro</label>
            <select id="pay" className="input" value={credit ? 'credit' : 'cash'} onChange={(e) => setCredit(e.target.value === 'credit')}>
              <option value="credit">A crédito (cuenta del cliente)</option>
              <option value="cash">Al contado (cuenta de cobro)</option>
            </select>
          </div>
          <div className="flex items-end"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={fiscal} onChange={(e) => setFiscal(e.target.checked)} /> Venta fiscal (ONAT)</label></div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {credit ? (
            <div><label className="label" htmlFor="cust">Cliente</label><PartyAccountSelect id="cust" value={partyAccountId} onChange={setPa} options={customers} required missing="No hay clientes con cuenta 137 en esta empresa." /></div>
          ) : (
            <div><span className="label">Cuenta de cobro</span><AccountPicker ariaLabel="Cuenta de cobro" accounts={accounts ?? []} value={counterAccountId} onChange={setCounter} /></div>
          )}
          <div><label className="label" htmlFor="desc">Descripción</label><input id="desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} required /></div>
        </div>
        <table className="table">
          <thead><tr><th>Lote (producto · contenedor)</th><th className="num">Cantidad</th><th className="num">Precio USD</th><th className="num">Comisión / u</th><th>Vendedor</th><th className="num">Importe</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const lot = lotOf(l.lot);
              let amount = '';
              try { amount = l.quantity && l.price ? formatNumber(money(numEs(l.quantity)).times(money(numEs(l.price)))) : ''; } catch { amount = ''; }
              return (
                <tr key={i}>
                  <td className="min-w-72">
                    <select aria-label={`Lote ${i + 1}`} className="input" value={l.lot} onChange={(e) => set(i, { lot: e.target.value })} required={i === 0}>
                      <option value="">Elige…</option>
                      {stock?.map((s) => (
                        <option key={`${s.containerId}|${s.productId}`} value={`${s.containerId}|${s.productId}`}>
                          {s.productName} · {s.containerCode} · quedan {formatNumber(s.quantity, 0)} {s.unit}
                        </option>
                      ))}
                    </select>
                    {lot && <div className="mt-0.5 text-[10px] text-subtle">Costo medio {formatNumber(lot.unitCostUsd)} USD / {lot.unit}</div>}
                  </td>
                  <td><input aria-label={`Cantidad ${i + 1}`} className="input num w-24" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} required={!!l.lot} /></td>
                  <td><input aria-label={`Precio ${i + 1}`} className="input num w-28" value={l.price} onChange={(e) => set(i, { price: e.target.value })} required={!!l.lot} /></td>
                  <td><input aria-label={`Comisión ${i + 1}`} className="input num w-24" value={l.commission} onChange={(e) => set(i, { commission: e.target.value })} placeholder="0,00" /></td>
                  <td>
                    <select aria-label={`Vendedor ${i + 1}`} className="input" value={l.seller} onChange={(e) => set(i, { seller: e.target.value })}>
                      <option value="">—</option>
                      {sellers.map((s) => <option key={s.partyAccountId} value={s.partyAccountId}>{s.partyName}</option>)}
                    </select>
                  </td>
                  <td className="num">{amount}</td>
                  <td>{lines.length > 1 && <button type="button" className="text-xs text-bad" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Quitar</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {companyId && stock?.length === 0 && <Alert kind="warning">No hay existencias en almacén en esta empresa: recibe un contenedor en Inventario.</Alert>}
        <div className="flex items-center justify-between">
          <button type="button" className="btn-secondary" onClick={() => setLines([...lines, emptyLine()])}>Añadir línea</button>
          <div className="flex items-center gap-4">
            <span className="text-sm">Total: <span className="font-bold tabular-nums">{formatNumber(total)} USD</span></span>
            <button className="btn-primary" disabled={busy || !companyId || (credit ? !partyAccountId : !counterAccountId)}>{busy ? 'Contabilizando…' : 'Contabilizar factura'}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
