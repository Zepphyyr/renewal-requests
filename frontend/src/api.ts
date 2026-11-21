// Типы ответов API и одна функция запроса. Сессия живёт в httpOnly-cookie,
// поэтому токен в коде страницы не хранится и не виден.

export type Status = 'pending' | 'rejected' | 'executing' | 'completed' | 'needs_attention';

export type SpaceAccess = {
  spaceId: string;
  spaceName: string;
  canInitiate: boolean;
  canApprove: boolean;
};

export type User = { id: string; email: string; name: string; memberships: SpaceAccess[] };

export type Resource = {
  id: string;
  spaceId: string;
  name: string;
  expiresOn: string; // YYYY-MM-DD
  priceMinor: number; // копейки
  currency: string;
  activeRequest: { id: string; status: Status } | null;
};

export type ResourceDetail = Omit<Resource, 'activeRequest'> & {
  requests: {
    id: string;
    status: Status;
    createdBy: string;
    decidedBy: string | null;
    amountMinor: number;
    currency: string;
    oldExpiresOn: string;
    newExpiresOn: string;
    createdAt: string;
  }[];
};

export type RequestItem = {
  id: string;
  operationKey: string;
  resourceId: string;
  resourceName: string;
  status: Status;
  createdBy: { id: string; name: string };
  decidedBy: { id: string; name: string } | null;
  amountMinor: number;
  currency: string;
  oldExpiresOn: string;
  newExpiresOn: string;
  providerOperationId: string | null;
  lastError: string | null;
  postAttempts: number;
  createdAt: string;
  can: { approve: boolean; reject: boolean; retry: boolean };
};

export type HistoryEvent = {
  id: number;
  at: string;
  actor: string | null;
  fromStatus: Status | null;
  toStatus: Status;
  note: string | null;
};

export type RequestDetail = RequestItem & { events: HistoryEvent[] };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const FALLBACK: Record<number, string> = {
  401: 'Требуется вход',
  403: 'Недостаточно прав',
  404: 'Не найдено',
  409: 'Действие сейчас недоступно',
};

export async function api<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Сервер недоступен. Проверьте, что приложение запущено.');
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof data?.message === 'string' ? data.message : FALLBACK[response.status];
    throw new ApiError(response.status, message ?? `Ошибка сервера (${response.status})`);
  }
  return data as T;
}

export const STATUS_LABEL: Record<Status, string> = {
  pending: 'На согласовании',
  rejected: 'Отклонена',
  executing: 'Выполняется',
  completed: 'Завершена',
  needs_attention: 'Требует внимания',
};

/** 2027-03-01 -> 01.03.2027. Работаем со строкой, чтобы часовой пояс не сдвинул день. */
export function formatDate(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day}.${month}.${year}`;
}

/** 128000 копеек -> «1 280,00 RUB» */
export function formatMoney(minor: number, currency: string): string {
  const amount = (minor / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${amount} ${currency}`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
}
