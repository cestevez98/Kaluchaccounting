'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Amount, Badge, DateInput, DateText, PageHeader, Pagination, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { BOOK_LABEL, KIND_LABEL, type EntrySummary, type Paged } from '@/lib/types';

export default function JournalPage() {
  const router = useRouter();
  const { companyId, can } = useSession();
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const { data, error, loading } = useApi<Paged<EntrySummary>>(
    `/journal${qs({ page, pageSize: 50, companyId, from, to, q: search })}`,
  );

  return (
    <div>
      <PageHeader
        title="Libro diario"
        subtitle="Todos los asientos contabilizados. Los asientos no se borran: se anulan con un contra-asiento."
        actions={can('ledger:post') && <Link className="btn-primary" href="/diario/nuevo">Nuevo asiento</Link>}
      />
      <div className="card mb-4 grid gap-3 p-3 sm:grid-cols-4">
        <div>
          <label className="label">Desde</label>
          <DateInput value={from} onChange={(v) => { setFrom(v); setPage(1); }} />
        </div>
        <div>
          <label className="label">Hasta</label>
          <DateInput value={to} onChange={(v) => { setTo(v); setPage(1); }} />
        </div>
        <form className="sm:col-span-2" onSubmit={(e) => { e.preventDefault(); setSearch(q); setPage(1); }}>
          <label className="label">Buscar (número o descripción)</label>
          <div className="flex gap-2">
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="p. ej. KEI-2026-000012 o alquiler" />
            <button className="btn-secondary">Buscar</button>
          </div>
        </form>
      </div>
      {error && <Alert>{error.message}</Alert>}
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Número</th>
              <th>Empresa</th>
              <th>Descripción</th>
              <th>Tipo</th>
              <th>Libro</th>
              <th className="num">Importe USD</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((e) => (
              <tr key={e.id} className="cursor-pointer" onClick={() => router.push(`/diario/${e.id}`)}>
                <td><DateText value={e.entryDate} /></td>
                <td className="font-mono text-xs"><Link href={`/diario/${e.id}`}>{e.number}</Link></td>
                <td>{e.companyCode}</td>
                <td className="max-w-md truncate">{e.memo}</td>
                <td>{KIND_LABEL[e.kind]}</td>
                <td>{BOOK_LABEL[e.book]}</td>
                <td className="num"><Amount value={e.totalUsd} /></td>
                <td>{e.status === 'REVERSED' ? <Badge tone="red">Anulado</Badge> : <Badge tone="green">Contabilizado</Badge>}</td>
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
