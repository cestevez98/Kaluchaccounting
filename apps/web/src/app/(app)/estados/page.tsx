'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { formatNumber, MONTH_NAMES } from '@kaluch/shared';
import { Fragment, Suspense, useState } from 'react';
import { Alert, Badge, PageHeader, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Segment } from '@/lib/types';

type Status = 'OK' | 'DIFF' | 'EXPLAINED' | 'NO_REF';

interface Line {
  key: string; label: string; source: string; indent: number; bold: boolean; values: string[];
  accounts: { code: string; name: string; values: string[] }[];
  categories: { name: string; values: string[] }[];
  excel: (string | null)[] | null; status: (Status | null)[] | null; explanations: (string | null)[] | null;
}
interface Statement {
  template: { id: string; code: string; name: string; kind: string; notes: string; origin: string };
  columns: { key: string; label: string; year: number; month: number | null }[];
  lines: Line[];
  unmapped: { code: string; name: string; classification: string; value: string }[];
  eliminated: { code: string; name: string; value: string }[];
  warnings: string[];
  comparison: Record<Status, number> | null;
}
interface Template { code: string; name: string; kind: string; origin: string; active: boolean; references: number }
interface StatementAlert { key: string; severity: 'error' | 'warning' | 'info'; title: string; detail: string }

const STATUS: Record<Status, { label: string; tone: 'green' | 'blue' | 'red' | 'gray'; icon: string }> = {
  OK: { label: 'Cuadra con el Excel', tone: 'green', icon: '✓' },
  EXPLAINED: { label: 'Diferencia explicada', tone: 'blue', icon: 'i' },
  DIFF: { label: 'Diferencia sin explicar', tone: 'red', icon: '!' },
  NO_REF: { label: 'Sin cifra en el Excel', tone: 'gray', icon: '–' },
};
const ORIGIN: Record<string, string> = {
  EXCEL: 'del Excel', EXCEL_MODIFICADA: 'del Excel, modificada en el sistema', SISTEMA: 'creada en el sistema', PREDETERMINADA: 'generada desde el plan de cuentas',
};

function StatementsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { companyId, can } = useSession();
  const now = new Date();
  const code = params.get('code') ?? 'ES';
  const [year, setYear] = useState(Number(params.get('year')) || now.getFullYear());
  const [fromMonth, setFromMonth] = useState(Number(params.get('from')) || 1);
  const [toMonth, setToMonth] = useState(Number(params.get('to')) || now.getMonth() + 1);
  const [view, setView] = useState<'REAL' | 'FISCAL'>('REAL');
  const [segment, setSegment] = useState('');
  const [eliminate, setEliminate] = useState(true);
  const [compare, setCompare] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { data: templates } = useApi<Template[]>('/statements/templates');
  const { data: segments } = useApi<Segment[]>('/segments');
  const query = { companyId, year, fromMonth, toMonth, view, segment: segment || undefined, eliminate };
  const { data, error, loading } = useApi<Statement>(`/statements/${encodeURIComponent(code)}${qs(query)}`);
  const { data: alerts } = useApi<StatementAlert[]>(`/statements/alerts${qs({ companyId, year, month: toMonth })}`);
  const monthCols = data?.columns.filter((c) => c.month !== null) ?? [];
  const showExcel = compare && !!data?.comparison;
  const toggle = (k: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  });

  return (
    <div>
      <PageHeader
        title={data?.template.name ?? 'Estados financieros'}
        subtitle={companyId ? 'Empresa seleccionada' : 'Consolidado del grupo (empresas que consolidan). Importes en USD con el signo del Excel: ingresos y pasivos en positivo, gastos en negativo.'}
        actions={(
          <div className="flex gap-2">
            {can('reports:design') && <Link className="btn-secondary" href={`/estados/disenador?code=${encodeURIComponent(code)}`}>Diseñar plantilla</Link>}
            <a className="btn-secondary" href={`/api/v1/statements/${encodeURIComponent(code)}/xlsx${qs(query)}`}>Descargar Excel</a>
          </div>
        )}
      />
      <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Estado">
        {(templates ?? []).filter((t) => t.active).map((t) => (
          <button
            key={t.code} role="tab" aria-selected={t.code === code}
            className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${t.code === code ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-white hover:border-brand-600'}`}
            onClick={() => router.replace(`/estados?code=${encodeURIComponent(t.code)}`)}
          >
            {t.code}
          </button>
        ))}
        {templates && templates.length === 0 && <span className="text-xs text-muted">No hay plantillas: impórtalas del Excel (Configuración → Importar Excel) o créalas en el diseñador.</span>}
      </div>
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-3">
        <div>
          <label className="label" htmlFor="st-year">Año</label>
          <input id="st-year" className="input w-24" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
        </div>
        <div>
          <label className="label" htmlFor="st-from">Desde</label>
          <select id="st-from" className="input" value={fromMonth} onChange={(e) => setFromMonth(Number(e.target.value))}>
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="st-to">Hasta</label>
          <select id="st-to" className="input" value={toMonth} onChange={(e) => setToMonth(Number(e.target.value))}>
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="st-view">Vista</label>
          <select id="st-view" className="input" value={view} onChange={(e) => setView(e.target.value as 'REAL' | 'FISCAL')}>
            <option value="REAL">Real</option>
            <option value="FISCAL">Fiscal / Presentado</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="st-seg">Segmento</label>
          <select id="st-seg" className="input" value={segment} onChange={(e) => setSegment(e.target.value)}>
            <option value="">Todos</option>
            {segments?.map((s) => <option key={s.id} value={s.code}>{s.code} · {s.name}</option>)}
          </select>
        </div>
        {!companyId && (
          <label className="flex items-center gap-1.5 pb-2 text-xs">
            <input type="checkbox" checked={eliminate} onChange={(e) => setEliminate(e.target.checked)} /> Eliminar operaciones entre empresas
          </label>
        )}
        {data?.comparison && (
          <label className="flex items-center gap-1.5 pb-2 text-xs">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Comparar con el Excel
          </label>
        )}
      </div>

      {error && <Alert>{error.message}</Alert>}
      {data?.warnings.map((w) => <div key={w} className="mb-2"><Alert kind="warning">{w}</Alert></div>)}
      {showExcel && data?.comparison && (
        <div className="mb-3 flex flex-wrap gap-2">
          {(Object.keys(STATUS) as Status[]).map((s) => (
            <div key={s} className="card px-3 py-1.5 text-xs">
              <span className="text-muted">{STATUS[s].label}: </span><span className="font-bold">{data.comparison![s]}</span>
            </div>
          ))}
          <span className="self-center text-[11px] text-muted">Cifras de las hojas del Excel, mes a mes. Pasa el ratón por el icono para ver la explicación.</span>
        </div>
      )}

      <div className="card max-h-[70vh] overflow-auto">
        {loading && !data ? <Spinner /> : data && (
          <table className="table">
            <thead className="sticky top-0 z-10 bg-white">
              <tr>
                <th className="min-w-[280px]">Línea</th>
                {data.columns.map((c) => <th key={c.key} className="num whitespace-nowrap">{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => {
                const expandable = l.accounts.length > 0 || l.categories.length > 0;
                const isOpen = open.has(l.key);
                if (!l.label && l.source === 'NONE') return <tr key={l.key} aria-hidden><td colSpan={data.columns.length + 1} className="h-3 p-0" /></tr>;
                return (
                  <Fragment key={l.key}>
                    <tr className={l.bold ? 'bg-gray-50 font-semibold' : ''}>
                      <td style={{ paddingLeft: `${0.75 + l.indent * 1.1}rem` }}>
                        {expandable ? (
                          <button className="text-left hover:text-brand-600" onClick={() => toggle(l.key)} aria-expanded={isOpen}>
                            <span className="mr-1 inline-block w-3 text-subtle">{isOpen ? '▾' : '▸'}</span>{l.label}
                          </button>
                        ) : <><span className="mr-1 inline-block w-3" />{l.label}</>}
                      </td>
                      {l.values.map((v, i) => {
                        const st = showExcel ? l.status?.[i] : null;
                        const excel = l.excel?.[i];
                        const why = l.explanations?.[i];
                        return (
                          <td key={i} className="num whitespace-nowrap">
                            {l.source === 'NONE' && !l.label ? '' : formatNumber(v)}
                            {st && (
                              <span
                                className={`ml-1.5 inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full text-[9px] font-bold ${st === 'OK' ? 'bg-green-100 text-green-700' : st === 'EXPLAINED' ? 'bg-blue-100 text-blue-700' : st === 'DIFF' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}
                                title={`${STATUS[st].label}${excel !== null && excel !== undefined ? ` · Excel ${formatNumber(excel)}` : ''}${why ? ` — ${why}` : ''}`}
                                aria-label={STATUS[st].label}
                              >
                                {STATUS[st].icon}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                    {isOpen && l.accounts.map((a) => (
                      <tr key={`${l.key}-${a.code}`} className="text-[11px] text-muted">
                        <td style={{ paddingLeft: `${2 + l.indent * 1.1}rem` }}><span className="font-mono">{a.code}</span> {a.name}</td>
                        {a.values.map((v, i) => <td key={i} className="num">{formatNumber(v)}</td>)}
                      </tr>
                    ))}
                    {isOpen && l.categories.map((c) => (
                      <tr key={`${l.key}-${c.name}`} className="text-[11px] text-muted">
                        <td style={{ paddingLeft: `${2 + l.indent * 1.1}rem` }}>{c.name}</td>
                        {c.values.map((v, i) => <td key={i} className="num">{formatNumber(v)}</td>)}
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {data && (data.unmapped.length > 0 || data.eliminated.length > 0) && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {data.unmapped.length > 0 && (
            <div className="card">
              <div className="border-b border-line px-4 py-2.5 text-xs font-bold">Cuentas que no están en ninguna línea</div>
              <table className="table">
                <thead><tr><th>Cuenta</th><th>Descripción</th><th className="num">{data.columns.at(-1)?.label}</th></tr></thead>
                <tbody>{data.unmapped.map((u) => <tr key={u.code}><td className="font-mono">{u.code}</td><td>{u.name}</td><td className="num">{formatNumber(u.value)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {data.eliminated.length > 0 && (
            <div className="card">
              <div className="border-b border-line px-4 py-2.5 text-xs font-bold">Eliminadas del consolidado (operaciones entre empresas)</div>
              <table className="table">
                <thead><tr><th>Cuenta</th><th>Descripción</th><th className="num">{data.columns.at(-1)?.label}</th></tr></thead>
                <tbody>{data.eliminated.map((u) => <tr key={u.code}><td className="font-mono">{u.code}</td><td>{u.name}</td><td className="num">{formatNumber(u.value)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {alerts && alerts.length > 0 && (
        <div className="card mt-4">
          <div className="border-b border-line px-4 py-2.5 text-xs font-bold">Alertas a {MONTH_NAMES[toMonth - 1]?.toLowerCase()} {year}</div>
          <ul className="divide-y divide-line">
            {alerts.map((a) => (
              <li key={a.key} className="flex gap-2 px-4 py-2 text-xs">
                <Badge tone={a.severity === 'error' ? 'red' : a.severity === 'warning' ? 'amber' : 'blue'}>{a.severity === 'error' ? 'Error' : a.severity === 'warning' ? 'Aviso' : 'Info'}</Badge>
                <div><div className="font-semibold">{a.title}</div><div className="text-muted">{a.detail}</div></div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data?.template.notes && (
        <div className="mt-4 text-[11px] text-muted">
          <div className="font-semibold">Notas de la plantilla ({ORIGIN[data.template.origin] ?? data.template.origin})</div>
          <ul className="list-disc pl-5">{data.template.notes.split('\n').filter(Boolean).map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
      {monthCols.length === 0 && data && <p className="mt-3 text-xs text-muted">No hay meses terminados en el periodo elegido.</p>}
    </div>
  );
}

export default function StatementsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <StatementsInner />
    </Suspense>
  );
}
