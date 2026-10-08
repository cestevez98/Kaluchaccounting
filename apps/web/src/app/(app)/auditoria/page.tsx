'use client';

import { useState } from 'react';
import { Alert, Badge, PageHeader, Pagination, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import type { Paged } from '@/lib/types';

interface Log {
  id: string; tableName: string; recordId: string; action: string; at: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  user: { name: string; email: string } | null;
}

const TABLES: Record<string, string> = {
  journal_entry: 'Asientos', account: 'Plan de cuentas', exchange_rate: 'Tasas', fiscal_period: 'Periodos',
  app_user: 'Usuarios', role: 'Roles', role_permission: 'Permisos', user_company_role: 'Asignaciones',
  company: 'Empresas', segment: 'Segmentos', dimension_value: 'Dimensiones', account_mapping: 'Mapeos', parameter_version: 'Parámetros',
};

function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  if (!before) return 'creado';
  if (!after) return 'eliminado';
  return Object.keys(after)
    .filter((k) => !['updated_at'].includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => `${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`)
    .join(' · ');
}

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [table, setTable] = useState('');
  const { data, error, loading } = useApi<Paged<Log>>(`/audit${qs({ page, pageSize: 50, table })}`);
  return (
    <div>
      <PageHeader title="Auditoría" subtitle="Quién creó o modificó qué y cuándo. El registro no se puede modificar." />
      <div className="mb-3 max-w-xs">
        <select className="input" value={table} onChange={(e) => { setTable(e.target.value); setPage(1); }}>
          <option value="">Todas las tablas</option>
          {Object.entries(TABLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {error && <Alert>{error.message}</Alert>}
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Fecha y hora</th><th>Usuario</th><th>Tabla</th><th>Acción</th><th>Cambios</th></tr></thead>
          <tbody>
            {data?.items.map((l) => (
              <tr key={l.id}>
                <td className="whitespace-nowrap">{new Date(l.at).toLocaleString('es-ES')}</td>
                <td>{l.user?.name ?? <span className="text-gray-400">sistema</span>}</td>
                <td>{TABLES[l.tableName] ?? l.tableName}</td>
                <td><Badge tone={l.action === 'INSERT' ? 'green' : l.action === 'DELETE' ? 'red' : 'blue'}>{l.action}</Badge></td>
                <td className="max-w-xl truncate text-xs text-gray-600" title={diff(l.before, l.after)}>{diff(l.before, l.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && !data && <Spinner />}
        {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </div>
    </div>
  );
}
