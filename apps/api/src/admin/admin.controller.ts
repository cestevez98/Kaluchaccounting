import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { hashPassword, withTx } from '@kaluch/db';
import { PERMISSIONS, roleInputSchema, userCreateSchema, userUpdateSchema } from '@kaluch/shared';
import type { AuthUser } from '../auth/access';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';

const VALID = new Set<string>([...Object.keys(PERMISSIONS), '*']);

@ApiTags('Administración')
@Controller('admin')
export class AdminController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('users')
  @RequirePermission('admin:users')
  async users() {
    const users = await this.prisma.appUser.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true, email: true, name: true, active: true, totpEnabled: true, lastLoginAt: true, createdAt: true,
        companyRoles: { select: { companyId: true, roleId: true, company: { select: { code: true } }, role: { select: { name: true } } } },
      },
    });
    return users;
  }

  @Post('users')
  @RequirePermission('admin:users')
  async createUser(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(userCreateSchema, body);
    const passwordHash = await hashPassword(b.password);
    return withTx(this.prisma, { userId: user.id }, async (tx) => {
      const u = await tx.appUser.create({ data: { email: b.email.toLowerCase(), name: b.name, passwordHash } });
      if (b.assignments.length) {
        await tx.userCompanyRole.createMany({ data: b.assignments.map((a) => ({ userId: u.id, ...a })), skipDuplicates: true });
      }
      return { id: u.id, email: u.email, name: u.name };
    });
  }

  @Patch('users/:id')
  @RequirePermission('admin:users')
  async updateUser(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(userUpdateSchema, body);
    if (id === user.id && b.active === false) {
      throw new BadRequestException({ code: 'SELF_DISABLE', message: 'No puedes desactivar tu propio usuario' });
    }
    const passwordHash = b.password ? await hashPassword(b.password) : undefined;
    return withTx(this.prisma, { userId: user.id }, async (tx) => {
      await tx.appUser.update({
        where: { id },
        data: {
          ...(b.name ? { name: b.name } : {}),
          ...(b.active !== undefined ? { active: b.active } : {}),
          ...(passwordHash ? { passwordHash } : {}),
          ...(b.resetTotp ? { totpEnabled: false, totpSecret: null } : {}),
        },
      });
      if (b.assignments) {
        await tx.userCompanyRole.deleteMany({ where: { userId: id } });
        await tx.userCompanyRole.createMany({ data: b.assignments.map((a) => ({ userId: id, ...a })), skipDuplicates: true });
      }
      return { ok: true };
    });
  }

  @Get('roles')
  @RequirePermission('admin:users')
  async roles() {
    const roles = await this.prisma.role.findMany({ include: { permissions: true, _count: { select: { assignments: true } } }, orderBy: { name: 'asc' } });
    return { roles: roles.map((r) => ({ ...r, permissions: r.permissions.map((p) => p.permission) })), catalog: PERMISSIONS };
  }

  @Post('roles')
  @RequirePermission('admin:users')
  async createRole(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(roleInputSchema, body);
    const invalid = b.permissions.filter((p) => !VALID.has(p));
    if (invalid.length) throw new BadRequestException({ code: 'VALIDATION', message: `Permisos desconocidos: ${invalid.join(', ')}` });
    return withTx(this.prisma, { userId: user.id }, (tx) =>
      tx.role.create({
        data: { name: b.name, description: b.description, requires2fa: b.requires2fa, permissions: { create: b.permissions.map((permission) => ({ permission })) } },
      }),
    );
  }

  @Patch('roles/:id')
  @RequirePermission('admin:users')
  async updateRole(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(roleInputSchema.partial(), body);
    const role = await this.prisma.role.findUniqueOrThrow({ where: { id } });
    if (role.name === 'Superadministrador' && b.permissions) {
      throw new BadRequestException({ code: 'PROTECTED', message: 'Los permisos del Superadministrador no se pueden modificar' });
    }
    const invalid = (b.permissions ?? []).filter((p) => !VALID.has(p));
    if (invalid.length) throw new BadRequestException({ code: 'VALIDATION', message: `Permisos desconocidos: ${invalid.join(', ')}` });
    return withTx(this.prisma, { userId: user.id }, async (tx) => {
      await tx.role.update({
        where: { id },
        data: {
          ...(b.name ? { name: b.name } : {}),
          ...(b.description !== undefined ? { description: b.description } : {}),
          ...(b.requires2fa !== undefined ? { requires2fa: b.requires2fa } : {}),
        },
      });
      if (b.permissions) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: b.permissions.map((permission) => ({ roleId: id, permission })) });
      }
      return { ok: true };
    });
  }
}
