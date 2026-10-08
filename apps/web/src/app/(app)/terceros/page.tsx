'use client';

import { formatNumber } from '@kaluch/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { BalanceText, RoleBadges } from '@/components/parties';
import { Alert, PageHeader, Pagination, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PARTY_ROLE_LABELS, type Paged, type PartyRow } from '@/lib/types';

function PartiesList() {
  const { companyId, can } = useSession();
  const params = useSearchParams();
  const [q, setQ] = useState('');
  const [role, setRole] = useState(params.get('role') ?? '');
  const [page, setPage] = useState(1);
  const { data, error, loading } = useApi<Paged<PartyRow>>(`/parties${qs({ companyId, q: q || undefined, role: role || undefined, page, pageSize: 50 })}`);
  return (
    <div>
      <PageHeader
        title="Terceros"
        subtitle="Clientes, proveedores, trabajadores, socios e intermediarios con los que hay deudas o créditos. El saldo es el neto de su cuenta corriente: positivo si nos debe, negativo si le debemos."
        actions={can('parties:manage') ? <><Link className="btn-secondary" href="/terceros/documento">Cargo / abono</Link><Link className="btn-primary" href="/terceros/nuevo">Nueva contraparte</Link></> : null}
      />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="q">Buscar</label>
          <input id="q" className="input w-72" placeholder="Nombre, código o NIF" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
        <div>
          <label className="label" htmlFor="role">Tipo</label>
          <select id="role" className="input" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
            <option value="">Todos</option>
            {Object.entries(PARTY_ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>
      {error && <Alert>{error.message}</Alert>}
      <div className="card overflow-x-auto">
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Contraparte</th><th>Tipo</th><th className="num">Cuentas</th><th className="num">Partidas abiertas</th><th className="num">Saldo USD</th></tr></thead>
            <tbody>
              {data?.items.map((p) => (
                <tr key={p.id} className={p.active ? '' : 'opacity-60'}>
                  <td>
                    <Link className="font-medium hover:underline" href={`/terceros/${p.id}`}>{p.name}</Link>
                    <div className="font-mono text-[10px] text-subtle">{p.code}{p.taxId ? ` · ${p.taxId}` : ''}</div>
                  </td>
                  <td><RoleBadges roles={p.roles} /></td>
                  <td className="num">{p.accounts || ''}</td>
                  <td className="num">{p.openItems ? formatNumber(p.openItems, 0) : ''}</td>
                  <td className="num"><BalanceText value={p.balanceUsd} /></td>
                </tr>
              ))}
              {data?.items.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-muted">No hay contrapartes.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </div>
  );
}

export default function PartiesPage() {
  return <Suspense><PartiesList /></Suspense>;
}
