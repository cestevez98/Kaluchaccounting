'use client';

import { DEFAULT_RATE_TYPES, formatNumber, money, parseNumberEs, sum, toUsd } from '@kaluch/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AccountPicker } from '@/components/account-picker';
import { Alert, DateInput, PageHeader, today } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Account, DimensionValue, Segment } from '@/lib/types';

interface Line {
  key: number;
  accountId: string;
  currency: string;
  debit: string;
  credit: string;
  rate: string;
  segmentId: string;
  posId: string;
  memo: string;
}

let keySeq = 1;
const emptyLine = (): Line => ({ key: keySeq++, accountId: '', currency: 'USD', debit: '', credit: '', rate: '', segmentId: '', posId: '', memo: '' });

function parseAmount(s: string): string | null {
  if (!s.trim()) return null;
  try {
    return parseNumberEs(s);
  } catch {
    return null;
  }
}

export default function NewEntryPage() {
  const router = useRouter();
  const { me, companyId: selectedCompany, can } = useSession();
  const { data: accounts } = useApi<Account[]>('/accounts?postable=true');
  const { data: segments } = useApi<Segment[]>('/segments');
  const { data: pos } = useApi<DimensionValue[]>('/dimensions?dimension=POS');
  const { data: cur } = useApi<{ currencies: { code: string }[] }>('/currencies');

  const postable = me?.companies.filter((c) => can('ledger:post', c.id)) ?? [];
  const [companyId, setCompanyId] = useState('');
  const [entryDate, setEntryDate] = useState(today());
  const [book, setBook] = useState<'BASE' | 'REAL' | 'FISCAL'>('BASE');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [rates, setRates] = useState<Record<string, string | { error: string }>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!companyId && postable.length) setCompanyId(postable.find((c) => c.id === selectedCompany)?.id ?? postable[0]!.id);
  }, [postable, companyId, selectedCompany]);

  const accountById = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a])), [accounts]);
  const rateTypeOf = (l: Line) => accountById.get(l.accountId)?.revalRateType ?? DEFAULT_RATE_TYPES[l.currency] ?? 'IC';

  // Tasas vigentes para la vista previa en USD.
  const neededRates = useMemo(() => {
    const keys = new Set<string>();
    for (const l of lines) if (l.currency !== 'USD' && !l.rate.trim()) keys.add(`${l.currency}|${rateTypeOf(l)}`);
    return [...keys].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, accountById]);
  useEffect(() => {
    if (!entryDate) return;
    for (const k of neededRates) {
      const cacheKey = `${entryDate}|${k}`;
      if (rates[cacheKey]) continue;
      const [currency, rateType] = k.split('|');
      api<{ rate: string }>(`/rates/lookup${qs({ date: entryDate, currency, rateType })}`)
        .then((r) => setRates((s) => ({ ...s, [cacheKey]: r.rate })))
        .catch((e) => setRates((s) => ({ ...s, [cacheKey]: { error: e instanceof ApiError ? e.message : 'Sin tasa' } })));
    }
  }, [neededRates, entryDate, rates]);

  const preview = lines.map((l) => {
    const d = parseAmount(l.debit);
    const c = parseAmount(l.credit);
    const amount = d ? money(d) : c ? money(c).neg() : null;
    if (!amount || !l.accountId) return { amount: null, usd: null, rate: null as string | null, rateError: null as string | null };
    if (l.currency === 'USD') return { amount, usd: amount, rate: '1', rateError: null };
    const manual = parseAmount(l.rate);
    const r = manual ?? rates[`${entryDate}|${l.currency}|${rateTypeOf(l)}`];
    if (!r) return { amount, usd: null, rate: null, rateError: null };
    if (typeof r === 'object') return { amount, usd: null, rate: null, rateError: r.error };
    return { amount, usd: toUsd(amount, r), rate: r, rateError: null };
  });
  const debitUsd = sum(preview.filter((p) => p.usd?.gt(0)).map((p) => p.usd!));
  const creditUsd = sum(preview.filter((p) => p.usd?.lt(0)).map((p) => p.usd!.neg()));
  const diff = debitUsd.minus(creditUsd);

  function update(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const payloadLines = [];
    for (const [i, l] of lines.entries()) {
      const p = preview[i]!;
      if (!l.accountId && !l.debit && !l.credit) continue;
      if (!l.accountId || !p.amount) {
        setError(new ApiError(400, 'VALIDATION', `Línea ${i + 1}: indica la cuenta y un importe en Debe o Haber`));
        return;
      }
      payloadLines.push({
        accountId: l.accountId,
        currency: l.currency,
        amount: p.amount.toString(),
        ...(parseAmount(l.rate) ? { rate: parseAmount(l.rate)! } : {}),
        ...(l.currency !== 'USD' && !parseAmount(l.rate) ? { rateType: rateTypeOf(l) } : {}),
        ...(l.segmentId ? { segmentId: l.segmentId } : {}),
        ...(l.posId ? { posId: l.posId } : {}),
        ...(l.memo ? { memo: l.memo } : {}),
      });
    }
    setBusy(true);
    try {
      const entry = await api<{ id: string }>('/journal', { method: 'POST', json: { companyId, entryDate, book, memo, lines: payloadLines } });
      router.push(`/diario/${entry.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'No se pudo conectar con el servidor'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <PageHeader title="Nuevo asiento manual" subtitle="Debe en positivo, Haber en negativo internamente. Cada línea conserva su moneda original y la tasa aplicada." />
      {error && (
        <div className="mb-4">
          <Alert>
            {error.message}
            {error.issues && (
              <ul className="mt-1 list-disc pl-5">
                {error.issues.map((i) => (
                  <li key={i.path + i.message}>{i.path}: {i.message}</li>
                ))}
              </ul>
            )}
          </Alert>
        </div>
      )}
      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-4">
        <div>
          <label className="label" htmlFor="company">Empresa</label>
          <select id="company" className="input" value={companyId} onChange={(e) => setCompanyId(e.target.value)} required>
            {postable.map((c) => (
              <option key={c.id} value={c.id}>{c.code} · {c.legalName}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="date">Fecha</label>
          <DateInput id="date" value={entryDate} onChange={setEntryDate} required />
        </div>
        <div>
          <label className="label" htmlFor="book">Libro</label>
          <select id="book" className="input" value={book} onChange={(e) => setBook(e.target.value as typeof book)}>
            <option value="BASE">Común (Real y Fiscal)</option>
            <option value="REAL">Solo Real</option>
            <option value="FISCAL">Solo Fiscal</option>
          </select>
        </div>
        <div className="sm:col-span-4">
          <label className="label" htmlFor="memo">Descripción</label>
          <input id="memo" className="input" value={memo} onChange={(e) => setMemo(e.target.value)} required maxLength={500} />
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="table min-w-[1100px]">
          <thead>
            <tr>
              <th className="w-[28%]">Cuenta</th>
              <th>Moneda</th>
              <th className="num">Debe</th>
              <th className="num">Haber</th>
              <th className="num">Tasa (1 USD =)</th>
              <th className="num">USD</th>
              <th>Segmento</th>
              <th>Punto de venta</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const p = preview[i]!;
              const acc = accountById.get(l.accountId);
              return (
                <tr key={l.key}>
                  <td>
                    <AccountPicker
                      accounts={(accounts ?? []).filter((a) => a.active)}
                      value={l.accountId}
                      ariaLabel={`Cuenta línea ${i + 1}`}
                      onChange={(id, a) => update(l.key, { accountId: id, ...(a?.currencyLock ? { currency: a.currencyLock } : {}) })}
                    />
                  </td>
                  <td>
                    <select
                      className="input w-24"
                      aria-label={`Moneda línea ${i + 1}`}
                      value={l.currency}
                      disabled={!!acc?.currencyLock}
                      onChange={(e) => update(l.key, { currency: e.target.value, rate: '' })}
                    >
                      {(cur?.currencies ?? [{ code: 'USD' }]).map((c) => <option key={c.code}>{c.code}</option>)}
                    </select>
                  </td>
                  <td><input aria-label={`Debe línea ${i + 1}`} className="input num w-32" inputMode="decimal" value={l.debit} onChange={(e) => update(l.key, { debit: e.target.value, credit: '' })} /></td>
                  <td><input aria-label={`Haber línea ${i + 1}`} className="input num w-32" inputMode="decimal" value={l.credit} onChange={(e) => update(l.key, { credit: e.target.value, debit: '' })} /></td>
                  <td>
                    {l.currency === 'USD' ? (
                      <span className="num block text-gray-400">1</span>
                    ) : (
                      <input
                        className="input num w-32"
                        inputMode="decimal"
                        aria-label={`Tasa línea ${i + 1}`}
                        placeholder={typeof p.rate === 'string' ? `${formatNumber(p.rate, 4)} (${rateTypeOf(l)})` : rateTypeOf(l)}
                        value={l.rate}
                        onChange={(e) => update(l.key, { rate: e.target.value })}
                        title={p.rateError ?? undefined}
                      />
                    )}
                    {p.rateError && <div className="mt-0.5 max-w-40 text-xs text-red-700">{p.rateError}</div>}
                  </td>
                  <td className="num">{p.usd ? formatNumber(p.usd.toString(), 2) : ''}</td>
                  <td>
                    <select className="input w-32" aria-label={`Segmento línea ${i + 1}`} value={l.segmentId} onChange={(e) => update(l.key, { segmentId: e.target.value })}>
                      <option value="">—</option>
                      {segments?.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select className="input w-36" aria-label={`Punto de venta línea ${i + 1}`} value={l.posId} onChange={(e) => update(l.key, { posId: e.target.value })}>
                      <option value="">—</option>
                      {pos?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <button type="button" className="text-sm text-gray-400 hover:text-red-600" aria-label={`Quitar línea ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} disabled={lines.length <= 2}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <td colSpan={2}>
                <button type="button" className="btn-secondary" onClick={() => setLines((ls) => [...ls, emptyLine()])}>Añadir línea</button>
              </td>
              <td colSpan={3} className="text-right text-sm text-gray-600">Debe USD {formatNumber(debitUsd.toString())} · Haber USD {formatNumber(creditUsd.toString())}</td>
              <td className={`num ${diff.isZero() ? 'text-green-700' : 'text-red-700'}`}>{diff.isZero() ? 'Cuadra' : `Dif. ${formatNumber(diff.toString(), 4)}`}</td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Si la diferencia en USD es solo de redondeo por conversión (≤ 0,01 USD), el sistema añade automáticamente un ajuste a la cuenta de redondeo.
      </p>
      <div className="mt-4 flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy || !companyId}>{busy ? 'Contabilizando…' : 'Contabilizar'}</button>
        <button type="button" className="btn-secondary" onClick={() => router.back()}>Cancelar</button>
      </div>
    </form>
  );
}
