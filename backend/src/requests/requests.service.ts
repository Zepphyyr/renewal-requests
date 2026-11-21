import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RequestStatus } from '@prisma/client';
import { AuthUser, requireSpace, SpaceAccess } from '../auth/auth.service';
import { addDays, RENEWAL_DAYS, toDateString } from '../dates';
import { isUniqueViolation, lockResource, PrismaService } from '../prisma.service';

const requestInclude = {
  resource: { select: { name: true } },
  createdBy: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
  job: { select: { postAttempts: true } },
} satisfies Prisma.RenewalRequestInclude;

const detailInclude = {
  ...requestInclude,
  events: { orderBy: { id: 'asc' }, include: { actor: { select: { name: true } } } },
} satisfies Prisma.RenewalRequestInclude;

type RequestRow = Prisma.RenewalRequestGetPayload<{ include: typeof requestInclude }>;
type RequestDetailRow = Prisma.RenewalRequestGetPayload<{ include: typeof detailInclude }>;

@Injectable()
export class RequestsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- чтение ----------

  async listForSpace(user: AuthUser, spaceId: string) {
    const access = requireSpace(user, spaceId);
    const rows = await this.prisma.renewalRequest.findMany({
      where: { spaceId },
      include: requestInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => toView(row, user, access));
  }

  async getOne(user: AuthUser, id: string) {
    const row = await this.prisma.renewalRequest.findUnique({
      where: { id },
      include: detailInclude,
    });
    if (!row) throw new NotFoundException('Заявка не найдена');
    const access = requireSpace(user, row.spaceId);
    return toDetailView(row, user, access);
  }

  // ---------- создание ----------

  async create(user: AuthUser, resourceId: string) {
    const found = await this.prisma.resource.findUnique({ where: { id: resourceId } });
    if (!found) throw new NotFoundException('Ресурс не найден');
    const access = requireSpace(user, found.spaceId);
    if (!access.canInitiate) throw new ForbiddenException('Нет права создавать заявки');

    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await lockResource(tx, resourceId);
        // Читаем ресурс уже под блокировкой: снимок точно соответствует текущему состоянию.
        const resource = await tx.resource.findUniqueOrThrow({ where: { id: resourceId } });
        const request = await tx.renewalRequest.create({
          data: {
            resourceId,
            spaceId: resource.spaceId,
            createdById: user.id,
            amountMinor: resource.priceMinor,
            currency: resource.currency,
            oldExpiresOn: resource.expiresOn,
            newExpiresOn: addDays(resource.expiresOn, RENEWAL_DAYS),
          },
        });
        await tx.requestEvent.create({
          data: { requestId: request.id, actorId: user.id, toStatus: 'pending', note: 'Заявка создана' },
        });
        return request.id;
      });
      return this.getOne(user, id);
    } catch (error) {
      // Правило «одна активная заявка на ресурс» держит частичный уникальный индекс в базе.
      // Здесь мы только переводим его срабатывание в понятный ответ.
      if (isUniqueViolation(error)) {
        throw new ConflictException('У этого ресурса уже есть активная заявка');
      }
      throw error;
    }
  }

  // ---------- решения согласующего ----------

  async approve(user: AuthUser, id: string) {
    const found = await this.loadForDecision(user, id);

    await this.prisma.$transaction(async (tx) => {
      await lockResource(tx, found.resourceId);
      const resource = await tx.resource.findUniqueOrThrow({ where: { id: found.resourceId } });
      const request = await tx.renewalRequest.findUniqueOrThrow({ where: { id } });
      if (request.status !== 'pending') throw invalidTransition(request.status);

      const snapshotIsCurrent =
        resource.expiresOn.getTime() === request.oldExpiresOn.getTime() &&
        resource.priceMinor === request.amountMinor &&
        resource.currency === request.currency;
      if (!snapshotIsCurrent) {
        throw new ConflictException(
          'Срок или стоимость ресурса изменились после создания заявки. Отклоните её и создайте новую.',
        );
      }

      // Условное обновление: сработает, только если заявка всё ещё «на согласовании».
      // Из двух параллельных одобрений строку изменит ровно одно.
      const changed = await tx.renewalRequest.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'executing', decidedById: user.id },
      });
      if (changed.count !== 1) throw invalidTransition(request.status);

      // Задача на отправку создаётся в той же транзакции, что и смена статуса:
      // либо сохранится и то и другое, либо ничего. Перезапуск её не потеряет.
      await tx.dispatchJob.create({ data: { requestId: id } });
      await tx.requestEvent.create({
        data: {
          requestId: id,
          actorId: user.id,
          fromStatus: 'pending',
          toStatus: 'executing',
          note: 'Заявка согласована, задача отправки поставлена в очередь',
        },
      });
    });
    return this.getOne(user, id);
  }

  async reject(user: AuthUser, id: string) {
    const found = await this.loadForDecision(user, id);

    await this.prisma.$transaction(async (tx) => {
      await lockResource(tx, found.resourceId);
      const changed = await tx.renewalRequest.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'rejected', decidedById: user.id },
      });
      if (changed.count !== 1) {
        const current = await tx.renewalRequest.findUniqueOrThrow({ where: { id } });
        throw invalidTransition(current.status);
      }
      await tx.requestEvent.create({
        data: {
          requestId: id,
          actorId: user.id,
          fromStatus: 'pending',
          toStatus: 'rejected',
          note: 'Заявка отклонена',
        },
      });
    });
    return this.getOne(user, id);
  }

  /** Повтор обработки из «Требует внимания». Ключ операции остаётся прежним (id заявки). */
  async retry(user: AuthUser, id: string) {
    const found = await this.prisma.renewalRequest.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('Заявка не найдена');
    const access = requireSpace(user, found.spaceId);
    if (!access.canApprove) throw new ForbiddenException('Нет права согласования');

    await this.prisma.$transaction(async (tx) => {
      await lockResource(tx, found.resourceId);
      const changed = await tx.renewalRequest.updateMany({
        where: { id, status: 'needs_attention' },
        data: { status: 'executing', lastError: null },
      });
      if (changed.count !== 1) {
        const current = await tx.renewalRequest.findUniqueOrThrow({ where: { id } });
        throw invalidTransition(current.status);
      }
      await tx.dispatchJob.update({
        where: { requestId: id },
        data: { state: 'active', postAttempts: 0, nextRunAt: new Date(), lockedUntil: null },
      });
      await tx.requestEvent.create({
        data: {
          requestId: id,
          actorId: user.id,
          fromStatus: 'needs_attention',
          toStatus: 'executing',
          note: 'Повтор обработки с прежним ключом операции',
        },
      });
    });
    return this.getOne(user, id);
  }

  /** Общие проверки доступа для одобрения и отклонения. */
  private async loadForDecision(user: AuthUser, id: string) {
    const found = await this.prisma.renewalRequest.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('Заявка не найдена');
    const access = requireSpace(user, found.spaceId);
    if (!access.canApprove) throw new ForbiddenException('Нет права согласования');
    if (found.createdById === user.id) {
      throw new ForbiddenException('Нельзя согласовать или отклонить собственную заявку');
    }
    return found;
  }
}

