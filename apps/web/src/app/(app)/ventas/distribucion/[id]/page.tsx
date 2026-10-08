'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Kpi } from '@/components/sales';
import { Alert, Amount, DateText, PageHeader, Spinner } from '@/components/ui';
import { useApi } from '@/lib/api';
import type { SalesInvoiceDetail } from '@/lib/types';

export default function DistributionInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { data, error } = useApi<SalesInvoiceDetail>(`/sales/invoices/${id}`);
  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return <Spinner />;
  const margin = (Number(data.totalUsd) - Number(data.costUsd) - Number(data.commissionUsd) - Number(data.onatUsd)).toFixed(4);
  return (
    <div className="max-w-6xl">
      <PageHeader
        title={`Factura ${data.number}`}
        subtitle={<><DateText value={data.date} /> · {data.companyCode} · {data.partyId ? <Link className="underline" href={`/terceros/${data.partyId}`}>{data.customer}</Link> : 'Al contado'} · {data.description}</>}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-5">
        <Kpi label="Total" value={data.totalUsd} />
        <Kpi label="Costo" value={data.costUsd} />
        <Kpi label="Comisiones" value={data.commissionUsd} />
        <Kpi label="ONAT" value={data.onatUsd} hint={`${(Number(data.onatRate) * 100).toFixed(2)} % sobre ventas`} />
        <Kpi label="Margen" value={margin} tone={Number(margin) < 0 ? 'bad' : 'ok'} />
      </div>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Producto</th><th>Contenedor</th><th className="num">Cantidad</th><th className="num">Precio</th><th className="num">Importe</th><th className="num">Costo</th><th className="num">Comisión</th><th>Vendedor</th><th className="num">ONAT</th></tr></thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.product}</td>
                <td><Link className="hover:underline" href={`/inventario/${l.containerId}`}>{l.container}</Link></td>
                <td className="num"><Amount value={l.quantity} /> <span className="text-[10px] text-subtle">{l.unit}</span></td>
                <td className="num"><Amount value={l.unitPriceUsd} /></td>
                <td className="num font-semibold"><Amount value={l.amountUsd} /></td>
                <td className="num"><Amount value={l.costUsd} muted /></td>
                <td className="num"><Amount value={l.commissionUsd} muted /></td>
                <td>{l.seller ?? ''}</td>
                <td className="num"><Amount value={l.onatUsd} muted /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
