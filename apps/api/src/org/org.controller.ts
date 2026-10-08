import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/access';
import { CurrentUser } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';

@ApiTags('Organización')
@Controller()
export class OrgController {
  constructor(private readonly prisma: PrismaService) {}

  /** Empresas a las que el usuario tiene acceso. */
  @Get('companies')
  companies(@CurrentUser() user: AuthUser) {
    return this.prisma.company.findMany({ where: { id: { in: [...user.permissions.keys()] } }, orderBy: { code: 'asc' } });
  }

  @Get('segments')
  segments() {
    return this.prisma.segment.findMany({ orderBy: { code: 'asc' } });
  }

  @Get('dimensions')
  dimensions(@Query('dimension') dimension?: string) {
    return this.prisma.dimensionValue.findMany({
      where: dimension ? { dimension: dimension as never } : undefined,
      orderBy: [{ dimension: 'asc' }, { code: 'asc' }],
    });
  }

  @Get('currencies')
  async currencies() {
    const [currencies, rateTypes] = await Promise.all([
      this.prisma.currency.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.rateType.findMany({ orderBy: { code: 'asc' } }),
    ]);
    return { currencies, rateTypes };
  }
}
