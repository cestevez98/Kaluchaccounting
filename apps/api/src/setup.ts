import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';

/** Configuración común de la app (la usan main.ts y los tests). */
export function configureApp(app: INestApplication) {
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true });
  const config = new DocumentBuilder()
    .setTitle('Kaluch ERP API')
    .setDescription('API del ERP financiero-operativo de Grupo Kaluch. Importes como string decimal; fechas AAAA-MM-DD.')
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('kaluch_session')
    .build();
  SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: 'api/openapi.json',
  });
  return app;
}
