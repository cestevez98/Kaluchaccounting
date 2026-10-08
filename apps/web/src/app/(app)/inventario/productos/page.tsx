'use client';

import { formatNumber } from '@kaluch/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert, Amount, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { ProductRow } from '@/lib/types';

export default function ProductsPage() {
  const { can } = useSession();
  const { data, error, loading, reload } = useApi<ProductRow[]>('/sales/products');
  const [form, setForm] = useState({ code: '', name: '', unit: 'u' });
  const [msg, setMsg] = useState<string | null>(null);
  async function create(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/sales/products', { method: 'POST', json: form });
      setForm({ code: '', name: '', unit: form.unit });
      await reload();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Error');
    }
  }
  return (
    <div className="max-w-4xl">
      <PageHeader title="Productos" subtitle="Catálogo de productos de distribución con sus existencias en almacén (todas las empresas visibles)." />
      {can('inventory:operate') && (
        <form onSubmit={create} className="card mb-4 grid gap-3 p-4 sm:grid-cols-4">
          {msg && <div className="sm:col-span-4"><Alert>{msg}</Alert></div>}
          <div><label className="label" htmlFor="code">Código</label><input id="code" className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></div>
          <div><label className="label" htmlFor="name">Nombre</label><input id="name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
          <div><label className="label" htmlFor="unit">Unidad</label><input id="unit" className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} required /></div>
          <div className="flex items-end"><button className="btn-primary">Añadir producto</button></div>
        </form>
      )}
      {error && <Alert>{error.message}</Alert>}
      <div className="card overflow-x-auto">
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Código</th><th>Producto</th><th>Unidad</th><th className="num">Existencias</th><th className="num">Valor</th></tr></thead>
            <tbody>
              {data?.map((p) => (
                <tr key={p.id}>
                  <td className="font-mono text-xs">{p.code}</td>
                  <td><Link className="hover:underline" href={`/inventario/kardex/${p.id}`}>{p.name}</Link></td>
                  <td>{p.unit}</td>
                  <td className="num">{formatNumber(p.stockQuantity, 0)}</td>
                  <td className="num"><Amount value={p.stockUsd} /></td>
                </tr>
              ))}
              {data?.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-muted">No hay productos.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
