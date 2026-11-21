import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../auth/password';

/** Общий пароль всех тестовых учётных записей. Данные вымышленные. */
export const DEMO_PASSWORD = 'renewals-demo';

export const DEMO_USERS = {
  initiatorAlpha: 'initiator.alpha@example.test',
  approverAlpha: 'approver.alpha@example.test',
  initiatorBeta: 'initiator.beta@example.test',
  universalAlpha: 'universal.alpha@example.test',
} as const;

/** Полностью очищает базу и создаёт начальные данные из задания. */
export async function seed(prisma: PrismaClient): Promise<void> {
  // Порядок удаления — от зависимых таблиц к основным.
  await prisma.dispatchJob.deleteMany();
  await prisma.requestEvent.deleteMany();
  await prisma.renewalRequest.deleteMany();
  await prisma.session.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.user.deleteMany();
  await prisma.space.deleteMany();

  await prisma.space.createMany({
    data: [
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta' },
    ],
  });

  await prisma.resource.createMany({
    data: [
      { id: 'res-a-01', spaceId: 'alpha', name: 'Хранилище A', expiresOn: new Date('2027-03-01'), priceMinor: 128_000 },
      { id: 'res-a-02', spaceId: 'alpha', name: 'Сервис B', expiresOn: new Date('2027-05-20'), priceMinor: 250_000 },
      { id: 'res-b-01', spaceId: 'beta', name: 'Сервис C', expiresOn: new Date('2027-06-01'), priceMinor: 150_000 },
    ],
  });

  const passwordHash = hashPassword(DEMO_PASSWORD);
  const users = [
    { email: DEMO_USERS.initiatorAlpha, name: 'Инициатор Alpha', spaceId: 'alpha', canInitiate: true, canApprove: false },
    { email: DEMO_USERS.approverAlpha, name: 'Согласующий Alpha', spaceId: 'alpha', canInitiate: false, canApprove: true },
    { email: DEMO_USERS.initiatorBeta, name: 'Инициатор Beta', spaceId: 'beta', canInitiate: true, canApprove: false },
    { email: DEMO_USERS.universalAlpha, name: 'Универсальный Alpha', spaceId: 'alpha', canInitiate: true, canApprove: true },
  ];
  for (const { email, name, spaceId, canInitiate, canApprove } of users) {
    await prisma.user.create({
      data: { email, name, passwordHash, memberships: { create: { spaceId, canInitiate, canApprove } } },
    });
  }
}

// Запуск из командной строки: npm run db:seed
if (require.main === module) {
  try {
    process.loadEnvFile();
  } catch {
    // .env необязателен, если переменные заданы в окружении
  }
  const prisma = new PrismaClient();
  seed(prisma)
    .then(() => console.log('Начальные данные созданы.'))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
