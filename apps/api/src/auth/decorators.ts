import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@kaluch/shared';
import type { AuthUser } from './access';

export const IS_PUBLIC = 'isPublic';
/** Ruta accesible sin sesión. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_PERMISSION = 'requiredPermission';
/**
 * Exige el permiso en al menos una empresa. La comprobación por empresa concreta
 * se hace en el servicio con `assertCan`/`scopeCompanies`.
 */
export const RequirePermission = (p: Permission) => SetMetadata(REQUIRED_PERMISSION, p);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
