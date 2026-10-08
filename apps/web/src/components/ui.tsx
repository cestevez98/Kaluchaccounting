'use client';

import { formatDate, formatNumber, parseDateEs } from '@kaluch/shared';
import { useEffect, useState, type ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-bold text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
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
    <span className={`num ${negative ? 'text-bad' : zero || muted ? 'text-subtle' : ''}`}>{formatNumber(String(value), decimals)}</span>
  );
}

export function DateText({ value }: { value: string | Date | null | undefined }) {
  return <span className="whitespace-nowrap tabular-nums">{formatDate(value ?? null)}</span>;
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'warning' | 'success' | 'info'; children: ReactNode }) {
  const cls = {
    error: 'border-bad/20 bg-bad-bg text-bad',
    warning: 'border-warn/20 bg-warn-bg text-[#8a5f00]',
    success: 'border-ok/20 bg-ok-bg text-ok',
    info: 'border-brand-100 bg-brand-50 text-brand-600',
  }[kind];
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-[13px] ${cls}`}>
      {children}
    </div>
  );
}

export function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: 'gray' | 'green' | 'amber' | 'red' | 'blue' }) {
  const cls = {
    gray: 'bg-gray-100 text-muted',
    green: 'bg-ok-bg text-ok',
    amber: 'bg-warn-bg text-warn',
    red: 'bg-bad-bg text-bad',
    blue: 'bg-brand-100 text-brand-600',
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${cls}`}>{children}</span>;
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2 text-xs text-muted">
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
  return <div className="py-8 text-center text-xs text-muted">Cargando…</div>;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
