/* Умная маршрутизация. Простой режим показывает только знакомые названия и
   один из двух маршрутов. Расширенный добавляет процесс, путь и источник
   правила — но ни одно из этих слов не встречается в простом режиме. */

import { useState } from 'react';
import { useStore } from '../state/store';
import { Avatar, Dialog, Empty, RouteSwitch, RouteTag, Toggle } from '../components/ui';
import { IconChevron, IconPlus, IconRefresh, IconTrash } from '../components/icons';
import { domainForApp, search } from '../mock/catalog';
import { appsInstalled, appsRunning, pickExe, pickFolder } from '../lib/tauri';
import type { AppItem } from '../lib/tauri';
import { useEffect } from 'react';
import { count } from '../lib/plural';
import type { AppRule, Route, SiteRule } from '../state/types';

const MODE_HINT = {
  simple: 'Знакомые названия и один из двух маршрутов. Этого хватает почти всегда.',
  advanced:
    'То же самое плюс процесс, путь к файлу и источник правила. Пригодится, когда программ с одинаковым названием несколько и нужно выбрать конкретную.',
};

export function Routing() {
  const { s, nav, goRouting, setMode } = useStore();

  return (
    <div className="viewport">
      <h1 className="screen-title">Умная маршрутизация</h1>
      <p className="screen-sub">Что идёт через VPN, а что — напрямую.</p>

      <div className="segmented" style={{ marginBottom: 10 }}>
        <button aria-pressed={s.mode === 'simple'} onClick={() => setMode('simple')}>
          Простой
        </button>
        <button aria-pressed={s.mode === 'advanced'} onClick={() => setMode('advanced')}>
          Расширенный
        </button>
      </div>
      <div className="hint" style={{ marginBottom: 16 }}>
        {MODE_HINT[s.mode]}
      </div>

      <div className="segmented" style={{ marginBottom: 16 }}>
        <button aria-pressed={nav.routingTab === 'apps'} onClick={() => goRouting('apps')}>
          Приложения
        </button>
        <button aria-pressed={nav.routingTab === 'sites'} onClick={() => goRouting('sites')}>
          Сайты
        </button>
        <button aria-pressed={nav.routingTab === 'lists'} onClick={() => goRouting('lists')}>
          Списки
        </button>
      </div>

      {nav.routingTab === 'apps' ? <AppsTab /> : null}
      {nav.routingTab === 'sites' ? <SitesTab /> : null}
      {nav.routingTab === 'lists' ? <ListsTab /> : null}
    </div>
  );
}

/* ── Приложения ───────────────────────────────────────────── */

