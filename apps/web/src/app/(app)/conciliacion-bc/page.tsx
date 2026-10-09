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
interface Control { name: string; excel: string; system: string; diff: string; status: Row['status']; explainedBy: string[]; pending: string[] }

const STATUS = {
  OK: { label: 'Cuadra', tone: 'green' },
  EXPLAINED: { label: 'Explicada', tone: 'blue' },
  DIFF: { label: 'Diferencia', tone: 'red' },
  ONLY_SYSTEM: { label: 'Solo en el sistema', tone: 'amber' },
} as const;

const PRESETS = [
  {
    label: 'Migradas (fases 2 a 5)',
    codes: '101,109,110,111,112,113,114,135,136,137,138,139,146,180,181,1181,405,406,407,408,409,410,411,412,413,430,455,480,520,600,630,699,800,814,815,816,817,818,819,820,821,822,823,824,825,826,827,828,829,830,831,832,833,834,835,836,837,838,839,840,841,842,843,844,845,846,847,848,849,900,901,920,921,924,925,926,930,1900,1814,1815,1816,1817,2900,2814,2815,2816',
  },
  { label: 'Caja y bancos', codes: '101,109,110,111,112,113,114' },
  { label: 'Deudas, proveedores y nómina', codes: '135,146,405,406,407,408,409,410,411,412,413,455,699' },
  { label: 'Diferencias de cambio y tenencia', codes: '845,846,924,925' },
  { label: 'Exportación y distribución (fase 4)', codes: '136,137,139,180,181,1181,430,800,814,815,816,817,824,826,900,901,1900,1814,1815,1816,1817,2900,2814,2815,2816' },
  { label: 'Financiamientos, impuestos y capital (fase 5)', codes: '138,411,480,520,600,630,842,848,920,921' },
  { label: 'Gastos e ingresos de operación', codes: '827,828,829,830,831,832,833,834,835,836,837,838,839,840,841,842,843,844,847,848,849,920,921,926,930' },
  { label: 'Todas las cuentas', codes: '' },
];

export default function BcComparePage() {
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(10);
  const [codes, setCodes] = useState(PRESETS[0]!.codes);
  const [only, setOnly] = useState<'' | Row['status']>('');
  const { data, error, loading } = useApi<Result>(`/reports/bc-compare${qs({ year, month, codes })}`);
  const rows = data?.rows.filter((r) => !only || r.status === only) ?? [];
  const { data: controls } = useApi<Control[]>(`/reports/bc-compare/controls${qs({ year, month })}`);

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
      {controls && controls.length > 0 && (
        <div className="card mt-4 overflow-x-auto">
          <div className="border-b border-line px-4 py-2.5 text-xs font-bold">Totales de control del BC (ingresos, gastos y utilidad por segmento)</div>
          <table className="table">
            <thead><tr><th>Total</th><th className="num">Excel</th><th className="num">Sistema</th><th className="num">Diferencia</th><th>Estado</th><th>Detalle</th></tr></thead>
            <tbody>
              {controls.map((c) => (
                <tr key={c.name}>
                  <td className="font-semibold">{c.name}</td>
                  <td className="num">{formatNumber(c.excel)}</td>
                  <td className="num">{formatNumber(c.system)}</td>
                  <td className={`num ${c.status === 'DIFF' ? 'font-semibold text-red-700' : 'text-gray-500'}`}>{formatNumber(c.diff)}</td>
                  <td><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge></td>
                  <td className="text-xs text-gray-600">
                    {c.status === 'EXPLAINED' && `Diferencias ya explicadas de ${c.explainedBy.join(', ')}`}
                    {c.status === 'DIFF' && c.pending.length > 0 && `Cuentas con diferencia: ${c.pending.join(', ')}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
