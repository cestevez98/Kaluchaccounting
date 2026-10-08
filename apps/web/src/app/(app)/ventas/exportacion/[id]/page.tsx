'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Kpi } from '@/components/sales';
import { Alert, Amount, Badge, DateInput, DateText, PageHeader, Spinner, today } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { EXPORT_STATUS, type ExportInvoiceDetail } from '@/lib/types';

export default function ExportInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data, error, reload } = useApi<ExportInvoiceDetail>(`/sales/export-invoices/${id}`);
  const [closeDate, setCloseDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function close(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api(`/sales/export-invoices/${id}/close`, { method: 'POST', json: { closeDate } });
      await reload();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Error al cerrar la factura');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return <Spinner />;
  return (
    <div className="max-w-5xl">
      <PageHeader
        title={`Factura ${data.number}`}
        subtitle={<><Link className="underline" href={`/terceros/${data.partyId}`}>{data.partyName}</Link> · {data.companyCode} · {data.description}</>}
        actions={<Badge tone={EXPORT_STATUS[data.status].tone}>{EXPORT_STATUS[data.status].label}</Badge>}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Kpi label="Importe" value={data.amountUsd} hint={<>Emitida el <DateText value={data.invoiceDate} /> ({data.issueDocument})</>} />
        <Kpi label="Costos" value={(Number(data.factoryUsd) + Number(data.logisticsUsd) + Number(data.otherUsd) + Number(data.estimatedUsd)).toFixed(4)} hint="Fábrica, logística, otros y estimado" />
        <Kpi label="Comisión" value={data.commissionUsd} hint={data.sellerName ?? 'Sin vendedor'} />
        <Kpi label="Margen" value={data.marginUsd} tone={Number(data.marginUsd) < 0 ? 'bad' : 'ok'} />
      </div>
      {data.status === 'PENDING' && can('sales:operate') && (
        <form onSubmit={close} className="card mb-4 flex flex-wrap items-end gap-3 p-4">
          {msg && <div className="w-full"><Alert>{msg}</Alert></div>}
          <div><label className="label" htmlFor="close">Fecha de cierre</label><DateInput id="close" value={closeDate} onChange={setCloseDate} required /></div>
          <button className="btn-primary" disabled={busy}>{busy ? 'Cerrando…' : 'Cerrar factura'}</button>
          <p className="text-[11px] text-muted">Pasa la venta y los costos de pendientes a definitivos y registra el costo estimado y la comisión.</p>
        </form>
      )}
      {data.closeDate && <div className="mb-4"><Alert kind="success">Cerrada el <DateText value={data.closeDate} /> ({data.closeDocument}).</Alert></div>}
      <div className="card overflow-x-auto">
        <div className="border-b border-line px-4 py-2.5 text-xs font-bold">Asientos</div>
        <table className="table">
          <thead><tr><th>Fecha</th><th>Asiento</th><th>Cuenta</th><th className="num">Debe</th><th className="num">Haber</th></tr></thead>
          <tbody>
            {data.lines.map((l, i) => (
              <tr key={i}>
                <td><DateText value={l.date} /></td>
                <td>{l.entry}</td>
                <td><span className="font-mono">{l.account}</span> <span className="text-muted">{l.accountName}</span></td>
                <td className="num">{Number(l.amountUsd) > 0 ? <Amount value={l.amountUsd} /> : ''}</td>
                <td className="num">{Number(l.amountUsd) < 0 ? <Amount value={String(-Number(l.amountUsd))} /> : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
