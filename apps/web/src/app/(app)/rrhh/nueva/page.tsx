'use client';

import { money, parseNumberEs } from '@kaluch/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert, DateInput, PageHeader, today } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import type { PartyBalance, Segment } from '@/lib/types';

const num = (v: string) => (v.trim() ? parseNumberEs(v) : '0');

export default function NewPayrollPage() {
  const { data: employees } = useApi<PartyBalance[]>('/parties/balances?role=EMPLOYEE&hideZero=false');
  const { data: segments } = useApi<Segment[]>('/segments');
  const [partyAccountId, setPa] = useState('');
  const [date, setDate] = useState(today());
  const [period, setPeriod] = useState(today().slice(0, 7));
  const [employer, setEmployer] = useState('KALUCH');
  const [concept, setConcept] = useState('Salario');
  const [gross, setGross] = useState('');
  const [attendance, setAttendance] = useState('');
  const [mipyme, setMipyme] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  let net = '';
  try { net = money(num(gross || '0')).minus(money(num(attendance)).abs()).minus(money(num(mipyme)).abs()).toFixed(2); } catch { net = ''; }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ document: { number: string } }>('/parties/payroll', {
        method: 'POST',
        json: {
          partyAccountId, date, period, employer, concept, gross: num(gross),
          attendanceDeduction: money(num(attendance)).abs().neg().toFixed(4), mipymeDeduction: money(num(mipyme)).abs().neg().toFixed(4),
          segmentId: segmentId || null,
        },
      });
      setDone(r.document.number);
      setGross(''); setAttendance(''); setMipyme('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <PageHeader title="Nueva nómina" subtitle="Gasto de personal contra Nóminas por pagar (455). El salario pagado por la Mipyme va a Pagos anticipados de nómina (146.0003)." />
      {done && <div className="mb-3"><Alert kind="success">Nómina {done} contabilizada. <Link className="underline" href="/rrhh">Ver nóminas</Link></Alert></div>}
      <form onSubmit={submit} className="card space-y-4 p-5">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="emp">Trabajador</label>
            <select id="emp" className="input" value={partyAccountId} onChange={(e) => setPa(e.target.value)} required>
              <option value="">Elige…</option>
              {employees?.map((e) => <option key={e.partyAccountId} value={e.partyAccountId}>{e.partyName} · {e.companyCode} · {e.currency}</option>)}
            </select>
            {employees?.length === 0 && <p className="mt-1 text-[11px] text-muted">No hay trabajadores con cuenta 455: <Link className="underline" href="/terceros/nuevo">crea la contraparte</Link> con rol Trabajador y ábrele la cuenta.</p>}
          </div>
          <div>
            <label className="label" htmlFor="seg">Segmento (gasto)</label>
            <select id="seg" className="input" value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
              <option value="">Por defecto (Distribución)</option>
              {segments?.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
            </select>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <div><label className="label" htmlFor="period">Periodo (AAAA-MM)</label><input id="period" className="input" value={period} onChange={(e) => setPeriod(e.target.value)} pattern="\d{4}-\d{2}" required /></div>
          <div><label className="label" htmlFor="date">Fecha</label><DateInput id="date" value={date} onChange={setDate} required /></div>
          <div><label className="label" htmlFor="employer">Pagador</label><input id="employer" className="input" value={employer} onChange={(e) => setEmployer(e.target.value)} required /></div>
          <div><label className="label" htmlFor="concept">Concepto</label><input id="concept" className="input" value={concept} onChange={(e) => setConcept(e.target.value)} required /></div>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <div><label className="label" htmlFor="gross">Salario</label><input id="gross" className="input num" value={gross} onChange={(e) => setGross(e.target.value)} required /></div>
          <div><label className="label" htmlFor="att">Descuento asistencia</label><input id="att" className="input num" value={attendance} onChange={(e) => setAttendance(e.target.value)} placeholder="0,00" /></div>
          <div><label className="label" htmlFor="mip">Salario Mipyme</label><input id="mip" className="input num" value={mipyme} onChange={(e) => setMipyme(e.target.value)} placeholder="0,00" /></div>
          <div><span className="label">Neto a pagar</span><div className="input num bg-canvas">{net}</div></div>
        </div>
        <button className="btn-primary" disabled={busy || !partyAccountId}>{busy ? 'Contabilizando…' : 'Contabilizar nómina'}</button>
      </form>
    </div>
  );
}
