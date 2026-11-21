import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';

async function bootstrap() {
  try {
    process.loadEnvFile(); // читает backend/.env
  } catch {
    // .env необязателен, если переменные заданы в окружении
  }
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  await app.listen(config.port, '127.0.0.1');
  console.log(`API: http://127.0.0.1:${config.port}/api  (пауза после 503: ${config.retryDelayMs} мс)`);
}

void bootstrap();
