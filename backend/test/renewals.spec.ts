import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { toDateString } from '../src/dates';
import { DEMO_PASSWORD, DEMO_USERS, seed } from '../src/db/seed';
import { PrismaService } from '../src/prisma.service';
import { DispatchWorker } from '../src/provider/dispatch.worker';
import { ProviderStub } from './provider-stub';

// Тесты идут через настоящий HTTP API и настоящую базу PostgreSQL (renewals_test).
// Провайдер — локальная копия имитатора (см. provider-stub.ts).

type Agent = ReturnType<typeof request.agent>;

const provider = new ProviderStub();
let app: INestApplication;
let prisma: PrismaService;
let worker: DispatchWorker;

async function startApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  prisma = app.get(PrismaService);
  worker = app.get(DispatchWorker);
}

/** Имитация перезапуска приложения: всё, что было в памяти процесса, пропадает. */
async function restartApp() {
  await app.close();
  await startApp();
}

async function login(email: string): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/auth/login').send({ email, password: DEMO_PASSWORD }).expect(200);
  return agent;
}

async function createRequest(agent: Agent, resourceId = 'res-a-01'): Promise<string> {
  const response = await agent.post('/api/requests').send({ resourceId }).expect(201);
  return response.body.id;
}

async function expiresOn(resourceId: string): Promise<string> {
  const resource = await prisma.resource.findUniqueOrThrow({ where: { id: resourceId } });
  return toDateString(resource.expiresOn);
}

async function statusOf(id: string) {
  return (await prisma.renewalRequest.findUniqueOrThrow({ where: { id } })).status;
}

beforeAll(async () => {
  process.env.PROVIDER_URL = await provider.start();
  await startApp();
});

beforeEach(async () => {
  provider.reset();
  await seed(prisma);
});

afterAll(async () => {
  await app.close();
  await provider.stop();
});

describe('авторизация', () => {
  it('без входа — 401', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
    await request(app.getHttpServer()).get('/api/spaces/alpha/resources').expect(401);
    await request(app.getHttpServer()).post('/api/requests').send({ resourceId: 'res-a-01' }).expect(401);
  });

  it('неверный пароль — 401, верный — пользователь с правами из базы', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: DEMO_USERS.initiatorAlpha, password: 'wrong' })
      .expect(401);

    const agent = await login(DEMO_USERS.universalAlpha);
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.memberships).toEqual([
      { spaceId: 'alpha', spaceName: 'Alpha', canInitiate: true, canApprove: true },
    ]);
  });

  it('после выхода сессия не действует', async () => {
    const agent = await login(DEMO_USERS.initiatorAlpha);
    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/me').expect(401);
  });

  it('испорченная, чужая и просроченная cookie — 401, а не ошибка сервера', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/auth/me').set('Cookie', 'sid=%E0%A4%A').expect(401);
    await request(server).get('/api/auth/me').set('Cookie', 'sid=not-a-real-token').expect(401);

    const agent = await login(DEMO_USERS.initiatorAlpha);
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await agent.get('/api/auth/me').expect(401);
  });
});

