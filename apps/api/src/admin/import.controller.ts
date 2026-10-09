import {
  BadRequestException, Body, ConflictException, Controller, Get, Post, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { type AuthUser } from '../auth/access';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { parse } from '../common/zod';

type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';
interface Step { key: string; label: string; args: string[]; status: StepStatus; startedAt: string | null; finishedAt: string | null }
interface ImportJob {
  status: 'running' | 'done' | 'error';
  mode: 'full' | 'sales' | 'rates';
  fileName: string;
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
  steps: Step[];
  log: string[];
  error: string | null;
}

/** Un único proceso de importación a la vez (en memoria: si la API se reinicia, se pierde el seguimiento). */
let job: ImportJob | null = null;

const MAX_LOG = 400;
const STEPS: Record<ImportJob['mode'], { key: string; label: string; args: (file: string) => string[] }[]> = {
  full: [
    { key: 'all', label: 'Plan de cuentas, tasas y valores del BC', args: (f) => ['all', f] },
    { key: 'treasury', label: 'Caja y bancos (apertura y movimientos)', args: (f) => ['treasury', f, '--revalue-until='] },
    { key: 'debts', label: 'Deudas, proveedores y nómina; revaluaciones y cierres abril–octubre', args: (f) => ['debts', f] },
    { key: 'sales', label: 'Exportación, distribución, inventario, ventas, costos y gastos', args: (f) => ['sales', f] },
    { key: 'fiscal', label: 'Financiamientos, impuestos devengados y capital', args: (f) => ['fiscal', f] },
    { key: 'explain', label: 'Explicaciones automáticas de diferencias', args: () => ['explain'] },
    { key: 'compare', label: 'Conciliación con el BC del Excel', args: () => ['compare'] },
  ],
  // Fases nuevas sobre una base ya migrada: actualiza el plan de cuentas y los valores del BC y migra lo que falte
  // (los pasos de las fases ya migradas se quitan al lanzar).
  sales: [
    { key: 'all', label: 'Plan de cuentas, tasas y valores del BC (actualización)', args: (f) => ['all', f] },
    { key: 'sales', label: 'Exportación, distribución, inventario, ventas, costos y gastos', args: (f) => ['sales', f] },
    { key: 'fiscal', label: 'Financiamientos, impuestos devengados y capital', args: (f) => ['fiscal', f] },
    { key: 'explain', label: 'Explicaciones automáticas de diferencias', args: () => ['explain'] },
    { key: 'compare', label: 'Conciliación con el BC del Excel', args: () => ['compare'] },
  ],
  rates: [{ key: 'rates', label: 'Actualizar tasas de cambio', args: (f) => ['rates', f, '--overwrite'] }],
};

function cliPath() {
  const candidates = [
    process.env.ETL_CLI_PATH,
    resolve(__dirname, '../../../../packages/etl/dist/cli.js'),
    resolve(process.cwd(), 'packages/etl/dist/cli.js'),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

function append(j: ImportJob, chunk: string) {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim() || /prisma-config|package\.json#prisma|Prisma 7/.test(line)) continue;
    j.log.push(line.slice(0, 500));
  }
  if (j.log.length > MAX_LOG) j.log.splice(0, j.log.length - MAX_LOG);
}

function runStep(j: ImportJob, step: Step): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [cliPath(), ...step.args], {
      env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${process.env.ETL_MAX_MEMORY_MB ?? '5120'}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d: Buffer) => append(j, d.toString()));
    child.stderr.on('data', (d: Buffer) => append(j, d.toString()));
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`El paso "${step.label}" terminó con error (código ${code})`))));
  });
}

async function run(j: ImportJob, file: string) {
  try {
    for (const step of j.steps) {
      step.status = 'running';
      step.startedAt = new Date().toISOString();
      append(j, `── ${step.label}`);
      try {
        await runStep(j, step);
        step.status = 'done';
      } catch (e) {
        step.status = 'error';
        j.error = (e as Error).message;
        for (const s of j.steps) if (s.status === 'pending') s.status = 'skipped';
        throw e;
      } finally {
        step.finishedAt = new Date().toISOString();
      }
    }
    j.status = 'done';
  } catch {
    j.status = 'error';
  } finally {
    j.finishedAt = new Date().toISOString();
    await unlink(file).catch(() => undefined);
    append(j, 'El archivo subido se ha borrado del servidor.');
  }
}

