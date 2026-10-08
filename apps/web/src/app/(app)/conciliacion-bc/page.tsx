'use client';

import { formatNumber, MONTH_NAMES } from '@kaluch/shared';
import { useState } from 'react';
import { Alert, Badge, PageHeader, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';

interface Row {
  displayCode: string; name: string; excelRow: number | null; excel: string | null; system: string; diff: string;
  status: 'OK' | 'EXPLAINED' | 'DIFF' | 'ONLY_SYSTEM'; explanation: string | null;
}
interface Result { rows: Row[]; summary: Record<Row['status'], number>; importId: string | null }

const STATUS = {
  OK: { label: 'Cuadra', tone: 'green' },
  EXPLAINED: { label: 'Explicada', tone: 'blue' },
  DIFF: { label: 'Diferencia', tone: 'red' },
  ONLY_SYSTEM: { label: 'Solo en el sistema', tone: 'amber' },
} as const;

const PRESETS = [
  { label: 'Caja y bancos (fase 2)', codes: '101,109,110,111,112,113,114' },
  { label: 'Todas las cuentas', codes: '' },
];

export default function BcComparePage() {
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(10);
  const [codes, setCodes] = useState(PRESETS[0]!.codes);
  const [only, setOnly] = useState<'' | Row['status']>('');
  const { data, error, loading } = useApi<Result>(`/reports/bc-compare${qs({ year, month, codes })}`);
  const rows = data?.rows.filter((r) => !only || r.status === only) ?? [];

  return (
    <div>
      <PageHeader
        title="Conciliación con el Excel"
        subtitle="Compara el “Valor BC” del sistema (consolidado, vista Real) con el BC del Excel importado. Tolerancia: ±0,01 USD por cuenta."
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-3">
        <div>
          <label className="label" htmlFor="bc-month">Mes</label>
          <select id="bc-month" className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div><label className="label" htmlFor="bc-year">Año</label><input id="bc-year" className="input w-24" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} /></div>
        <div>
          <label className="label" htmlFor="bc-codes">Cuentas</label>
          <select id="bc-codes" className="input" value={codes} onChange={(e) => setCodes(e.target.value)}>
            {PRESETS.map((p) => <option key={p.label} value={p.codes}>{p.label}</option>)}
          </select>
        </div>
      </div>
      {error && <Alert>{error.message}</Alert>}
      {data && !data.importId && <Alert kind="warning">Todavía no se ha importado el BC del Excel (pnpm etl bc-ref).</Alert>}
      {data && (
        <div className="mb-4 flex flex-wrap gap-2">
          {(Object.keys(STATUS) as Row['status'][]).map((s) => (
            <button key={s} className={`card px-4 py-2 text-left ${only === s ? 'ring-2 ring-brand-600' : ''}`} onClick={() => setOnly(only === s ? '' : s)}>
              <div className="text-xs text-gray-500">{STATUS[s].label}</div>
              <div className="text-lg font-semibold">{data.summary[s]}</div>
            </button>
          ))}
        </div>
      )}
      <div className="card max-h-[65vh] overflow-auto">
        <table className="table">
          <thead><tr><th>Cuenta</th><th>Descripción</th><th className="num">Excel</th><th className="num">Sistema</th><th className="num">Diferencia</th><th>Estado</th><th>Explicación</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.displayCode}-${r.excelRow}`}>
                <td className="font-mono text-xs">{r.displayCode}</td>
                <td className="max-w-sm truncate" title={r.name}>{r.name}</td>
                <td className="num">{r.excel === null ? '—' : formatNumber(r.excel)}</td>
                <td className="num">{formatNumber(r.system)}</td>
                <td className={`num ${r.status === 'DIFF' ? 'font-semibold text-red-700' : 'text-gray-500'}`}>{formatNumber(r.diff)}</td>
                <td><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge></td>
                <td className="max-w-md text-xs text-gray-600">{r.explanation?.replace('[auto] ', '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && !data && <Spinner />}
      </div>
      <p className="mt-2 text-xs text-gray-500">Mes mostrado: {MONTH_NAMES[month - 1]} {year}.</p>
    </div>
  );
}
