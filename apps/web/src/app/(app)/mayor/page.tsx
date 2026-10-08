'use client';

import { formatNumber } from '@kaluch/shared';
import Link from 'next/link';
import { useState } from 'react';
import { AccountPicker } from '@/components/account-picker';
import { Alert, Amount, DateInput, DateText, PageHeader, Pagination, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Account } from '@/lib/types';

interface Ledger {
  opening: string;
  total: number;
  page: number;
  pageSize: number;
  lines: {
    id: string; entryId: string; number: string; entryDate: string; memo: string; account: string;
    currency: string; amount: string; rate: string; amountUsd: string; balance: string; status: string;
  }[];
}

export default function GeneralLedgerPage() {
  const { companyId } = useSession();
  const y = new Date().getFullYear();
  const { data: accounts } = useApi<Account[]>('/accounts');
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(`${y}-12-31`);
  const [page, setPage] = useState(1);
  const { data, error, loading } = useApi<Ledger>(
    accountId && from && to ? `/reports/general-ledger${qs({ accountId, from, to, companyId, page, pageSize: 100 })}` : null,
  );

  return (
    <div>
      <PageHeader title="Libro mayor" subtitle="Movimientos de una cuenta (incluye sus subcuentas) con saldo acumulado en USD." />
      <div className="card mb-4 grid gap-3 p-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label className="label">Cuenta</label>
          <AccountPicker accounts={accounts ?? []} value={accountId} onChange={(id) => { setAccountId(id); setPage(1); }} />
        </div>
        <div><label className="label">Desde</label><DateInput value={from} onChange={(v) => { setFrom(v); setPage(1); }} /></div>
        <div><label className="label">Hasta</label><DateInput value={to} onChange={(v) => { setTo(v); setPage(1); }} /></div>
      </div>
      {error && <Alert>{error.message}</Alert>}
      {!accountId && <Alert kind="info">Elige una cuenta para ver su mayor.</Alert>}
      {data && (
        <div className="card overflow-x-auto">
          <div className="px-3 py-2 text-sm">Saldo inicial: <strong><Amount value={data.opening} /> USD</strong></div>
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th><th>Asiento</th><th>Cuenta</th><th>Concepto</th><th>Moneda</th>
                <th className="num">Importe orig.</th><th className="num">Tasa</th><th className="num">Debe USD</th><th className="num">Haber USD</th><th className="num">Saldo USD</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id} className={l.status === 'REVERSED' ? 'text-gray-400 line-through' : ''}>
                  <td><DateText value={l.entryDate} /></td>
                  <td className="font-mono text-xs"><Link className="text-brand-600" href={`/diario/${l.entryId}`}>{l.number}</Link></td>
                  <td className="text-xs">{l.account}</td>
                  <td className="max-w-xs truncate">{l.memo}</td>
                  <td>{l.currency}</td>
                  <td className="num"><Amount value={l.amount} /></td>
                  <td className="num text-gray-500">{l.currency === 'USD' ? '' : formatNumber(l.rate, 4)}</td>
                  <td className="num">{Number(l.amountUsd) > 0 ? formatNumber(l.amountUsd) : ''}</td>
                  <td className="num">{Number(l.amountUsd) < 0 ? formatNumber(l.amountUsd.replace('-', '')) : ''}</td>
                  <td className="num font-medium"><Amount value={l.balance} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </div>
      )}
      {loading && !data && accountId && <Spinner />}
    </div>
  );
}