@ApiTags('Administración')
@Controller('admin/import')
export class ImportController {
  constructor(private readonly prisma: PrismaService) {}

  /** Estado de la importación y de los datos migrados. */
  @Get()
  @RequirePermission('admin:settings')
  async state() {
    const [accounts, rates, treasuryMovements, partyDocuments, lastBatch, debts, sales, fiscal] = await Promise.all([
      this.prisma.account.count(), this.prisma.exchangeRate.count(), this.prisma.treasuryMovement.count(),
      this.prisma.partyDocument.count(), this.prisma.importBatch.findFirst({ orderBy: { createdAt: 'desc' } }),
      this.prisma.importBatch.count({ where: { tableName: 'Deudas' } }), this.prisma.importBatch.count({ where: { tableName: 'Ventas' } }),
      this.prisma.importBatch.count({ where: { tableName: 'Fiscal y capital' } }),
    ]);
    return {
      // Sin los argumentos internos (ruta del archivo temporal).
      job: job ? { ...job, steps: job.steps.map(({ args: _args, ...s }) => s) } : null,
      data: { accounts, rates, treasuryMovements, partyDocuments, phases: { debts: debts > 0, sales: sales > 0, fiscal: fiscal > 0 }, lastImport: lastBatch ? { at: lastBatch.createdAt, file: lastBatch.sourceFile, table: lastBatch.tableName } : null },
    };
  }

  /**
   * Sube el Excel y lanza la migración en segundo plano. "full": migración completa (solo sobre una base
   * sin tesorería ni deudas importadas). "sales": añade la fase 4 a una base con las fases 1–3. "rates": solo
   * actualiza las tasas de cambio.
   */
  @Post()
  @RequirePermission('admin:settings')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 60 * 1024 * 1024 } }))
  async start(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: unknown) {
    const b = parse(z.object({ mode: z.enum(['full', 'sales', 'rates']).default('full') }), body);
    if (job?.status === 'running') throw new ConflictException({ code: 'IMPORT_RUNNING', message: 'Ya hay una importación en curso' });
    if (!file) throw new BadRequestException({ code: 'VALIDATION', message: 'Adjunta el archivo Excel (.xlsx)' });
    if (!/\.xlsx$/i.test(file.originalname) || file.buffer.subarray(0, 2).toString('latin1') !== 'PK') {
      throw new BadRequestException({ code: 'VALIDATION', message: 'El archivo debe ser un Excel .xlsx' });
    }
    if (b.mode === 'full') {
      const [movements, docs] = await Promise.all([this.prisma.treasuryMovement.count(), this.prisma.partyDocument.count()]);
      if (movements > 0 || docs > 0) {
        throw new ConflictException({
          code: 'ALREADY_IMPORTED',
          message: 'La base ya tiene movimientos de tesorería o documentos de contrapartes: la migración completa solo se hace una vez, sobre una base vacía',
        });
      }
    }
    const skip = new Set<string>();
    if (b.mode === 'sales') {
      const [debts, sales, fiscal] = await Promise.all(['Deudas', 'Ventas', 'Fiscal y capital'].map((tableName) => this.prisma.importBatch.findFirst({ where: { tableName } })));
      if (!debts) throw new ConflictException({ code: 'PHASE_MISSING', message: 'Primero hay que migrar tesorería y deudas (migración completa)' });
      if (sales && fiscal) throw new ConflictException({ code: 'ALREADY_IMPORTED', message: 'Esta base ya tiene migradas todas las fases' });
      if (sales) skip.add('sales');
    }
    // El nombre original queda en el historial de importaciones (sin caracteres raros).
    const safe = file.originalname.normalize('NFD').replace(/[^\w.-]+/g, '_').slice(-80);
    const path = join(tmpdir(), `kaluch-import-${Date.now()}-${safe}`);
    await writeFile(path, file.buffer, { mode: 0o600 });
    await chmod(path, 0o600);
    job = {
      status: 'running', mode: b.mode, fileName: file.originalname, startedBy: user.email, startedAt: new Date().toISOString(), finishedAt: null,
      steps: STEPS[b.mode].filter((s) => !skip.has(s.key)).map((s) => ({ key: s.key, label: s.label, args: s.args(path), status: 'pending', startedAt: null, finishedAt: null })),
      log: [], error: null,
    };
    void run(job, path);
    return { started: true, steps: job.steps.map((s) => ({ key: s.key, label: s.label })) };
  }
}
