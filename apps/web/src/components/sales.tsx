'use client';

import { formatNumber, parseNumberEs } from '@kaluch/shared';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { PartyBalance } from '@/lib/types';

/** Importe escrito en formato español ("1.234,56") → "1234.56"; vacío → "0". */
export const numEs = (v: string) => (v.trim() ? parseNumberEs(v) : '0');

export function Kpi({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'ok' | 'bad' | 'warn'; hint?: ReactNode }) {
  const cls = tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : '';
  return (
    <div className="card px-4 py-3">
      <div className="text-[10px] font-semibold tracking-wide text-subtle uppercase">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${cls}`}>{typeof value === 'string' && /^-?\d+\.\d+$/.test(value) ? formatNumber(value) : value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

/** Cuentas corrientes en USD cuya cuenta contable empieza por alguno de los prefijos (136, 410.9990…). */
export function usePartyAccounts(prefixes: string[], companyId?: string | null) {
  const session = useSession();
  const company = companyId ?? session.companyId;
  const { data } = useApi<PartyBalance[]>(`/parties/balances${qs({ companyId: company, hideZero: false })}`);
  return (data ?? []).filter((p) => p.currency === 'USD' && prefixes.some((pre) => p.accountCode === pre || p.accountCode.startsWith(`${pre}.`)));
}

export function PartyAccountSelect({
  id, value, onChange, options, required, empty = 'Elige…', missing,
}: { id: string; value: string; onChange: (v: string) => void; options: PartyBalance[]; required?: boolean; empty?: string; missing?: string }) {
  return (
    <>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} required={required}>
        <option value="">{empty}</option>
        {options.map((p) => <option key={p.partyAccountId} value={p.partyAccountId}>{p.partyName} · {p.companyCode} · {p.accountCode}</option>)}
      </select>
      {options.length === 0 && missing && (
        <p className="mt-1 text-[11px] text-muted">{missing} <Link className="underline" href="/terceros/nuevo">Crea la contraparte</Link> y ábrele la cuenta corriente.</p>
      )}
    </>
  );
}

export function CompanySelect({ id, value, onChange, perm }: { id: string; value: string; onChange: (v: string) => void; perm: string }) {
  const { me, can } = useSession();
  const companies = (me?.companies ?? []).filter((c) => can(perm, c.id) && c.kind !== 'PARTNER_POOL');
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} required>
      <option value="">Elige…</option>
      {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.legalName}</option>)}
    </select>
  );
}
