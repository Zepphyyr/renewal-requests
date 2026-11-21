import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { PrismaService } from './prisma.service';
import { DispatchWorker } from './provider/dispatch.worker';
import { ProviderClient } from './provider/provider.client';
import { RequestsController } from './requests/requests.controller';
import { RequestsService } from './requests/requests.service';
import { ResourcesController } from './resources.controller';

@Module({
  controllers: [AuthController, ResourcesController, RequestsController],
  providers: [
    PrismaService,
    AuthService,
    RequestsService,
    ProviderClient,
    DispatchWorker,
    // Проверка входа включена для всех обработчиков сразу.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
