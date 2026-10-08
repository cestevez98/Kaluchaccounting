'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApi } from './api';

export interface MeCompany {
  id: string;
  code: string;
  legalName: string;
  kind: string;
  roles: string[];
  permissions: string[];
}

export interface Me {
  id: string;
  email: string;
  name: string;
  totpEnabled: boolean;
  requires2fa: boolean;
  companies: MeCompany[];
}

interface SessionCtx {
  me: Me | null;
  /** Empresa seleccionada; null = Grupo consolidado. */
  companyId: string | null;
  setCompanyId: (id: string | null) => void;
  can: (permission: string, companyId?: string | null) => boolean;
}

const Ctx = createContext<SessionCtx | null>(null);
const STORAGE_KEY = 'kaluch.company';

export function SessionProvider({ children }: { children: ReactNode }) {
  const { data: me } = useApi<Me>('/auth/me');
  const [companyId, setCompanyIdState] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setCompanyIdState(saved);
    } catch {
      /* almacenamiento no disponible */
    }
  }, []);

  useEffect(() => {
    if (me && companyId && !me.companies.some((c) => c.id === companyId)) setCompanyIdState(null);
  }, [me, companyId]);

  const value = useMemo<SessionCtx>(
    () => ({
      me,
      companyId,
      setCompanyId: (id) => {
        setCompanyIdState(id);
        try {
          if (id) localStorage.setItem(STORAGE_KEY, id);
          else localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* almacenamiento no disponible */
        }
      },
      can: (permission, cid) => {
        if (!me) return false;
        const list = cid ? me.companies.filter((c) => c.id === cid) : me.companies;
        return list.some((c) => c.permissions.includes('*') || c.permissions.includes(permission));
      },
    }),
    [me, companyId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession fuera de SessionProvider');
  return c;
}
