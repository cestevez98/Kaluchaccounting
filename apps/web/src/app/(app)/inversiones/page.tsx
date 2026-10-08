'use client';

import { formatNumber, money } from '@kaluch/shared';
import Link from 'next/link';
import { Kpi } from '@/components/sales';
import { Alert, Amount, Badge, PageHeader, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CONTAINER_STATUS, type ContainerRow } from '@/lib/types';

export default function InvestmentsPage() {
  const { companyId } = useSession();
  const { data, error, loading } = useApi<ContainerRow[]>(`/sales/containers${qs({ companyId })}`);
  const rows = (data ?? []).flatMap((c) => c.investors.map((i) => ({ c, i })));
  const invested = rows.reduce((s, r) => s.plus(money(r.i.investedUsd)), money(0));
  const share = rows.reduce((s, r) => s.plus(money(r.i.shareUsd)), money(0));
  return (
    <div>
      <PageHeader
        title="Inversionistas"
        subtitle="Participación de cada inversionista en los contenedores: capital invertido, % de la utilidad y su parte de la utilidad actual del contenedor. Los cobros y pagos van en su cuenta corriente (139 / 412)."
      />
      {error && <Alert>{error.message}</Alert>}
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Kpi label="Capital invertido" value={data ? invested.toFixed(4) : '…'} />
        <Kpi label="Utilidad de los inversionistas" value={data ? share.toFixed(4) : '…'} tone="ok" />
        <Kpi label="Participaciones" value={data ? String(rows.length) : '…'} />
      </div>
      <div className="card overflow-x-auto">
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Inversionista</th><th>Contenedor</th><th>Estado</th><th className="num">Invertido</th><th className="num">% utilidad</th><th className="num">Utilidad del contenedor</th><th className="num">Su parte</th></tr></thead>
            <tbody>
              {rows.map(({ c, i }) => (
                <tr key={i.id}>
                  <td><Link className="hover:underline" href={`/terceros/${i.partyId}`}>{i.name}</Link></td>
                  <td><Link className="hover:underline" href={`/inventario/${c.id}`}>{c.code}</Link></td>
                  <td><Badge tone={CONTAINER_STATUS[c.status].tone}>{CONTAINER_STATUS[c.status].label}</Badge></td>
                  <td className="num"><Amount value={i.investedUsd} /></td>
                  <td className="num">{formatNumber(i.profitPct)} %</td>
                  <td className="num"><Amount value={c.utilityUsd} muted /></td>
                  <td className="num font-semibold"><Amount value={i.shareUsd} /></td>
                </tr>
              ))}
              {data && rows.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-muted">No hay inversionistas asignados a contenedores. Se asignan desde la ficha del contenedor.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
