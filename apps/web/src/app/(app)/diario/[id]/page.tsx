'use client';

import { formatNumber, money, sum } from '@kaluch/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Amount, Badge, DateInput, DateText, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { BOOK_LABEL, KIND_LABEL, type EntryDetail } from '@/lib/types';

export default function EntryPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useSession();
  const { data: e, error, loading } = useApi<EntryDetail>(`/journal/${id}`);
  const [confirming, setConfirming] = useState(false);
  const [revDate, setRevDate] = useState('');
  const [revError, setRevError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading && !e) return <Spinner />;
  if (error) return <Alert>{error.message}</Alert>;
  if (!e) return null;

  const debit = sum(e.lines.filter((l) => money(l.amountUsd).gt(0)).map((l) => l.amountUsd));
  const credit = sum(e.lines.filter((l) => money(l.amountUsd).lt(0)).map((l) => l.amountUsd)).neg();

  async function reverse() {
    setBusy(true);
    setRevError(null);
    try {
      const r = await api<{ id: string }>(`/journal/${id}/reverse`, { method: 'POST', json: revDate ? { entryDate: revDate } : {} });
      router.push(`/diario/${r.id}`);
    } catch (err) {
      setRevError(err instanceof ApiError ? err.message : 'Error al anular');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={`Asiento ${e.number}`}
        subtitle={<>{e.company.code} · {e.company.legalName} · <DateText value={e.entryDate} /></>}
        actions={
          <>
            <Link href="/diario" className="btn-secondary">Volver</Link>
            {e.status === 'POSTED' && e.kind !== 'REVERSAL' && can('ledger:reverse', e.companyId) && (
              <button className="btn-danger" onClick={() => setConfirming(true)}>Anular</button>
            )}
          </>
        }
      />
      {confirming && (
        <div className="card mb-4 space-y-3 border-red-200 p-4">
          <p className="text-sm">
            Se creará un <strong>contra-asiento</strong> con las mismas líneas y el signo invertido. El asiento original quedará marcado como anulado. Nada se borra.
          </p>
          <div className="max-w-xs">
            <label className="label">Fecha del contra-asiento (opcional)</label>
            <DateInput value={revDate} onChange={setRevDate} />
            <p className="mt-1 text-xs text-gray-500">Por defecto, la del original si su periodo está abierto; si no, el día 1 del primer periodo abierto.</p>
          </div>
          {revError && <Alert>{revError}</Alert>}
          <div className="flex gap-2">
            <button className="btn-danger" onClick={reverse} disabled={busy}>{busy ? 'Anulando…' : 'Confirmar anulación'}</button>
            <button className="btn-secondary" onClick={() => setConfirming(false)}>Cancelar</button>
          </div>
        </div>
      )}
      <div className="card mb-4 grid gap-3 p-4 text-sm sm:grid-cols-4">
        <div><div className="label">Descripción</div>{e.memo}</div>
        <div><div className="label">Tipo · Libro</div>{KIND_LABEL[e.kind]} · {BOOK_LABEL[e.book]}</div>
        <div>
          <div className="label">Estado</div>
          {e.status === 'REVERSED' ? <Badge tone="red">Anulado</Badge> : <Badge tone="green">Contabilizado</Badge>}
          {e.reversedBy && <> por <Link className="text-brand-600 underline" href={`/diario/${e.reversedBy.id}`}>{e.reversedBy.number}</Link></>}
          {e.reverses && <> · anula <Link className="text-brand-600 underline" href={`/diario/${e.reverses.id}`}>{e.reverses.number}</Link></>}
        </div>
        <div><div className="label">Registrado</div>{new Date(e.createdAt).toLocaleString('es-ES')}</div>
      </div>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Cuenta</th>
              <th>Moneda</th>
              <th className="num">Debe (orig.)</th>
              <th className="num">Haber (orig.)</th>
              <th className="num">Tasa</th>
              <th className="num">Debe USD</th>
              <th className="num">Haber USD</th>
              <th>Concepto</th>
            </tr>
          </thead>
          <tbody>
            {e.lines.map((l) => (
              <tr key={l.id}>
                <td className="text-gray-400">{l.lineNo}</td>
                <td><span className="font-mono text-xs">{l.account.displayCode}</span> {l.account.name}</td>
                <td>{l.currency}</td>
                <td className="num">{Number(l.amount) > 0 ? <Amount value={l.amount} /> : ''}</td>
                <td className="num">{Number(l.amount) < 0 ? <Amount value={money(l.amount).neg().toString()} /> : ''}</td>
                <td className="num text-gray-600">{l.currency === 'USD' ? '' : `${formatNumber(l.rate, 4)}${l.rateType ? ` ${l.rateType}` : ''}`}</td>
                <td className="num">{Number(l.amountUsd) > 0 ? formatNumber(l.amountUsd) : ''}</td>
                <td className="num">{Number(l.amountUsd) < 0 ? formatNumber(money(l.amountUsd).neg()) : ''}</td>
                <td className="text-gray-600">{l.memo}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td colSpan={6} className="text-right">Totales USD</td>
              <td className="num">{formatNumber(debit)}</td>
              <td className="num">{formatNumber(credit)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
