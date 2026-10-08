import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AccountsController } from './accounts/accounts.controller';
import { AuditController } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { Public } from './auth/decorators';
import { ErrorsFilter } from './common/errors.filter';
import { PrismaService } from './common/prisma.service';
import { FxController } from './fx/fx.controller';
import { JournalController } from './journal/journal.controller';
import { OrgController } from './org/org.controller';
import { PeriodsController } from './periods/periods.controller';
import { ReportsController } from './reports/reports.controller';

@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}

function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || (process.env.NODE_ENV === 'production' && s.length < 32)) {
    throw new Error('JWT_SECRET no definido (en producción, mínimo 32 caracteres)');
  }
  return s;
}

@Module({
  imports: [JwtModule.registerAsync({ useFactory: () => ({ secret: jwtSecret() }) })],
  controllers: [
    HealthController, AuthController, OrgController, AccountsController, FxController,
    PeriodsController, JournalController, ReportsController, AuditController,
  ],
  providers: [
    PrismaService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorsFilter },
  ],
})
export class AppModule {}
