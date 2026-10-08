'use client';

import { formatNumber, money } from '@kaluch/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AccountPicker } from '@/components/account-picker';
import { Kpi, numEs, PartyAccountSelect, usePartyAccounts } from '@/components/sales';
import { Alert, Amount, Badge, DateInput, DateText, PageHeader, Spinner, today } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CONTAINER_STATUS, MOVE_KIND_LABEL, type Account, type ContainerDetail, type ProductRow } from '@/lib/types';

export default function ContainerPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data: c, error, reload } = useApi<ContainerDetail>(`/sales/containers/${id}`);
  if (error) return <Alert>{error.message}</Alert>;
  if (!c) return <Spinner />;
  return (
    <div className="max-w-6xl">
      <PageHeader
        title={`Contenedor ${c.code}`}
        subtitle={<>{c.companyCode} · {c.description || 'Sin descripción'}{c.arrivalDate ? <> · recibido el <DateText value={c.arrivalDate} /></> : null}</>}
        actions={<Badge tone={CONTAINER_STATUS[c.status].tone}>{CONTAINER_STATUS[c.status].label}</Badge>}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-5">
        <Kpi label="Costo total" value={c.totalCostUsd} hint={c.status === 'TRANSIT' ? `En tránsito: ${formatNumber(c.transitUsd)}` : undefined} />
        <Kpi label="Ventas" value={c.revenueUsd} hint={`${formatNumber(c.soldQuantity, 0)} unidades`} />
        <Kpi label="Costo de ventas" value={c.costOfSalesUsd} hint={`Comisiones ${formatNumber(c.commissionUsd)} · ONAT ${formatNumber(c.onatUsd)}`} />
        <Kpi label="Utilidad" value={c.utilityUsd} tone={money(c.utilityUsd).lt(0) ? 'bad' : 'ok'} hint={c.marginPct === null ? undefined : `Margen ${formatNumber(c.marginPct)} %`} />
        <Kpi label="Existencias" value={c.stockUsd} hint={`${formatNumber(c.stockQuantity, 0)} unidades`} />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <div className="card overflow-x-auto">
          <div className="border-b border-line px-4 py-2.5 text-xs font-bold">Existencias por producto</div>
          <table className="table">
            <thead><tr><th>Producto</th><th className="num">Cantidad</th><th className="num">Valor</th><th className="num">Costo medio</th></tr></thead>
            <tbody>
              {c.lots.map((l) => (
                <tr key={l.productId}>
                  <td><Link className="hover:underline" href={`/inventario/kardex/${l.productId}?container=${c.id}`}>{l.productName}</Link></td>
                  <td className="num">{formatNumber(l.quantity, 0)}</td>
                  <td className="num"><Amount value={l.valueUsd} /></td>
                  <td className="num">{money(l.quantity).isZero() ? '' : formatNumber(money(l.valueUsd).div(money(l.quantity)))}</td>
                </tr>
              ))}
              {c.lots.length === 0 && <tr><td colSpan={4} className="py-4 text-center text-muted">{c.status === 'TRANSIT' ? 'Aún en tránsito: los productos se reparten al recibirlo.' : 'Sin existencias.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <Investors c={c} onChange={reload} canEdit={can('sales:operate', c.companyId)} />
      </div>

      {can('inventory:operate', c.companyId) && c.status !== 'CLOSED' && (
        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <CostForm c={c} onDone={reload} />
          {c.status === 'TRANSIT' && <ReceiptForm c={c} onDone={reload} />}
        </div>
      )}

      <div className="card overflow-x-auto">
        <div className="border-b border-line px-4 py-2.5 text-xs font-bold">Movimientos</div>
        <table className="table">
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Ubicación</th><th>Producto</th><th>Descripción</th><th className="num">Cantidad</th><th className="num">Importe</th><th>Documento</th></tr></thead>
          <tbody>
            {c.movements.map((m) => (
              <tr key={m.id}>
                <td><DateText value={m.date} /></td>
                <td>{MOVE_KIND_LABEL[m.kind] ?? m.kind}</td>
                <td>{m.location === 'TRANSIT' ? 'Tránsito' : 'Almacén'}</td>
                <td>{m.product ?? ''}</td>
                <td className="max-w-80 truncate" title={m.description}>{m.description}</td>
                <td className="num">{money(m.quantity).isZero() ? '' : formatNumber(m.quantity, 0)}</td>
                <td className="num"><Amount value={m.amountUsd} /></td>
                <td className="text-[11px] text-muted">{m.document}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Investors({ c, onChange, canEdit }: { c: ContainerDetail; onChange: () => void; canEdit: boolean }) {
  const investors = usePartyAccounts(['139', '412'], c.companyId);
  const [pa, setPa] = useState('');
  const [invested, setInvested] = useState('');
  const [pct, setPct] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api(`/sales/containers/${c.id}/investors`, { method: 'POST', json: { partyAccountId: pa, investedUsd: numEs(invested), profitPct: numEs(pct) } });
      setPa(''); setInvested(''); setPct('');
      onChange();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Error');
    }
  }
  return (
    <div className="card overflow-x-auto">
      <div className="border-b border-line px-4 py-2.5 text-xs font-bold">Inversionistas</div>
      <table className="table">
        <thead><tr><th>Inversionista</th><th className="num">Invertido</th><th className="num">% utilidad</th><th className="num">Parte de la utilidad</th></tr></thead>
        <tbody>
          {c.investors.map((i) => (
            <tr key={i.id}>
              <td><Link className="hover:underline" href={`/terceros/${i.partyId}`}>{i.name}</Link></td>
              <td className="num"><Amount value={i.investedUsd} /></td>
              <td className="num">{formatNumber(i.profitPct)} %</td>
              <td className="num font-semibold"><Amount value={i.shareUsd} /></td>
            </tr>
          ))}
          {c.investors.length === 0 && <tr><td colSpan={4} className="py-4 text-center text-muted">Sin inversionistas: la utilidad es del grupo.</td></tr>}
        </tbody>
      </table>
      {canEdit && (
        <form onSubmit={add} className="grid gap-2 border-t border-line p-3 sm:grid-cols-4">
          {msg && <div className="sm:col-span-4"><Alert>{msg}</Alert></div>}
          <div className="sm:col-span-2"><PartyAccountSelect id="inv" value={pa} onChange={setPa} options={investors} required empty="Inversionista…" missing="No hay inversionistas con cuenta 139 o 412." /></div>
          <input aria-label="Invertido" className="input num" value={invested} onChange={(e) => setInvested(e.target.value)} placeholder="Invertido" />
          <div className="flex gap-2"><input aria-label="% de utilidad" className="input num" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="% util." required /><button className="btn-secondary" disabled={!pa}>Guardar</button></div>
        </form>
      )}
    </div>
  );
}

function CostForm({ c, onDone }: { c: ContainerDetail; onDone: () => void }) {
  const suppliers = usePartyAccounts(['406', '407', '408', '409'], c.companyId);
  const { data: accounts } = useApi<Account[]>('/accounts?postable=true');
  const { data: products } = useApi<ProductRow[]>('/sales/products');
  const [mode, setMode] = useState<'supplier' | 'account'>('supplier');
  const [pa, setPa] = useState('');
  const [account, setAccount] = useState('');
  const [productId, setProduct] = useState('');
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await api<{ document: string }>(`/sales/containers/${c.id}/costs`, {
        method: 'POST',
        json: {
          date, amountUsd: numEs(amount), description, productId: productId || null, reference: reference || null,
          partyAccountId: mode === 'supplier' ? pa : null, counterAccountId: mode === 'account' ? account : null,
        },
      });
      setAmount(''); setDescription(''); setReference('');
      setMsg({ kind: 'success', text: `Costo registrado (${r.document}).` });
      onDone();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Error' });
    }
  }
  return (
    <form onSubmit={submit} className="card space-y-3 p-4">
      <div className="text-xs font-bold">Registrar un costo</div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <div><label className="label" htmlFor="cdate">Fecha</label><DateInput id="cdate" value={date} onChange={setDate} required /></div>
        <div><label className="label" htmlFor="camount">Importe USD</label><input id="camount" className="input num" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
        <div><label className="label" htmlFor="cref">Factura / ref.</label><input id="cref" className="input" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
      </div>
      <div><label className="label" htmlFor="cdesc">Concepto</label><input id="cdesc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} required placeholder="Mercancía, flete, aduana…" /></div>
      {c.status === 'WAREHOUSE' && (
        <div>
          <label className="label" htmlFor="cprod">Producto al que se carga</label>
          <select id="cprod" className="input" value={productId} onChange={(e) => setProduct(e.target.value)} required>
            <option value="">Elige…</option>
            {c.lots.map((l) => <option key={l.productId} value={l.productId}>{l.productName}</option>)}
            {products?.filter((p) => !c.lots.some((l) => l.productId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="cmode">Contrapartida</label>
          <select id="cmode" className="input" value={mode} onChange={(e) => setMode(e.target.value as 'supplier')}>
            <option value="supplier">Proveedor (por pagar)</option>
            <option value="account">Otra cuenta</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          {mode === 'supplier'
            ? <><span className="label">Proveedor</span><PartyAccountSelect id="csup" value={pa} onChange={setPa} options={suppliers} required missing="No hay proveedores con cuenta 406–409 en esta empresa." /></>
            : <><span className="label">Cuenta</span><AccountPicker ariaLabel="Cuenta de contrapartida" accounts={accounts ?? []} value={account} onChange={setAccount} /></>}
        </div>
      </div>
      <button className="btn-primary" disabled={mode === 'supplier' ? !pa : !account}>Registrar costo</button>
    </form>
  );
}

function ReceiptForm({ c, onDone }: { c: ContainerDetail; onDone: () => void }) {
  const { data: products } = useApi<ProductRow[]>('/sales/products');
  const [date, setDate] = useState(today());
  const [lines, setLines] = useState([{ productId: '', quantity: '', amount: '' }]);
  const [msg, setMsg] = useState<string | null>(null);
  let allocated = money(0);
  try { allocated = lines.reduce((s, l) => s.plus(money(numEs(l.amount))), money(0)); } catch { /* importe a medio escribir */ }
  const rest = money(c.transitUsd).minus(allocated);
  const set = (i: number, patch: Partial<(typeof lines)[number]>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api(`/sales/containers/${c.id}/receipt`, {
        method: 'POST',
        json: { date, lines: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: numEs(l.quantity), amountUsd: numEs(l.amount) })) },
      });
      onDone();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Error');
    }
  }
  return (
    <form onSubmit={submit} className="card space-y-3 p-4">
      <div className="text-xs font-bold">Recibir en almacén</div>
      <p className="text-[11px] text-muted">Reparte el costo en tránsito ({formatNumber(c.transitUsd)} USD) entre los productos del contenedor. Productos nuevos: <Link className="underline" href="/inventario/productos">alta de productos</Link>.</p>
      {msg && <Alert>{msg}</Alert>}
      <div><label className="label" htmlFor="rdate">Fecha de recepción</label><DateInput id="rdate" value={date} onChange={setDate} required /></div>
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-[1fr_6rem_8rem] gap-2">
          <select aria-label={`Producto ${i + 1}`} className="input" value={l.productId} onChange={(e) => set(i, { productId: e.target.value })} required={i === 0}>
            <option value="">Producto…</option>
            {products?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input aria-label={`Cantidad ${i + 1}`} className="input num" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} placeholder="Cantidad" required={!!l.productId} />
          <input aria-label={`Costo ${i + 1}`} className="input num" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} placeholder="Costo USD" required={!!l.productId} />
        </div>
      ))}
      <div className="flex items-center justify-between">
        <button type="button" className="btn-secondary" onClick={() => setLines([...lines, { productId: '', quantity: '', amount: '' }])}>Añadir producto</button>
        <span className={`text-xs ${rest.abs().lt(0.005) ? 'text-ok' : 'text-warn'}`}>Por repartir: {formatNumber(rest)} USD</span>
      </div>
      <button className="btn-primary" disabled={!rest.abs().lt(0.005)}>Recibir contenedor</button>
    </form>
  );
}
