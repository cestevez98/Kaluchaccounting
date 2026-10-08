'use client';

import { formatNumber, money, MONTH_NAMES } from '@kaluch/shared';
import { Fragment, useState } from 'react';
import { Alert, Amount, Badge, PageHeader, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CLASS_LABEL, type Segment, type TrialBalance } from '@/lib/types';

export default function TrialBalancePage() {
  const { companyId } = useSession();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [segmentId, setSegmentId] = useState('');
  const [view, setView] = useState<'REAL' | 'FISCAL'>('REAL');
  const [includeZero, setIncludeZero] = useState(false);
  const [onlyPostable, setOnlyPostable] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: segments } = useApi<Segment[]>('/segments');
  const params = { year, month, companyId, segmentId, view, includeZero };
  const { data, error, loading } = useApi<TrialBalance>(`/reports/trial-balance${qs(params)}`);
  const rows = data?.rows.filter((r) => !onlyPostable || r.postable) ?? [];

  return (
    <div>
      <PageHeader
        title="Balance de comprobación"
        subtitle={`${MONTH_NAMES[month - 1]} ${year} · importes en USD · ${companyId ? 'empresa seleccionada' : 'grupo consolidado'}`}
        actions={
          <a className="btn-secondary" href={`/api/v1/reports/trial-balance.xlsx${qs(params)}`}>
            Exportar a Excel
          </a>
        }
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-3">
        <div>
          <label className="label" htmlFor="tb-month">Mes</label>
          <select id="tb-month" className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="tb-year">Año</label>
          <input id="tb-year" className="input w-24" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
        </div>
        <div>
          <label className="label" htmlFor="tb-segment">Segmento</label>
          <select id="tb-segment" className="input" value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
            <option value="">Todos</option>
            {segments?.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="tb-view">Vista</label>
          <select id="tb-view" className="input" value={view} onChange={(e) => setView(e.target.value as 'REAL' | 'FISCAL')}>
            <option value="REAL">Real</option>
            <option value="FISCAL">Fiscal / Presentado</option>
          </select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} /> Cuentas sin saldo</label>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={onlyPostable} onChange={(e) => setOnlyPostable(e.target.checked)} /> Solo cuentas de detalle</label>
      </div>
      {error && <Alert>{error.message}</Alert>}
      {data && (
        <div className="mb-4">
          {data.summary.balanced ? (
            <Alert kind="success">
              Cuadra · Activo {formatNumber(data.summary.assets)} = Pasivo {formatNumber(data.summary.liabilities)} + Patrimonio {formatNumber(data.summary.equity)} + Resultado{' '}
              {formatNumber(money(data.summary.income).minus(data.summary.expenses))}
            </Alert>
          ) : (
            <Alert>Descuadre: Activo − (Pasivo + Patrimonio + Resultado) = {formatNumber(data.summary.difference, 4)} USD</Alert>
          )}
        </div>
      )}
      <div className="card max-h-[70vh] overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Cuenta</th>
              <th>Descripción</th>
              <th>Clase</th>
              <th className="num">Saldo inicial</th>
              <th className="num">Debe</th>
              <th className="num">Haber</th>
              <th className="num">Saldo final</th>
              <th className="num" title="Saldo para cuentas de balance; movimiento del mes para ingresos y gastos (como el BC del Excel)">Valor BC</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.accountId}>
                <tr className={r.postable ? '' : 'bg-gray-50/70 font-semibold'} onClick={() => setExpanded(expanded === r.accountId ? null : r.accountId)}>
                  <td className="font-mono text-xs whitespace-nowrap">{r.displayCode}</td>
                  <td style={{ paddingLeft: `${0.75 + r.level * 1.25}rem` }}>
                    {r.name} {r.anomaly && <Badge tone="amber">anomalía</Badge>}
                    {r.byCurrency.some((c) => c.currency !== 'USD') && <span className="ml-1 text-xs text-brand-600">{expanded === r.accountId ? '▾' : '▸'} monedas</span>}
                  </td>
                  <td className="text-xs text-gray-500">{CLASS_LABEL[r.classification]}</td>
                  <td className="num"><Amount value={r.opening} /></td>
                  <td className="num"><Amount value={r.debit} /></td>
                  <td className="num"><Amount value={r.credit} /></td>
                  <td className="num"><Amount value={r.closing} /></td>
                  <td className="num"><Amount value={r.bcValue} /></td>
                </tr>
                {expanded === r.accountId &&
                  r.byCurrency.map((c) => (
                    <tr key={c.currency} className="text-xs text-gray-600">
                      <td />
                      <td style={{ paddingLeft: `${2 + r.level * 1.25}rem` }} colSpan={2}>Saldo en {c.currency}</td>
                      <td colSpan={3} className="num">{formatNumber(c.closingOrig)} {c.currency}</td>
                      <td className="num">{formatNumber(c.closingUsd)} USD</td>
                      <td />
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
          {data && (
            <tfoot>
              <tr className="font-semibold">
                <td colSpan={3} className="text-right">Totales</td>
                <td className="num"><Amount value={data.totals.opening} /></td>
                <td className="num"><Amount value={data.totals.debit} /></td>
                <td className="num"><Amount value={data.totals.credit} /></td>
                <td className="num"><Amount value={data.totals.closing} /></td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
        {loading && !data && <Spinner />}
      </div>
    </div>
  );
}
