// Настройки читаются из окружения в момент обращения, поэтому тесты могут их менять.
const num = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const config = {
  get port() {
    return num('PORT', 4000);
  },
  get providerUrl() {
    return (process.env.PROVIDER_URL ?? 'http://127.0.0.1:8091').replace(/\/+$/, '');
  },
  get providerTimeoutMs() {
    return num('PROVIDER_TIMEOUT_MS', 5000);
  },
  /** Пауза после неопределённого ответа перед GET-проверкой или повторным POST. */
  get retryDelayMs() {
    return num('PROVIDER_RETRY_DELAY_MS', 15000);
  },
  get workerPollMs() {
    return num('WORKER_POLL_MS', 1000);
  },
  get workerEnabled() {
    return process.env.WORKER_ENABLED !== 'false';
  },
};

/** Сколько POST-попыток делаем, прежде чем заявка уходит в «Требует внимания». */
export const MAX_POST_ATTEMPTS = 3;
/** Срок сессии. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
