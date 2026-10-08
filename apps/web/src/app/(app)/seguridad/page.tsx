'use client';

import { useState, type FormEvent } from 'react';
import { Alert, PageHeader } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function SecurityPage() {
  const { me } = useSession();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  async function enable(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/auth/totp/enable', { method: 'POST', json: { code } });
      setMsg({ kind: 'success', text: 'Verificación en dos pasos activada. La próxima vez se te pedirá el código.' });
      setSetup(null);
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Error' });
    }
  }

  return (
    <div className="max-w-xl">
      <PageHeader title="Seguridad" subtitle="Verificación en dos pasos (TOTP) con Google Authenticator, Microsoft Authenticator, 1Password…" />
      {msg && <div className="mb-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {me?.totpEnabled && !setup ? (
        <Alert kind="success">La verificación en dos pasos está activada.</Alert>
      ) : !setup ? (
        <button className="btn-primary" onClick={async () => setSetup(await api('/auth/totp/setup', { method: 'POST' }))}>
          Configurar verificación en dos pasos
        </button>
      ) : (
        <form onSubmit={enable} className="card space-y-3 p-4 text-sm">
          <p>1. En tu app de autenticación, añade una cuenta manualmente con esta clave:</p>
          <code className="block rounded bg-gray-100 px-3 py-2 font-mono text-base tracking-widest break-all">{setup.secret}</code>
          <p className="text-xs text-gray-500">O abre este enlace desde el móvil: <a className="break-all text-brand-600" href={setup.otpauthUrl}>{setup.otpauthUrl}</a></p>
          <p>2. Escribe el código de 6 dígitos que muestra la app:</p>
          <input className="input w-40 tracking-widest" inputMode="numeric" pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value)} required />
          <div><button className="btn-primary">Activar</button></div>
        </form>
      )}
    </div>
  );
}
