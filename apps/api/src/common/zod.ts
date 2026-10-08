import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** Valida con un esquema Zod compartido y devuelve errores legibles en español. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new BadRequestException({
      code: 'VALIDATION',
      message: 'Datos no válidos',
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}
