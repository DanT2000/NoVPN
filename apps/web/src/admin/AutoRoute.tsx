// AutoRoute — отдельный редактор основной базы умной маршрутизации (Upstream).
//
// Здесь собирается список «что не работает в России»: много источников в разных
// форматах → нормализация → слияние по приоритету → версия. Результат публикуется
// тремя сериализациями одного датасета: upstream.json, geosite.dat, geoip.dat —
// и зашивается в умный профиль Xray-подписки (список → VPN, остальное напрямую).

import { useEffect, useRef, useState } from 'react';
import type {
  AutoRouteBuild,
  AutoRouteConflict,
  AutoRouteSearchHit,
  AutoRouteSource,
  AutoRouteSourceFormat,
  AutoRouteState,
  RoutingAction,
} from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import { Chip, Field, Loading, Panel, ScreenHeader, Toggle } from '../components/ui';
import { copyText } from '../lib/clipboard';

const ACTION_LABEL: Record<RoutingAction, string> = {
  vpn: 'В VPN',
  direct: 'Напрямую',
  block: 'Блокировать',
};
const FORMAT_LABEL: Record<AutoRouteSourceFormat, string> = {
  auto: 'Авто',
  json: 'JSON',
  lst: 'LST',
  txt: 'TXT',
  srs: 'SRS',
};
const STATUS_COLOR: Record<string, string> = {
  ok: 'var(--green-fg)',
  nochange: 'var(--green-fg)',
  idle: 'var(--text-muted)',
  error: 'var(--red-fg)',
  rejected: 'var(--amber-fg)',
};
const STATUS_LABEL: Record<string, string> = {
  ok: '✓ Обновлён',
  nochange: '✓ Актуален',
  idle: 'Не проверялся',
  error: '✕ Ошибка',
  rejected: '⚠ Отклонён проверкой',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('ru-RU'));

function CopyLink({ url, label }: { url: string; label: string }) {
  const { showToast } = useApp();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '4px 12px', alignItems: 'baseline', fontSize: 13 }}>
      <span className="muted">{label}</span>
      <a className="mono" href={url} target="_blank" rel="noreferrer" style={{ color: 'var(--link)', wordBreak: 'break-all', fontSize: 12 }}>
        {url}
      </a>
      <button className="btn btn-outline btn-sm" onClick={async () => showToast((await copyText(url)) ? 'Ссылка скопирована' : 'Не удалось скопировать')}>
        Копировать
      </button>
    </div>
  );
}

