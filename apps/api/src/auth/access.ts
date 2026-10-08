import { ForbiddenException } from '@nestjs/common';
import { hasPermission, type Permission } from '@kaluch/shared';

/** Usuario autenticado con sus permisos por empresa (se carga en cada petición). */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  totpEnabled: boolean;
  /** companyId → permisos */
  permissions: Map<string, Set<string>>;
}

export function companiesWith(user: AuthUser, perm: Permission): string[] {
  return [...user.permissions.entries()].filter(([, p]) => hasPermission(p, perm)).map(([id]) => id);
}

export function can(user: AuthUser, perm: Permission, companyId?: string): boolean {
  if (companyId) return hasPermission(user.permissions.get(companyId) ?? [], perm);
  return companiesWith(user, perm).length > 0;
}

export function assertCan(user: AuthUser, perm: Permission, companyId?: string) {
  if (!can(user, perm, companyId)) {
    throw new ForbiddenException({
      code: 'FORBIDDEN',
      message: companyId ? 'No tienes permiso para esta acción en esta empresa' : 'No tienes permiso para esta acción',
    });
  }
}

/** Empresas sobre las que se ejecuta una consulta: la pedida (si hay permiso) o todas las permitidas. */
export function scopeCompanies(user: AuthUser, perm: Permission, companyId?: string): string[] {
  if (companyId) {
    assertCan(user, perm, companyId);
    return [companyId];
  }
  const all = companiesWith(user, perm);
  if (all.length === 0) assertCan(user, perm);
  return all;
}
