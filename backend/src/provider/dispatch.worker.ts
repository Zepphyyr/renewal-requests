import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RenewalRequest } from '@prisma/client';
import { config, MAX_POST_ATTEMPTS } from '../config';
import { toDateString } from '../dates';
import { lockResource, PrismaService } from '../prisma.service';
import { ProviderClient, ProviderOperation, RenewalPayload } from './provider.client';

/**
 * Фоновый обработчик задач отправки. Работает внутри приложения: раз в WORKER_POLL_MS
 * берёт из таблицы dispatch_jobs задачи, у которых подошло время, и выполняет их.
 *
 * Всё состояние лежит в базе, в памяти процесса ничего не хранится. Поэтому после
 * остановки и запуска приложения обработчик просто находит те же задачи и продолжает.
 *
 * Шаги одной задачи:
 *   1. GET по ключу — вдруг операция уже есть у провайдера (после 503 или после перезапуска).
 *      GET ничего не создаёт и попыткой не считается.
 *   2. Если операции нет и попытки не исчерпаны — POST с тем же ключом и телом.
 *   3. Определённый результат записываем одной транзакцией; неопределённый — откладываем
 *      на PROVIDER_RETRY_DELAY_MS и возвращаемся к шагу 1.
 */
@Injectable()
export class DispatchWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DispatchWorker.name);
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: ProviderClient,
  ) {}

  onModuleInit() {
    if (!config.workerEnabled) return;
    this.timer = setInterval(() => void this.tick(), config.workerPollMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Один проход: выполнить все задачи, которым пора. Возвращает число взятых задач. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const now = new Date();
      const due = await this.prisma.dispatchJob.findMany({
        where: { state: 'active', nextRunAt: { lte: now }, ...notLocked(now) },
        orderBy: { nextRunAt: 'asc' },
        take: 20,
        select: { requestId: true },
      });
      for (const { requestId } of due) {
        try {
          await this.process(requestId);
        } catch (error) {
          // Задача останется занятой до lockedUntil и будет взята снова.
          this.log.error(`Заявка ${requestId}: сбой обработки (${errorName(error)})`);
        }
      }
      return due.length;
    } catch (error) {
      this.log.error(`Не удалось прочитать очередь задач (${errorName(error)})`);
      return 0;
    } finally {
      this.busy = false;
    }
  }

  private async process(requestId: string): Promise<void> {
    // Захват задачи условным обновлением: если запущено два экземпляра приложения,
    // задачу возьмёт только один. Срок захвата истекает сам, если процесс упал.
    const now = new Date();
    const lockMs = 2 * config.providerTimeoutMs + 10_000;
    const claimed = await this.prisma.dispatchJob.updateMany({
      where: { requestId, state: 'active', nextRunAt: { lte: now }, ...notLocked(now) },
      data: { lockedUntil: new Date(now.getTime() + lockMs) },
    });
    if (claimed.count !== 1) return;

    const job = await this.prisma.dispatchJob.findUniqueOrThrow({
      where: { requestId },
      include: { request: true },
    });
    const request = job.request;
    const payload: RenewalPayload = {
      resource_id: request.resourceId,
      period_months: 1, // по условию задания 1 = условные 30 дней
      amount_minor: request.amountMinor,
      currency: request.currency,
    };

    // Шаг 1. Сначала спрашиваем, не выполнена ли операция уже.
    const check = await this.provider.get(request.id);
    if (check.kind === 'found') return this.onOperation(request, check.operation, payload);

    if (job.postAttempts >= MAX_POST_ATTEMPTS) {
      return this.needsAttention(
        request,
        `Нет подтверждения после ${MAX_POST_ATTEMPTS} попыток отправки. Результат не определён.`,
      );
    }

    // Шаг 2. Отправляем. Попытку записываем ДО запроса: если процесс упадёт
    // посреди отправки, попытка всё равно будет учтена (итого не больше трёх POST).
    // Тем же обновлением назначаем паузу перед следующим проходом: она сохранится,
    // даже если процесс остановят сразу после ответа провайдера.
    const attempt = job.postAttempts + 1;
    await this.prisma.dispatchJob.update({
      where: { requestId },
      data: { postAttempts: { increment: 1 }, nextRunAt: new Date(Date.now() + config.retryDelayMs) },
    });
    const result = await this.provider.post(request.id, payload);
    this.log.log(`Заявка ${requestId}: POST, попытка ${attempt}, исход ${result.kind}`);

    if (result.kind === 'found') return this.onOperation(request, result.operation, payload);
    if (result.kind === 'rejected') {
      return this.needsAttention(
        request,
        result.httpStatus === 409
          ? 'Провайдер отклонил запрос: ключ операции уже использован с другими параметрами (HTTP 409).'
          : `Провайдер отклонил запрос (HTTP ${result.httpStatus}).`,
      );
    }

    // Неопределённость: операция могла выполниться. Ждём и идём проверять по ключу.
    const reason = result.kind === 'unknown' ? result.reason : 'нет ответа';
    await this.prisma.$transaction([
      this.prisma.dispatchJob.update({
        where: { requestId },
        data: { nextRunAt: new Date(Date.now() + config.retryDelayMs), lockedUntil: null },
      }),
      this.prisma.requestEvent.create({
        data: {
          requestId,
          fromStatus: 'executing',
          toStatus: 'executing',
          note: `Попытка ${attempt} из ${MAX_POST_ATTEMPTS}: подтверждение не получено (${reason}). Результат не определён, проверим по ключу операции.`,
        },
      }),
    ]);
  }

  /** Провайдер показал операцию: убеждаемся, что это наша, и фиксируем результат. */
  private async onOperation(
    request: RenewalRequest,
    operation: ProviderOperation,
    payload: RenewalPayload,
  ): Promise<void> {
    if (operation.status !== 'completed') {
      return this.needsAttention(request, `Провайдер вернул неожиданный статус операции: ${operation.status}.`);
    }
    const matches =
      operation.resource_id === payload.resource_id &&
      operation.amount_minor === payload.amount_minor &&
      operation.currency === payload.currency;
    if (!matches) {
      return this.needsAttention(request, 'Операция у провайдера не совпадает с параметрами заявки.');
    }
    await this.complete(request, operation.operation_id);
  }

  /**
   * Результат, статус заявки и новый срок ресурса — одной транзакцией.
   * Защита от повторного сдвига срока двойная:
   *  - условие status = 'executing': повторная обработка не найдёт строку и ничего не сделает;
   *  - срок записывается готовым значением из заявки (newExpiresOn), а не «плюс 30 дней».
   */
  private async complete(request: RenewalRequest, operationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockResource(tx, request.resourceId);
      const changed = await tx.renewalRequest.updateMany({
        where: { id: request.id, status: 'executing' },
        data: { status: 'completed', providerOperationId: operationId, lastError: null },
      });
      if (changed.count === 1) {
        await tx.resource.update({
          where: { id: request.resourceId },
          data: { expiresOn: request.newExpiresOn },
        });
        await tx.requestEvent.create({
          data: {
            requestId: request.id,
            fromStatus: 'executing',
            toStatus: 'completed',
            note: `Провайдер подтвердил операцию ${operationId}. Срок ресурса: ${toDateString(request.newExpiresOn)}.`,
          },
        });
      }
      await tx.dispatchJob.update({
        where: { requestId: request.id },
        data: { state: 'done', lockedUntil: null },
      });
    });
    // В лог идёт только идентификатор операции, не полный ответ провайдера.
    this.log.log(`Заявка ${request.id}: завершена, операция ${operationId}`);
  }

  private async needsAttention(request: RenewalRequest, note: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.renewalRequest.updateMany({
        where: { id: request.id, status: 'executing' },
        data: { status: 'needs_attention', lastError: note },
      });
      if (changed.count === 1) {
        await tx.requestEvent.create({
          data: { requestId: request.id, fromStatus: 'executing', toStatus: 'needs_attention', note },
        });
      }
      await tx.dispatchJob.update({
        where: { requestId: request.id },
        data: { state: 'attention', lockedUntil: null },
      });
    });
    this.log.warn(`Заявка ${request.id}: требует внимания`);
  }
}

function notLocked(now: Date) {
  return { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}