export function AutoRoute() {
  const { showToast, showConfirm } = useApp();
  const [state, setState] = useState<AutoRouteState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<AutoRouteConflict[]>([]);
  const [adding, setAdding] = useState(false);
  const dragId = useRef<string | null>(null);
  // Экран может закрыться, пока идёт долгая сборка: не пишем в размонтированный компонент.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = async () => {
    try {
      const s = await api.getAutoRoute();
      if (!alive.current) return;
      setState(s);
      setErr(null);
    } catch (e) {
      if (alive.current) setErr(e instanceof Error ? e.message : 'Не удалось загрузить.');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не получилось');
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const build = (refresh: boolean) =>
    run(refresh ? 'build' : 'rebuild', async () => {
      const r = await api.buildAutoRoute({ refresh });
      setConflicts(r.conflicts ?? []);
      showToast(r.reason);
    });

  const reorder = async (ids: string[]) => {
    if (!state) return;
    const byId = new Map(state.sources.map((s) => [s.id, s]));
    setState({ ...state, sources: ids.map((i) => byId.get(i)!).filter(Boolean) });
    await run('reorder', () => api.reorderAutoRouteSources(ids));
  };

  const move = (id: string, delta: number) => {
    if (!state) return;
    const ids = state.sources.map((s) => s.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    void reorder(ids);
  };

  const onDrop = (targetId: string) => {
    const src = dragId.current;
    dragId.current = null;
    if (!src || src === targetId || !state) return;
    const ids = state.sources.map((s) => s.id);
    const from = ids.indexOf(src);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    void reorder(ids);
  };

  if (err) return <div className="notice notice-red">{err}</div>;
  if (!state) return <Loading text="Загрузка AutoRoute…" />;

  const published = state.builds.find((b) => b.published) ?? null;
  const enabledCount = state.sources.filter((s) => s.enabled).length;

  return (
    <>
      <ScreenHeader eyebrow="Маршрутизация" title="AutoRoute" />
      <div className="body small muted" style={{ margin: '-8px 0 16px', maxWidth: 680 }}>
        Основная база умной маршрутизации: что не работает в России — идёт через VPN, остальное напрямую.
        Собирается из нескольких источников, публикуется по постоянным ссылкам и зашивается в умный профиль подписки.
      </div>
      <div className="stack" style={{ gap: 16, maxWidth: 820 }}>
        {/* Что опубликовано */}
        <Panel title="Опубликованная сборка">
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 13 }}>
            <span className="muted">Версия</span>
            <span>{published ? `v${published.version} · ${fmtDate(published.builtAt)}` : 'ещё не собиралась — нажмите «Проверить и пересобрать»'}</span>
            <span className="muted">Правил</span>
            <span>{published ? `${num(published.domains)} доменов, ${num(published.ips)} IP-подсетей` : '—'}</span>
            <span className="muted">В подписке Xray</span>
            <span>
              {num(state.subscription.rules)} правил
              {state.subscription.truncated ? (
                <span style={{ color: 'var(--amber-fg)' }}> — достигнут потолок {num(state.subscription.cap)}: в телефонный конфиг входят первые по приоритету, остальные только в DAT/JSON</span>
              ) : null}
            </span>
          </div>
          <div className="stack" style={{ gap: 6, marginTop: 4 }}>
            <CopyLink label="geosite.dat" url={state.dat.geosite} />
            <CopyLink label="geoip.dat" url={state.dat.geoip} />
            <CopyLink label="upstream.json" url={state.publicUrl} />
          </div>
          <div className="small muted">
            Три сериализации одного датасета. DAT — для Xray, sing-box и чужих панелей (тег <span className="mono">novpn</span>);
            JSON — для NoVPN Desktop. Ссылки постоянные: при каждой сборке меняется содержимое, не адрес.
          </div>
        </Panel>

        {/* Поиск по сборке */}
        <RuleSearch />

        {/* Источники */}
        <Panel title={`Источники (${enabledCount} из ${state.sources.length} включено)`}>
          <span className="small muted" style={{ marginTop: -4 }}>
            Порядок = приоритет. Если один домен пришёл из нескольких списков с разными действиями, побеждает верхний.
            Перетаскивайте мышью или двигайте стрелками. Источник, который сейчас недоступен, участвует последней
            удачной версией — база от этого не худеет.
          </span>

          {state.sources.length === 0 ? (
            <div className="small muted" style={{ marginTop: 8 }}>Пока ни одного источника — добавьте первый ниже.</div>
          ) : (
            <div className="stack" style={{ gap: 8, marginTop: 8 }}>
              {state.sources.map((s, i) => (
                <SourceRow
                  key={s.id}
                  source={s}
                  index={i}
                  total={state.sources.length}
                  busy={busy}
                  onDragStart={() => (dragId.current = s.id)}
                  onDropOn={() => onDrop(s.id)}
                  onMove={(d) => move(s.id, d)}
                  onToggle={(v) => void run(`t:${s.id}`, () => api.updateAutoRouteSource(s.id, { enabled: v }))}
                  onCheck={() =>
                    void run(`c:${s.id}`, async () => {
                      const r = await api.checkAutoRouteSource(s.id);
                      showToast(r.ok ? `${s.title}: ${r.reason} Правил: ${num(r.count)}` : `${s.title}: ${r.reason}`);
                    })
                  }
                  onSave={(patch) => void run(`e:${s.id}`, () => api.updateAutoRouteSource(s.id, patch))}
                  onDelete={() =>
                    showConfirm({
                      title: 'Удалить источник?',
                      text: `«${s.title}» больше не будет участвовать в сборке. Уже опубликованная версия не изменится, пока вы не пересоберёте базу.`,
                      confirmLabel: 'Удалить',
                      onConfirm: async () => {
                        await api.deleteAutoRouteSource(s.id);
                        await load();
                      },
                    })
                  }
                />
              ))}
            </div>
          )}

          {adding ? (
            <SourceForm
              busy={busy === 'add'}
              onCancel={() => setAdding(false)}
              onSubmit={(input) =>
                void run('add', async () => {
                  await api.addAutoRouteSource(input);
                  setAdding(false);
                })
              }
            />
          ) : (
            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>Добавить источник</button>
              <button className="btn btn-primary btn-sm" disabled={!!busy || !enabledCount} onClick={() => void build(true)}>
                {busy === 'build' ? 'Проверяем и собираем…' : 'Проверить и пересобрать'}
              </button>
              <button
                className="btn btn-outline btn-sm"
                disabled={!!busy || !enabledCount}
                title="Пересобрать из уже скачанного — быстро, например после смены приоритетов"
                onClick={() => void build(false)}
              >
                {busy === 'rebuild' ? 'Собираем…' : 'Пересобрать без скачивания'}
              </button>
            </div>
          )}
        </Panel>

        {conflicts.length > 0 ? <Conflicts list={conflicts} onClose={() => setConflicts([])} /> : null}

        {/* История сборок */}
        {state.builds.length > 0 ? (
          <Panel title="История сборок">
            <div className="stack" style={{ gap: 8 }}>
              {state.builds.map((b) => (
                <BuildRow
                  key={b.version}
                  build={b}
                  busy={busy === `r:${b.version}`}
                  onRollback={() =>
                    showConfirm({
                      title: `Откатиться на v${b.version}?`,
                      text: 'Публичные ссылки и подписка начнут отдавать содержимое этой версии. Источники и их приоритеты не меняются — при следующей сборке снова получится свежая версия.',
                      confirmLabel: 'Откатиться',
                      onConfirm: async () => {
                        const r = await api.rollbackAutoRoute(b.version);
                        showToast(r.reason);
                        await load();
                      },
                    })
                  }
                />
              ))}
            </div>
          </Panel>
        ) : null}
      </div>
    </>
  );
}

