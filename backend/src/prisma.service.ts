import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

export type Tx = Prisma.TransactionClient;

/**
 * Блокирует строку ресурса до конца транзакции.
 * Каждая операция, меняющая заявки ресурса, начинается с этого вызова,
 * поэтому такие операции выполняются строго по очереди и всегда берут
 * блокировки в одном порядке (ресурс -> заявка), что исключает взаимную блокировку.
 */
export async function lockResource(tx: Tx, resourceId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM resources WHERE id = ${resourceId} FOR UPDATE`;
}

/** Нарушение уникального индекса (код Prisma P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
