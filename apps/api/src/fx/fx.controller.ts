import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { findRate, toDate, withTx } from '@kaluch/db';
import { exchangeRateInputSchema, paginationSchema } from '@kaluch/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/access';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';

const listSchema = paginationSchema.extend({
  currency: z.string().length(3).optional(),
  rateType: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

@ApiTags('Tasas de cambio')
@Controller('rates')
export class FxController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission('fx:read')
  async list(@Query() query: unknown) {
    const q = parse(listSchema, query);
    const where = {
      ...(q.currency ? { currency: q.currency } : {}),
      ...(q.rateType ? { rateType: q.rateType } : {}),
      ...(q.from || q.to ? { rateDate: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.exchangeRate.count({ where }),
      this.prisma.exchangeRate.findMany({
        where,
        orderBy: [{ rateDate: 'desc' }, { currency: 'asc' }, { rateType: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items };
  }

  /** Registra o corrige la tasa de un día (una por fecha, moneda, tipo y base). */
  @Post()
  @RequirePermission('fx:manage')
  upsert(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const r = parse(exchangeRateInputSchema, body);
    const rateDate = toDate(r.rateDate);
    return withTx(this.prisma, { userId: user.id }, (tx) =>
      tx.exchangeRate.upsert({
        where: { rateDate_currency_rateType_base: { rateDate, currency: r.currency, rateType: r.rateType, base: r.base } },
        update: { rate: r.rate, source: r.source ?? 'manual', createdBy: user.id },
        create: { rateDate, currency: r.currency, rateType: r.rateType, base: r.base, rate: r.rate, source: r.source ?? 'manual', createdBy: user.id },
      }),
    );
  }

  /** Tasa aplicable a una fecha (la del día o la última anterior dentro del plazo permitido). */
  @Get('lookup')
  @RequirePermission('fx:read')
  async lookup(@Query() query: unknown) {
    const q = parse(
      z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), currency: z.string().length(3), rateType: z.string() }),
      query,
    );
    const r = await this.prisma.$transaction((tx) => findRate(tx, toDate(q.date), q.currency, q.rateType));
    return { rate: r.rate.toString(), rateType: r.rateType, rateDate: r.rateDate };
  }
}
