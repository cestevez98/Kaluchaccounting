'use client';

import { formatNumber, parseNumberEs } from '@kaluch/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert, DateInput, PageHeader, today } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CATEGORY_KIND_LABEL, type CashCategory, type TreasuryAccount } from '@/lib/types';

type Kind = 'MOVEMENT' | 'EXCHANGE' | 'TRANSFER';

export default function NewMovementPage() {
  const router = useRouter();
  const { me, can, companyId: selected } = useSession();
  const companies = me?.companies.filter((c) => can('cash:operate', c.id)) ?? [];
  const [companyId, setCompanyId] = useState('');
  useEffect(() => {
    if (!companyId && companies.length) setCompanyId(companies.find((c) => c.id === selected)?.id ?? companies[0]!.id);
  }, [companies, companyId, selected]);
  const { data: accounts } = useApi<TreasuryAccount[]>(companyId ? `/treasury/accounts${qs({ companyId })}` : null);
  const { data: categories } = useApi<CashCategory[]>('/treasury/categories');

  const [kind, setKind] = useState<Kind>('MOVEMENT');
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [direction, setDirection] = useState<'IN' | 'OUT'>('IN');
  const [account1, setAccount1] = useState('');
  const [amount1, setAmount1] = useState('');
  const [account2, setAccount2] = useState('');
  const [amount2, setAmount2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const visibleCategories = useMemo(
    () => (categories ?? []).filter((c) => (kind === 'MOVEMENT' ? !['EXCHANGE', 'TRANSFER'].includes(c.kind) : c.kind === kind)),
    [categories, kind],
  );
  const acc = (id: string) => accounts?.find((a) => a.id === id);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let legs;
    try {
      if (kind === 'MOVEMENT') {
        const a = parseNumberEs(amount1);
        legs = [{ treasuryAccountId: account1, amount: direction === 'IN' ? a : `-${a}` }];
      } else {
        legs = [
          { treasuryAccountId: account1, amount: `-${parseNumberEs(amount1)}` },
          { treasuryAccountId: account2, amount: parseNumberEs(amount2) },
        ];
      }
    } catch {
      setError('Revisa los importes (formato 1.234,56)');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ id: string }>('/treasury/movements', {
        method: 'POST',
        json: { companyId, date, kind, description, categoryId: categoryId || null, legs },
      });
      router.push(`/tesoreria/movimientos/${r.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor');
    } finally {
      setBusy(false);
    }
  }

  const accountSelect = (value: string, onChange: (v: string) => void, label: string, exclude?: string) => (
    <div>
      <label className="label">{label}</label>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)} required aria-label={label}>
        <option value="">Elige una cuenta…</option>
        {accounts?.filter((a) => a.id !== exclude).map((a) => (
          <option key={a.id} value={a.id}>{a.name} · {a.currency} (saldo {formatNumber(a.balance)})</option>
        ))}
      </select>
    </div>
  );

  return (
    <form onSubmit={submit} className="max-w-3xl">
      <PageHeader title="Nuevo movimiento de tesorería" subtitle="Se contabiliza automáticamente con la tasa del día de cada cuenta." />
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      <div className="card space-y-4 p-4">
        <div className="flex gap-2" role="tablist">
          {(['MOVEMENT', 'EXCHANGE', 'TRANSFER'] as Kind[]).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'btn-primary' : 'btn-secondary'} onClick={() => { setKind(k); setCategoryId(''); }}>
              {k === 'MOVEMENT' ? 'Entrada / salida' : k === 'EXCHANGE' ? 'Cambio de moneda' : 'Traspaso entre cuentas'}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="mv-company">Empresa</label>
            <select id="mv-company" className="input" value={companyId} onChange={(e) => { setCompanyId(e.target.value); setAccount1(''); setAccount2(''); }}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.legalName}</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="mv-date">Fecha</label><DateInput id="mv-date" value={date} onChange={setDate} required /></div>
          <div>
            <label className="label" htmlFor="mv-cat">Categoría</label>
            <select id="mv-cat" className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{kind === 'MOVEMENT' ? 'Sin clasificar (va a la bandeja)' : '—'}</option>
              {visibleCategories.map((c) => <option key={c.id} value={c.id}>{c.name} · {CATEGORY_KIND_LABEL[c.kind]}{c.account ? '' : ' (sin cuenta)'}</option>)}
            </select>
          </div>
        </div>
        <div><label className="label" htmlFor="mv-desc">Concepto</label><input id="mv-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={480} /></div>

        {kind === 'MOVEMENT' ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {accountSelect(account1, setAccount1, 'Cuenta')}
            <div>
              <label className="label" htmlFor="mv-direction">Tipo</label>
              <select id="mv-direction" className="input" value={direction} onChange={(e) => setDirection(e.target.value as 'IN' | 'OUT')}>
                <option value="IN">Entrada (cobro)</option>
                <option value="OUT">Salida (pago)</option>
              </select>
            </div>
            <div><label className="label" htmlFor="mv-amount">Importe {acc(account1)?.currency ?? ''}</label><input id="mv-amount" className="input num" inputMode="decimal" value={amount1} onChange={(e) => setAmount1(e.target.value)} required /></div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {accountSelect(account1, setAccount1, 'Sale de')}
            <div><label className="label" htmlFor="mv-out">Importe que sale {acc(account1)?.currency ?? ''}</label><input id="mv-out" className="input num" inputMode="decimal" value={amount1} onChange={(e) => setAmount1(e.target.value)} required /></div>
            {accountSelect(account2, setAccount2, 'Entra en', account1)}
            <div><label className="label" htmlFor="mv-in">Importe que entra {acc(account2)?.currency ?? ''}</label><input id="mv-in" className="input num" inputMode="decimal" value={amount2} onChange={(e) => setAmount2(e.target.value)} required /></div>
            <p className="text-xs text-gray-500 sm:col-span-2">
              La diferencia entre lo que sale y lo que entra, valorado en USD a la tasa del día, se registra como
              {kind === 'EXCHANGE' ? ' diferencia de cambio (Cambios, 845/924).' : ' diferencia de cambio de traspasos (845/924). Si es una comisión, clasifícala después.'}
            </p>
          </div>
        )}
      </div>
      <div className="mt-4 flex gap-2">
        <button className="btn-primary" disabled={busy || !companyId}>{busy ? 'Contabilizando…' : 'Contabilizar'}</button>
        <button type="button" className="btn-secondary" onClick={() => router.back()}>Cancelar</button>
      </div>
    </form>
  );
}
