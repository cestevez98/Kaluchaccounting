import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './setup';

async function bootstrap() {
  const app = configureApp(await NestFactory.create(AppModule, { bufferLogs: false }));
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  console.log(`API escuchando en http://localhost:${port}/api/v1 — documentación en /api/docs`);
}

void bootstrap();
