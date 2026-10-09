'use client';

import { formatNumber } from '@kaluch/shared';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';

type Mode = 'full' | 'sales' | 'rates';
const MODE_LABEL: Record<Mode, string> = { full: 'migración completa', sales: 'fases nuevas', rates: 'tasas' };

interface Step { key: string; label: string; status: 'pending' | 'running' | 'done' | 'error' | 'skipped'; startedAt: string | null; finishedAt: string | null }
interface ImportState {
  job: { status: 'running' | 'done' | 'error'; mode: Mode; fileName: string; startedBy: string; startedAt: string; finishedAt: string | null; steps: Step[]; log: string[]; error: string | null } | null;
  data: { accounts: number; rates: number; treasuryMovements: number; partyDocuments: number; phases: { debts: boolean; sales: boolean; fiscal: boolean }; lastImport: { at: string; file: string; table: string } | null };
}

const STEP_TONE: Record<Step['status'], { label: string; tone: 'gray' | 'green' | 'amber' | 'red' | 'blue' }> = {
  pending: { label: 'Pendiente', tone: 'gray' },
  running: { label: 'En curso…', tone: 'blue' },
  done: { label: 'Hecho', tone: 'green' },
  error: { label: 'Error', tone: 'red' },
  skipped: { label: 'No ejecutado', tone: 'gray' },
};

const minutes = (a: string | null, b: string | null) => (a ? `${Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000))} s` : '');

export default function ImportPage() {
  const { data, error, reload } = useApi<ImportState>('/admin/import');
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const running = data?.job?.status === 'running';
  const migrated = (data?.data.treasuryMovements ?? 0) > 0 || (data?.data.partyDocuments ?? 0) > 0;
  const salesPending = !!data?.data.phases.debts && (!data.data.phases.sales || !data.data.phases.fiscal);
  // Por defecto: lo que falta por migrar.
  const current: Mode = mode ?? (!migrated ? 'full' : salesPending ? 'sales' : 'rates');
  const needsConfirm = current !== 'rates';

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [running, reload]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.append('mode', current);
    fd.append('file', file);
    try {
      await api('/admin/import', { method: 'POST', body: fd });
      setFile(null);
      setConfirm(false);
      await reload();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Error al subir el archivo');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Importar el Excel"
        subtitle="Migración de “Balance de comprobación.xlsx”: plan de cuentas, tasas, caja y bancos, deudas, proveedores y nómina, exportación y distribución, con conciliación final contra el BC del propio Excel. El archivo se borra del servidor al terminar."
      />
      {error && <Alert>{error.message}</Alert>}
      {!data && !error && <Spinner />}
      {data && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            {[
              ['Cuentas', data.data.accounts], ['Tasas', data.data.rates], ['Movimientos de tesorería', data.data.treasuryMovements], ['Documentos de terceros', data.data.partyDocuments],
            ].map(([l, v]) => (
              <div key={l as string} className="card px-4 py-3">
                <div className="text-[10px] font-semibold tracking-wide text-subtle uppercase">{l}</div>
                <div className="mt-1 text-xl font-bold tabular-nums">{formatNumber(v as number, 0)}</div>
              </div>
            ))}
          </div>

          {!running && (
            <form onSubmit={submit} className="card mb-4 space-y-4 p-5">
              {msg && <Alert>{msg}</Alert>}
              <div>
                <label className="label" htmlFor="mode">Qué importar</label>
                <select id="mode" className="input" value={current} onChange={(e) => setMode(e.target.value as Mode)}>
                  <option value="full">Migración completa (una sola vez, sobre una base vacía)</option>
                  <option value="sales">Añadir lo que falta por migrar (exportación y distribución, financiamientos, impuestos y capital)</option>
                  <option value="rates">Solo actualizar las tasas de cambio</option>
                </select>
              </div>
              {current === 'full' && migrated && (
                <Alert kind="warning">Esta base ya tiene datos migrados: la migración completa no se puede repetir. Puedes actualizar solo las tasas.</Alert>
              )}
              {current === 'sales' && !salesPending && (
                <Alert kind="warning">{data.data.phases.debts ? 'Esta base ya tiene migradas todas las fases.' : 'Primero hay que hacer la migración completa (caja, bancos y deudas).'}</Alert>
              )}
              <div>
                <label className="label" htmlFor="file">Archivo Excel (.xlsx)</label>
                <input id="file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </div>
              {needsConfirm && (
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5" />
                  <span>
                    {current === 'full'
                      ? 'Entiendo que la migración tarda unos 15–20 minutos, que crea los saldos de apertura al 31/03/2026 y los movimientos desde abril, y que no se puede deshacer desde la aplicación.'
                      : 'Entiendo que migrar lo que falta tarda unos 5 minutos, que actualiza el plan de cuentas y los valores del BC con este archivo y que no se puede deshacer desde la aplicación. Debe ser el mismo Excel (o una versión posterior) del que se migraron las fases anteriores.'}
                  </span>
                </label>
              )}
              <button className="btn-primary" disabled={busy || !file || (needsConfirm && !confirm) || (current === 'full' && migrated) || (current === 'sales' && !salesPending)}>
                {busy ? 'Subiendo…' : current === 'rates' ? 'Subir y actualizar tasas' : 'Subir e importar'}
              </button>
            </form>
          )}

          {data.job && (
            <div className="card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-xs">
                <span className="font-bold">{data.job.fileName} · {MODE_LABEL[data.job.mode]} · {data.job.startedBy}</span>
                {data.job.status === 'running' && <Badge tone="blue">En curso · {minutes(data.job.startedAt, null)}</Badge>}
                {data.job.status === 'done' && <Badge tone="green">Terminada en {minutes(data.job.startedAt, data.job.finishedAt)}</Badge>}
                {data.job.status === 'error' && <Badge tone="red">Con error</Badge>}
              </div>
              <table className="table">
                <tbody>
                  {data.job.steps.map((s) => (
                    <tr key={s.key}><td>{s.label}</td><td className="w-32"><Badge tone={STEP_TONE[s.status].tone}>{STEP_TONE[s.status].label}</Badge></td><td className="num w-20">{minutes(s.startedAt, s.finishedAt)}</td></tr>
                  ))}
                </tbody>
              </table>
              {data.job.error && <div className="p-3"><Alert>{data.job.error}</Alert></div>}
              {data.job.status === 'done' && data.job.mode !== 'rates' && (
                <div className="p-3"><Alert kind="success">Migración terminada. Revisa el resultado en <Link className="underline" href="/conciliacion-bc">Conciliación con el Excel</Link>.</Alert></div>
              )}
              <pre aria-label="Registro" className="max-h-96 overflow-auto bg-ink px-4 py-3 text-[11px] leading-relaxed text-white/85">{data.job.log.join('\n') || '…'}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
