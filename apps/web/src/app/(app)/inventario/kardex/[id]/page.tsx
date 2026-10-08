'use client';

import { formatNumber } from '@kaluch/shared';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Alert, Amount, DateText, PageHeader, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { MOVE_KIND_LABEL, type KardexRow, type ProductRow } from '@/lib/types';

function Kardex() {
  const { id } = useParams<{ id: string }>();
  const container = useSearchParams().get('container');
  const { data, error } = useApi<{ product: ProductRow; rows: KardexRow[] }>(`/sales/products/${id}/kardex${qs({ containerId: container })}`);
  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return <Spinner />;
  return (
    <div className="max-w-5xl">
      <PageHeader
        title={`Kardex · ${data.product.name}`}
        subtitle={<>Entradas por recepción de contenedores, salidas por venta al costo medio del lote. {container ? <Link className="underline" href={`/inventario/kardex/${id}`}>Ver todos los contenedores</Link> : null}</>}
      />
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Contenedor</th><th>Documento</th><th className="num">Cantidad</th><th className="num">Importe</th><th className="num">Existencias</th><th className="num">Valor</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <td><DateText value={r.date} /></td>
                <td>{MOVE_KIND_LABEL[r.kind] ?? r.kind}</td>
                <td>{r.container}</td>
                <td className="text-[11px] text-muted" title={r.description}>{r.document}</td>
                <td className="num">{formatNumber(r.quantity, 0)} <span className="text-[10px] text-subtle">{data.product.unit}</span></td>
                <td className="num"><Amount value={r.amountUsd} /></td>
                <td className="num font-semibold">{formatNumber(r.balanceQuantity, 0)}</td>
                <td className="num"><Amount value={r.balanceUsd} /></td>
              </tr>
            ))}
            {data.rows.length === 0 && <tr><td colSpan={8} className="py-6 text-center text-muted">Sin movimientos.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function KardexPage() {
  return <Suspense fallback={<Spinner />}><Kardex /></Suspense>;
}
