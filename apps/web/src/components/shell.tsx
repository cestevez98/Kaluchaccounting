'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

const NAV: { href: string; label: string; perm?: string }[] = [
  { href: '/', label: 'Inicio' },
  { href: '/diario', label: 'Libro diario', perm: 'ledger:read' },
  { href: '/mayor', label: 'Libro mayor', perm: 'ledger:read' },
  { href: '/balance', label: 'Balance de comprobación', perm: 'reports:financial' },
  { href: '/plan-de-cuentas', label: 'Plan de cuentas', perm: 'accounts:read' },
  { href: '/tasas', label: 'Tasas de cambio', perm: 'fx:read' },
  { href: '/periodos', label: 'Periodos', perm: 'period:read' },
  { href: '/auditoria', label: 'Auditoría', perm: 'audit:read' },
];

export function CompanySelector() {
  const { me, companyId, setCompanyId } = useSession();
  if (!me) return null;
  return (
    <select
      aria-label="Empresa"
      className="input max-w-64 bg-white"
      value={companyId ?? ''}
      onChange={(e) => setCompanyId(e.target.value || null)}
    >
      <option value="">Grupo consolidado</option>
      {me.companies.map((c) => (
        <option key={c.id} value={c.id}>
          {c.code} · {c.legalName}
        </option>
      ))}
    </select>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { me, can } = useSession();
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col bg-brand-900 text-white md:flex">
        <div className="px-5 py-5">
          <div className="text-lg font-semibold tracking-tight">Kaluch ERP</div>
          <div className="text-xs text-brand-100/80">Grupo Kaluch</div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.filter((n) => !n.perm || can(n.perm)).map((n) => {
            const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`block rounded-md px-3 py-2 text-sm ${active ? 'bg-white/15 font-medium' : 'text-brand-100 hover:bg-white/10'}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-white/10 px-5 py-4 text-xs text-brand-100/80">Fase 1 · Motor contable</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 py-2.5 md:px-6">
          <CompanySelector />
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-gray-600 sm:inline">{me?.name}</span>
            <button
              className="btn-secondary"
              onClick={async () => {
                await api('/auth/logout', { method: 'POST' });
                window.location.href = '/login';
              }}
            >
              Salir
            </button>
          </div>
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b border-gray-200 bg-white px-2 py-1.5 md:hidden">
          {NAV.filter((n) => !n.perm || can(n.perm)).map((n) => (
            <Link key={n.href} href={n.href} className="shrink-0 rounded px-2 py-1 text-xs text-gray-700 hover:bg-gray-100">
              {n.label}
            </Link>
          ))}
        </nav>
        <main className="min-w-0 flex-1 px-4 py-5 md:px-6">{children}</main>
      </div>
    </div>
  );
}