describe('изоляция пространств и права', () => {
  it('пользователь Beta не читает и не меняет данные Alpha даже по известному ID', async () => {
    const alpha = await login(DEMO_USERS.initiatorAlpha);
    const requestId = await createRequest(alpha);
    const beta = await login(DEMO_USERS.initiatorBeta);

    await beta.get('/api/spaces/alpha/resources').expect(403);
    await beta.get('/api/spaces/alpha/requests').expect(403);
    await beta.get('/api/resources/res-a-01').expect(403);
    await beta.get(`/api/requests/${requestId}`).expect(403);
    await beta.post('/api/requests').send({ resourceId: 'res-a-02' }).expect(403);
    await beta.post(`/api/requests/${requestId}/approve`).expect(403);
    await beta.post(`/api/requests/${requestId}/reject`).expect(403);
    await beta.post(`/api/requests/${requestId}/retry`).expect(403);

    // Свои данные при этом доступны.
    const own = await beta.get('/api/spaces/beta/resources').expect(200);
    expect(own.body.map((r: { id: string }) => r.id)).toEqual(['res-b-01']);
    expect(await statusOf(requestId)).toBe('pending');
  });

  it('пользователи Alpha (включая согласующего) не читают и не меняют данные Beta', async () => {
    const beta = await login(DEMO_USERS.initiatorBeta);
    const requestId = await createRequest(beta, 'res-b-01');

    for (const email of [DEMO_USERS.approverAlpha, DEMO_USERS.universalAlpha, DEMO_USERS.initiatorAlpha]) {
      const alpha = await login(email);
      await alpha.get('/api/spaces/beta/resources').expect(403);
      await alpha.get('/api/spaces/beta/requests').expect(403);
      await alpha.get('/api/resources/res-b-01').expect(403);
      await alpha.get(`/api/requests/${requestId}`).expect(403);
      await alpha.post('/api/requests').send({ resourceId: 'res-b-01' }).expect(403);
      await alpha.post(`/api/requests/${requestId}/approve`).expect(403);
      await alpha.post(`/api/requests/${requestId}/reject`).expect(403);
      await alpha.post(`/api/requests/${requestId}/retry`).expect(403);
    }
    expect(await statusOf(requestId)).toBe('pending');
    expect(await prisma.dispatchJob.count()).toBe(0);
  });

  it('роль и пространство нельзя подставить в тело запроса', async () => {
    const approver = await login(DEMO_USERS.approverAlpha);
    // У согласующего нет права создавать заявки, что бы он ни прислал.
    await approver
      .post('/api/requests')
      .send({ resourceId: 'res-a-01', canInitiate: true, role: 'initiator', spaceId: 'alpha', createdById: 'x' })
      .expect(403);

    const initiator = await login(DEMO_USERS.initiatorAlpha);
    const id = await createRequest(initiator);
    // У инициатора нет права согласования.
    await initiator.post(`/api/requests/${id}/approve`).send({ canApprove: true }).expect(403);
    const other = await login(DEMO_USERS.universalAlpha);
    await other.post(`/api/requests/${id}/approve`).send({ decidedById: 'x' }).expect(200);

    const saved = await prisma.renewalRequest.findUniqueOrThrow({
      where: { id },
      include: { createdBy: true, decidedBy: true },
    });
    expect(saved.createdBy.email).toBe(DEMO_USERS.initiatorAlpha);
    expect(saved.decidedBy?.email).toBe(DEMO_USERS.universalAlpha);
  });

  it('несуществующие ресурс и заявка — 404', async () => {
    const agent = await login(DEMO_USERS.universalAlpha);
    await agent.get('/api/resources/nope').expect(404);
    await agent.get('/api/requests/nope').expect(404);
    await agent.post('/api/requests').send({ resourceId: 'nope' }).expect(404);
    await agent.post('/api/requests').send({}).expect(400);
  });
});

