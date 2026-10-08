import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { LedgerError, translateDbError } from '@kaluch/db';
import type { Response } from 'express';

const STATUS: Record<LedgerError['code'], number> = {
  NOT_FOUND: HttpStatus.NOT_FOUND,
  MISSING_RATE: HttpStatus.UNPROCESSABLE_ENTITY,
  UNBALANCED: HttpStatus.UNPROCESSABLE_ENTITY,
  PERIOD_CLOSED: HttpStatus.CONFLICT,
  IMMUTABLE: HttpStatus.CONFLICT,
  INVALID_ACCOUNT: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  ALREADY_REVERSED: HttpStatus.CONFLICT,
  MISSING_MAPPING: HttpStatus.UNPROCESSABLE_ENTITY,
};

/** Respuesta de error uniforme: { code, message, issues? }. */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const e = translateDbError(exception);
    if (e instanceof LedgerError) {
      res.status(STATUS[e.code]).json({ code: e.code, message: e.message });
      return;
    }
    if (e instanceof HttpException) {
      const body = e.getResponse();
      const payload =
        typeof body === 'string'
          ? { code: 'HTTP_' + e.getStatus(), message: body }
          : { code: 'HTTP_' + e.getStatus(), ...(body as object) };
      res.status(e.getStatus()).json(payload);
      return;
    }
    const prismaCode = (e as { code?: string })?.code;
    if (prismaCode === 'P2002') {
      res.status(HttpStatus.CONFLICT).json({ code: 'DUPLICATE', message: 'Ya existe un registro con esos datos' });
      return;
    }
    if (prismaCode === 'P2025') {
      res.status(HttpStatus.NOT_FOUND).json({ code: 'NOT_FOUND', message: 'Registro no encontrado' });
      return;
    }
    this.logger.error(e instanceof Error ? e.stack : String(e));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ code: 'INTERNAL', message: 'Error interno del servidor' });
  }
}
