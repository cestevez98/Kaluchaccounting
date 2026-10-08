'use client';

import { useEffect, useId, useState } from 'react';
import type { Account } from '@/lib/types';

const label = (a: Account) => `${a.displayCode} · ${a.name}`;

/** Selector de cuenta con búsqueda por código o nombre. */
export function AccountPicker({
  accounts,
  value,
  onChange,
  placeholder = 'Código o nombre de cuenta',
  ariaLabel = 'Cuenta',
}: {
  accounts: Account[];
  value: string;
  onChange: (id: string, account: Account | null) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const listId = useId();
  const selected = accounts.find((a) => a.id === value) ?? null;
  const [text, setText] = useState(selected ? label(selected) : '');
  useEffect(() => setText(selected ? label(selected) : ''), [selected]);

  return (
    <>
      <input
        className="input min-w-72"
        list={listId}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const match = accounts.find((a) => label(a) === e.target.value);
          if (match) onChange(match.id, match);
          else if (!e.target.value) onChange('', null);
        }}
        onBlur={() => {
          if (!accounts.some((a) => label(a) === text)) {
            // Permite escribir solo el código ("101.0001").
            const byCode = accounts.find((a) => a.displayCode === text.trim());
            if (byCode) onChange(byCode.id, byCode);
            else setText(selected ? label(selected) : '');
          }
        }}
      />
      <datalist id={listId}>
        {accounts.map((a) => (
          <option key={a.id} value={label(a)} />
        ))}
      </datalist>
    </>
  );
}
