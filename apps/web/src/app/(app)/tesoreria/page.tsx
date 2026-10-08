'use client';

import { formatNumber, money, sum } from '@kaluch/shared';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Badge, DateInput, PageHeader, Spinner, today } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { TREASURY_KIND_LABEL, type TreasuryAccount } from '@/lib/types';

/** País según el grupo de cuentas del BC: 101/111/114 Cuba · 109/112 Rep. Dominicana · 110/113 España. */
const COUNTRY_BY_GROUP: Record<string, string> = {
  '101': 'Cuba', '111': 'Cuba', '114': 'Cuba', '109': 'Rep. Dominicana', '112': 'Rep. Dominicana', '110': 'España', '113': 'España',
};
const COUNTRY_META: Record<string, { color: string; bg: string; flag: string }> = {
  Cuba: { color: '#1F3864', bg: '#e8ecf4', flag: '🇨🇺' },
  España: { color: '#B91C1C', bg: '#fde8e8', flag: '🇪🇸' },
  'Rep. Dominicana': { color: '#1D4ED8', bg: '#dbeafe', flag: '🇩🇴' },
  Otros: { color: '#047857', bg: '#d1fae5', flag: '🌐' },
};
const countryOf = (a: TreasuryAccount) => COUNTRY_BY_GROUP[a.glAccount.displayCode.slice(0, 3)] ?? 'Otros';

export default function TreasuryPage() {
  const { companyId, can } = useSession();
  const [date, setDate] = useState(today());
  const { data, error, loading } = useApi<TreasuryAccount[]>(`/treasury/accounts${qs({ companyId, date })}`);
  const accounts = data ?? [];
  const total = sum(accounts.map((a) => a.balanceUsd));
  const countries = ['Cuba', 'España', 'Rep. Dominicana', 'Otros'].filter((c) => accounts.some((a) => countryOf(a) === c));

  return (
    <div>
      <PageHeader
        title="Tesorería consolidada"
        subtitle={`${accounts.length} cuentas · saldos al ${date.split('-').reverse().join('/')} (USD valorado con la tasa aplicada y la revaluación de fin de mes)`}
        actions={
          <>
            <div className="w-36"><DateInput value={date} onChange={(v) => setDate(v || today())} /></div>
            {can('cash:operate') && <Link href="/tesoreria/nuevo" className="btn-primary">Nuevo movimiento</Link>}
          </>
        }
      />
      {error && <Alert>{error.message}</Alert>}

      {data && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div className="card flex flex-col justify-center px-4 py-3">
            <div className="text-[11px] text-subtle">Saldo total</div>
            <div className="text-2xl font-extrabold text-brand-600 tabular-nums">USD {formatNumber(total)}</div>
          </div>
          {countries.map((c) => {
            const meta = COUNTRY_META[c]!;
            const list = accounts.filter((a) => countryOf(a) === c);
            const t = sum(list.map((a) => a.balanceUsd));
            const pct = total.isZero() ? 0 : t.div(total).times(100).toNumber();
            return (
              <div key={c} className="rounded-lg px-3.5 py-3" style={{ background: meta.bg, border: `1px solid ${meta.color}22` }}>
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold" style={{ color: meta.color }}>
                  <span className="text-base">{meta.flag}</span>{c}
                </div>
                <div className="text-lg font-bold tabular-nums" style={{ color: meta.color }}>
                  {formatNumber(t)} <span className="text-[11px] font-normal">USD</span>
                </div>
                <div className="flex justify-between text-[10px]" style={{ color: `${meta.color}99` }}>
                  <span>{list.length} {list.length === 1 ? 'cuenta' : 'cuentas'}</span>
                  <span>{formatNumber(pct.toFixed(1), 1)} %</span>
                </div>
                <div className="mt-2 h-[3px] rounded" style={{ background: `${meta.color}22` }}>
                  <div className="h-[3px] rounded" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: meta.color }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="card max-h-[65vh] overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Cuenta</th><th>Titular</th><th>Banco</th><th>País</th><th>Tipo</th><th>Moneda</th>
              <th className="num">Saldo original</th><th className="num">Saldo USD</th><th>Pendientes</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const c = countryOf(a);
              const meta = COUNTRY_META[c]!;
              return (
                <tr key={a.id}>
                  <td className="font-medium">
                    <Link className="hover:underline" href={`/tesoreria/movimientos?account=${a.id}`}>{a.name}</Link>
                    <div className="font-mono text-[10px] text-subtle">{a.company.code} · {a.glAccount.displayCode}</div>
                    {a.createdByEtl && <Badge tone="amber">creada en migración</Badge>}
                  </td>
                  <td>
                    {a.ownerName ?? '—'} {a.ownerType === 'PARTNER' && <Badge>Personal</Badge>}
                  </td>
                  <td>{a.bank ?? (a.kind === 'CASH' ? 'Caja' : '—')}</td>
                  <td>
                    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap" style={{ background: meta.bg, color: meta.color }}>
                      {meta.flag} {c}
                    </span>
                  </td>
                  <td><Badge tone={a.kind === 'CASH' ? 'gray' : 'blue'}>{TREASURY_KIND_LABEL[a.kind]}</Badge></td>
                  <td className="font-semibold">{a.currency}</td>
                  <td className={`num ${money(a.balance).isNeg() ? 'text-bad' : ''}`}>{formatNumber(a.balance)} <span className="text-[11px] text-subtle">{a.currency}</span></td>
                  <td className={`num font-semibold ${money(a.balanceUsd).isNeg() ? 'text-bad' : 'text-brand-600'}`}>{formatNumber(a.balanceUsd)} <span className="text-[11px] font-normal text-subtle">USD</span></td>
                  <td>
                    {a.unmatchedStatementLines > 0 ? (
                      <Link href={`/tesoreria/extractos?account=${a.id}`}><Badge tone="amber">{a.unmatchedStatementLines} en extracto</Badge></Link>
                    ) : <span className="text-subtle">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {data && (
            <tfoot>
              <tr>
                <td colSpan={7} className="!bg-brand-900 font-bold text-white">TOTAL TESORERÍA — {accounts.length} cuentas</td>
                <td className="num !bg-brand-900 text-sm font-extrabold text-[#86efac]">{formatNumber(total)} <span className="text-[11px] font-normal text-white/60">USD</span></td>
                <td className="!bg-brand-900" />
              </tr>
            </tfoot>
          )}
        </table>
        {loading && !data && <Spinner />}
      </div>
    </div>
  );
}
