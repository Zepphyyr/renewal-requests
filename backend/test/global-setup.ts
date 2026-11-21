import { execSync } from 'node:child_process';
import { TEST_DATABASE_URL } from './setup-env';

// Один раз перед всеми тестами: применяем миграции к отдельной тестовой базе.
export default function globalSetup() {
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
  });
}