/** Поиск домена по опубликованной сборке: откуда пришло правило и почему победило. */
function RuleSearch() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<AutoRouteSearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) {
      setHits(null);
      return;
    }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api.searchAutoRoute(q.trim());
        setHits(r.hits);
      } catch {
        setHits([]);
      } finally {
        setBusy(false);
      }
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  return (
    <Panel title="Проверить домен">
      <Field label="Домен" hint="Покажет, попадает ли домен в базу, из какого источника пришло правило и с каким приоритетом. Поддомен находит правило родителя.">
        <input
          className="input mono"
          style={{ fontSize: 13 }}
          spellCheck={false}
          placeholder="youtube.com"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </Field>
      {busy ? <span className="small muted">Ищем…</span> : null}
      {hits && !busy ? (
        hits.length === 0 ? (
          <div className="small muted">Не найдено: такой домен идёт по умолчанию — напрямую.</div>
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {hits.map((h) => (
              <div key={`${h.kind}:${h.value}:${h.sourceId}`} className="row-between" style={{ gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
                <span className="mono" style={{ wordBreak: 'break-all' }}>
                  {h.kind === 'domain' ? '' : `${h.kind}:`}{h.value}
                </span>
                <span className="small muted">
                  <b style={{ color: h.action === 'vpn' ? 'var(--text-primary)' : 'var(--amber-fg)' }}>{ACTION_LABEL[h.action]}</b>
                  {' · '}{h.sourceTitle}{' · '}приоритет {h.priority + 1}
                </span>
              </div>
            ))}
          </div>
        )
      ) : null}
    </Panel>
  );
}

function SourceRow({
  source: s,
  index,
  total,
  busy,
  onDragStart,
  onDropOn,
  onMove,
  onToggle,
  onCheck,
  onSave,
  onDelete,
}: {
  source: AutoRouteSource;
  index: number;
  total: number;
  busy: string | null;
  onDragStart: () => void;
  onDropOn: () => void;
  onMove: (delta: number) => void;
  onToggle: (v: boolean) => void;
  onCheck: () => void;
  onSave: (patch: { title?: string; url?: string; format?: AutoRouteSourceFormat; action?: RoutingAction }) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const anyBusy = !!busy;

  if (editing) {
    return (
      <SourceForm
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

  return (
    <div
      className="card"
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDropOn();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, opacity: s.enabled ? 1 : 0.55, cursor: 'grab' }}
    >
      <div className="row-between" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: 8, minWidth: 0, alignItems: 'baseline' }}>
          <span className="small mono muted" style={{ flex: 'none' }}>{index + 1}.</span>
          <b style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</b>
          <span className="small muted">{ACTION_LABEL[s.action]}</span>
          <span className="small muted">{FORMAT_LABEL[s.format]}{s.resolvedFormat && s.format === 'auto' ? ` → ${s.resolvedFormat.toUpperCase()}` : ''}</span>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <Toggle on={s.enabled} onChange={onToggle} ariaLabel="Источник включён" />
          <button className="btn btn-outline btn-sm" disabled={index === 0 || anyBusy} title="Выше (приоритетнее)" onClick={() => onMove(-1)}>↑</button>
          <button className="btn btn-outline btn-sm" disabled={index === total - 1 || anyBusy} title="Ниже" onClick={() => onMove(1)}>↓</button>
        </div>
      </div>

      <a className="small mono" href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--link)', wordBreak: 'break-all' }}>
        {s.url}
      </a>

      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 14px', fontSize: 12 }}>
        <span className="muted">Правил</span>
        <span>{num(s.ruleCount)}</span>
        <span className="muted">Проверен</span>
        <span>{fmtDate(s.lastCheckAt)}</span>
        <span className="muted">Статус</span>
        <span style={{ color: STATUS_COLOR[s.status] ?? 'var(--text-muted)' }}>
          {STATUS_LABEL[s.status] ?? s.status}
          {s.statusReason ? ` — ${s.statusReason}` : ''}
        </span>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-outline btn-sm" disabled={anyBusy} onClick={onCheck}>
          {busy === `c:${s.id}` ? 'Проверяем…' : 'Проверить'}
        </button>
        <button className="btn btn-outline btn-sm" disabled={anyBusy} onClick={() => setEditing(true)}>Изменить</button>
        <button className="btn btn-danger-outline btn-sm" disabled={anyBusy} onClick={onDelete}>Удалить</button>
      </div>
    </div>
  );
}

