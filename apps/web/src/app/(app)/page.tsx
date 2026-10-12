'use client';

import Link from 'next/link';
import { formatNumber, money, MONTH_NAMES, sum } from '@kaluch/shared';
import { useState } from 'react';
import { Alert, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { PartyBalance, TreasuryAccount, TrialBalance } from '@/lib/types';

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

interface Dashboard {
  monthly: { month: number; incomeUsd: string; expensesUsd: string; resultUsd: string }[];
  ytd: { incomeUsd: string; expensesUsd: string; resultUsd: string };
  aging: { receivable: { key: string; label: string; usd: string }[]; payable: { key: string; label: string; usd: string }[] };
  commissionsPendingUsd: string;
  containers: {
    count: number; utilityUsd: string; revenueUsd: string; stockUsd: string;
    top: { id: string; code: string; description: string | null; status: string; revenueUsd: string; utilityUsd: string; marginPct: string | null; stockUsd: string }[];
  };
  markets: { market: string; name: string; incomeUsd: string; expensesUsd: string; resultUsd: string }[];
  alerts: { key: string; severity: 'error' | 'warning' | 'info'; title: string; detail: string }[];
}

function Panel({ title, href, link, children }: { title: string; href?: string; link?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-xs font-bold">{title}</span>
        {href && <Link href={href} className="text-[11px] text-brand-600 hover:underline">{link ?? 'Ver detalle →'}</Link>}
      </div>
      {children}
    </div>
  );
}

/** Barras de resultado mensual (ingresos − gastos) del año. */
function MonthlyBars({ data }: { data: Dashboard['monthly'] }) {
  const max = Math.max(1, ...data.map((m) => Math.abs(Number(m.resultUsd))));
  return (
    <div className="flex h-40 items-stretch gap-1.5 px-4 py-3" role="img" aria-label="Resultado mensual del año">
      {data.map((m) => {
        const v = Number(m.resultUsd);
        const h = `${(Math.abs(v) / max) * 50}%`;
        return (
          <div key={m.month} className="flex flex-1 flex-col items-center" title={`${MONTH_NAMES[m.month - 1]}: resultado ${formatNumber(m.resultUsd)} · ingresos ${formatNumber(m.incomeUsd)} · gastos ${formatNumber(m.expensesUsd)}`}>
            <div className="flex w-full flex-1 flex-col justify-end">{v > 0 && <div className="w-full rounded-t bg-ok/80" style={{ height: h }} />}</div>
            <div className="h-px w-full bg-line" />
            <div className="flex w-full flex-1 flex-col justify-start">{v < 0 && <div className="w-full rounded-b bg-bad/80" style={{ height: h }} />}</div>
            <div className="mt-1 text-[9px] text-subtle">{MONTH_NAMES[m.month - 1]?.slice(0, 3)}</div>
          </div>
        );
      })}
    </div>
  );
}

function AgingTable({ rows }: { rows: { key: string; label: string; usd: string }[] }) {
  const total = sum(rows.map((r) => r.usd));
  return (
    <table className="table">
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.label}</td>
            <td className="num">{formatNumber(r.usd, 0)}</td>
            <td className="w-24"><div className="h-1.5 rounded bg-gray-100"><div className={`h-1.5 rounded ${r.key === 'older' ? 'bg-bad' : r.key === 'current' ? 'bg-ok' : 'bg-warn'}`} style={{ width: total.isZero() ? 0 : `${money(r.usd).div(total).times(100).toFixed(0)}%` }} /></div></td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr><td>Total USD</td><td className="num">{formatNumber(total, 0)}</td><td /></tr></tfoot>
    </table>
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
  const { data: parties } = useApi<PartyBalance[]>(me && can('parties:read') ? `/parties/balances${qs({ companyId })}` : null);
  const { data: dash } = useApi<Dashboard>(me && can('reports:financial') ? `/dashboard${qs({ companyId, year, month })}` : null);
  const receivable = sum((parties ?? []).filter((p) => money(p.balanceUsd).gt(0)).map((p) => p.balanceUsd));
  const payable = sum((parties ?? []).filter((p) => money(p.balanceUsd).lt(0)).map((p) => p.balanceUsd)).neg();

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
        <Kpi icon="📑" label="Conciliación con el Excel" value="Ver" sub="BC y estados, línea a línea" href="/conciliacion-bc" />
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
          {can('parties:read') && (
            <div className="grid grid-cols-2 gap-3">
              <Kpi icon="📥" label="Por cobrar" value={parties ? formatNumber(receivable, 0) : '…'} sub="USD · cuentas corrientes" href="/cobrar" />
              <Kpi icon="📤" label="Por pagar" value={parties ? formatNumber(payable, 0) : '…'} sub="USD · proveedores, nómina…" href="/pagar" />
            </div>
          )}
          {dash && (
            <div className="grid grid-cols-2 gap-3">
              <Kpi icon="📦" label="Inventario valorado" value={formatNumber(dash.containers.stockUsd, 0)} sub={`USD · ${dash.containers.count} contenedores`} href="/inventario" />
              <Kpi icon="🤝" label="Comisiones pendientes" value={formatNumber(dash.commissionsPendingUsd, 0)} sub="USD · por pagar a vendedores" href="/ventas/comisiones" tone={money(dash.commissionsPendingUsd).gt(0) ? 'warn' : undefined} />
            </div>
          )}
          {dash && (
            <Kpi
              icon="📊" label={`Resultado realizado hasta ${MONTH_NAMES[month - 1]?.toLowerCase()}`} value={formatNumber(dash.ytd.resultUsd, 0)}
              sub={`USD · ingresos ${formatNumber(dash.ytd.incomeUsd, 0)} · gastos ${formatNumber(dash.ytd.expensesUsd, 0)}`}
              href={`/estados?code=ER&year=${year}&to=${month}`} tone={money(dash.ytd.resultUsd).isNeg() ? 'bad' : 'ok'}
            />
          )}
        </div>
      </div>

      {dash && (
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Panel title={`📈 Resultado mensual ${year}`} href={`/estados?code=ER&year=${year}&to=${month}`} link="Estado de resultados →">
            <MonthlyBars data={dash.monthly} />
            <p className="px-4 pb-2 text-[10px] text-subtle">Realizado: sin facturas de exportación pendientes de cierre{companyId ? '' : ' ni operaciones entre empresas'}.</p>
          </Panel>
          <Panel title="📥 Antigüedad de cuentas por cobrar" href="/cobrar"><AgingTable rows={dash.aging.receivable} /></Panel>
          <Panel title="📤 Antigüedad de cuentas por pagar" href="/pagar"><AgingTable rows={dash.aging.payable} /></Panel>
          <div className="lg:col-span-2">
            <Panel title="🚢 Utilidad por contenedor" href="/inventario">
              {dash.containers.top.length === 0 ? <p className="px-4 py-3 text-xs text-muted">Sin contenedores.</p> : (
                <table className="table">
                  <thead><tr><th>Contenedor</th><th>Estado</th><th className="num">Ventas</th><th className="num">Utilidad</th><th className="num">Margen</th><th className="num">Existencias</th></tr></thead>
                  <tbody>
                    {dash.containers.top.map((c) => (
                      <tr key={c.id}>
                        <td><Link className="text-brand-600 hover:underline" href={`/inventario/${c.id}`}>{c.code}</Link> <span className="text-muted">{c.description}</span></td>
                        <td className="text-xs">{c.status}</td>
                        <td className="num">{formatNumber(c.revenueUsd, 0)}</td>
                        <td className={`num ${money(c.utilityUsd).isNeg() ? 'text-bad' : ''}`}>{formatNumber(c.utilityUsd, 0)}</td>
                        <td className="num">{c.marginPct === null ? '—' : `${formatNumber(c.marginPct, 1)} %`}</td>
                        <td className="num">{formatNumber(c.stockUsd, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr><td>Total ({dash.containers.count})</td><td /><td className="num">{formatNumber(dash.containers.revenueUsd, 0)}</td><td className="num">{formatNumber(dash.containers.utilityUsd, 0)}</td><td /><td className="num">{formatNumber(dash.containers.stockUsd, 0)}</td></tr></tfoot>
                </table>
              )}
            </Panel>
          </div>
          <Panel title={`🏪 Utilidad por mercado ${year}`} href={`/estados?code=ERD999&year=${year}&to=${month}`} link="Distribución 999 →">
            {dash.markets.length === 0 ? <p className="px-4 py-3 text-xs text-muted">Sin ingresos ni gastos por inversión en mercados.</p> : (
              <table className="table">
                <thead><tr><th>Mercado</th><th className="num">Ingresos</th><th className="num">Gastos</th><th className="num">Resultado</th></tr></thead>
                <tbody>
                  {dash.markets.map((m) => (
                    <tr key={m.market}>
                      <td>{m.name || m.market}</td>
                      <td className="num">{formatNumber(m.incomeUsd, 0)}</td>
                      <td className="num">{formatNumber(m.expensesUsd, 0)}</td>
                      <td className={`num ${money(m.resultUsd).isNeg() ? 'text-bad' : ''}`}>{formatNumber(m.resultUsd, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          {dash.alerts.length > 0 && (
            <div className="lg:col-span-3">
              <Panel title={`⚠️ Alertas (${dash.alerts.length})`} href={`/estados?code=ES&year=${year}&to=${month}`} link="Estados financieros →">
                <ul className="max-h-64 divide-y divide-line overflow-auto">
                  {dash.alerts.map((a) => (
                    <li key={a.key} className="px-4 py-2 text-xs">
                      <span className={`mr-2 font-bold ${a.severity === 'error' ? 'text-bad' : a.severity === 'warning' ? 'text-warn' : 'text-brand-600'}`}>{a.severity === 'error' ? 'Error' : a.severity === 'warning' ? 'Aviso' : 'Info'}</span>
                      <span className="font-semibold">{a.title}.</span> <span className="text-muted">{a.detail}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          )}
        </div>
      )}
      {money(cash).isZero() && accounts?.length === 0 && <p className="mt-4 text-xs text-muted">Aún no hay cuentas de tesorería: impórtalas del Excel o créalas desde Bancos y Caja.</p>}
    </div>
  );
}
