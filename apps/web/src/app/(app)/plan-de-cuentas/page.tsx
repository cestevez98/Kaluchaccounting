'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Alert, Badge, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CLASS_LABEL, type Account } from '@/lib/types';

const NATURE_LABEL = { DEUDORA: 'Deudora', ACREEDORA: 'Acreedora', MIXTA: 'Mixta' } as const;

function NewSubaccount({ parent, onDone }: { parent: Account; onDone: () => void }) {
  const [subcode, setSubcode] = useState('');
  const [name, setName] = useState('');
  const [currencyLock, setCurrencyLock] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/accounts', {
        method: 'POST',
        json: {
          parentId: parent.id, code: parent.code, subcode, name, nature: parent.nature, classification: parent.classification,
          postable: true, currencyLock: currencyLock || null, revalRateType: null,
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error');
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 bg-brand-50 px-3 py-2">
      <div><label className="label">Subcuenta de {parent.code}</label><input className="input w-28" value={subcode} onChange={(e) => setSubcode(e.target.value)} placeholder="0001" required pattern="\d{1,6}" /></div>
      <div className="min-w-64 flex-1"><label className="label">Nombre</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></div>
      <div><label className="label">Moneda fija</label>
        <select className="input" value={currencyLock} onChange={(e) => setCurrencyLock(e.target.value)}>
          <option value="">Cualquiera</option>
          {['USD', 'CUP', 'MLC', 'EUR', 'DOP', 'CAD', 'GBP'].map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      <button className="btn-primary">Crear</button>
      <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
      {error && <div className="w-full"><Alert>{error}</Alert></div>}
    </form>
  );
}

export default function ChartOfAccountsPage() {
  const { can } = useSession();
  const { data, error, loading, reload } = useApi<Account[]>('/accounts');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const canManage = can('accounts:manage');

  const children = useMemo(() => {
    const m = new Map<string | null, Account[]>();
    for (const a of data ?? []) m.set(a.parentId, [...(m.get(a.parentId) ?? []), a]);
    return m;
  }, [data]);

  const filter = q.trim().toLowerCase();
  const matches = (a: Account) => !filter || a.displayCode.startsWith(filter) || a.name.toLowerCase().includes(filter);
  const visible = (a: Account): boolean => matches(a) || (children.get(a.id) ?? []).some(visible);

  async function toggleActive(a: Account) {
    await api(`/accounts/${a.id}`, { method: 'PATCH', json: { active: !a.active } });
    void reload();
  }

  function renderRows(parent: string | null, level: number): React.ReactNode[] {
    return (children.get(parent) ?? []).filter(visible).flatMap((a) => {
      const kids = children.get(a.id) ?? [];
      const isOpen = open.has(a.id) || !!filter;
      return [
        <tr key={a.id} className={a.active ? '' : 'text-gray-400'}>
          <td className="font-mono text-xs whitespace-nowrap" style={{ paddingLeft: `${0.75 + level * 1.5}rem` }}>
            {kids.length > 0 ? (
              <button
                className="mr-1 w-4 text-gray-500"
                aria-label={isOpen ? 'Contraer' : 'Expandir'}
                onClick={() => setOpen((s) => { const n = new Set(s); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n; })}
              >
                {isOpen ? '▾' : '▸'}
              </button>
            ) : <span className="mr-1 inline-block w-4" />}
            {a.displayCode}
          </td>
          <td className={a.postable ? '' : 'font-semibold'}>
            {a.name}
            {a.anomaly && <span className="ml-2" title={a.anomaly}><Badge tone="amber">anomalía</Badge></span>}
            {!a.active && <span className="ml-2"><Badge>inactiva</Badge></span>}
          </td>
          <td>{NATURE_LABEL[a.nature]}</td>
          <td>{a.classification} <span className="text-xs text-gray-500">({CLASS_LABEL[a.classification]})</span></td>
          <td>{a.postable ? 'Detalle' : 'Grupo'}</td>
          <td>{a.currencyLock ?? ''}</td>
          <td>{a.revalRateType ?? ''}</td>
          <td className="text-xs text-gray-500" title={a.anomaly ?? ''}>{a.anomaly ? a.anomaly.slice(0, 60) : ''}</td>
          <td className="whitespace-nowrap">
            {canManage && !a.subcode && (
              <button className="text-xs text-brand-600 hover:underline" onClick={() => setAdding(a.id)}>+ subcuenta</button>
            )}
            {canManage && a.postable && (
              <button className="ml-2 text-xs text-gray-500 hover:underline" onClick={() => toggleActive(a)}>{a.active ? 'desactivar' : 'activar'}</button>
            )}
          </td>
        </tr>,
        ...(adding === a.id
          ? [<tr key={`${a.id}-new`}><td colSpan={9} className="p-0"><NewSubaccount parent={a} onDone={() => { setAdding(null); setOpen((s) => new Set(s).add(a.id)); void reload(); }} /></td></tr>]
          : []),
        ...(isOpen ? renderRows(a.id, level + 1) : []),
      ];
    });
  }

  return (
    <div>
      <PageHeader
        title="Plan de cuentas"
        subtitle={`${data?.length ?? 0} cuentas · cuenta (3–4 dígitos) + subcuenta · las anomalías vienen del Excel y se corrigen después de migrar`}
        actions={
          <>
            <button className="btn-secondary" onClick={() => setOpen(new Set((data ?? []).map((a) => a.id)))}>Expandir todo</button>
            <button className="btn-secondary" onClick={() => setOpen(new Set())}>Contraer</button>
          </>
        }
      />
      <div className="mb-3 max-w-md">
        <input className="input" placeholder="Buscar por código o nombre" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <Alert>{error.message}</Alert>}
      <div className="card max-h-[75vh] overflow-auto">
        <table className="table">
          <thead>
            <tr><th>Código</th><th>Descripción</th><th>Naturaleza</th><th>Clasificación</th><th>Tipo</th><th>Moneda</th><th>Tasa reval.</th><th>Observaciones</th><th /></tr>
          </thead>
          <tbody>{renderRows(null, 0)}</tbody>
        </table>
        {loading && !data && <Spinner />}
      </div>
    </div>
  );
}
