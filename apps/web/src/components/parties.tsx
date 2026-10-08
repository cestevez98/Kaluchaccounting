'use client';

import { formatNumber, money } from '@kaluch/shared';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Alert, Amount, Badge, DateInput, DateText, Pagination, Spinner, today } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  OPEN_ITEM_STATUS, PARTY_ROLE_LABELS, type AgingRow, type OpenItemRow, type Paged, type PartyBalance, type PartyRole,
} from '@/lib/types';

export function RoleBadges({ roles }: { roles: PartyRole[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {roles.map((r) => <Badge key={r} tone={r === 'SUPPLIER' ? 'amber' : r === 'EMPLOYEE' ? 'green' : r === 'CUSTOMER' ? 'blue' : 'gray'}>{PARTY_ROLE_LABELS[r]}</Badge>)}
    </span>
  );
}

/** Saldo con su lectura: + nos debe / − le debemos. */
export function BalanceText({ value, currency }: { value: string; currency?: string }) {
  const v = money(value);
  if (v.abs().lt(0.005)) return <span className="text-subtle">0,00</span>;
  return (
    <span className={v.gt(0) ? 'text-ok' : 'text-bad'} title={v.gt(0) ? 'Nos debe' : 'Le debemos'}>
      {formatNumber(v.abs())}{currency ? ` ${currency}` : ''} <span className="text-[10px] text-muted">{v.gt(0) ? 'nos debe' : 'le debemos'}</span>
    </span>
  );
}

/** Saldos de cuentas corrientes (por cobrar o por pagar) con antigüedad. */
export function PartyBalancesView({ side }: { side: 'receivable' | 'payable' }) {
  const { companyId } = useSession();
  const [asOf, setAsOf] = useState(today());
  const [role, setRole] = useState('');
  const { data, error, loading } = useApi<PartyBalance[]>(`/parties/balances${qs({ companyId, asOf, side, role: role || undefined })}`);
  const { data: aging } = useApi<AgingRow[]>(`/parties/aging${qs({ companyId, asOf, side: side === 'receivable' ? 'RECEIVABLE' : 'PAYABLE' })}`);
  const total = (data ?? []).reduce((s, r) => s.plus(money(r.balanceUsd)), money(0)).abs();
  const agingTotal = (aging ?? []).reduce((s, r) => s.plus(money(r.totalUsd)), money(0));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="asof">Saldos al</label>
          <DateInput id="asof" value={asOf} onChange={setAsOf} />
        </div>
        <div>
          <label className="label" htmlFor="role">Tipo de contraparte</label>
          <select id="role" className="input" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">Todas</option>
            {Object.entries(PARTY_ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>
      {error && <Alert>{error.message}</Alert>}
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="card px-4 py-3">
          <div className="text-[10px] font-semibold tracking-wide text-subtle uppercase">{side === 'receivable' ? 'Total por cobrar' : 'Total por pagar'}</div>
          <div className={`mt-1 text-xl font-bold tabular-nums ${side === 'receivable' ? 'text-ok' : 'text-bad'}`}>{data ? `USD ${formatNumber(total)}` : '…'}</div>
          <div className="text-[11px] text-muted">{data?.length ?? 0} cuentas corrientes</div>
        </div>
        <div className="card px-4 py-3">
          <div className="text-[10px] font-semibold tracking-wide text-subtle uppercase">Partidas abiertas</div>
          <div className="mt-1 text-xl font-bold tabular-nums">{aging ? `USD ${formatNumber(agingTotal)}` : '…'}</div>
          <div className="text-[11px] text-muted"><Link className="text-brand-600 hover:underline" href={side === 'receivable' ? '/cobrar/partidas' : '/pagar/partidas'}>Ver partidas →</Link></div>
        </div>
        <div className="card px-4 py-3">
          <div className="text-[10px] font-semibold tracking-wide text-subtle uppercase">Más de 90 días</div>
          <div className="mt-1 text-xl font-bold tabular-nums text-warn">
            {aging ? `USD ${formatNumber((aging ?? []).reduce((s, r) => s.plus(money(r.buckets.older).times(money(r.totalUsd)).div(money(r.total).isZero() ? 1 : money(r.total))), money(0)))}` : '…'}
          </div>
          <div className="text-[11px] text-muted">por vencimiento o fecha de la partida</div>
        </div>
      </div>

      <div className="card mb-6 overflow-x-auto">
        <div className="border-b border-line px-4 py-2.5 text-xs font-bold">Saldos por contraparte</div>
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Contraparte</th><th>Empresa</th><th>Cuenta</th><th>Moneda</th><th className="num">Saldo</th><th className="num">Saldo USD</th><th className="num">Partidas</th><th>Más antigua</th></tr></thead>
            <tbody>
              {data?.map((r) => (
                <tr key={r.partyAccountId}>
                  <td><Link className="font-medium hover:underline" href={`/terceros/${r.partyId}`}>{r.partyName}</Link><div><RoleBadges roles={r.roles} /></div></td>
                  <td>{r.companyCode}</td>
                  <td className="font-mono text-[11px]">{r.accountCode}{r.oppositeCode ? ` ↔ ${r.oppositeCode}` : ''}</td>
                  <td>{r.currency}</td>
                  <td className="num">{formatNumber(money(r.balance).abs())}</td>
                  <td className="num"><BalanceText value={r.balanceUsd} /></td>
                  <td className="num">{r.openItems || ''}</td>
                  <td><DateText value={r.oldestOpen} /></td>
                </tr>
              ))}
              {data?.length === 0 && <tr><td colSpan={8} className="py-6 text-center text-muted">No hay saldos {side === 'receivable' ? 'por cobrar' : 'por pagar'} a esa fecha.</td></tr>}
            </tbody>
            {data && data.length > 0 && <tfoot><tr><td colSpan={5}>Total</td><td className="num">{formatNumber(total)}</td><td colSpan={2} /></tr></tfoot>}
          </table>
        )}
      </div>

      <div className="card overflow-x-auto">
        <div className="border-b border-line px-4 py-2.5 text-xs font-bold">Antigüedad de partidas abiertas</div>
        <table className="table">
          <thead><tr><th>Contraparte</th><th>Moneda</th><th className="num">0–30 días</th><th className="num">31–60</th><th className="num">61–90</th><th className="num">&gt; 90</th><th className="num">Total</th><th className="num">Total USD</th></tr></thead>
          <tbody>
            {aging?.map((r) => (
              <tr key={`${r.partyId}-${r.currency}`}>
                <td><Link className="hover:underline" href={`/terceros/${r.partyId}`}>{r.partyName}</Link></td>
                <td>{r.currency}</td>
                <td className="num"><Amount value={r.buckets.current} muted /></td>
                <td className="num"><Amount value={r.buckets.d60} muted /></td>
                <td className="num"><Amount value={r.buckets.d90} muted /></td>
                <td className="num"><Amount value={r.buckets.older} muted /></td>
                <td className="num"><Amount value={r.total} /></td>
                <td className="num"><Amount value={r.totalUsd} /></td>
              </tr>
            ))}
            {aging?.length === 0 && <tr><td colSpan={8} className="py-6 text-center text-muted">Sin partidas abiertas.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Candidate { documentId: string; number: string; date: string; memo: string; amount: string; currency: string; applied: string }

function SettleForm({ item, onDone }: { item: OpenItemRow; onDone: (msg: string) => void }) {
  const [amount, setAmount] = useState(item.openAmount);
  const [date, setDate] = useState(today());
  const [kind, setKind] = useState<'PAYMENT' | 'WRITE_OFF'>('PAYMENT');
  const [paymentDocumentId, setPaymentDocumentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: candidates } = useApi<Candidate[]>(`/parties/open-items/${item.id}/candidates`);
  return (
    <form
      className="grid gap-3 bg-canvas p-3 sm:grid-cols-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api('/parties/settlements', { method: 'POST', json: { openItemId: item.id, amount: money(amount).toFixed(4), date, kind, paymentDocumentId: paymentDocumentId || null } });
          onDone(`Partida ${item.reference} ${kind === 'WRITE_OFF' ? 'cerrada por diferencia' : 'liquidada'} por ${formatNumber(amount)} ${item.currency}`);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'Error');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <label className="label" htmlFor={`k-${item.id}`}>Tipo</label>
        <select id={`k-${item.id}`} className="input" value={kind} onChange={(e) => setKind(e.target.value as 'PAYMENT' | 'WRITE_OFF')}>
          <option value="PAYMENT">Pago / cobro</option>
          <option value="WRITE_OFF">Diferencia (cerrar)</option>
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`p-${item.id}`}>Pago contabilizado</label>
        <select id={`p-${item.id}`} className="input" value={paymentDocumentId} onChange={(e) => {
          setPaymentDocumentId(e.target.value);
          const c = candidates?.find((x) => x.documentId === e.target.value);
          if (c) {
            const free = money(c.amount).minus(money(c.applied));
            setAmount((free.lt(money(item.openAmount)) ? free : money(item.openAmount)).toFixed(2));
            setDate(c.date);
          }
        }} disabled={kind === 'WRITE_OFF'}>
          <option value="">— Sin enlazar —</option>
          {candidates?.map((c) => (
            <option key={c.documentId} value={c.documentId}>
              {c.date.split('-').reverse().join('/')} · {c.number} · {formatNumber(c.amount)} {c.currency}{money(c.applied).gt(0) ? ` (aplicado ${formatNumber(c.applied)})` : ''}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor={`a-${item.id}`}>Importe ({item.currency})</label>
        <input id={`a-${item.id}`} className="input num" value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} required />
      </div>
      <div>
        <label className="label" htmlFor={`d-${item.id}`}>Fecha</label>
        <DateInput id={`d-${item.id}`} value={date} onChange={setDate} required />
      </div>
      {error && <div className="sm:col-span-5"><Alert>{error}</Alert></div>}
      <div className="sm:col-span-5"><button className="btn-primary" disabled={busy}>{busy ? 'Guardando…' : 'Aplicar'}</button></div>
    </form>
  );
}

/** Partidas abiertas (de un lado, de una contraparte o todas) con liquidación. */
export function OpenItemsTable({ side, partyId }: { side?: 'RECEIVABLE' | 'PAYABLE'; partyId?: string }) {
  const { companyId, can } = useSession();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<'open' | 'closed' | 'all'>('open');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { data, error, loading, reload } = useApi<Paged<OpenItemRow>>(`/parties/open-items${qs({ companyId, side, partyId, status, q: q || undefined, page, pageSize: 50 })}`);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="oi-status">Estado</label>
          <select id="oi-status" className="input" value={status} onChange={(e) => { setStatus(e.target.value as 'open'); setPage(1); }}>
            <option value="open">Pendientes</option>
            <option value="closed">Liquidadas</option>
            <option value="all">Todas</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="oi-q">Buscar</label>
          <input id="oi-q" className="input" placeholder="Referencia o concepto" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
      </div>
      {msg && <div className="mb-3"><Alert kind="success">{msg}</Alert></div>}
      {error && <Alert>{error.message}</Alert>}
      <div className="card overflow-x-auto">
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th><th>Referencia</th>{!partyId && <th>Contraparte</th>}<th>Empresa</th><th>Concepto</th>
                <th className="num">Importe</th><th className="num">Pendiente</th><th>Estado</th><th />
              </tr>
            </thead>
            <tbody>
              {data?.items.map((it) => (
                <Fragment key={it.id}>
                  <tr>
                    <td><DateText value={it.docDate} /></td>
                    <td className="font-mono text-[11px]">{it.reference}</td>
                    {!partyId && <td><Link className="hover:underline" href={`/terceros/${it.party.id}`}>{it.party.name}</Link></td>}
                    <td>{it.companyCode}</td>
                    <td className="max-w-80 truncate" title={it.description}>{it.description}</td>
                    <td className="num">{formatNumber(it.amount)} <span className="text-[10px] text-muted">{it.currency}</span></td>
                    <td className="num font-semibold">{money(it.openAmount).isZero() ? '' : formatNumber(it.openAmount)}</td>
                    <td><Badge tone={OPEN_ITEM_STATUS[it.status].tone}>{OPEN_ITEM_STATUS[it.status].label}</Badge>{it.side === 'PAYABLE' ? <span className="ml-1 text-[10px] text-muted">por pagar</span> : <span className="ml-1 text-[10px] text-muted">por cobrar</span>}</td>
                    <td>
                      {(it.status === 'OPEN' || it.status === 'PARTIAL') && can('parties:manage') && (
                        <button className="btn-secondary h-6 px-2 text-[11px]" onClick={() => setOpen(open === it.id ? null : it.id)}>{open === it.id ? 'Cerrar' : 'Liquidar'}</button>
                      )}
                    </td>
                  </tr>
                  {it.settlements.length > 0 && (
                    <tr>
                      <td />
                      <td colSpan={partyId ? 7 : 8} className="text-[11px] text-muted">
                        {it.settlements.map((s) => (
                          <span key={s.id} className="mr-3">
                            {s.kind === 'WRITE_OFF' ? 'Diferencia' : 'Pago'} <DateText value={s.date} />: {formatNumber(s.amount)}
                            {can('parties:manage') && (
                              <button className="ml-1 text-bad hover:underline" title="Deshacer la liquidación" onClick={async () => {
                                if (!confirm('¿Deshacer esta liquidación? La partida vuelve a quedar pendiente por ese importe.')) return;
                                try { await api(`/parties/settlements/${s.id}/void`, { method: 'POST' }); setMsg('Liquidación deshecha'); void reload(); } catch (e) { setMsg(e instanceof ApiError ? e.message : 'Error'); }
                              }}>×</button>
                            )}
                          </span>
                        ))}
                      </td>
                    </tr>
                  )}
                  {open === it.id && (
                    <tr><td colSpan={partyId ? 8 : 9} className="p-0"><SettleForm item={it} onDone={(m) => { setMsg(m); setOpen(null); void reload(); }} /></td></tr>
                  )}
                </Fragment>
              ))}
              {data?.items.length === 0 && <tr><td colSpan={9} className="py-6 text-center text-muted">No hay partidas.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </div>
  );
}
