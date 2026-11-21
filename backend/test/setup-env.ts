// Выполняется перед каждым тестовым файлом, до создания приложения.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://renewals:renewals@127.0.0.1:5433/renewals_test?schema=public';

process.env.DATABASE_URL = TEST_DATABASE_URL;
// Обработчик в тестах запускаем вручную (worker.tick()), чтобы шаги были предсказуемыми.
process.env.WORKER_ENABLED = 'false';
process.env.PROVIDER_RETRY_DELAY_MS = '0';
process.env.PROVIDER_TIMEOUT_MS = '1000';
