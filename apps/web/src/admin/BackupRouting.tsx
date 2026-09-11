// Резервная маршрутизация — внешние резервные VPN-подписки (аварийный пул).
//
// Когда обычные серверы NoVPN недоступны (блокировки, белые списки), приложение
// временно уходит на резерв. Общий пул админа доступен пользователям с привилегией
// «Приоритетный доступ»; плюс у каждого может быть своя личная резервная подписка,
// добавленная в приложении (её админ видит здесь только справочно).

import { useEffect, useState } from 'react';
import type { BackupSubscription, BackupServer } from '@novpn/shared';
import type { BackupInput, BackupServersResult } from '../api/types';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import { Field, Loading, Panel, ScreenHeader, Toggle } from '../components/ui';
import { gb, dateShort } from '../lib/format';

// Дата с временем — как в AutoRoute: важен не только день, но и час последнего фетча.
function fmtDateTime(iso: string | null): string {
  if (!iso) return 'ещё не обновлялась';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Статистику ВНЕШНЕЙ подписки провайдеры отдают в ГиБ (по 1024), не в ГБ по 1000:
// у BuzzVPN total=193273528320 — это ровно 180 ГиБ, а не 193. Поэтому делим на 1024³.
const bytes = (n: number | null | undefined) => (n == null ? '—' : gb(n / 1024 ** 3));

// В подписке-ссылке зашит секрет — по умолчанию показываем только хост.
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// unix-секунды срока → дата (или «бессрочно», если провайдер срок не прислал).
function providerExpire(expire: number | null): string {
  if (!expire) return 'бессрочно';
  return dateShort(new Date(expire * 1000).toISOString());
}

// Использовано у провайдера = отдача + приём (если хоть что-то известно).
function providerUsed(p: BackupSubscription['provider']): number | null {
  if (p.download == null && p.upload == null) return null;
  return (p.download ?? 0) + (p.upload ?? 0);
}

export function BackupRouting() {
  const { showToast, showConfirm } = useApp();
  const [shared, setShared] = useState<BackupSubscription[] | null>(null);
  const [personal, setPersonal] = useState<BackupSubscription[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      const r = await api.getBackup();
      setShared(r.shared);
      setPersonal(r.personal);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось загрузить.');
    }
  };
  // Разовая загрузка при первом рендере (как в AutoRoute).
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Обёртка «занят → выполнить → перезагрузить» с показом ошибки тостом.
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не получилось');
    } finally {
      setBusy(null);
    }
  };

  if (err) return <div className="notice notice-red">{err}</div>;
  if (!shared) return <Loading text="Загрузка резерва…" />;

  return (
    <>
      <ScreenHeader eyebrow="Маршрутизация" title="Резервная маршрутизация" />
      <div className="body small muted" style={{ margin: '-8px 0 16px', maxWidth: 680 }}>
        Внешние резервные VPN-подписки. Когда обычные серверы NoVPN недоступны (блокировки, белые списки),
        приложение временно уходит на резерв. Доступен пользователям с привилегией «Приоритетный доступ», плюс
        каждый может добавить свою личную резервную подписку в приложении.
      </div>

      <div className="stack" style={{ gap: 16, maxWidth: 820 }}>
        {/* Общий пул администратора */}
        <Panel
          title={`Общий пул (${shared.filter((s) => s.enabled).length} из ${shared.length} включено)`}
          extra={
            !adding ? (
              <button className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>
                Добавить подписку
              </button>
            ) : null
          }
        >
          <span className="small muted" style={{ marginTop: -4 }}>
            Эти подписки доступны всем, у кого включён «Приоритетный доступ». Пользователь уходит на резерв только
            когда основной маршрут не работает.
          </span>

          {adding ? (
            <SubForm
              busy={busy === 'add'}
              onCancel={() => setAdding(false)}
              onSubmit={(input) =>
                void run('add', async () => {
                  await api.addBackup(input);
                  setAdding(false);
                })
              }
            />
          ) : null}

          {shared.length === 0 && !adding ? (
            <div className="small muted" style={{ marginTop: 8 }}>
              Пока ни одной резервной подписки — добавьте первую.
            </div>
          ) : (
            <div className="stack" style={{ gap: 10, marginTop: 10 }}>
              {shared.map((s) => (
                <SubCard
                  key={s.id}
                  sub={s}
                  busy={busy}
                  onToggle={(v) => void run(`t:${s.id}`, () => api.updateBackup(s.id, { enabled: v }))}
                  onRefresh={() =>
                    void run(`r:${s.id}`, async () => {
                      await api.refreshBackup(s.id);
                      showToast('Подписка обновлена');
                    })
                  }
                  onSave={(patch) => void run(`e:${s.id}`, () => api.updateBackup(s.id, patch))}
                  onDelete={() =>
                    showConfirm({
                      title: 'Удалить резервную подписку?',
                      text: `«${s.title}» перестанет быть доступна пользователям с приоритетным доступом.`,
                      confirmLabel: 'Удалить',
                      danger: true,
                      onConfirm: async () => {
                        await api.deleteBackup(s.id);
                        await load();
                      },
                    })
                  }
                />
              ))}
            </div>
          )}
        </Panel>

        {/* Личные резервные подписки пользователей — только справочно */}
        {personal.length > 0 ? (
          <Panel title={`Личные резервные подписки пользователей (${personal.length})`}>
            <span className="small muted" style={{ marginTop: -4 }}>
              Пользователи добавляют их сами в приложении. Здесь только для справки — расход по ним тоже виден.
            </span>
            <div className="stack" style={{ gap: 8, marginTop: 10 }}>
              {personal.map((s) => (
                <PersonalCard key={s.id} sub={s} />
              ))}
            </div>
          </Panel>
        ) : null}
      </div>
    </>
  );
}