function SourceForm({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial?: AutoRouteSource;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { title: string; url: string; format: AutoRouteSourceFormat; action: RoutingAction }) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [format, setFormat] = useState<AutoRouteSourceFormat>(initial?.format ?? 'auto');
  const [action, setAction] = useState<RoutingAction>(initial?.action ?? 'vpn');
  const urlOk = /^https?:\/\//i.test(url.trim());

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
      <b style={{ fontSize: 14 }}>{initial ? 'Изменить источник' : 'Новый источник'}</b>
      <Field label="Название" hint="Как показывать в списке. Пусто — возьмём URL.">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Re:filter" />
      </Field>
      <Field label="URL" hint="Прямой адрес списка. Форматы: .json, .lst, .txt, .srs (sing-box). Домены, CIDR и префиксы Xray (full:/keyword:/regexp:) понимаются.">
        <input
          className="input mono"
          style={{ fontSize: 12 }}
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://raw.githubusercontent.com/…/domains_all.lst"
        />
      </Field>
      <div className="field">
        <span className="field-label">Что делать с попаданиями</span>
        <div className="chip-row">
          {(['vpn', 'direct', 'block'] as RoutingAction[]).map((a) => (
            <Chip key={a} label={ACTION_LABEL[a]} size="sm" active={action === a} onClick={() => setAction(a)} />
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">Формат</span>
        <div className="chip-row">
          {(['auto', 'json', 'lst', 'txt', 'srs'] as AutoRouteSourceFormat[]).map((f) => (
            <Chip key={f} label={FORMAT_LABEL[f]} size="sm" active={format === f} onClick={() => setFormat(f)} />
          ))}
        </div>
        <span className="small muted">«Авто» определяет формат по расширению адреса — почти всегда этого достаточно.</span>
      </div>
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button className="btn btn-outline btn-sm" onClick={onCancel}>Отмена</button>
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || !urlOk}
          onClick={() => onSubmit({ title: title.trim(), url: url.trim(), format, action })}
        >
          {busy ? 'Сохраняем…' : initial ? 'Сохранить' : 'Добавить'}
        </button>
      </div>
      {!urlOk && url.trim() ? <span className="small" style={{ color: 'var(--amber-fg)' }}>Адрес должен начинаться с http:// или https://</span> : null}
    </div>
  );
}

function BuildRow({ build: b, busy, onRollback }: { build: AutoRouteBuild; busy: boolean; onRollback: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="row-between" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <b style={{ fontSize: 14 }}>v{b.version}</b>
          {b.published ? <span className="small" style={{ color: 'var(--green-fg)' }}>опубликована</span> : null}
          <span className="small muted">{fmtDate(b.builtAt)}</span>
          <span className="small">
            <span style={{ color: 'var(--green-fg)' }}>+{num(b.added)}</span>{' '}
            <span style={{ color: 'var(--red-fg)' }}>−{num(b.removed)}</span>
          </span>
          {b.conflicts > 0 ? <span className="small" style={{ color: 'var(--amber-fg)' }}>конфликтов {num(b.conflicts)}</span> : null}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-outline btn-sm" onClick={() => setOpen((v) => !v)}>{open ? 'Скрыть' : 'Подробнее'}</button>
          {!b.published ? (
            <button className="btn btn-outline btn-sm" disabled={busy} onClick={onRollback}>
              {busy ? 'Откатываем…' : 'Откатиться'}
            </button>
          ) : null}
        </div>
      </div>
      {open ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 14px', fontSize: 12 }}>
          <span className="muted">Доменов</span>
          <span>{num(b.domains)}</span>
          <span className="muted">IP/подсетей</span>
          <span>{num(b.ips)}</span>
          <span className="muted">SHA-256</span>
          <span className="mono" style={{ wordBreak: 'break-all' }}>{b.sha256.slice(0, 32)}…</span>
          {b.sources.map((s) => (
            <span key={s.sourceId} style={{ display: 'contents' }}>
              <span className="muted">{s.title}</span>
              <span>
                {num(s.rules)} правил, в итог вошло {num(s.won)}
                {s.conflicts > 0 ? `, перебито ${num(s.conflicts)}` : ''}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Conflicts({ list, onClose }: { list: AutoRouteConflict[]; onClose: () => void }) {
  return (
    <div className="notice notice-amber" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <b>Конфликты приоритетов: {list.length}</b>
        <button className="btn btn-outline btn-sm" onClick={onClose}>Скрыть</button>
      </div>
      <span className="small">
        Значение встретилось в нескольких источниках с разными действиями. Победил тот, что выше в списке.
      </span>
      <div className="stack" style={{ gap: 4 }}>
        {list.slice(0, 50).map((c) => (
          <div key={`${c.kind}:${c.value}`} className="small mono" style={{ wordBreak: 'break-all' }}>
            {c.value} → <b>{ACTION_LABEL[c.winner.action]}</b> ({c.winner.title}); перебито:{' '}
            {c.losers.map((l) => `${l.title} → ${ACTION_LABEL[l.action]}`).join(', ')}
          </div>
        ))}
        {list.length > 50 ? <span className="small muted">…и ещё {list.length - 50}.</span> : null}
      </div>
    </div>
  );
}
