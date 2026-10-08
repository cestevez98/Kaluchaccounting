import { Body, Controller, Get, HttpCode, Post, Res, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { loginSchema, PERMISSIONS } from '@kaluch/shared';
import argon2 from 'argon2';
import type { Response } from 'express';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';
import type { AuthUser } from './access';
import { SESSION_COOKIE } from './auth.guard';
import { CurrentUser, Public } from './decorators';

const SESSION_HOURS = 10;
// Hash ficticio para igualar el tiempo de respuesta cuando el usuario no existe.
const DUMMY_HASH = argon2.hash('usuario-inexistente', { type: argon2.argon2id });

@ApiTags('Autenticación')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email, password, totp } = parse(loginSchema, body);
    const user = await this.prisma.appUser.findUnique({ where: { email: email.toLowerCase() } });
    const ok = await argon2.verify(user?.passwordHash ?? (await DUMMY_HASH), password).catch(() => false);
    if (!user || !ok || !user.active) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Correo o contraseña incorrectos' });
    }
    if (user.totpEnabled) {
      if (!totp) return { requiresTotp: true };
      if (!user.totpSecret || !authenticator.check(totp, user.totpSecret)) {
        throw new UnauthorizedException({ code: 'INVALID_TOTP', message: 'Código de verificación incorrecto' });
      }
    }
    await this.prisma.appUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const token = await this.jwt.signAsync({ sub: user.id }, { expiresIn: `${SESSION_HOURS}h` });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_HOURS * 3600 * 1000,
      path: '/',
    });
    return { ok: true, token };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const companies = await this.prisma.company.findMany({
      where: { id: { in: [...user.permissions.keys()] } },
      orderBy: { code: 'asc' },
    });
    const roles = await this.prisma.userCompanyRole.findMany({ where: { userId: user.id }, include: { role: true } });
    const requires2fa = roles.some((r) => r.role.requires2fa);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      totpEnabled: user.totpEnabled,
      requires2fa,
      companies: companies.map((c) => ({
        id: c.id,
        code: c.code,
        legalName: c.legalName,
        kind: c.kind,
        roles: roles.filter((r) => r.companyId === c.id).map((r) => r.role.name),
        permissions: [...(user.permissions.get(c.id) ?? [])].sort(),
      })),
      permissionCatalog: PERMISSIONS,
    };
  }

  /** Paso 1 de la activación de 2FA: genera el secreto (no se activa hasta verificar un código). */
  @Post('totp/setup')
  @HttpCode(200)
  async totpSetup(@CurrentUser() user: AuthUser) {
    const secret = authenticator.generateSecret();
    await this.prisma.appUser.update({ where: { id: user.id }, data: { totpSecret: secret, totpEnabled: false } });
    return { secret, otpauthUrl: authenticator.keyuri(user.email, 'Kaluch ERP', secret) };
  }

  @Post('totp/enable')
  @HttpCode(200)
  async totpEnable(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), body);
    const u = await this.prisma.appUser.findUniqueOrThrow({ where: { id: user.id } });
    if (!u.totpSecret || !authenticator.check(code, u.totpSecret)) {
      throw new UnauthorizedException({ code: 'INVALID_TOTP', message: 'Código de verificación incorrecto' });
    }
    await this.prisma.appUser.update({ where: { id: user.id }, data: { totpEnabled: true } });
    return { ok: true };
  }
}