/** Карточка одной подписки из общего пула: статистика, действия, разворот серверов. */
function SubCard({
  sub: s,
  busy,
  onToggle,
  onRefresh,
  onSave,
  onDelete,
}: {
  sub: BackupSubscription;
  busy: string | null;
  onToggle: (v: boolean) => void;
  onRefresh: () => void;
  onSave: (patch: BackupInput) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const [serversOpen, setServersOpen] = useState(false);
  const [servers, setServers] = useState<BackupServersResult | null>(null);
  const [loadingServers, setLoadingServers] = useState(false);
  const anyBusy = !!busy;

  const toggleServers = async () => {
    const next = !serversOpen;
    setServersOpen(next);
    // Грузим состав лениво — только при первом развороте.
    if (next && !servers) {
      setLoadingServers(true);
      try {
        setServers(await api.getBackupServers(s.id));
      } catch {
        setServers({ subscription: s, servers: [], usage: [] });
      } finally {
        setLoadingServers(false);
      }
    }
  };

  if (editing) {
    return (
      <SubForm
        initial={s}
        busy={busy === `e:${s.id}`}
        onCancel={() => setEditing(false)}
        onSubmit={(input) => {
          onSave(input);
          setEditing(false);
        }}
      />
    );
  }

  const used = providerUsed(s.provider);
  const unlimited = s.provider.total == null || s.provider.total === 0;
  const remaining = !unlimited && s.provider.total != null && used != null ? Math.max(0, s.provider.total - used) : null;

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, opacity: s.enabled ? 1 : 0.55 }}>
      <div className="row-between" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: 8, minWidth: 0, alignItems: 'baseline' }}>
          <b style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</b>
          <span className="small muted">{s.format ?? 'формат неизвестен'}</span>
          <span className="small muted">· серверов: {s.serverCount}</span>
        </div>
        <Toggle on={s.enabled} onChange={onToggle} ariaLabel="Подписка включена" />
      </div>

      {/* URL с секретом: по умолчанию только хост, полную ссылку показываем по кнопке. */}
      <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="small mono" style={{ color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
          {showUrl ? s.url : hostOf(s.url)}
        </span>
        <button className="btn btn-outline btn-sm" onClick={() => setShowUrl((v) => !v)}>
          {showUrl ? 'Скрыть ссылку' : 'Показать ссылку'}
        </button>
      </div>

      {s.lastError ? (
        <div className="small" style={{ color: 'var(--red-fg)', wordBreak: 'break-word' }}>
          Ошибка: {s.lastError}
        </div>
      ) : null}

      {/* Две статистики: провайдера (его лимит) и наша (сколько мы через неё прогнали). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 14px', fontSize: 12 }}>
        <span className="muted">У провайдера</span>
        <span>
          {used == null ? '—' : bytes(used)} использовано
          {' · '}
          {unlimited ? 'лимит безлимит' : `лимит ${bytes(s.provider.total)}`}
          {remaining != null ? ` · остаток ${bytes(remaining)}` : ''}
          {' · '}срок {providerExpire(s.provider.expire)}
        </span>
        <span className="muted">Наш расход</span>
        <span className="mono">{bytes(s.internalBytes)}</span>
        <span className="muted">Обновлено</span>
        <span>{fmtDateTime(s.lastFetchedAt)}</span>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-outline btn-sm" disabled={anyBusy} onClick={onRefresh}>
          {busy === `r:${s.id}` ? 'Обновляем…' : 'Обновить'}
        </button>
        <button className="btn btn-outline btn-sm" disabled={anyBusy} onClick={() => setEditing(true)}>
          Изменить
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => void toggleServers()}>
          {serversOpen ? 'Скрыть серверы' : 'Серверы'}
        </button>
        <button className="btn btn-danger-outline btn-sm" disabled={anyBusy} onClick={onDelete}>
          Удалить
        </button>
      </div>

      {serversOpen ? (
        loadingServers ? (
          <span className="small muted">Загрузка состава…</span>
        ) : (
          <ServersView data={servers} />
        )
      ) : null}
    </div>
  );
}

/** Развёрнутый состав подписки: серверы + разбивка нашего расхода по людям. */
function ServersView({ data }: { data: BackupServersResult | null }) {
  if (!data) return <span className="small muted">Нет данных.</span>;
  return (
    <div className="stack" style={{ gap: 10, marginTop: 2 }}>
      <div>
        <div className="field-label" style={{ marginBottom: 4 }}>Серверы ({data.servers.length})</div>
        {data.servers.length === 0 ? (
          <span className="small muted">Список серверов пуст — обновите подписку.</span>
        ) : (
          <div className="stack" style={{ gap: 0 }}>
            {data.servers.map((srv: BackupServer) => (
              <div key={srv.id} className="divide-row">
                <span className="row" style={{ gap: 8, minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{srv.name}</span>
                  <span className="small muted mono">
                    {srv.host}:{srv.port} · {srv.protocol}
                  </span>
                </span>
                {!srv.enabled ? <span className="small muted">выключен</span> : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="field-label" style={{ marginBottom: 4 }}>Наш расход по людям</div>
        {data.usage.length === 0 ? (
          <span className="small muted">Пока никто не расходовал резерв.</span>
        ) : (
          <div className="stack" style={{ gap: 0 }}>
            {data.usage
              .slice()
              .sort((a, b) => b.bytes - a.bytes)
              .map((u) => (
                <div key={u.userId} className="divide-row">
                  <span style={{ fontWeight: 600 }}>{u.name}</span>
                  <span className="mono small">{bytes(u.bytes)}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Личная подписка пользователя — только для просмотра, без действий. */
function PersonalCard({ sub: s }: { sub: BackupSubscription }) {
  const used = providerUsed(s.provider);
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 14 }}>{s.title}</b>
        <span className="small muted">владелец: {s.ownerUserId ?? '—'}</span>
      </div>
      <span className="small mono muted" style={{ wordBreak: 'break-all' }}>{hostOf(s.url)}</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 14px', fontSize: 12 }}>
        <span className="muted">Серверов</span>
        <span>{s.serverCount}</span>
        <span className="muted">У провайдера</span>
        <span>{used == null ? '—' : `${bytes(used)} использовано`} · срок {providerExpire(s.provider.expire)}</span>
        <span className="muted">Наш расход</span>
        <span className="mono">{bytes(s.internalBytes)}</span>
      </div>
      {s.lastError ? <div className="small" style={{ color: 'var(--red-fg)' }}>Ошибка: {s.lastError}</div> : null}
    </div>
  );
}

/** Форма добавления/изменения резервной подписки. */
function SubForm({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial?: BackupSubscription;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: BackupInput) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [userAgent, setUserAgent] = useState(initial?.userAgent ?? '');
  const [hwid, setHwid] = useState(initial?.hwid ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const urlOk = /^https?:\/\//i.test(url.trim());

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
      <b style={{ fontSize: 14 }}>{initial ? 'Изменить подписку' : 'Новая резервная подписка'}</b>
      <Field label="Название" hint="Как показывать в списке. Пусто — возьмём хост из ссылки.">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Аварийный пул" />
      </Field>
      <Field label="Ссылка на подписку" hint="Прямой URL подписки стороннего провайдера.">
        <input
          className="input mono"
          style={{ fontSize: 12 }}
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://sub.example.com/abcd1234"
        />
      </Field>
      <Field label="User-Agent" hint="С каким User-Agent ходить к провайдеру. Пусто — по умолчанию.">
        <input
          className="input mono"
          style={{ fontSize: 12 }}
          spellCheck={false}
          value={userAgent}
          onChange={(e) => setUserAgent(e.target.value)}
          placeholder="по умолчанию v2rayNG/1.9.5"
        />
      </Field>
      <Field label="HWID" hint="Необязательно — только если провайдер требует привязку к устройству.">
        <input
          className="input mono"
          style={{ fontSize: 12 }}
          spellCheck={false}
          value={hwid}
          onChange={(e) => setHwid(e.target.value)}
          placeholder="необязательно"
        />
      </Field>
      <label className="row" style={{ gap: 10, alignItems: 'center', cursor: 'pointer', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600 }}>Включена</span>
        <Toggle on={enabled} onChange={setEnabled} ariaLabel="Подписка включена" />
      </label>
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button className="btn btn-outline btn-sm" onClick={onCancel}>Отмена</button>
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || !urlOk}
          onClick={() =>
            onSubmit({
              title: title.trim(),
              url: url.trim(),
              userAgent: userAgent.trim() || undefined,
              hwid: hwid.trim() || undefined,
              enabled,
            })
          }
        >
          {busy ? 'Сохраняем…' : initial ? 'Сохранить' : 'Добавить'}
        </button>
      </div>
      {!urlOk && url.trim() ? (
        <span className="small" style={{ color: 'var(--amber-fg)' }}>Ссылка должна начинаться с http:// или https://</span>
      ) : null}
    </div>
  );
}
