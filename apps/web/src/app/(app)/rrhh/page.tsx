'use client';

import { formatNumber, money } from '@kaluch/shared';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Alert, Badge, DateText, PageHeader, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { OPEN_ITEM_STATUS, type PayrollRow } from '@/lib/types';

export default function PayrollPage() {
  const { companyId, can } = useSession();
  const [period, setPeriod] = useState('');
  const { data, error, loading } = useApi<PayrollRow[]>(`/parties/payroll${qs({ companyId, period: period || undefined })}`);
  const periods = useMemo(() => [...new Set((data ?? []).map((r) => r.period))].sort().reverse(), [data]);
  const totals = (data ?? []).reduce((t, r) => ({ gross: t.gross.plus(money(r.gross)), net: t.net.plus(money(r.net)), open: t.open.plus(money(r.openAmount ?? 0)) }), { gross: money(0), net: money(0), open: money(0) });
  return (
    <div>
      <PageHeader
        title="Nóminas"
        subtitle="Salarios por trabajador y periodo, con descuentos de asistencia y salario Mipyme. El neto queda en Nóminas por pagar (455) hasta su pago."
        actions={can('payroll:manage') ? <Link className="btn-primary" href="/rrhh/nueva">Nueva nómina</Link> : null}
      />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="period">Periodo</label>
          <select id="period" className="input" value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="">Todos</option>
            {periods.map((p) => <option key={p} value={p}>{p.split('-').reverse().join('/')}</option>)}
          </select>
        </div>
      </div>
      {error && <Alert>{error.message}</Alert>}
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="card px-4 py-3"><div className="text-[10px] font-semibold tracking-wide text-subtle uppercase">Salario bruto</div><div className="mt-1 text-xl font-bold tabular-nums">{data ? formatNumber(totals.gross) : '…'}</div></div>
        <div className="card px-4 py-3"><div className="text-[10px] font-semibold tracking-wide text-subtle uppercase">Neto a pagar</div><div className="mt-1 text-xl font-bold tabular-nums">{data ? formatNumber(totals.net) : '…'}</div></div>
        <div className="card px-4 py-3"><div className="text-[10px] font-semibold tracking-wide text-subtle uppercase">Pendiente de pago</div><div className="mt-1 text-xl font-bold tabular-nums text-warn">{data ? formatNumber(totals.open) : '…'}</div></div>
      </div>
      <div className="card overflow-x-auto">
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Periodo</th><th>Trabajador</th><th>Pagador</th><th>Concepto</th><th className="num">Salario</th><th className="num">Desc. asistencia</th><th className="num">Desc. Mipyme</th><th className="num">Neto</th><th>Moneda</th><th>Estado</th></tr></thead>
            <tbody>
              {data?.map((r) => (
                <tr key={r.id}>
                  <td>{r.period.split('-').reverse().join('/')}<div className="text-[10px] text-subtle"><DateText value={r.date} /> · {r.number}</div></td>
                  <td><Link className="hover:underline" href={`/terceros/${r.partyId}`}>{r.partyName}</Link></td>
                  <td>{r.employer}</td>
                  <td>{r.concept}</td>
                  <td className="num">{formatNumber(r.gross)}</td>
                  <td className="num">{money(r.attendanceDeduction).isZero() ? '' : formatNumber(r.attendanceDeduction)}</td>
                  <td className="num">{money(r.mipymeDeduction).isZero() ? '' : formatNumber(r.mipymeDeduction)}</td>
                  <td className="num font-semibold">{formatNumber(r.net)}</td>
                  <td>{r.currency}</td>
                  <td>{r.status ? <Badge tone={OPEN_ITEM_STATUS[r.status as keyof typeof OPEN_ITEM_STATUS]?.tone ?? 'gray'}>{OPEN_ITEM_STATUS[r.status as keyof typeof OPEN_ITEM_STATUS]?.label ?? r.status}</Badge> : null}</td>
                </tr>
              ))}
              {data?.length === 0 && <tr><td colSpan={10} className="py-6 text-center text-muted">No hay nóminas.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
