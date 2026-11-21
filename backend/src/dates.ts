// Срок ресурса — календарная дата без времени. В базе это тип DATE,
// Prisma отдаёт его как Date в полночь UTC. Наружу отдаём строку YYYY-MM-DD,
// чтобы часовой пояс сервера или браузера не мог сдвинуть день.

const DAY_MS = 24 * 60 * 60 * 1000;

export const RENEWAL_DAYS = 30;

export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}
