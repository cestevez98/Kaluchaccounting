'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Kpi } from '@/components/sales';
import { Alert, Amount, DateInput, DateText, PageHeader, Pagination, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Paged, SalesInvoiceRow } from '@/lib/types';

type Totals = { totalUsd: string; costUsd: string; commissionUsd: string; onatUsd: string };

export default function DistributionInvoicesPage() {
  const { companyId, can } = useSession();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, loading } = useApi<Paged<SalesInvoiceRow> & { totals: Totals }>(
    `/sales/invoices${qs({ companyId, from: from || undefined, to: to || undefined, page, pageSize: 50 })}`,
  );
  const t = data?.totals;
  const margin = t ? (Number(t.totalUsd) - Number(t.costUsd) - Number(t.commissionUsd) - Number(t.onatUsd)).toFixed(4) : '…';
  return (
    <div>
      <PageHeader
        title="Ventas de distribución"
        subtitle="Facturas con ingreso (900.9990), costo identificado por contenedor al costo medio del lote, comisión por unidad del vendedor y ONAT sobre ventas."
        actions={can('sales:operate') ? <Link className="btn-primary" href="/ventas/distribucion/nueva">Nueva factura</Link> : null}
      />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div><label className="label" htmlFor="from">Desde</label><DateInput id="from" value={from} onChange={(v) => { setFrom(v); setPage(1); }} /></div>
        <div><label className="label" htmlFor="to">Hasta</label><DateInput id="to" value={to} onChange={(v) => { setTo(v); setPage(1); }} /></div>
      </div>
      {error && <Alert>{error.message}</Alert>}
      <div className="mb-4 grid gap-3 sm:grid-cols-5">
        <Kpi label="Ventas" value={t?.totalUsd ?? '…'} />
        <Kpi label="Costo de ventas" value={t?.costUsd ?? '…'} />
        <Kpi label="Comisiones" value={t?.commissionUsd ?? '…'} />
        <Kpi label="ONAT" value={t?.onatUsd ?? '…'} />
        <Kpi label="Margen" value={margin} tone={Number(margin) < 0 ? 'bad' : 'ok'} />
      </div>
      <div className="card overflow-x-auto">
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Factura</th><th>Cliente</th><th className="num">Líneas</th><th className="num">Total</th><th className="num">Costo</th><th className="num">Comisión</th><th className="num">ONAT</th><th className="num">Margen</th></tr></thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id}>
                  <td><Link className="font-semibold hover:underline" href={`/ventas/distribucion/${r.id}`}>{r.number}</Link><div className="text-[10px] text-subtle"><DateText value={r.date} /> · {r.companyCode}</div></td>
                  <td>{r.partyId ? <Link className="hover:underline" href={`/terceros/${r.partyId}`}>{r.customer}</Link> : <span className="text-muted">Al contado</span>}</td>
                  <td className="num">{r.lines}</td>
                  <td className="num font-semibold"><Amount value={r.totalUsd} /></td>
                  <td className="num"><Amount value={r.costUsd} muted /></td>
                  <td className="num"><Amount value={r.commissionUsd} muted /></td>
                  <td className="num"><Amount value={r.onatUsd} muted /></td>
                  <td className="num font-semibold"><Amount value={r.marginUsd} /></td>
                </tr>
              ))}
              {data?.items.length === 0 && <tr><td colSpan={8} className="py-6 text-center text-muted">No hay facturas de distribución.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </div>
  );
}
