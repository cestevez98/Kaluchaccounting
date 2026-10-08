'use client';

import { Suspense, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

const MODULES = [
  { icon: '📊', label: 'Contabilidad de partida doble' },
  { icon: '🏦', label: 'Tesorería multimoneda' },
  { icon: '🌍', label: 'Cuba · Rep. Dominicana · España' },
  { icon: '🔒', label: 'Auditoría y verificación en dos pasos' },
];

function TotpBoxes({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  return (
    <div className="flex justify-between gap-2" onPaste={(e) => {
      const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6).split('');
      if (digits.length) {
        e.preventDefault();
        onChange([...digits, ...Array(6 - digits.length).fill('')]);
        refs.current[Math.min(digits.length, 5)]?.focus();
      }
    }}>
      {value.map((d, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          aria-label={`Dígito ${i + 1} del código`}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          className="input h-11 w-11 text-center text-lg font-semibold"
          value={d}
          autoFocus={i === 0}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(-1);
            const next = [...value];
            next[i] = v;
            onChange(next);
            if (v && i < 5) refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Backspace' && !value[i] && i > 0) refs.current[i - 1]?.focus();
          }}
        />
      ))}
    </div>
  );
}

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totp, setTotp] = useState<string[]>(Array(6).fill(''));
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const code = totp.join('');
      const r = await api<{ ok?: boolean; requiresTotp?: boolean }>('/auth/login', {
        method: 'POST',
        json: { email, password, ...(needsTotp ? { totp: code } : {}) },
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
    <form onSubmit={submit} className="w-full max-w-sm space-y-5">
      <div>
        <h2 className="text-xl font-bold text-ink">{needsTotp ? 'Verificación en dos pasos' : 'Iniciar sesión'}</h2>
        <p className="mt-1 text-[13px] text-muted">
          {needsTotp ? 'Introduce el código de 6 dígitos de tu app de autenticación.' : 'Accede con tu cuenta de Kaluch Group.'}
        </p>
      </div>
      {error && <Alert>{error}</Alert>}
      {!needsTotp ? (
        <>
          <div>
            <label className="label" htmlFor="email">Correo electrónico</label>
            <input id="email" type="email" autoComplete="username" className="input h-10" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="password">Contraseña</label>
            <div className="relative">
              <input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" className="input h-10 pr-16" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-brand-600" onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? 'Ocultar' : 'Mostrar'}
              </button>
            </div>
          </div>
        </>
      ) : (
        <TotpBoxes value={totp} onChange={setTotp} />
      )}
      <button type="submit" className="btn-primary h-10 w-full" disabled={busy || (needsTotp && totp.join('').length < 6)}>
        {busy ? 'Comprobando…' : needsTotp ? 'Verificar' : 'Acceder'}
      </button>
      {needsTotp && (
        <button type="button" className="w-full text-xs text-muted hover:underline" onClick={() => { setNeedsTotp(false); setTotp(Array(6).fill('')); }}>
          Volver
        </button>
      )}
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen bg-canvas">
      <div className="relative hidden w-96 shrink-0 flex-col justify-between overflow-hidden bg-brand-900 p-10 lg:flex">
        <div className="absolute inset-0 opacity-10">
          {Array.from({ length: 12 }, (_, i) => (
            <div
              key={i}
              className="absolute rounded-full border border-white/50"
              style={{ width: 60 + i * 30, height: 60 + i * 30, top: -10 + (i % 4) * 80, left: -20 + Math.floor(i / 4) * 120 }}
            />
          ))}
        </div>
        <div className="relative z-10">
          <div className="mb-12 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/15 font-bold text-white">K</span>
            <div>
              <div className="text-base leading-tight font-semibold text-white">Kaluch Group</div>
              <div className="text-xs text-white/55">Enterprise Resource Planning</div>
            </div>
          </div>
          <h1 className="mb-4 text-3xl leading-tight font-bold text-white">La gestión del grupo, en un solo lugar.</h1>
          <p className="text-sm text-white/65">Exportación, distribución y tesorería con contabilidad de partida doble y conciliación con el Excel.</p>
        </div>
        <ul className="relative z-10 space-y-3">
          {MODULES.map((m) => (
            <li key={m.label} className="flex items-center gap-3 text-sm text-white/80">
              <span className="flex h-8 w-8 items-center justify-center rounded bg-white/10">{m.icon}</span>
              {m.label}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-1 items-center justify-center px-6">
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
