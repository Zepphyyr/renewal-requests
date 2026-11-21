// Контрольный сценарий из раздела «Приёмка» на настоящих процессах:
// приложение запускается, получает 503 от имитатора, ЖЁСТКО останавливается,
// запускается снова и должно завершить заявку без повторного продления.
//
// Перед запуском:
//   1. docker compose up -d        (база)
//   2. python provider_simulator.py (имитатор, СВЕЖЕзапущенный)
//   3. npm run build                (в папке backend)
// Запуск: node scripts/acceptance.mjs   (из папки backend)
// ВНИМАНИЕ: сценарий заново создаёт начальные данные в базе из .env.

import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

try {
  process.loadEnvFile();
} catch {
  // переменные могут быть заданы в окружении
}

const PORT = 4010;
const API = `http://127.0.0.1:${PORT}/api`;
const PROVIDER = (process.env.PROVIDER_URL ?? 'http://127.0.0.1:8091').replace(/\/+$/, '');
const RETRY_DELAY_MS = 8000; // окно, в которое мы останавливаем приложение
const PASSWORD = 'renewals-demo';

let failed = 0;
function check(name, ok, details = '') {
  if (!ok) failed++;
  console.log(`${ok ? '  OK ' : ' FAIL'}  ${name}${details ? `  (${details})` : ''}`);
}

function startApp() {
  const child = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, PORT: String(PORT), PROVIDER_RETRY_DELAY_MS: String(RETRY_DELAY_MS), WORKER_POLL_MS: '500' },
    stdio: 'ignore',
  });
  return child;
}

async function waitForApi() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${API}/health`)).ok) return;
    } catch {
      // ещё не поднялось
    }
    await sleep(200);
  }
  throw new Error('Приложение не запустилось');
}

async function login(email) {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`Вход ${email}: HTTP ${response.status}`);
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  return async (path, method = 'GET', body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const provider = async (path) => {
  const res = await fetch(`${PROVIDER}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function main() {
  const stats0 = await provider('/stats?resource_id=res-a-01').catch(() => null);
  if (!stats0) throw new Error(`Имитатор не отвечает по адресу ${PROVIDER}. Запустите python provider_simulator.py`);
  if (stats0.body.operation_count !== 0) {
    throw new Error('Имитатор не свежий: для res-a-01 уже есть операции. Перезапустите его.');
  }

  execFileSync(process.execPath, ['dist/db/seed.js'], { stdio: 'inherit' });
  let app = startApp();
  try {
    await waitForApi();
    const initiator = await login('initiator.alpha@example.test');
    const approver = await login('approver.alpha@example.test');
    const universal = await login('universal.alpha@example.test');
    const beta = await login('initiator.beta@example.test');

    console.log('\n1. Создание заявки');
    const created = await initiator('/requests', 'POST', { resourceId: 'res-a-01' });
    const id = created.body.id;
    check('заявка создана и находится на согласовании', created.status === 201 && created.body.status === 'pending');
    let resource = await initiator('/resources/res-a-01');
    check('срок ресурса пока не изменился', resource.body.expiresOn === '2027-03-01', resource.body.expiresOn);
    const second = await initiator('/requests', 'POST', { resourceId: 'res-a-01' });
    check('вторая активная заявка отклонена (409)', second.status === 409, `HTTP ${second.status}`);

    console.log('\n2. Изоляция и собственная заявка');
    check('Beta не видит ресурс Alpha (403)', (await beta('/resources/res-a-01')).status === 403);
    check('Beta не видит заявку Alpha по ID (403)', (await beta(`/requests/${id}`)).status === 403);
    const own = await universal('/requests', 'POST', { resourceId: 'res-a-02' });
    const ownApprove = await universal(`/requests/${own.body.id}/approve`, 'POST');
    check('универсальный не может согласовать свою заявку (403)', ownApprove.status === 403, `HTTP ${ownApprove.status}`);

    console.log('\n3. Отклонение');
    const rejected = await approver(`/requests/${own.body.id}/reject`, 'POST');
    check('заявка на res-a-02 отклонена', rejected.status === 200 && rejected.body.status === 'rejected');

    console.log('\n4. Параллельное согласование');
    const [a, b] = await Promise.all([
      approver(`/requests/${id}/approve`, 'POST'),
      universal(`/requests/${id}/approve`, 'POST'),
    ]);
    check('из двух параллельных одобрений прошло одно', [a.status, b.status].sort().join() === '200,409', `${a.status}, ${b.status}`);
    check('повторное одобрение — 409', (await approver(`/requests/${id}/approve`, 'POST')).status === 409);

    console.log('\n5. Первая отправка: операция создана, ответ 503');
    let stats;
    for (let i = 0; i < 40; i++) {
      stats = await provider('/stats?resource_id=res-a-01');
      if (stats.body.operation_count === 1) break;
      await sleep(250);
    }
    check('у имитатора появилась одна операция', stats.body.operation_count === 1);
    let detail = await initiator(`/requests/${id}`);
    check('заявка всё ещё «Выполняется», срок прежний', detail.body.status === 'executing');

    console.log('\n6. Жёсткая остановка приложения и повторный запуск');
    app.kill('SIGKILL');
    await sleep(500);
    check('приложение остановлено', await fetch(`${API}/health`).then(() => false, () => true));
    app = startApp();
    await waitForApi();
    const after = await login('initiator.alpha@example.test');
    for (let i = 0; i < 80; i++) {
      detail = await after(`/requests/${id}`);
      if (detail.body.status !== 'executing') break;
      await sleep(250);
    }
    check('после перезапуска заявка завершена', detail.body.status === 'completed', detail.body.status);
    resource = await after('/resources/res-a-01');
    check('срок ресурса равен 31.03.2027', resource.body.expiresOn === '2027-03-31', resource.body.expiresOn);

    console.log('\n7. Проверка имитатора');
    const operation = await provider(`/renewals/${encodeURIComponent(id)}`);
    check('GET по ключу: started_count = 1', operation.body?.started_count === 1, `ключ ${id}`);
    check('operation_id совпадает с записанным в заявке', operation.body?.operation_id === detail.body.providerOperationId);
    check('stats res-a-01: operation_count = 1', (await provider('/stats?resource_id=res-a-01')).body.operation_count === 1);
    check('stats res-a-02 (отклонённая заявка): 0', (await provider('/stats?resource_id=res-a-02')).body.operation_count === 0);

    console.log('\n8. Повторная обработка не меняет дату');
    await sleep(2000);
    resource = await after('/resources/res-a-01');
    check('срок по-прежнему 31.03.2027', resource.body.expiresOn === '2027-03-31');
    check('срок res-a-02 не менялся', (await after('/resources/res-a-02')).body.expiresOn === '2027-05-20');
    console.log('\nИстория заявки:');
    for (const e of detail.body.events) {
      console.log(`  ${e.actor ?? 'Система'}: ${e.fromStatus ?? '—'} -> ${e.toStatus}  ${e.note ?? ''}`);
    }
  } finally {
    app.kill('SIGKILL');
  }
  console.log(failed ? `\nПровалено проверок: ${failed}` : '\nВсе проверки пройдены.');
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`\nОшибка: ${error.message}`);
  process.exitCode = 1;
});