function AppsTab() {
  const { s, toggleApp } = useStore();
  const [edit, setEdit] = useState<AppRule | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const advanced = s.mode === 'advanced';

  // Конфликт: приложение стоит напрямую (или выключено), но его сайт идёт через
  // VPN. Тогда Discord может «работать через VPN» из-за сайта discord.com, хотя
  // правило приложения выключено — человека это путает. Предупреждаем.
  const vpnDomains = new Set(s.sites.filter((v) => v.route === 'vpn').map((v) => v.domain));
  const conflict = (a: AppRule): boolean => {
    if (a.route === 'vpn' && a.enabled) return false;
    const d = domainForApp(a.name);
    return !!d && [...vpnDomains].some((x) => x === d || x.endsWith('.' + d) || d.endsWith('.' + x));
  };

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? s.apps.filter(
        (a) =>
          a.name.toLowerCase().includes(needle) ||
          a.processes.some((pr) => pr.toLowerCase().includes(needle)),
      )
    : s.apps;

  return (
    <>
      <div className="toolbar">
        <input
          className="input"
          placeholder="Поиск приложения"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
          <IconPlus size={16} /> Добавить
        </button>
      </div>
      {needle ? (
        <div className="list-count">
          показано {shown.length} из {s.apps.length}
        </div>
      ) : null}

      {shown.length === 0 ? <Empty title="Ничего не найдено" note="Попробуйте другое слово." /> : null}

      {shown.map((a) => (
        <div key={a.id} className="item">
          <Avatar name={a.name} />
          <button type="button" className="item-main" onClick={() => setEdit(a)}>
            <span className="item-name">{a.name}</span>
            <span className="item-meta">
              {conflict(a) ? (
                <span style={{ color: 'var(--amber-fg)' }}>⚠ сайт идёт через VPN</span>
              ) : !a.found ? (
                'Не найдено'
              ) : advanced ? (
                a.processes.join(', ')
              ) : a.source === 'auto' ? (
                'Найдено'
              ) : (
                'Указано вручную'
              )}
            </span>
          </button>
          <span className="item-tail">
            <RouteTag route={a.route} />
            <Toggle on={a.enabled} onChange={() => toggleApp(a.id)} ariaLabel={`Правило для ${a.name}`} />
          </span>
        </div>
      ))}

      {edit ? <AppDialog app={edit} onClose={() => setEdit(null)} /> : null}
      {adding ? <AddAppDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}

function AppDialog({ app, onClose }: { app: AppRule; onClose: () => void }) {
  const { s, setAppRoute, locateApp, removeApp } = useStore();
  const cur = s.apps.find((a) => a.id === app.id) ?? app;
  const advanced = s.mode === 'advanced';

  return (
    <Dialog title={cur.name} onClose={onClose}>
      {!cur.found ? (
        <div className="notice notice-amber" style={{ marginBottom: 16 }}>
          <div className="row-between">
            <span>Не найдено на компьютере</span>
            <button className="link-btn" onClick={() => locateApp(cur.id)}>
              Указать вручную
            </button>
          </div>
        </div>
      ) : null}

      <div className="section-label first">Маршрут</div>
      <RouteSwitch value={cur.route} onChange={(r) => setAppRoute(cur.id, r)} />

      {advanced && cur.found ? (
        <>
          <div className="section-label">Процесс</div>
          <div className="mono t-body">{cur.processes.join(', ')}</div>
          <div className="section-label">Путь</div>
          <div className="mono t-note" style={{ wordBreak: 'break-all' }}>
            {cur.path}
          </div>
          <div className="section-label">Источник правила</div>
          <div className="t-body">
            {cur.source === 'auto'
              ? 'Определено автоматически'
              : cur.source === 'list'
                ? 'Из готового списка'
                : 'Добавлено вручную'}
          </div>
        </>
      ) : null}

      <div style={{ display: 'flex', gap: 9, marginTop: 20 }}>
        <button
          className="btn btn-danger-outline btn-sm"
          onClick={() => {
            removeApp(cur.id);
            onClose();
          }}
        >
          <IconTrash size={16} /> Убрать
        </button>
        <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={onClose}>
          Готово
        </button>
      </div>
    </Dialog>
  );
}

/* Добавление приложения из настоящих источников: установленные программы,
   запущенные процессы, либо выбор .exe/папки системным окном. */
type Src = 'installed' | 'running' | 'exe' | 'folder';
const SOURCES: { id: Src; label: string; note: string }[] = [
  { id: 'running', label: 'Из запущенных', note: 'Что работает прямо сейчас' },
  { id: 'installed', label: 'Из установленных', note: 'Программы с этого компьютера' },
  { id: 'exe', label: 'Указать файл программы', note: 'Системное окно выбора .exe' },
  { id: 'folder', label: 'Указать папку', note: 'Все программы из папки' },
];

function exeName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}
function niceName(exe: string): string {
  const stem = exe.replace(/\.exe$/i, '');
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

function AddAppDialog({ onClose }: { onClose: () => void }) {
  const { addApp } = useStore();
  const [src, setSrc] = useState<Src | null>(null);
  const [list, setList] = useState<AppItem[] | null>(null);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<{ name: string; processes: string[] } | null>(null);
  const [route, setRoute] = useState<Route>('vpn');
  const [busy, setBusy] = useState(false);

  // Списки тянем по требованию: перечисление процессов не мгновенное.
  useEffect(() => {
    if (src !== 'installed' && src !== 'running') return;
    setList(null);
    const load = src === 'installed' ? appsInstalled : appsRunning;
    void load().then(setList);
  }, [src]);

  const openPicker = async (kind: Src) => {
    setBusy(true);
    try {
      const path = kind === 'exe' ? await pickExe() : await pickFolder();
      if (!path) return;
      // Для папки берём её имя как название, а процесс — по имени папки (грубо,
      // человек поправит); для .exe — имя файла как процесс.
      if (kind === 'exe') {
        const exe = exeName(path);
        setPick({ name: niceName(exe), processes: [exe] });
      } else {
        const folder = exeName(path);
        setPick({ name: folder, processes: [] });
      }
    } finally {
      setBusy(false);
    }
  };

  const needle = q.trim().toLowerCase();
  const shown = (list ?? []).filter(
    (a) => !needle || a.name.toLowerCase().includes(needle) || a.processes.some((p) => p.toLowerCase().includes(needle)),
  );

  return (
    <Dialog title="Добавить приложение" onClose={onClose}>
      {pick ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <Avatar name={pick.name} />
            <span className="t-strong">{pick.name}</span>
          </div>
          {pick.processes.length ? (
            <div className="mono t-note" style={{ marginBottom: 14 }}>{pick.processes.join(', ')}</div>
          ) : (
            <div className="notice notice-amber" style={{ marginBottom: 14 }}>
              У папки не удалось определить процесс — правило сработает, когда вы запустите программу из неё.
            </div>
          )}
          <div className="section-label first">Маршрут</div>
          <RouteSwitch value={route} onChange={setRoute} />
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn btn-outline btn-sm" onClick={() => setPick(null)}>Назад</button>
            <button
              className="btn btn-primary btn-sm"
              style={{ flex: 1 }}
              onClick={() => {
                addApp(pick.name, route, pick.processes);
                onClose();
              }}
            >
              Добавить
            </button>
          </div>
        </>
      ) : !src ? (
        <div role="radiogroup" aria-label="Откуда взять приложение">
          {SOURCES.map((o) => (
            <button
              key={o.id}
              type="button"
              className="choice"
              role="radio"
              aria-checked={false}
              onClick={() => (o.id === 'exe' || o.id === 'folder' ? void openPicker(o.id) : setSrc(o.id))}
            >
              <span style={{ flex: 1 }}>
                <span className="t-name" style={{ display: 'block' }}>{o.label}</span>
                <span className="t-note" style={{ display: 'block', marginTop: 3 }}>{o.note}</span>
              </span>
              <span style={{ color: 'var(--text-muted-2)', display: 'grid' }}><IconChevron size={16} /></span>
            </button>
          ))}
          {busy ? <div className="t-note" style={{ marginTop: 12 }}>Открываю окно выбора…</div> : null}
        </div>
      ) : (
        <>
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <input className="input" placeholder="Поиск" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
          </div>
          {list === null ? (
            <div className="t-note">Смотрим, что {src === 'running' ? 'запущено' : 'установлено'}…</div>
          ) : shown.length === 0 ? (
            <Empty title="Ничего не найдено" />
          ) : (
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {shown.slice(0, 60).map((a) => (
                <button
                  key={a.processes[0] ?? a.name}
                  type="button"
                  className="choice"
                  role="radio"
                  aria-checked={false}
                  onClick={() => setPick({ name: a.name, processes: a.processes })}
                >
                  <Avatar name={a.name} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="t-name" style={{ display: 'block' }}>{a.name}</span>
                    <span className="item-meta mono" style={{ display: 'block' }}>{a.processes.join(', ')}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <button className="link-btn" style={{ marginTop: 12 }} onClick={() => setSrc(null)}>← Назад</button>
        </>
      )}
    </Dialog>
  );
}

/* ── Сайты ────────────────────────────────────────────────── */

function SitesTab() {
  const { s } = useStore();
  const [edit, setEdit] = useState<SiteRule | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const advanced = s.mode === 'advanced';

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? s.sites.filter(
        (v) => v.title.toLowerCase().includes(needle) || v.domain.includes(needle),
      )
    : s.sites;

  return (
    <>
      <div className="toolbar">
        <input
          className="input"
          placeholder="Поиск сайта"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
          <IconPlus size={16} /> Добавить
        </button>
      </div>
      {needle ? (
        <div className="list-count">
          показано {shown.length} из {s.sites.length}
        </div>
      ) : null}

      {s.sites.length === 0 ? <Empty title="Пока пусто" note="Добавьте сайт, которому нужен свой маршрут." /> : null}
      {s.sites.length > 0 && shown.length === 0 ? (
        <Empty title="Ничего не найдено" note="Попробуйте другое слово." />
      ) : null}

      {shown.map((v) => (
        <button key={v.id} type="button" className="item" onClick={() => setEdit(v)}>
          <Avatar name={v.title} domain={v.domain} />
          <span className="item-main">
            <span className="item-name">{v.title}</span>
            <span className="item-meta mono">
              {v.domain}
              {advanced ? (v.source === 'list' ? ' · из списка' : ' · вручную') : ''}
            </span>
          </span>
          <span className="item-tail">
            <RouteTag route={v.route} />
          </span>
        </button>
      ))}

      {edit ? <SiteDialog site={edit} onClose={() => setEdit(null)} /> : null}
      {adding ? <AddSiteDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}

function SiteDialog({ site, onClose }: { site: SiteRule; onClose: () => void }) {
  const { s, setSiteRoute, removeSite } = useStore();
  const cur = s.sites.find((v) => v.id === site.id) ?? site;

  return (
    <Dialog title={cur.title} onClose={onClose}>
      <div className="mono t-note" style={{ marginBottom: 16 }}>
        {cur.domain}
      </div>
      <div className="section-label first">Маршрут</div>
      <RouteSwitch value={cur.route} onChange={(r) => setSiteRoute(cur.id, r)} />
      <div style={{ display: 'flex', gap: 9, marginTop: 20 }}>
        <button
          className="btn btn-danger-outline btn-sm"
          onClick={() => {
            removeSite(cur.id);
            onClose();
          }}
        >
          <IconTrash size={16} /> Убрать
        </button>
        <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={onClose}>
          Готово
        </button>
      </div>
    </Dialog>
  );
}

function AddSiteDialog({ onClose }: { onClose: () => void }) {
  const { addSite } = useStore();
  const [v, setV] = useState('');
  const [route, setRoute] = useState<Route>('vpn');
  const hints = search(v);

  return (
    <Dialog title="Добавить сайт" onClose={onClose}>
      <div className="field">
        <label className="field-label" htmlFor="site">
          Сайт
        </label>
        <input
          id="site"
          className="input mono"
          placeholder="example.com"
          value={v}
          autoFocus
          onChange={(e) => setV(e.target.value)}
        />
      </div>
      <div className="t-note" style={{ marginTop: 8 }}>
        Можно вставить целиком, со схемой и путём — лишнее уберём сами.
      </div>

      {hints.length ? (
        <>
          <div className="section-label">Возможно, вы про это</div>
          {hints.map((h) => (
            <button
              key={h.domain}
              type="button"
              className="item"
              style={{ padding: '10px 12px' }}
              onClick={() => setV(h.domain)}
            >
              <Avatar name={h.name} domain={h.domain} />
              <span className="item-main">
                <span className="item-name">{h.name}</span>
                <span className="item-meta mono">{h.domain}</span>
              </span>
            </button>
          ))}
        </>
      ) : null}

      <div className="section-label">Маршрут</div>
      <RouteSwitch value={route} onChange={setRoute} />

      <button
        className="btn btn-primary btn-block"
        style={{ marginTop: 18 }}
        disabled={!v.trim()}
        onClick={() => {
          addSite(v, route);
          onClose();
        }}
      >
        Добавить
      </button>
    </Dialog>
  );
}

/* ── Списки ───────────────────────────────────────────────── */

function ListsTab() {
  const { s, toggleList, syncNow } = useStore();
  const syncing = s.conn === 'config-updating';
  const advanced = s.mode === 'advanced';

  return (
    <>
      <div className="hint" style={{ marginBottom: 14 }}>
        Готовые списки приходят с сервера NoVPN и обновляются сами. Список целиком либо
        включён, либо выключен — а ваши собственные правила всегда сильнее списка.
      </div>

      <div className="card" style={{ padding: '15px 16px', marginBottom: 14 }}>
        <div className="row-between">
          <div>
            <div className="t-name" style={{ color: syncing ? 'var(--amber-fg)' : 'var(--green-fg)' }}>
              {syncing ? 'Обновляем…' : 'Списки актуальны'}
            </div>
            <div className="t-note" style={{ marginTop: 3 }}>
              Последняя синхронизация: {s.syncedAgo}
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" disabled={syncing} onClick={syncNow}>
            <IconRefresh size={16} /> Обновить
          </button>
        </div>
      </div>

      {s.lists.map((l) => (
        <div key={l.id} className="item">
          <span className="item-main">
            <span className="item-name">{l.name}</span>
            <span className="item-meta">
              {count(l.rules, 'правило', 'правила', 'правил')} · обновлено {l.updated}
            </span>
          </span>
          <span className="item-tail">
            <Toggle on={l.enabled} onChange={() => toggleList(l.id)} ariaLabel={l.name} />
          </span>
        </div>
      ))}

      {advanced ? (
        <>
          <div className="section-label">Исключения</div>
          <Empty
            title="Исключений нет"
            note="Здесь окажутся ваши правила, которые спорят с готовыми списками."
          />
        </>
      ) : null}
    </>
  );
}