describe('создание заявки', () => {
  it('фиксирует снимок, не меняет срок ресурса, пишет историю', async () => {
    const agent = await login(DEMO_USERS.initiatorAlpha);
    const response = await agent.post('/api/requests').send({ resourceId: 'res-a-01' }).expect(201);

    expect(response.body).toMatchObject({
      status: 'pending',
      resourceId: 'res-a-01',
      amountMinor: 128000,
      currency: 'RUB',
      oldExpiresOn: '2027-03-01',
      newExpiresOn: '2027-03-31',
      createdBy: { name: 'Инициатор Alpha' },
    });
    expect(response.body.events).toHaveLength(1);
    expect(response.body.events[0]).toMatchObject({ actor: 'Инициатор Alpha', fromStatus: null, toStatus: 'pending' });
    expect(await expiresOn('res-a-01')).toBe('2027-03-01');
  });

  it('вторая активная заявка на тот же ресурс — 409', async () => {
    const agent = await login(DEMO_USERS.initiatorAlpha);
    await createRequest(agent);
    await agent.post('/api/requests').send({ resourceId: 'res-a-01' }).expect(409);
    // Другой ресурс того же пространства не затронут.
    await createRequest(agent, 'res-a-02');
  });

  it('параллельные запросы не обходят правило: создаётся ровно одна заявка', async () => {
    const first = await login(DEMO_USERS.initiatorAlpha);
    const second = await login(DEMO_USERS.universalAlpha);
    const responses = await Promise.all(
      [first, second, first, second, first, second].map((agent) =>
        agent.post('/api/requests').send({ resourceId: 'res-a-01' }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await prisma.renewalRequest.count({ where: { resourceId: 'res-a-01' } })).toBe(1);
  });

  it('база сама отклоняет вторую активную заявку, даже в обход приложения', async () => {
    const agent = await login(DEMO_USERS.initiatorAlpha);
    const id = await createRequest(agent);
    const existing = await prisma.renewalRequest.findUniqueOrThrow({ where: { id } });
    await expect(
      prisma.renewalRequest.create({
        data: {
          resourceId: existing.resourceId,
          spaceId: existing.spaceId,
          createdById: existing.createdById,
          amountMinor: existing.amountMinor,
          currency: existing.currency,
          oldExpiresOn: existing.oldExpiresOn,
          newExpiresOn: existing.newExpiresOn,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('согласование и отклонение', () => {
  it('свою заявку нельзя ни одобрить, ни отклонить, даже с обеими ролями', async () => {
    const universal = await login(DEMO_USERS.universalAlpha);
    const id = await createRequest(universal);
    await universal.post(`/api/requests/${id}/approve`).expect(403);
    await universal.post(`/api/requests/${id}/reject`).expect(403);
    expect(await statusOf(id)).toBe('pending');

    const approver = await login(DEMO_USERS.approverAlpha);
    await approver.post(`/api/requests/${id}/approve`).expect(200);
  });

  it('одобрение атомарно ставит задачу; повторное одобрение и отклонение — 409', async () => {
    const id = await createRequest(await login(DEMO_USERS.initiatorAlpha));
    const approver = await login(DEMO_USERS.approverAlpha);

    const approved = await approver.post(`/api/requests/${id}/approve`).expect(200);
    expect(approved.body.status).toBe('executing');
    expect(approved.body.decidedBy.name).toBe('Согласующий Alpha');
    expect(await prisma.dispatchJob.count({ where: { requestId: id } })).toBe(1);

    await approver.post(`/api/requests/${id}/approve`).expect(409);
    await approver.post(`/api/requests/${id}/reject`).expect(409);
    expect(await prisma.dispatchJob.count()).toBe(1);
    // До ответа провайдера срок не меняется.
    expect(await expiresOn('res-a-01')).toBe('2027-03-01');
  });

  it('два параллельных одобрения: один успех, один 409, одна задача', async () => {
    const id = await createRequest(await login(DEMO_USERS.initiatorAlpha));
    const approver = await login(DEMO_USERS.approverAlpha);
    const universal = await login(DEMO_USERS.universalAlpha);

    const responses = await Promise.all([
      approver.post(`/api/requests/${id}/approve`),
      universal.post(`/api/requests/${id}/approve`),
      approver.post(`/api/requests/${id}/approve`),
      universal.post(`/api/requests/${id}/approve`),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(await prisma.dispatchJob.count()).toBe(1);
    expect(
      await prisma.requestEvent.count({ where: { requestId: id, toStatus: 'executing', fromStatus: 'pending' } }),
    ).toBe(1);
  });

  it('одновременные одобрение и отклонение: срабатывает только одно решение', async () => {
    const id = await createRequest(await login(DEMO_USERS.initiatorAlpha));
    const approver = await login(DEMO_USERS.approverAlpha);
    const universal = await login(DEMO_USERS.universalAlpha);

    const [approved, rejected] = await Promise.all([
      approver.post(`/api/requests/${id}/approve`),
      universal.post(`/api/requests/${id}/reject`),
    ]);
    expect([approved.status, rejected.status].sort()).toEqual([200, 409]);
    const status = await statusOf(id);
    expect(status).toBe(approved.status === 200 ? 'executing' : 'rejected');
    // Задача есть только у одобренной заявки.
    expect(await prisma.dispatchJob.count()).toBe(status === 'executing' ? 1 : 0);
  });

  it('отклонённая заявка не идёт к провайдеру и не меняет срок; затем можно создать новую', async () => {
    const initiator = await login(DEMO_USERS.initiatorAlpha);
    const id = await createRequest(initiator);
    const approver = await login(DEMO_USERS.approverAlpha);

    const rejected = await approver.post(`/api/requests/${id}/reject`).expect(200);
    expect(rejected.body.status).toBe('rejected');
    await approver.post(`/api/requests/${id}/reject`).expect(409);
    await approver.post(`/api/requests/${id}/approve`).expect(409);

    await worker.tick();
    expect(await prisma.dispatchJob.count()).toBe(0);
    expect(provider.postCount + provider.getCount).toBe(0);
    expect(await expiresOn('res-a-01')).toBe('2027-03-01');

    await createRequest(initiator);
  });

  it('если срок или стоимость ресурса изменились после создания заявки — 409 и провайдеру ничего не уходит', async () => {
    const id = await createRequest(await login(DEMO_USERS.initiatorAlpha));
    await prisma.resource.update({ where: { id: 'res-a-01' }, data: { priceMinor: 130_000 } });
    const approver = await login(DEMO_USERS.approverAlpha);

    await approver.post(`/api/requests/${id}/approve`).expect(409);
    expect(await statusOf(id)).toBe('pending');
    expect(await prisma.dispatchJob.count()).toBe(0);
    await worker.tick();
    expect(provider.postCount).toBe(0);

    // То же для изменившегося срока.
    await prisma.resource.update({
      where: { id: 'res-a-01' },
      data: { priceMinor: 128_000, expiresOn: new Date('2027-04-01') },
    });
    await approver.post(`/api/requests/${id}/approve`).expect(409);
    // Устаревшую заявку можно отклонить, чтобы освободить ресурс.
    await approver.post(`/api/requests/${id}/reject`).expect(200);
  });
});

describe('выполнение, неопределённый ответ и восстановление', () => {
  async function approvedRequest(resourceId = 'res-a-01'): Promise<string> {
    const id = await createRequest(await login(DEMO_USERS.initiatorAlpha), resourceId);
    await (await login(DEMO_USERS.approverAlpha)).post(`/api/requests/${id}/approve`).expect(200);
    return id;
  }

  it('контрольный сценарий: 503 -> перезапуск -> тот же ключ -> завершено, срок сдвинут один раз', async () => {
    const id = await approvedRequest();

    // Первая отправка: провайдер операцию создал, но ответил 503.
    await worker.tick();
    expect(provider.postCount).toBe(1);
    expect(provider.operations.has(id)).toBe(true); // ключ операции = id заявки
    expect(await statusOf(id)).toBe('executing');
    expect(await expiresOn('res-a-01')).toBe('2027-03-01');

    // Приложение останавливают и запускают снова. Задача лежит в базе и не теряется.
    await restartApp();
    await worker.tick();

    expect(await statusOf(id)).toBe('completed');
    expect(await expiresOn('res-a-01')).toBe('2027-03-31');
    // Результат получен проверкой по ключу, второго POST не было.
    expect(provider.postCount).toBe(1);
    expect(provider.operations.get(id)?.operation.started_count).toBe(1);
    expect(provider.operationCount('res-a-01')).toBe(1);
    expect(provider.operationCount('res-a-02')).toBe(0);

    const saved = await prisma.renewalRequest.findUniqueOrThrow({ where: { id }, include: { job: true } });
    expect(saved.providerOperationId).toBe(provider.operations.get(id)?.operation.operation_id);
    expect(saved.job?.state).toBe('done');

    // Повторная обработка той же задачи ничего не меняет.
    await prisma.dispatchJob.update({ where: { requestId: id }, data: { state: 'active', nextRunAt: new Date(0) } });
    await worker.tick();
    await worker.tick();
    expect(await expiresOn('res-a-01')).toBe('2027-03-31');
    expect(await statusOf(id)).toBe('completed');
    expect(provider.postCount).toBe(1);
    expect(provider.operationCount('res-a-01')).toBe(1);
    expect(await prisma.requestEvent.count({ where: { requestId: id, toStatus: 'completed' } })).toBe(1);
  });

  it('история показывает автора, время и каждый переход', async () => {
    const id = await approvedRequest();
    await worker.tick();
    await worker.tick();

    const agent = await login(DEMO_USERS.initiatorAlpha);
    const detail = await agent.get(`/api/requests/${id}`).expect(200);
    const transitions = detail.body.events.map(
      (e: { actor: string | null; fromStatus: string | null; toStatus: string }) =>
        `${e.actor ?? 'система'}: ${e.fromStatus ?? '-'} -> ${e.toStatus}`,
    );
    expect(transitions).toEqual([
      'Инициатор Alpha: - -> pending',
      'Согласующий Alpha: pending -> executing',
      'система: executing -> executing', // неопределённый ответ на первую отправку
      'система: executing -> completed',
    ]);
    expect(detail.body.events.every((e: { at: string }) => !Number.isNaN(Date.parse(e.at)))).toBe(true);

    const resource = await agent.get('/api/resources/res-a-01').expect(200);
    expect(resource.body.expiresOn).toBe('2027-03-31');
    expect(resource.body.requests).toHaveLength(1);
  });

  it('после завершения можно создать новую заявку уже от нового срока', async () => {
    await approvedRequest();
    await worker.tick();
    await worker.tick();

    const agent = await login(DEMO_USERS.initiatorAlpha);
    const next = await agent.post('/api/requests').send({ resourceId: 'res-a-01' }).expect(201);
    expect(next.body).toMatchObject({ oldExpiresOn: '2027-03-31', newExpiresOn: '2027-04-30' });
  });

  it('три POST без подтверждения -> «Требует внимания»; повтор с тем же ключом завершает заявку', async () => {
    provider.mode = 'down';
    const id = await approvedRequest();

    for (let i = 0; i < 6; i++) await worker.tick();

    expect(await statusOf(id)).toBe('needs_attention');
    expect(provider.postCount).toBe(3); // GET-проверки попытками не считаются
    expect(provider.getCount).toBeGreaterThanOrEqual(3);
    expect(await expiresOn('res-a-01')).toBe('2027-03-01');

    // Пока результат не разрешён, новая заявка на ресурс недоступна.
    const initiator = await login(DEMO_USERS.initiatorAlpha);
    await initiator.post('/api/requests').send({ resourceId: 'res-a-01' }).expect(409);

    // Повторить может только пользователь с правом согласования.
    await initiator.post(`/api/requests/${id}/retry`).expect(403);
    provider.mode = 'simulator';
    const approver = await login(DEMO_USERS.approverAlpha);
    const retried = await approver.post(`/api/requests/${id}/retry`).expect(200);
    expect(retried.body.status).toBe('executing');
    await approver.post(`/api/requests/${id}/retry`).expect(409);

    for (let i = 0; i < 3; i++) await worker.tick();

    expect(await statusOf(id)).toBe('completed');
    expect(await expiresOn('res-a-01')).toBe('2027-03-31');
    expect([...provider.operations.keys()]).toEqual([id]);
    expect(provider.operationCount('res-a-01')).toBe(1);
  });

  it('операция выполнилась у провайдера, но все ответы потерялись: повтор находит её и не создаёт вторую', async () => {
    const id = await approvedRequest();
    await worker.tick(); // POST: операция создана, ответ 503
    provider.mode = 'down'; // дальше провайдер недоступен
    for (let i = 0; i < 6; i++) await worker.tick();
    expect(await statusOf(id)).toBe('needs_attention');

    provider.mode = 'simulator';
    await (await login(DEMO_USERS.approverAlpha)).post(`/api/requests/${id}/retry`).expect(200);
    await worker.tick();

    expect(await statusOf(id)).toBe('completed');
    expect(await expiresOn('res-a-01')).toBe('2027-03-31');
    expect(provider.operationCount('res-a-01')).toBe(1);
    expect(provider.operations.get(id)?.operation.started_count).toBe(1);
  });

  it('задачу, занятую другим обработчиком, не трогаем; после истечения захвата — подбираем', async () => {
    const id = await approvedRequest();
    // Как будто другой экземпляр взял задачу и ещё работает (или упал посреди работы).
    await prisma.dispatchJob.update({
      where: { requestId: id },
      data: { lockedUntil: new Date(Date.now() + 60_000) },
    });
    await worker.tick();
    expect(provider.postCount + provider.getCount).toBe(0);
    expect(await statusOf(id)).toBe('executing');

    // Захват истёк: задачу можно взять снова, она доводится до конца.
    await prisma.dispatchJob.update({ where: { requestId: id }, data: { lockedUntil: new Date(Date.now() - 1) } });
    await worker.tick();
    await worker.tick();
    expect(await statusOf(id)).toBe('completed');
    expect(provider.operationCount('res-a-01')).toBe(1);
  });

  it('остановка сразу после отправки POST: попытка учтена, пауза сохранена, результат находится по ключу', async () => {
    process.env.PROVIDER_RETRY_DELAY_MS = '60000';
    try {
      const id = await approvedRequest();
      await worker.tick(); // POST ушёл, ответ 503
      const job = await prisma.dispatchJob.findUniqueOrThrow({ where: { requestId: id } });
      expect(job.postAttempts).toBe(1);
      expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 30_000);

      // Пока пауза не прошла, обработчик к провайдеру не ходит.
      const callsBefore = provider.postCount + provider.getCount;
      await restartApp();
      await worker.tick();
      expect(provider.postCount + provider.getCount).toBe(callsBefore);

      // Пауза прошла: проверка по ключу находит операцию, второго POST нет.
      await prisma.dispatchJob.update({ where: { requestId: id }, data: { nextRunAt: new Date(0) } });
      await worker.tick();
      expect(await statusOf(id)).toBe('completed');
      expect(provider.postCount).toBe(1);
      expect(await expiresOn('res-a-01')).toBe('2027-03-31');
    } finally {
      process.env.PROVIDER_RETRY_DELAY_MS = '0';
    }
  });

  it('операция у провайдера не совпадает с заявкой -> «Требует внимания», срок не меняется', async () => {
    const id = await approvedRequest();
    // У провайдера под нашим ключом уже лежит операция с другой суммой.
    provider.operations.set(id, {
      payload: '{}',
      operation: {
        operation_id: 'foreign',
        status: 'completed',
        started_count: 1,
        resource_id: 'res-a-01',
        period_months: 1,
        amount_minor: 1,
        currency: 'RUB',
      },
    });
    await worker.tick();

    expect(await statusOf(id)).toBe('needs_attention');
    expect(await expiresOn('res-a-01')).toBe('2027-03-01');
    expect(provider.postCount).toBe(0);
    const detail = await (await login(DEMO_USERS.approverAlpha)).get(`/api/requests/${id}`).expect(200);
    expect(detail.body.lastError).toContain('не совпадает');
    expect(detail.body.can.retry).toBe(true);
  });

  it('повтор недоступен для заявки не в состоянии «Требует внимания»', async () => {
    const id = await createRequest(await login(DEMO_USERS.initiatorAlpha));
    const approver = await login(DEMO_USERS.approverAlpha);
    await approver.post(`/api/requests/${id}/retry`).expect(409);
  });
});
