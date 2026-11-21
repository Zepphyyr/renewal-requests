import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';

type Payload = Record<string, unknown>;
type Entry = { payload: string; operation: Payload };

/**
 * Копия поведения provider_simulator.py для автотестов (чтобы тесты не требовали Python):
 *  - первый POST с новым ключом сохраняет операцию, но отвечает 503;
 *  - повторный POST с тем же ключом и телом — 200 и прежняя операция;
 *  - тот же ключ с другим телом — 409;
 *  - GET /renewals/{ключ} — 200 или 404.
 * Режим 'down' — провайдер полностью недоступен: любой запрос 503, ничего не сохраняется.
 */
export class ProviderStub {
  mode: 'simulator' | 'down' = 'simulator';
  postCount = 0;
  getCount = 0;
  readonly operations = new Map<string, Entry>();
  private server?: http.Server;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  reset(): void {
    this.mode = 'simulator';
    this.postCount = 0;
    this.getCount = 0;
    this.operations.clear();
  }

  /** Аналог GET /stats?resource_id=... */
  operationCount(resourceId: string): number {
    return [...this.operations.values()].filter((e) => e.operation.resource_id === resourceId).length;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? '/', 'http://stub').pathname;

    if (req.method === 'GET' && path.startsWith('/renewals/')) {
      this.getCount++;
      if (this.mode === 'down') return send(503, { error: 'unavailable' });
      const entry = this.operations.get(decodeURIComponent(path.slice('/renewals/'.length)));
      return entry ? send(200, entry.operation) : send(404, { error: 'not_found' });
    }

    if (req.method === 'POST' && path === '/renewals') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        this.postCount++;
        if (this.mode === 'down') return send(503, { error: 'unavailable' });
        const key = String(req.headers['idempotency-key'] ?? '');
        const data = JSON.parse(raw) as Payload;
        const payload = JSON.stringify(data, Object.keys(data).sort());
        const entry = this.operations.get(key);
        if (!entry) {
          this.operations.set(key, {
            payload,
            operation: { operation_id: randomUUID(), status: 'completed', started_count: 1, ...data },
          });
          return send(503, { error: 'response_lost' });
        }
        if (entry.payload !== payload) return send(409, { error: 'idempotency_key_conflict' });
        return send(200, entry.operation);
      });
      return;
    }
    send(404, { error: 'not_found' });
  }
}
