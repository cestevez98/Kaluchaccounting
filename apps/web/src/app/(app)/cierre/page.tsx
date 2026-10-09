'use client';

import { formatNumber, MONTH_NAMES } from '@kaluch/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { CompanySelect } from '@/components/sales';
import { Alert, Amount, Badge, DateText, PageHeader, Spinner, today } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { MonthClose, YearCloseRow } from '@/lib/types';

const ACTION: Record<string, { href: string; label: string }> = {
  rates: { href: '/tasas', label: 'Tasas de cambio' },
  tray: { href: '/tesoreria/revision', label: 'Bandeja de revisión' },
  loans: { href: '/financiamientos', label: 'Préstamos' },
  revaluation: { href: '/tesoreria/revaluacion', label: 'Revaluación y cierre' },
  taxes: { href: '/impuestos', label: 'Impuestos' },
  period: { href: '/periodos', label: 'Periodos' },
};
const TONE = { OK: { tone: 'green', label: 'Hecho' }, PENDING: { tone: 'amber', label: 'Pendiente' }, INFO: { tone: 'gray', label: 'Info' } } as const;

export default function ClosingPage() {
  const { companyId: sc, can } = useSession();
  const [companyId, setCompanyId] = useState(sc ?? '');
  const [ym, setYm] = useState(() => {
    const d = new Date();
    d.setUTCDate(0);
    return d.toISOString().slice(0, 7);
  });
  const [year, month] = ym.split('-').map(Number) as [number, number];
  const { data, error, loading } = useApi<MonthClose>(companyId ? `/finance/close/month${qs({ companyId, year, month })}` : null);
  const pending = data?.checks.filter((c) => c.status === 'PENDING').length ?? 0;
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Cierre de mes y de ejercicio"
        subtitle="Lista de comprobación del cierre mensual de cada empresa y cierre del ejercicio (resultados a Utilidades retenidas, 630)."
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div><label className="label" htmlFor="co">Empresa</label><CompanySelect id="co" value={companyId} onChange={setCompanyId} perm="ledger:read" /></div>
        <div><label className="label" htmlFor="ym">Mes (AAAA-MM)</label><input id="ym" className="input" value={ym} onChange={(e) => setYm(e.target.value)} pattern="\d{4}-\d{2}" /></div>
        {data && <span className="text-sm">{MONTH_NAMES[month - 1]} {year}: {pending ? <Badge tone="amber">{pending} pendientes</Badge> : <Badge tone="green">Todo listo</Badge>}</span>}
      </div>
      {error && <Alert>{error.message}</Alert>}
      {!companyId && <Alert kind="info">Elige una empresa para ver su lista de cierre.</Alert>}
      {companyId && (loading && !data ? <Spinner /> : data && (
        <div className="card mb-6 overflow-x-auto">
          <table className="table">
            <thead><tr><th>Paso</th><th>Estado</th><th>Detalle</th><th /></tr></thead>
            <tbody>
              {data.checks.map((c, i) => (
                <tr key={c.key}>
                  <td className="font-semibold">{i + 1}. {c.label}</td>
                  <td><Badge tone={TONE[c.status].tone}>{TONE[c.status].label}</Badge></td>
                  <td className="text-xs text-muted">{c.detail}</td>
                  <td>{ACTION[c.key] && <Link className="text-xs underline" href={ACTION[c.key]!.href}>{ACTION[c.key]!.label}</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <YearClose canClose={can('year:close')} />
    </div>
  );
}

function YearClose({ canClose }: { canClose: boolean }) {
  const { companyId: sc } = useSession();
  const { data, reload } = useApi<YearCloseRow[]>(`/finance/close/year${qs({ companyId: sc })}`);
  const [companyId, setCompanyId] = useState(sc ?? '');
  const [year, setYear] = useState(Number(today().slice(0, 4)) - 1);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const r = await api<{ year: number; resultUsd: string }>('/finance/close/year', { method: 'POST', json: { companyId, year } });
      setMsg({ kind: 'success', text: `Ejercicio ${r.year} cerrado: resultado ${formatNumber(r.resultUsd)} USD llevado a Utilidades retenidas.` });
      setConfirm(false);
      await reload();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Error' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card overflow-x-auto">
      <div className="border-b border-line px-4 py-2.5 text-xs font-bold">Cierre del ejercicio</div>
      <div className="px-4 py-3 text-xs text-muted">
        Lleva el saldo del año de todas las cuentas de ingresos y gastos (por libro y segmento) a Utilidades retenidas (630) en el periodo de cierre (31/12), así diciembre conserva su resultado en los informes. Deja abiertos los meses del año siguiente. Si se repite, anula el cierre anterior y lo rehace.
      </div>
      {canClose && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3 border-t border-line p-4">
          {msg && <div className="w-full"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
          <div><label className="label" htmlFor="yco">Empresa</label><CompanySelect id="yco" value={companyId} onChange={setCompanyId} perm="year:close" /></div>
          <div><label className="label" htmlFor="year">Ejercicio</label><input id="year" type="number" className="input w-24" value={year} onChange={(e) => setYear(Number(e.target.value))} /></div>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> He revisado el cierre de diciembre</label>
          <button className="btn-primary" disabled={busy || !companyId || !confirm}>{busy ? 'Cerrando…' : `Cerrar el ejercicio ${year}`}</button>
        </form>
      )}
      <table className="table">
        <thead><tr><th>Empresa</th><th>Ejercicio</th><th className="num">Resultado</th><th className="num">Asientos</th><th>Fecha</th></tr></thead>
        <tbody>
          {data?.map((r) => (
            <tr key={r.id}><td>{r.companyCode}</td><td>{r.year}</td><td className="num"><Amount value={r.resultUsd} /></td><td className="num">{r.entries}</td><td><DateText value={r.createdAt} /></td></tr>
          ))}
          {data?.length === 0 && <tr><td colSpan={5} className="py-4 text-center text-muted">Ningún ejercicio cerrado todavía.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
