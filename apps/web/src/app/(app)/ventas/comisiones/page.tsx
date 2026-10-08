'use client';

import { formatNumber, money } from '@kaluch/shared';
import Link from 'next/link';
import { useState } from 'react';
import { Kpi } from '@/components/sales';
import { Alert, Amount, DateInput, DateText, PageHeader, Spinner, today } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { CommissionRow } from '@/lib/types';

const monthStart = () => `${today().slice(0, 7)}-01`;

export default function CommissionsPage() {
  const { companyId } = useSession();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const { data, error, loading } = useApi<CommissionRow[]>(from && to ? `/sales/commissions${qs({ companyId, from, to })}` : null);
  const total = (data ?? []).reduce((s, r) => s.plus(money(r.commissionUsd)), money(0));
  return (
    <div>
      <PageHeader
        title="Comisiones de vendedores"
        subtitle="Comisión por unidad vendida, por vendedor y semana (de lunes a domingo). Se acredita en la cuenta corriente del vendedor (410.9990); la liquidación semanal es el pago desde Bancos y Caja o un abono en su cuenta."
      />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div><label className="label" htmlFor="from">Desde</label><DateInput id="from" value={from} onChange={setFrom} /></div>
        <div><label className="label" htmlFor="to">Hasta</label><DateInput id="to" value={to} onChange={setTo} /></div>
      </div>
      {error && <Alert>{error.message}</Alert>}
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Kpi label="Comisiones del periodo" value={data ? total.toFixed(4) : '…'} />
        <Kpi label="Vendedores" value={data ? String(new Set(data.map((r) => r.sellerPartyAccountId)).size) : '…'} />
      </div>
      <div className="card overflow-x-auto">
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Semana del</th><th>Vendedor</th><th className="num">Unidades</th><th className="num">Ventas</th><th className="num">Comisión</th><th>Facturas</th></tr></thead>
            <tbody>
              {data?.map((r) => (
                <tr key={`${r.sellerPartyAccountId}-${r.week}`}>
                  <td><DateText value={r.week} /></td>
                  <td><Link className="hover:underline" href={`/terceros/${r.partyId}`}>{r.seller}</Link></td>
                  <td className="num">{formatNumber(r.units, 0)}</td>
                  <td className="num"><Amount value={r.salesUsd} /></td>
                  <td className="num font-semibold"><Amount value={r.commissionUsd} /></td>
                  <td className="text-[11px] text-muted">{r.invoices.join(', ')}</td>
                </tr>
              ))}
              {data?.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-muted">No hay comisiones en el periodo.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
