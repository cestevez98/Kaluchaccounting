'use client';

import { formatNumber, money } from '@kaluch/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { CompanySelect, Kpi } from '@/components/sales';
import { Alert, Amount, Badge, DateText, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CONTAINER_STATUS, type ContainerRow } from '@/lib/types';

export default function ContainersPage() {
  const { companyId, can } = useSession();
  const { data, error, loading, reload } = useApi<ContainerRow[]>(`/sales/containers${qs({ companyId })}`);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ companyId: companyId ?? '', code: '', description: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const sum = (k: keyof ContainerRow) => (data ?? []).reduce((s, c) => s.plus(money(String(c[k]))), money(0)).toFixed(4);

  async function create(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/sales/containers', { method: 'POST', json: form });
      setForm({ ...form, code: '', description: '' });
      setShow(false);
      await reload();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Error');
    }
  }

  return (
    <div>
      <PageHeader
        title="Contenedores"
        subtitle="Cada contenedor es un lote: sus costos (en tránsito, 181.9991), la recepción en almacén (181.9990) repartida por producto, las ventas con su costo identificado y la utilidad para los inversionistas."
        actions={can('inventory:operate') ? <button className="btn-primary" onClick={() => setShow(!show)}>Nuevo contenedor</button> : null}
      />
      {show && (
        <form onSubmit={create} className="card mb-4 grid gap-3 p-4 sm:grid-cols-4">
          {msg && <div className="sm:col-span-4"><Alert>{msg}</Alert></div>}
          <div><label className="label" htmlFor="co">Empresa</label><CompanySelect id="co" value={form.companyId} onChange={(v) => setForm({ ...form, companyId: v })} perm="inventory:operate" /></div>
          <div><label className="label" htmlFor="code">Código</label><input id="code" className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required placeholder="CONT-2026-07" /></div>
          <div><label className="label" htmlFor="desc">Descripción</label><input id="desc" className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div className="flex items-end"><button className="btn-primary" disabled={!form.companyId || !form.code}>Crear</button></div>
        </form>
      )}
      {error && <Alert>{error.message}</Alert>}
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Kpi label="Costo total de contenedores" value={data ? sum('totalCostUsd') : '…'} />
        <Kpi label="Ventas" value={data ? sum('revenueUsd') : '…'} />
        <Kpi label="Utilidad" value={data ? sum('utilityUsd') : '…'} tone="ok" />
        <Kpi label="Existencias (valor)" value={data ? sum('stockUsd') : '…'} />
      </div>
      <div className="card overflow-x-auto">
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Contenedor</th><th>Estado</th><th className="num">Costo total</th><th className="num">Ventas</th><th className="num">Costo de ventas</th><th className="num">Comisiones + ONAT</th><th className="num">Utilidad</th><th className="num">Margen</th><th className="num">Existencias</th></tr></thead>
            <tbody>
              {data?.map((c) => (
                <tr key={c.id}>
                  <td><Link className="font-semibold hover:underline" href={`/inventario/${c.id}`}>{c.code}</Link><div className="text-[10px] text-subtle">{c.description}{c.arrivalDate ? <> · recibido <DateText value={c.arrivalDate} /></> : null}</div></td>
                  <td><Badge tone={CONTAINER_STATUS[c.status].tone}>{CONTAINER_STATUS[c.status].label}</Badge></td>
                  <td className="num"><Amount value={c.totalCostUsd} /></td>
                  <td className="num"><Amount value={c.revenueUsd} /></td>
                  <td className="num"><Amount value={c.costOfSalesUsd} muted /></td>
                  <td className="num"><Amount value={money(c.commissionUsd).plus(money(c.onatUsd)).toFixed(4)} muted /></td>
                  <td className="num font-semibold"><Amount value={c.utilityUsd} /></td>
                  <td className="num">{c.marginPct === null ? '' : `${formatNumber(c.marginPct)} %`}</td>
                  <td className="num"><Amount value={c.stockUsd} muted /><div className="text-[10px] text-subtle">{formatNumber(c.stockQuantity, 0)} u</div></td>
                </tr>
              ))}
              {data?.length === 0 && <tr><td colSpan={9} className="py-6 text-center text-muted">No hay contenedores.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
