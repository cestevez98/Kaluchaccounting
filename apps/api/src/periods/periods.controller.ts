import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { withTx } from '@kaluch/db';
import { z } from 'zod';
import { assertCan, scopeCompanies, type AuthUser } from '../auth/access';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';

@ApiTags('Periodos contables')
@Controller('periods')
export class PeriodsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission('period:read')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(z.object({ companyId: z.string().uuid().optional(), year: z.coerce.number().int() }), query);
    const companyIds = scopeCompanies(user, 'period:read', q.companyId);
    return this.prisma.fiscalPeriod.findMany({
      where: { companyId: { in: companyIds }, year: q.year },
      include: { company: { select: { code: true } }, _count: { select: { entries: true } } },
      orderBy: [{ company: { code: 'asc' } }, { month: 'asc' }],
    });
  }

  /** Crea los 12 periodos de un año para las empresas indicadas (o todas a las que tienes acceso). */
  @Post('generate')
  @RequirePermission('period:close')
  async generate(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(z.object({ year: z.number().int().min(2020).max(2100), companyId: z.string().uuid().optional() }), body);
    const companyIds = scopeCompanies(user, 'period:close', b.companyId);
    return withTx(this.prisma, { userId: user.id }, async (tx) => {
      const r = await tx.fiscalPeriod.createMany({
        data: companyIds.flatMap((companyId) =>
          Array.from({ length: 12 }, (_, i) => ({ companyId, year: b.year, month: i + 1 })),
        ),
        skipDuplicates: true,
      });
      return { ok: true, created: r.count };
    });
  }

  /**
   * Cambia el estado del periodo:
   * OPEN → SOFT_CLOSED (period:close), SOFT_CLOSED → LOCKED (period:lock),
   * SOFT_CLOSED → OPEN (period:close), LOCKED → OPEN/SOFT_CLOSED (period:reopen, con motivo).
   */
  @Patch(':id')
  async setStatus(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(
      z.object({ status: z.enum(['OPEN', 'SOFT_CLOSED', 'LOCKED']), reason: z.string().max(500).optional() }),
      body,
    );
    const period = await this.prisma.fiscalPeriod.findUniqueOrThrow({ where: { id } });
    const from = period.status;
    const to = b.status;
    if (from === to) return period;
    if (from === 'LOCKED') {
      assertCan(user, 'period:reopen', period.companyId);
      if (!b.reason) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'Indica el motivo de la reapertura' });
    } else if (to === 'LOCKED') {
      assertCan(user, 'period:lock', period.companyId);
      if (from !== 'SOFT_CLOSED') {
        throw new BadRequestException({ code: 'INVALID_TRANSITION', message: 'Antes de bloquear, pasa el periodo a revisión de cierre' });
      }
      // No se bloquea un mes si hay meses anteriores abiertos.
      const earlierOpen = await this.prisma.fiscalPeriod.count({
        where: {
          companyId: period.companyId,
          status: { not: 'LOCKED' },
          OR: [{ year: { lt: period.year } }, { year: period.year, month: { lt: period.month, gte: 1 } }],
        },
      });
      if (earlierOpen > 0) {
        throw new BadRequestException({ code: 'EARLIER_OPEN', message: 'Hay periodos anteriores sin bloquear' });
      }
    } else {
      assertCan(user, 'period:close', period.companyId);
    }
    return withTx(this.prisma, { userId: user.id }, async (tx) => {
      if (b.reason) await tx.$executeRaw`SELECT set_config('app.reason', ${b.reason}, true)`;
      return tx.fiscalPeriod.update({ where: { id }, data: { status: to } });
    });
  }
}
