'use client';

import { formatDate, formatNumber, parseDateEs } from '@kaluch/shared';
import { useEffect, useState, type ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Importe en formato es-ES; negativos en rojo. */
export function Amount({ value, decimals = 2, muted }: { value: string | number | null | undefined; decimals?: number; muted?: boolean }) {
  if (value === null || value === undefined || value === '') return <span className="num" />;
  const negative = Number(value) < 0;
  const zero = Number(value) === 0;
  return (
    <span className={`num ${negative ? 'text-red-700' : zero || muted ? 'text-gray-400' : ''}`}>{formatNumber(String(value), decimals)}</span>
  );
}

export function DateText({ value }: { value: string | Date | null | undefined }) {
  return <span className="whitespace-nowrap tabular-nums">{formatDate(value ?? null)}</span>;
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'warning' | 'success' | 'info'; children: ReactNode }) {
  const cls = {
    error: 'border-red-200 bg-red-50 text-red-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    success: 'border-green-200 bg-green-50 text-green-800',
    info: 'border-brand-100 bg-brand-50 text-brand-900',
  }[kind];
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-sm ${cls}`}>
      {children}
    </div>
  );
}

export function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: 'gray' | 'green' | 'amber' | 'red' | 'blue' }) {
  const cls = {
    gray: 'bg-gray-100 text-gray-700',
    green: 'bg-green-100 text-green-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-800',
    blue: 'bg-brand-100 text-brand-700',
  }[tone];
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm text-gray-600">
      <span>
        {total === 0 ? 'Sin resultados' : `${formatNumber((page - 1) * pageSize + 1, 0)}–${formatNumber(Math.min(page * pageSize, total), 0)} de ${formatNumber(total, 0)}`}
      </span>
      <div className="flex gap-1">
        <button className="btn-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Anterior
        </button>
        <span className="px-2 py-1.5">
          {page} / {pages}
        </span>
        <button className="btn-secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Siguiente
        </button>
      </div>
    </div>
  );
}

/** Campo de fecha en formato dd/mm/aaaa. Valor interno: AAAA-MM-DD. */
export function DateInput({ value, onChange, id, required }: { value: string; onChange: (iso: string) => void; id?: string; required?: boolean }) {
  const [text, setText] = useState(formatDate(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(formatDate(value)), [value]);
  return (
    <input
      id={id}
      className={`input ${invalid ? 'border-red-400' : ''}`}
      placeholder="dd/mm/aaaa"
      inputMode="numeric"
      required={required}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (!text.trim()) {
          setInvalid(false);
          onChange('');
          return;
        }
        try {
          const iso = parseDateEs(text);
          setInvalid(false);
          onChange(iso);
          setText(formatDate(iso));
        } catch {
          setInvalid(true);
        }
      }}
      aria-invalid={invalid}
    />
  );
}

export function Spinner() {
  return <div className="py-8 text-center text-sm text-gray-500">Cargando…</div>;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
