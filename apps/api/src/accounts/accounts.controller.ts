import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { withTx } from '@kaluch/db';
import { accountInputSchema } from '@kaluch/shared';
import type { AuthUser } from '../auth/access';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';

@ApiTags('Plan de cuentas')
@Controller('accounts')
export class AccountsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Plan de cuentas completo (plano, con parentId para construir el árbol). */
  @Get()
  @RequirePermission('accounts:read')
  list(@Query('q') q?: string, @Query('postable') postable?: string) {
    return this.prisma.account.findMany({
      where: {
        ...(q ? { OR: [{ displayCode: { startsWith: q } }, { name: { contains: q, mode: 'insensitive' } }] } : {}),
        ...(postable === 'true' ? { postable: true, active: true } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { fullCode: 'asc' }],
    });
  }

  @Post()
  @RequirePermission('accounts:manage')
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(accountInputSchema, body);
    const displayCode = input.subcode ? `${input.code}.${input.subcode}` : input.code;
    if (input.subcode && !input.parentId) {
      const parent = await this.prisma.account.findFirst({ where: { code: input.code, subcode: null } });
      if (!parent) throw new BadRequestException({ code: 'NO_PARENT', message: `No existe la cuenta de grupo ${input.code}` });
      input.parentId = parent.id;
    }
    return withTx(this.prisma, { userId: user.id }, async (tx) => {
      const acc = await tx.account.create({
        data: { ...input, parentId: input.parentId ?? null, fullCode: displayCode, displayCode, sortOrder: 100_000 },
      });
      // Una cuenta de grupo con subcuentas deja de ser de detalle.
      if (acc.parentId) {
        const parent = await tx.account.findUniqueOrThrow({ where: { id: acc.parentId } });
        if (parent.postable) {
          const used = await tx.journalLine.count({ where: { accountId: parent.id } });
          if (used > 0) {
            throw new BadRequestException({
              code: 'PARENT_HAS_MOVEMENTS',
              message: `La cuenta ${parent.displayCode} ya tiene movimientos: no puede pasar a ser de grupo`,
            });
          }
          await tx.account.update({ where: { id: parent.id }, data: { postable: false } });
        }
      }
      return acc;
    });
  }

  @Patch(':id')
  @RequirePermission('accounts:manage')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(accountInputSchema.partial(), body);
    // El código identifica la cuenta en el histórico: no se cambia desde aquí.
    delete input.code;
    delete input.subcode;
    return withTx(this.prisma, { userId: user.id }, (tx) => tx.account.update({ where: { id }, data: input }));
  }
}
