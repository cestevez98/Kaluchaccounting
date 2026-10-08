import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Permission } from '@kaluch/shared';
import type { Request } from 'express';
import { PrismaService } from '../common/prisma.service';
import { assertCan, type AuthUser } from './access';
import { IS_PUBLIC, REQUIRED_PERMISSION } from './decorators';

export const SESSION_COOKIE = 'kaluch_session';

/** Autenticación (cookie httpOnly o Bearer) + permiso mínimo declarado en la ruta. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Inicia sesión' });

    let sub: string;
    try {
      sub = (await this.jwt.verifyAsync<{ sub: string }>(token)).sub;
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'La sesión ha caducado' });
    }
    const user = await this.prisma.appUser.findUnique({
      where: { id: sub },
      include: { companyRoles: { include: { role: { include: { permissions: true } } } } },
    });
    if (!user || !user.active) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Usuario no válido' });

    const permissions = new Map<string, Set<string>>();
    for (const cr of user.companyRoles) {
      const set = permissions.get(cr.companyId) ?? new Set<string>();
      cr.role.permissions.forEach((p) => set.add(p.permission));
      permissions.set(cr.companyId, set);
    }
    req.user = { id: user.id, email: user.email, name: user.name, totpEnabled: user.totpEnabled, permissions };

    const required = this.reflector.getAllAndOverride<Permission>(REQUIRED_PERMISSION, targets);
    if (required) assertCan(req.user, required);
    return true;
  }
}
