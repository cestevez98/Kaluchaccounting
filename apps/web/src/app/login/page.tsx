'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ok?: boolean; requiresTotp?: boolean }>('/auth/login', {
        method: 'POST',
        json: { email, password, ...(needsTotp ? { totp } : {}) },
      });
      if (r.requiresTotp) {
        setNeedsTotp(true);
        return;
      }
      const next = params.get('next');
      window.location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Kaluch ERP</h1>
        <p className="text-sm text-gray-500">Accede con tu cuenta</p>
      </div>
      {error && <Alert>{error}</Alert>}
      <div>
        <label className="label" htmlFor="email">
          Correo electrónico
        </label>
        <input id="email" type="email" autoComplete="username" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
      <div>
        <label className="label" htmlFor="password">
          Contraseña
        </label>
        <input id="password" type="password" autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      {needsTotp && (
        <div>
          <label className="label" htmlFor="totp">
            Código de verificación (6 dígitos)
          </label>
          <input id="totp" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" className="input" value={totp} onChange={(e) => setTotp(e.target.value)} required autoFocus />
        </div>
      )}
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Accediendo…' : 'Acceder'}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-900/5 px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
