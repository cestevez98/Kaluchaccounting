'use client';

import Link from 'next/link';
import { formatNumber, money, MONTH_NAMES, sum } from '@kaluch/shared';
import { useState } from 'react';
import { Alert, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { TreasuryAccount, TrialBalance } from '@/lib/types';

function Kpi({ label, value, sub, icon, href, tone }: { label: string; value: string; sub: string; icon: string; href?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-ink';
  const body = (
    <div className="card h-full px-4 py-3 transition hover:border-brand-600">
      <div className="flex items-start justify-between">
        <div className="text-[10px] font-semibold tracking-wide text-subtle uppercase">{label}</div>
        <span className="text-base">{icon}</span>
      </div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-[11px] text-muted">{sub}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function Future({ label, icon, phase }: { label: string; icon: string; phase: number }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-3 text-subtle">
      <div className="flex items-start justify-between">
        <div className="text-[10px] font-semibold tracking-wide uppercase">{label}</div>
        <span className="text-base grayscale">{icon}</span>
      </div>
      <div className="mt-1 text-sm">Disponible en la fase {phase}</div>
    </div>
  );
}

export default function DashboardPage() {
  const { me, companyId, can } = useSession();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const company = me?.companies.find((c) => c.id === companyId);
  const { data: tb, error } = useApi<TrialBalance>(me && can('reports:financial') ? `/reports/trial-balance${qs({ year, month, companyId })}` : null);
  const { data: accounts } = useApi<TreasuryAccount[]>(me && can('ledger:read') ? `/treasury/accounts${qs({ companyId })}` : null);
  const { data: review } = useApi<{ count: number; usd: string }[]>(me && can('ledger:read') ? `/treasury/review/summary${qs({ companyId })}` : null);

  const cash = sum((accounts ?? []).map((a) => a.balanceUsd));
  const pending = review?.reduce((s, r) => s + r.count, 0) ?? 0;
  const pendingUsd = sum((review ?? []).map((r) => r.usd));
  const unmatched = (accounts ?? []).reduce((s, a) => s + a.unmatchedStatementLines, 0);
  const top = (tb?.rows ?? []).filter((r) => r.level === 0);
  const income = sum(top.filter((r) => r.classification === 'CNA').map((r) => r.bcValue)).neg();
  const expenses = sum(top.filter((r) => r.classification === 'CND').map((r) => r.bcValue));
  const result = income.minus(expenses);

  const byCurrency = new Map<string, { orig: string[]; usd: string[] }>();
  for (const a of accounts ?? []) {
    const e = byCurrency.get(a.currency) ?? { orig: [], usd: [] };
    e.orig.push(a.balance);
    e.usd.push(a.balanceUsd);
    byCurrency.set(a.currency, e);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold">Hola{me ? `, ${me.name}` : ''}</h1>
          <p className="text-xs text-muted">{company ? `${company.code} · ${company.legalName}` : 'Consolidado del grupo'}</p>
        </div>
        <div className="flex gap-2">
          <div>
            <div className="label">Periodo</div>
            <div className="flex gap-1">
              <select aria-label="Mes" className="input h-7 text-xs" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <select aria-label="Año" className="input h-7 w-20 text-xs" value={year} onChange={(e) => setYear(Number(e.target.value))}>
                {[2025, 2026, 2027].map((y) => <option key={y}>{y}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      {me?.requires2fa && !me.totpEnabled && (
        <div className="mb-4"><Alert kind="warning">Tu rol exige verificación en dos pasos. <Link className="underline" href="/seguridad">Actívala ahora</Link>.</Alert></div>
      )}
      {error && <Alert>{error.message}</Alert>}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi icon="🏦" label="Disponible caja y bancos" value={accounts ? formatNumber(cash) : '…'} sub={`USD · ${accounts?.length ?? 0} cuentas`} href="/tesoreria" />
        <Kpi icon="💹" label={`Resultado ${MONTH_NAMES[month - 1]?.toLowerCase()}`} value={tb ? formatNumber(result) : '…'} sub={`USD · ingresos ${tb ? formatNumber(income, 0) : '…'}`} href="/balance" tone={tb ? (result.isNeg() && !result.isZero() ? 'bad' : 'ok') : undefined} />
        <Kpi icon="🗂️" label="Pendientes de clasificar" value={review ? formatNumber(pending, 0) : '…'} sub={`movimientos · USD ${formatNumber(pendingUsd, 0)}`} href="/tesoreria/revision" tone={pending > 0 ? 'warn' : 'ok'} />
        <Kpi icon="🧾" label="Extractos por conciliar" value={accounts ? formatNumber(unmatched, 0) : '…'} sub="líneas sin casar" href="/tesoreria/extractos" tone={unmatched > 0 ? 'warn' : undefined} />
        <Kpi
          icon="⚖️"
          label="Cuadre del balance"
          value={tb ? (tb.summary.balanced ? 'Cuadra' : 'No cuadra') : '…'}
          sub={tb ? `A ${formatNumber(tb.summary.assets, 0)} · dif. ${formatNumber(tb.summary.difference)}` : ''}
          href="/balance"
          tone={tb ? (tb.summary.balanced ? 'ok' : 'bad') : undefined}
        />
        <Kpi icon="📑" label="Conciliación con el Excel" value="Ver" sub="caja y bancos abril–octubre" href="/conciliacion-bc" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-xs font-bold">🏦 Tesorería por moneda</span>
            <Link href="/tesoreria" className="text-[11px] text-brand-600 hover:underline">Ver detalle →</Link>
          </div>
          {!accounts ? <Spinner /> : (
            <table className="table">
              <thead><tr><th>Moneda</th><th className="num">Saldo original</th><th className="num">Equivalente USD</th><th className="num">% del total</th></tr></thead>
              <tbody>
                {[...byCurrency.entries()].sort((a, b) => sum(b[1].usd).cmp(sum(a[1].usd))).map(([cur, v]) => {
                  const usd = sum(v.usd);
                  return (
                    <tr key={cur}>
                      <td className="font-semibold">{cur}</td>
                      <td className="num">{formatNumber(sum(v.orig))}</td>
                      <td className="num">{formatNumber(usd)}</td>
                      <td className="num">{cash.isZero() ? '' : `${formatNumber(usd.div(cash).times(100), 1)} %`}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr><td>Total</td><td /><td className="num">{formatNumber(cash)}</td><td /></tr></tfoot>
            </table>
          )}
        </div>
        <div className="space-y-3">
          <div className="text-[10px] font-semibold tracking-wide text-subtle uppercase">Próximamente</div>
          <Future label="Ventas y utilidad por contenedor" icon="🛒" phase={4} />
          <Future label="Cuentas por cobrar y pagar" icon="📥" phase={3} />
          <Future label="Inventario valorado" icon="📦" phase={4} />
          <Future label="Estados financieros (ES, ER, EFE)" icon="📊" phase={6} />
        </div>
      </div>
      {money(cash).isZero() && accounts?.length === 0 && <p className="mt-4 text-xs text-muted">Aún no hay cuentas de tesorería: impórtalas del Excel o créalas desde Bancos y Caja.</p>}
    </div>
  );
}
