'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, PageHeader } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { PARTY_ROLE_LABELS, type PartyRole } from '@/lib/types';

export default function NewPartyPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'PERSON' | 'COMPANY'>('PERSON');
  const [roles, setRoles] = useState<PartyRole[]>([]);
  const [taxId, setTaxId] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api<{ id: string }>('/parties', { method: 'POST', json: { name, kind, roles, taxId: taxId || null, email: email || null, phone: phone || null, notes: notes || null } });
      router.push(`/terceros/${p.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <PageHeader title="Nueva contraparte" subtitle="Después podrás abrirle una o varias cuentas corrientes (por empresa y moneda)." />
      <form onSubmit={submit} className="card space-y-4 p-5">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="name">Nombre</label>
            <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="kind">Tipo</label>
            <select id="kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as 'PERSON')}>
              <option value="PERSON">Persona</option>
              <option value="COMPANY">Empresa</option>
            </select>
          </div>
        </div>
        <fieldset>
          <legend className="label">Roles</legend>
          <div className="flex flex-wrap gap-3">
            {(Object.entries(PARTY_ROLE_LABELS) as [PartyRole, string][]).map(([k, v]) => (
              <label key={k} className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={roles.includes(k)} onChange={(e) => setRoles(e.target.checked ? [...roles, k] : roles.filter((r) => r !== k))} /> {v}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-3">
          <div><label className="label" htmlFor="tax">NIF / identificación</label><input id="tax" className="input" value={taxId} onChange={(e) => setTaxId(e.target.value)} /></div>
          <div><label className="label" htmlFor="email">Correo</label><input id="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div><label className="label" htmlFor="phone">Teléfono</label><input id="phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
        </div>
        <div><label className="label" htmlFor="notes">Notas</label><textarea id="notes" className="input min-h-20" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <button className="btn-primary" disabled={busy}>{busy ? 'Guardando…' : 'Crear contraparte'}</button>
      </form>
    </div>
  );
}
