import { FormEvent, MouseEvent, ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  api,
  ApiError,
  formatDate,
  formatDateTime,
  formatMoney,
  RequestDetail,
  RequestItem,
  Resource,
  ResourceDetail,
  SpaceAccess,
  Status,
  STATUS_LABEL,
  User,
} from './api';

const REFRESH_MS = 3000;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Неизвестная ошибка';

// ---------------------------------------------------------------- приложение

export function App() {
  // undefined — ещё проверяем сессию; null — не вошёл.
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api<User>('/auth/me')
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return <p className="page-note" aria-busy="true">Загрузка…</p>;
  if (user === null) return <Login onLogin={setUser} />;
  return <Workspace user={user} onLogout={() => setUser(null)} />;
}

// ---------------------------------------------------------------- вход

const DEMO_ACCOUNTS = [
  ['Инициатор Alpha', 'initiator.alpha@example.test'],
  ['Согласующий Alpha', 'approver.alpha@example.test'],
  ['Инициатор Beta', 'initiator.beta@example.test'],
  ['Универсальный Alpha', 'universal.alpha@example.test'],
] as const;
const DEMO_PASSWORD = 'renewals-demo';

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api<User>('/auth/login', 'POST', { email, password }));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <main className="shell shell-narrow">
      <h1>Заявки на продление</h1>
      <p className="subtitle">Вход в систему</p>
      <form className="card form" onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            autoFocus
          />
        </label>
        <label>
          Пароль
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="alert" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Входим…' : 'Войти'}
        </button>
        <div className="demo">
          <p className="muted">Тестовые учётные записи (данные вымышленные):</p>
          {DEMO_ACCOUNTS.map(([name, mail]) => (
            <button
              key={mail}
              type="button"
              className="ghost"
              onClick={() => {
                setEmail(mail);
                setPassword(DEMO_PASSWORD);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------- рабочее пространство

type Opened =
  | { kind: 'request'; id: string }
  | { kind: 'resource'; id: string }
  | { kind: 'create' }
  | null;

function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [access, setAccess] = useState<SpaceAccess | undefined>(user.memberships[0]);
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [requests, setRequests] = useState<RequestItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened>(null);
  const spaceId = access?.spaceId;

  const load = useCallback(async () => {
    if (!spaceId) return;
    try {
      const [nextResources, nextRequests] = await Promise.all([
        api<Resource[]>(`/spaces/${spaceId}/resources`),
        api<RequestItem[]>(`/spaces/${spaceId}/requests`),
      ]);
      setResources(nextResources);
      setRequests(nextRequests);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onLogout();
      setError(errorText(e));
    }
  }, [spaceId, onLogout]);

  // Первая загрузка и тихое обновление раз в несколько секунд:
  // так статус «Выполняется» сам сменится на «Завершена», когда отработает обработчик.
  useEffect(() => {
    setResources(null);
    setRequests(null);
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function logout() {
    await api('/auth/logout', 'POST').catch(() => undefined);
    onLogout();
  }

  const count = (status: Status) => requests?.filter((r) => r.status === status).length ?? 0;
  const loading = !error && (resources === null || requests === null);

  return (
    <main className="shell">
      <header className="topbar">
        <span className="muted">{user.name}</span>
        {user.memberships.length > 1 && (
          <select
            aria-label="Рабочее пространство"
            value={spaceId}
            onChange={(e) => setAccess(user.memberships.find((m) => m.spaceId === e.target.value))}
          >
            {user.memberships.map((m) => (
              <option key={m.spaceId} value={m.spaceId}>
                {m.spaceName}
              </option>
            ))}
          </select>
        )}
        <button className="ghost" onClick={logout}>
          Выйти
        </button>
      </header>

      <h1>Заявки на продление</h1>
      <p className="subtitle">Рабочее пространство: {access?.spaceName ?? 'нет доступа'}</p>

      {!access && <p className="alert" role="alert">У этой учётной записи нет доступа ни к одному пространству.</p>}
      {error && (
        <p className="alert" role="alert">
          {error}{' '}
          <button className="link" onClick={() => void load()}>
            Повторить
          </button>
        </p>
      )}

      {access && (
        <>
          <section className="card" aria-labelledby="requests-title" aria-busy={loading}>
            <h2 id="requests-title" className="visually-hidden">
              Заявки
            </h2>
            {requests && (
              <p className="counters">
                <span>Всего: {requests.length}</span>
                <span className="st-pending">Ожидают: {count('pending')}</span>
                <span className="st-executing">Выполняется: {count('executing')}</span>
                {count('needs_attention') > 0 && (
                  <span className="st-needs_attention">Требуют внимания: {count('needs_attention')}</span>
                )}
              </p>
            )}

            {loading && <p className="state">Загрузка…</p>}
            {requests?.length === 0 && (
              <p className="state">
                Заявок пока нет.
                {access.canInitiate && ' Создайте первую кнопкой ниже.'}
              </p>
            )}
            {requests && requests.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Ресурс</th>
                    <th>Срок</th>
                    <th>Стоимость</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Ресурс">
                        <button className="link" onClick={() => setOpened({ kind: 'request', id: r.id })}>
                          {r.resourceName}
                        </button>
                      </td>
                      <td data-label="Срок">
                        {formatDate(r.oldExpiresOn)} <span className="muted">→ {formatDate(r.newExpiresOn)}</span>
                      </td>
                      <td data-label="Стоимость">{formatMoney(r.amountMinor, r.currency)}</td>
                      <td data-label="Статус">
                        <StatusText status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="card-footer">
              {access.canInitiate ? (
                <button className="primary" onClick={() => setOpened({ kind: 'create' })} disabled={!resources}>
                  Создать заявку
                </button>
              ) : (
                <span className="muted">У вас нет права создавать заявки</span>
              )}
              <span className="muted small">Нажмите на ресурс, чтобы открыть заявку и её историю</span>
            </div>
          </section>

          <section className="card" aria-labelledby="resources-title" aria-busy={loading}>
            <h2 id="resources-title">Ресурсы</h2>
            {loading && <p className="state">Загрузка…</p>}
            {resources?.length === 0 && <p className="state">В этом пространстве нет ресурсов.</p>}
            {resources && resources.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Ресурс</th>
                    <th>Текущий срок</th>
                    <th>Стоимость</th>
                    <th>Активная заявка</th>
                  </tr>
                </thead>
                <tbody>
                  {resources.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Ресурс">
                        <button className="link" onClick={() => setOpened({ kind: 'resource', id: r.id })}>
                          {r.name}
                        </button>{' '}
                        <span className="muted small">{r.id}</span>
                      </td>
                      <td data-label="Текущий срок">{formatDate(r.expiresOn)}</td>
                      <td data-label="Стоимость">{formatMoney(r.priceMinor, r.currency)}</td>
                      <td data-label="Активная заявка">
                        {r.activeRequest ? <StatusText status={r.activeRequest.status} /> : <span className="muted">нет</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {opened?.kind === 'request' && (
        <RequestDialog id={opened.id} onClose={() => setOpened(null)} onChanged={load} />
      )}
      {opened?.kind === 'resource' && (
        <ResourceDialog
          id={opened.id}
          onClose={() => setOpened(null)}
          onOpenRequest={(id) => setOpened({ kind: 'request', id })}
        />
      )}
      {opened?.kind === 'create' && resources && (
        <CreateDialog
          resources={resources}
          onClose={() => setOpened(null)}
          onCreated={(id) => {
            void load();
            setOpened({ kind: 'request', id });
          }}
        />
      )}
    </main>
  );
}

function StatusText({ status }: { status: Status }) {
  return <span className={`status st-${status}`}>{STATUS_LABEL[status]}</span>;
}

// ---------------------------------------------------------------- окна

/** Обёртка над встроенным <dialog>: фокус внутри окна и закрытие по Esc даёт сам браузер. */
function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);

  // Кнопки с атрибутом data-close закрывают окно через dialog.close():
  // тогда браузер сам возвращает фокус на элемент, с которого окно открыли.
  function closeByButton(event: MouseEvent<HTMLDialogElement>) {
    if ((event.target as HTMLElement).closest('[data-close]')) ref.current?.close();
  }

  return (
    <dialog ref={ref} onClose={onClose} onClick={closeByButton} aria-labelledby={titleId}>
      <header className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button className="ghost" data-close aria-label="Закрыть окно">
          ✕
        </button>
      </header>
      {children}
    </dialog>
  );
}

function CreateDialog({
  resources,
  onClose,
  onCreated,
}: {
  resources: Resource[];
  onClose: () => void;
  onCreated: (requestId: string) => void;
}) {
  const free = resources.filter((r) => !r.activeRequest);
  const [resourceId, setResourceId] = useState(free[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = resources.find((r) => r.id === resourceId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api<RequestDetail>('/requests', 'POST', { resourceId });
      onCreated(created.id);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Dialog title="Новая заявка на продление" onClose={onClose}>
      {free.length === 0 ? (
        <p className="state">У всех ресурсов уже есть активная заявка. Новую можно создать после её завершения.</p>
      ) : (
        <form className="form" onSubmit={submit}>
          <label>
            Ресурс
            <select value={resourceId} onChange={(e) => setResourceId(e.target.value)} autoFocus>
              {resources.map((r) => (
                <option key={r.id} value={r.id} disabled={!!r.activeRequest}>
                  {r.name} ({r.id}){r.activeRequest ? ' — уже есть активная заявка' : ''}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <dl className="facts">
              <dt>Текущий срок</dt>
              <dd>{formatDate(selected.expiresOn)}</dd>
              <dt>Продление</dt>
              <dd>на 30 календарных дней</dd>
              <dt>Стоимость</dt>
              <dd>{formatMoney(selected.priceMinor, selected.currency)}</dd>
            </dl>
          )}
          {error && <p className="alert" role="alert">{error}</p>}
          <div className="actions">
            <button className="primary" disabled={busy || !resourceId}>
              {busy ? 'Создаём…' : 'Создать заявку'}
            </button>
            <button type="button" className="ghost" data-close>
              Отмена
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function RequestDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api<RequestDetail>(`/requests/${id}`));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function act(action: 'approve' | 'reject' | 'retry') {
    setBusy(true);
    setActionError(null);
    try {
      setDetail(await api<RequestDetail>(`/requests/${id}/${action}`, 'POST'));
    } catch (e) {
      setActionError(errorText(e));
      void load(); // показать актуальное состояние, если нас опередили
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <Dialog title={detail ? `Заявка: ${detail.resourceName}` : 'Заявка'} onClose={onClose}>
      {!detail && !loadError && <p className="state" aria-busy="true">Загрузка…</p>}
      {loadError && <p className="alert" role="alert">{loadError}</p>}
      {detail && (
        <>
          <dl className="facts">
            <dt>Статус</dt>
            <dd>
              <StatusText status={detail.status} />
            </dd>
            <dt>Ресурс</dt>
            <dd>
              {detail.resourceName} <span className="muted small">{detail.resourceId}</span>
            </dd>
            <dt>Срок</dt>
            <dd>
              {formatDate(detail.oldExpiresOn)} → {formatDate(detail.newExpiresOn)}
            </dd>
            <dt>Сумма</dt>
            <dd>{formatMoney(detail.amountMinor, detail.currency)}</dd>
            <dt>Создал</dt>
            <dd>{detail.createdBy.name}</dd>
            <dt>Решение принял</dt>
            <dd>{detail.decidedBy?.name ?? '—'}</dd>
            <dt>Ключ операции</dt>
            <dd className="mono">{detail.operationKey}</dd>
            {detail.providerOperationId && (
              <>
                <dt>Операция провайдера</dt>
                <dd className="mono">{detail.providerOperationId}</dd>
              </>
            )}
          </dl>

          {detail.status === 'executing' && (
            <p className="note">Заявка отправляется провайдеру. Статус обновится автоматически.</p>
          )}
          {detail.lastError && <p className="alert" role="alert">{detail.lastError}</p>}
          {detail.status === 'pending' && !detail.can.approve && (
            <p className="note">Решение по этой заявке принимает другой сотрудник с правом согласования.</p>
          )}
          {actionError && <p className="alert" role="alert">{actionError}</p>}

          {(detail.can.approve || detail.can.reject || detail.can.retry) && (
            <div className="actions">
              {detail.can.approve && (
                <button className="primary" disabled={busy} onClick={() => act('approve')}>
                  Одобрить
                </button>
              )}
              {detail.can.reject && (
                <button className="danger" disabled={busy} onClick={() => act('reject')}>
                  Отклонить
                </button>
              )}
              {detail.can.retry && (
                <button className="primary" disabled={busy} onClick={() => act('retry')}>
                  Повторить обработку
                </button>
              )}
            </div>
          )}

          <h3>История</h3>
          <ol className="history">
            {detail.events.map((event) => (
              <li key={event.id}>
                <div>
                  <time dateTime={event.at}>{formatDateTime(event.at)}</time>
                  <span className="muted"> · {event.actor ?? 'Система'}</span>
                </div>
                <div>
                  {event.fromStatus && event.fromStatus !== event.toStatus && (
                    <>
                      <StatusText status={event.fromStatus} /> →{' '}
                    </>
                  )}
                  <StatusText status={event.toStatus} />
                </div>
                {event.note && <div className="muted">{event.note}</div>}
              </li>
            ))}
          </ol>
        </>
      )}
    </Dialog>
  );
}

function ResourceDialog({
  id,
  onClose,
  onOpenRequest,
}: {
  id: string;
  onClose: () => void;
  onOpenRequest: (requestId: string) => void;
}) {
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ResourceDetail>(`/resources/${id}`)
      .then(setDetail)
      .catch((e) => setError(errorText(e)));
  }, [id]);

  return (
    <Dialog title={detail?.name ?? 'Ресурс'} onClose={onClose}>
      {!detail && !error && <p className="state" aria-busy="true">Загрузка…</p>}
      {error && <p className="alert" role="alert">{error}</p>}
      {detail && (
        <>
          <dl className="facts">
            <dt>ID</dt>
            <dd className="mono">{detail.id}</dd>
            <dt>Текущий срок</dt>
            <dd>{formatDate(detail.expiresOn)}</dd>
            <dt>Стоимость</dt>
            <dd>{formatMoney(detail.priceMinor, detail.currency)}</dd>
          </dl>
          <h3>История заявок</h3>
          {detail.requests.length === 0 ? (
            <p className="state">По этому ресурсу заявок ещё не было.</p>
          ) : (
            <ol className="history">
              {detail.requests.map((r) => (
                <li key={r.id}>
                  <div>
                    <time dateTime={r.createdAt}>{formatDateTime(r.createdAt)}</time>
                    <span className="muted"> · {r.createdBy}</span>
                  </div>
                  <div>
                    <StatusText status={r.status} />
                    <span className="muted">
                      {' '}
                      · {formatDate(r.oldExpiresOn)} → {formatDate(r.newExpiresOn)} · {formatMoney(r.amountMinor, r.currency)}
                    </span>
                  </div>
                  <button className="link" onClick={() => onOpenRequest(r.id)}>
                    Открыть заявку
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Dialog>
  );
}
