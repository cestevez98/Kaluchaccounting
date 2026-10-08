'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Kpi } from '@/components/sales';
import { Alert, Amount, Badge, DateText, PageHeader, Pagination, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { EXPORT_STATUS, type ExportInvoiceRow, type Paged } from '@/lib/types';

export default function ExportInvoicesPage() {
  const { companyId, can } = useSession();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, loading } = useApi<Paged<ExportInvoiceRow> & { pending: { count: number; amountUsd: string } }>(
    `/sales/export-invoices${qs({ companyId, status: status || undefined, q: q || undefined, page, pageSize: 50 })}`,
  );
  return (
    <div>
      <PageHeader
        title="Facturas de exportación"
        subtitle="Al emitirse quedan pendientes de cierre (Ventas pendientes 2900 y costos pendientes 2814–2816); al cerrarse pasan a ventas (900/901, o 1900 si el cliente es del grupo) y a costo de ventas."
        actions={can('sales:operate') ? <Link className="btn-primary" href="/ventas/exportacion/nueva">Nueva factura</Link> : null}
      />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="status">Estado</label>
          <select id="status" className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Todas</option>
            <option value="PENDING">Pendientes de cierre</option>
            <option value="CLOSED">Cerradas</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="q">Buscar</label>
          <input id="q" className="input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Nº de factura o cliente" />
        </div>
      </div>
      {error && <Alert>{error.message}</Alert>}
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Kpi label="Facturas" value={data ? String(data.total) : '…'} />
        <Kpi label="Pendientes de cierre" value={data ? String(data.pending.count) : '…'} tone="warn" />
        <Kpi label="Importe pendiente (USD)" value={data?.pending.amountUsd ?? '…'} tone="warn" />
      </div>
      <div className="card overflow-x-auto">
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead>
              <tr>
                <th>Factura</th><th>Cliente</th><th>Servicio</th><th className="num">Importe</th><th className="num">Fábrica</th><th className="num">Logística</th>
                <th className="num">Otros</th><th className="num">Comisión</th><th className="num">Margen</th><th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link className="font-semibold hover:underline" href={`/ventas/exportacion/${r.id}`}>{r.number}</Link>
                    <div className="text-[10px] text-subtle"><DateText value={r.invoiceDate} /> · {r.companyCode}{r.closeDate ? <> · cierre <DateText value={r.closeDate} /></> : null}</div>
                  </td>
                  <td><Link className="hover:underline" href={`/terceros/${r.partyId}`}>{r.partyName}</Link>{r.internal && <div><Badge tone="blue">Cliente interno</Badge></div>}</td>
                  <td>{r.service === 'GOODS' ? 'Productos' : 'Servicios'}</td>
                  <td className="num font-semibold"><Amount value={r.amountUsd} /></td>
                  <td className="num"><Amount value={r.factoryUsd} muted /></td>
                  <td className="num"><Amount value={r.logisticsUsd} muted /></td>
                  <td className="num"><Amount value={(Number(r.otherUsd) + Number(r.estimatedUsd)).toFixed(4)} muted /></td>
                  <td className="num"><Amount value={r.commissionUsd} muted /></td>
                  <td className="num font-semibold"><Amount value={r.marginUsd} /></td>
                  <td><Badge tone={EXPORT_STATUS[r.status].tone}>{EXPORT_STATUS[r.status].label}</Badge></td>
                </tr>
              ))}
              {data?.items.length === 0 && <tr><td colSpan={10} className="py-6 text-center text-muted">No hay facturas de exportación.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </div>
  );
}
