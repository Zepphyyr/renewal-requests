import { Injectable } from '@nestjs/common';
import { config } from '../config';

export type RenewalPayload = {
  resource_id: string;
  period_months: number;
  amount_minor: number;
  currency: string;
};

export type ProviderOperation = RenewalPayload & {
  operation_id: string;
  status: string;
  started_count: number;
};

/**
 * Три возможных исхода обращения к провайдеру:
 *  - found:    провайдер вернул операцию (она точно существует);
 *  - rejected: провайдер ответил определённым отказом (4xx) — повторять бессмысленно;
 *  - unknown:  503, таймаут, обрыв сети — мы НЕ знаем, выполнена ли операция.
 * Для GET добавляется not_found: провайдер точно не знает такого ключа.
 */
export type ProviderResult =
  | { kind: 'found'; operation: ProviderOperation }
  | { kind: 'not_found' }
  | { kind: 'rejected'; httpStatus: number }
  | { kind: 'unknown'; reason: string };

@Injectable()
export class ProviderClient {
  /** Создать операцию продления. Ключ идемпотентности один и тот же при любых повторах. */
  post(key: string, payload: RenewalPayload): Promise<ProviderResult> {
    return this.call(`${config.providerUrl}/renewals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(payload),
    });
  }

  /** Узнать результат по ключу, не создавая новой операции. */
  get(key: string): Promise<ProviderResult> {
    return this.call(`${config.providerUrl}/renewals/${encodeURIComponent(key)}`, { method: 'GET' });
  }

  private async call(url: string, init: RequestInit): Promise<ProviderResult> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(config.providerTimeoutMs) });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      return { kind: 'unknown', reason: name === 'TimeoutError' ? 'таймаут' : 'нет соединения' };
    }
    if (response.status === 200) {
      const operation = await response.json().catch(() => null);
      if (isOperation(operation)) return { kind: 'found', operation };
      return { kind: 'unknown', reason: 'непонятный ответ HTTP 200' };
    }
    if (response.status === 404 && init.method === 'GET') return { kind: 'not_found' };
    if (response.status >= 400 && response.status < 500) {
      return { kind: 'rejected', httpStatus: response.status };
    }
    return { kind: 'unknown', reason: `HTTP ${response.status}` };
  }
}

function isOperation(value: unknown): value is ProviderOperation {
  const op = value as ProviderOperation | null;
  return (
    !!op &&
    typeof op.operation_id === 'string' &&
    typeof op.status === 'string' &&
    typeof op.resource_id === 'string' &&
    typeof op.amount_minor === 'number'
  );
}
