import argon2 from 'argon2';
import type { PrismaClient } from '@prisma/client';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/** Crea el usuario si no existe y le asigna el rol en las empresas indicadas (todas por defecto). */
export async function ensureUser(
  prisma: PrismaClient,
  u: { email: string; name: string; password: string; role: string; companyCodes?: string[] },
) {
  const user =
    (await prisma.appUser.findUnique({ where: { email: u.email } })) ??
    (await prisma.appUser.create({
      data: { email: u.email, name: u.name, passwordHash: await hashPassword(u.password) },
    }));
  const role = await prisma.role.findUniqueOrThrow({ where: { name: u.role } });
  const companies = await prisma.company.findMany(
    u.companyCodes ? { where: { code: { in: u.companyCodes } } } : undefined,
  );
  for (const c of companies) {
    await prisma.userCompanyRole.upsert({
      where: { userId_companyId_roleId: { userId: user.id, companyId: c.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, companyId: c.id, roleId: role.id },
    });
  }
  return user;
}
