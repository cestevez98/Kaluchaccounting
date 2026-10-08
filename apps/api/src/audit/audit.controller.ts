import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { paginationSchema } from '@kaluch/shared';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';

@ApiTags('Auditoría')
@Controller('audit')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission('audit:read')
  async list(@Query() query: unknown) {
    const q = parse(paginationSchema.extend({ table: z.string().optional(), recordId: z.string().optional() }), query);
    const where = { ...(q.table ? { tableName: q.table } : {}), ...(q.recordId ? { recordId: q.recordId } : {}) };
    const [total, items] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const users = await this.prisma.appUser.findMany({
      where: { id: { in: items.map((i) => i.userId).filter((x): x is string => !!x) } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: items.map((i) => ({ ...i, id: i.id.toString(), user: i.userId ? byId.get(i.userId) ?? null : null })),
    };
  }
}
