'use client';

import { Fragment, useState, type FormEvent } from 'react';
import { Alert, Badge, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';

interface User {
  id: string; email: string; name: string; active: boolean; totpEnabled: boolean; lastLoginAt: string | null;
  companyRoles: { companyId: string; roleId: string; company: { code: string }; role: { name: string } }[];
}
interface Role { id: string; name: string; description: string; requires2fa: boolean; system: boolean; permissions: string[] }
interface Company { id: string; code: string; legalName: string }

/** Asignación de un rol por empresa (vacío = sin acceso a esa empresa). */
function AssignmentEditor({ companies, roles, value, onChange }: { companies: Company[]; roles: Role[]; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {companies.map((c) => (
        <div key={c.id}>
          <label className="label">{c.code}</label>
          <select className="input" value={value[c.id] ?? ''} onChange={(e) => onChange({ ...value, [c.id]: e.target.value })} aria-label={`Rol en ${c.code}`}>
            <option value="">Sin acceso</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}

const toAssignments = (v: Record<string, string>) => Object.entries(v).filter(([, r]) => r).map(([companyId, roleId]) => ({ companyId, roleId }));

export default function UsersPage() {
  const { me } = useSession();
  const { data: users, error, loading, reload } = useApi<User[]>('/admin/users');
  const { data: rolesData } = useApi<{ roles: Role[]; catalog: Record<string, string> }>('/admin/roles');
  const { data: companies } = useApi<Company[]>('/companies');
  const roles = rolesData?.roles ?? [];
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ email: '', name: '', password: '' });
  const [newAssign, setNewAssign] = useState<Record<string, string>>({});

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'success', text: ok });
      void reload();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? `${e.message}${e.issues ? ': ' + e.issues.map((i) => i.message).join(', ') : ''}` : 'Error' });
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    await run(() => api('/admin/users', { method: 'POST', json: { ...form, assignments: toAssignments(newAssign) } }), `Usuario ${form.email} creado`);
    setForm({ email: '', name: '', password: '' });
    setNewAssign({});
  }

  return (
    <div>
      <PageHeader title="Usuarios y roles" subtitle="Cada usuario tiene un rol por empresa. Los roles con 2FA obligatorio no pueden operar hasta activarla." />
      {msg && <div className="mb-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {error && <Alert>{error.message}</Alert>}
      <div className="card mb-6 overflow-x-auto">
        <table className="table">
          <thead><tr><th>Nombre</th><th>Correo</th><th>Roles por empresa</th><th>2FA</th><th>Último acceso</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {users?.map((u) => (
              <Fragment key={u.id}>
                <tr>
                  <td className="font-medium">{u.name}</td>
                  <td>{u.email}</td>
                  <td className="text-xs">{u.companyRoles.map((cr) => `${cr.company.code}: ${cr.role.name}`).join(' · ') || <span className="text-gray-400">sin acceso</span>}</td>
                  <td>{u.totpEnabled ? <Badge tone="green">activa</Badge> : <Badge>no</Badge>}</td>
                  <td className="text-xs">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('es-ES') : '—'}</td>
                  <td>{u.active ? <Badge tone="green">activo</Badge> : <Badge tone="red">desactivado</Badge>}</td>
                  <td className="space-x-2 text-xs whitespace-nowrap">
                    <button className="text-brand-600 hover:underline" onClick={() => { setEditing(editing === u.id ? null : u.id); setAssign(Object.fromEntries(u.companyRoles.map((cr) => [cr.companyId, cr.roleId]))); }}>roles</button>
                    {u.id !== me?.id && <button className="text-gray-600 hover:underline" onClick={() => run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', json: { active: !u.active } }), u.active ? 'Usuario desactivado' : 'Usuario activado')}>{u.active ? 'desactivar' : 'activar'}</button>}
                    <button className="text-gray-600 hover:underline" onClick={() => {
                      const p = prompt(`Nueva contraseña para ${u.email} (mínimo 12 caracteres):`);
                      if (p) void run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', json: { password: p } }), 'Contraseña cambiada');
                    }}>contraseña</button>
                    {u.totpEnabled && <button className="text-gray-600 hover:underline" onClick={() => confirm(`¿Restablecer la 2FA de ${u.email}? Tendrá que configurarla de nuevo.`) && run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', json: { resetTotp: true } }), '2FA restablecida')}>reset 2FA</button>}
                  </td>
                </tr>
                {editing === u.id && companies && (
                  <tr key={`${u.id}-edit`}>
                    <td colSpan={7} className="bg-brand-50/50">
                      <AssignmentEditor companies={companies} roles={roles} value={assign} onChange={setAssign} />
                      <button className="btn-primary mt-2" onClick={() => run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', json: { assignments: toAssignments(assign) } }), 'Roles actualizados').then(() => setEditing(null))}>Guardar roles</button>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {loading && !users && <Spinner />}
      </div>

      <form onSubmit={create} className="card mb-6 space-y-3 p-4">
        <div className="font-medium">Nuevo usuario</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div><label className="label" htmlFor="u-name">Nombre</label><input id="u-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
          <div><label className="label" htmlFor="u-email">Correo</label><input id="u-email" type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></div>
          <div><label className="label" htmlFor="u-pass">Contraseña inicial (≥ 12)</label><input id="u-pass" type="password" className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={12} /></div>
        </div>
        {companies && <AssignmentEditor companies={companies} roles={roles} value={newAssign} onChange={setNewAssign} />}
        <button className="btn-primary">Crear usuario</button>
      </form>

      <h2 className="mb-2 text-base font-semibold">Roles</h2>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Rol</th><th>Descripción</th><th>2FA</th><th>Permisos</th></tr></thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id}>
                <td className="font-medium">{r.name}</td>
                <td className="text-sm">{r.description}</td>
                <td>{r.requires2fa ? <Badge tone="amber">obligatoria</Badge> : ''}</td>
                <td className="text-xs text-gray-600">{r.permissions.includes('*') ? 'Todos' : r.permissions.map((p) => rolesData?.catalog[p] ?? p).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
