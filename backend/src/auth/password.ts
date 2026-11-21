import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Пароли хешируются scrypt из стандартной библиотеки Node: соль + хеш, без сторонних пакетов.
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function newSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/** В базе хранится только хеш токена: утечка таблицы сессий не даёт войти. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