const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: 'На согласовании',
  rejected: 'Отклонена',
  executing: 'Выполняется',
  completed: 'Завершена',
  needs_attention: 'Требует внимания',
};

function invalidTransition(current: RequestStatus) {
  return new ConflictException(
    `Действие недоступно: заявка уже в состоянии «${STATUS_LABEL[current]}»`,
  );
}

function toView(row: RequestRow, user: AuthUser, access: SpaceAccess) {
  const canDecide = access.canApprove && row.status === 'pending' && row.createdById !== user.id;
  return {
    id: row.id,
    // Ключ идемпотентности у провайдера — это id заявки.
    operationKey: row.id,
    resourceId: row.resourceId,
    resourceName: row.resource.name,
    spaceId: row.spaceId,
    status: row.status,
    createdBy: row.createdBy,
    decidedBy: row.decidedBy,
    amountMinor: row.amountMinor,
    currency: row.currency,
    oldExpiresOn: toDateString(row.oldExpiresOn),
    newExpiresOn: toDateString(row.newExpiresOn),
    providerOperationId: row.providerOperationId,
    lastError: row.lastError,
    postAttempts: row.job?.postAttempts ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // Подсказка интерфейсу, какие кнопки показать. Сервер всё равно проверяет права сам.
    can: {
      approve: canDecide,
      reject: canDecide,
      retry: access.canApprove && row.status === 'needs_attention',
    },
  };
}

function toDetailView(row: RequestDetailRow, user: AuthUser, access: SpaceAccess) {
  return {
    ...toView(row, user, access),
    events: row.events.map((event) => ({
      id: event.id,
      at: event.createdAt.toISOString(),
      actor: event.actor?.name ?? null, // null — действие системы
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      note: event.note,
    })),
  };
}
