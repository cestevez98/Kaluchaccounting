'use client';

import { formatNumber } from '@kaluch/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, DateInput, DateText, Pagination, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { MOVEMENT_KIND_LABEL, type CashCategory, type Movement, type Paged } from '@/lib/types';

/** Tabla de movimientos de tesorería con filtros y paginación en servidor. */
export function MovementsTable({ treasuryAccountId, needsReview, categoryId: fixedCategory }: { treasuryAccountId?: string; needsReview?: boolean; categoryId?: string }) {
  const router = useRouter();
  const { companyId } = useSession();
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [categoryId, setCategoryId] = useState(fixedCategory ?? '');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const { data: categories } = useApi<CashCategory[]>('/treasury/categories');
  const { data, error, loading } = useApi<Paged<Movement>>(
    `/treasury/movements${qs({ page, pageSize: 50, companyId, treasuryAccountId, needsReview, categoryId: fixedCategory ?? categoryId, from, to, q: search })}`,
  );

  return (
    <div>
      <div className="card mb-3 grid gap-3 p-3 sm:grid-cols-5">
        <div><label className="label">Desde</label><DateInput value={from} onChange={(v) => { setFrom(v); setPage(1); }} /></div>
        <div><label className="label">Hasta</label><DateInput value={to} onChange={(v) => { setTo(v); setPage(1); }} /></div>
        {!fixedCategory && (
          <div>
            <label className="label">Categoría</label>
            <select className="input" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setPage(1); }}>
              <option value="">Todas</option>
              {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <form className="sm:col-span-2" onSubmit={(e) => { e.preventDefault(); setSearch(q); setPage(1); }}>
          <label className="label">Buscar (concepto, referencia o número)</label>
          <div className="flex gap-2"><input className="input" value={q} onChange={(e) => setQ(e.target.value)} /><button className="btn-secondary">Buscar</button></div>
        </form>
      </div>
      {error && <Alert>{error.message}</Alert>}
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr><th>Fecha</th><th>Número</th><th>Emp.</th><th>Concepto</th><th>Categoría</th><th>Cuenta</th><th className="num">Importe</th><th className="num">USD</th><th>Estado</th></tr>
          </thead>
          <tbody>
            {data?.items.map((m) => (
              <tr key={m.id} className="cursor-pointer" onClick={() => router.push(`/tesoreria/movimientos/${m.id}`)}>
                <td><DateText value={m.document.docDate} /></td>
                <td className="font-mono text-xs whitespace-nowrap">{m.document.number}</td>
                <td>{m.document.company.code}</td>
                <td className="max-w-sm truncate" title={m.description}>{m.description}</td>
                <td className="text-xs">{m.category?.name ?? <span className="text-gray-400">{m.sourceReference ?? '—'}</span>}</td>
                <td className="text-xs">{m.legs.map((l) => <div key={l.id}>{l.treasuryAccount.name}</div>)}</td>
                <td className="num">{m.legs.map((l) => <div key={l.id} className={Number(l.amount) < 0 ? 'text-red-700' : ''}>{formatNumber(l.amount)} {l.currency}</div>)}</td>
                <td className="num">{m.legs.map((l) => <div key={l.id}>{formatNumber(l.amountUsd)}</div>)}</td>
                <td className="whitespace-nowrap">
                  {m.document.status === 'VOIDED' ? <Badge tone="red">Anulado</Badge> : m.needsReview ? <Badge tone="amber">Por clasificar</Badge> : <Badge tone="green">{MOVEMENT_KIND_LABEL[m.kind]}</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && !data && <Spinner />}
        {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </div>
    </div>
  );
}
