/* Настройки. Всё техническое спрятано под «Расширенные» — на первом уровне
   только то, что человек действительно меняет. */

import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { Toggle } from '../components/ui';
import { lookOf } from '../mock/browsers';
import {
  autostartGet,
  autostartSync,
  inTauri,
  openConfigDir,
  openEngineLog,
  updateCheck,
  updateInstall,
  vpnPort,
  browsersInstalled,
} from '../lib/tauri';
import type { InstalledBrowser, UpdateInfo } from '../lib/tauri';
import { IconChevron, IconRefresh } from '../components/icons';
import type { Theme, UiScale } from '../state/types';

const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: 'Системная' },
  { id: 'dark', label: 'Тёмная' },
  { id: 'light', label: 'Светлая' },
];

const SCALES: { id: UiScale; label: string }[] = [
  { id: 'normal', label: 'Обычный' },
  { id: 'large', label: 'Крупный' },
  { id: 'xlarge', label: 'Очень крупный' },
];

function Row({ title, note, on, onChange }: { title: string; note?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="item" style={{ cursor: 'auto' }}>
      <span className="item-main">
        <span className="item-name">{title}</span>
        {note ? <span className="item-meta">{note}</span> : null}
      </span>
      <Toggle on={on} onChange={onChange} ariaLabel={title} />
    </div>
  );
}


const DNS_OPTIONS: { id: 'cloudflare' | 'google' | 'quad9' | 'custom'; label: string }[] = [
  { id: 'cloudflare', label: 'Cloudflare' },
  { id: 'google', label: 'Google' },
  { id: 'quad9', label: 'Quad9' },
  { id: 'custom', label: 'Свой' },
];

/** Расширенные настройки: DNS, свои локальные домены, диагностика. Реально
    работающие, а не заглушка. */
function AdvancedSettings() {
  const { s, setSetting } = useStore();
  const [port, setPort] = useState<number | null>(null);
  const [domain, setDomain] = useState('');

  useEffect(() => {
    if (inTauri) void vpnPort().then((p) => setPort(p ?? null));
  }, []);

  const addDomain = () => {
    const d = domain.trim().toLowerCase().replace(/^\.+/, '');
    if (!d || s.settings.customLocalDomains.includes(d)) return;
    setSetting('customLocalDomains', [...s.settings.customLocalDomains, d]);
    setDomain('');
  };
  const removeDomain = (d: string) =>
    setSetting('customLocalDomains', s.settings.customLocalDomains.filter((x) => x !== d));

  return (
    <div style={{ marginTop: 8 }}>
      <div className="section-label first">DNS-сервер</div>
      <div className="segmented">
        {DNS_OPTIONS.map((o) => (
          <button key={o.id} aria-pressed={s.settings.dnsProvider === o.id} onClick={() => setSetting('dnsProvider', o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      {s.settings.dnsProvider === 'custom' ? (
        <input
          className="input mono"
          style={{ marginTop: 8 }}
          placeholder="https://dns.example/dns-query или 192.168.1.1"
          value={s.settings.customDns}
          onChange={(e) => setSetting('customDns', e.target.value)}
        />
      ) : null}
      <div className="t-note" style={{ marginTop: 8 }}>
        {s.settings.dnsProvider === 'custom'
          ? 'Свой DNS-сервер: адрес роутера/домашнего DNS или ссылка DoH. Несколько — через запятую.'
          : 'Запросы имён идут через DNS-over-HTTPS, чтобы провайдер не подменял ответы.'}
      </div>

      <div className="section-label">Свои локальные домены</div>
      <div className="t-note" style={{ marginBottom: 8 }}>
        Корпоративные суффиксы, которые всегда идут напрямую (например{' '}
        <span className="mono">corp.example</span>).
      </div>
      <div className="toolbar">
        <input
          className="input mono"
          placeholder="ad.company.net"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addDomain();
          }}
        />
        <button className="btn btn-secondary btn-sm" disabled={!domain.trim()} onClick={addDomain}>
          Добавить
        </button>
      </div>
      {s.settings.customLocalDomains.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 10 }}>
          {s.settings.customLocalDomains.map((d) => (
            <button
              key={d}
              className="route route-direct mono"
              style={{ cursor: 'default', border: 0 }}
              title="Убрать"
              onClick={() => removeDomain(d)}
            >
              {d} ✕
            </button>
          ))}
        </div>
      ) : null}

      <div className="section-label">Локальный прокси</div>
      <div className="card" style={{ padding: '13px 14px' }}>
        <div className="row-between">
          <span className="t-body">Порт для расширений и ручной настройки</span>
          <span className="mono t-name">{port ? `127.0.0.1:${port}` : '—'}</span>
        </div>
      </div>

      <div className="section-label">Диагностика</div>
      <button className="btn btn-outline btn-block btn-sm" onClick={() => void openEngineLog()}>
        Открыть журнал движка
      </button>
      <button className="btn btn-outline btn-block btn-sm" style={{ marginTop: 8 }} onClick={() => void openConfigDir()}>
        Открыть папку настроек
      </button>
    </div>
  );
}

export function Settings() {
  // Список установленных браузеров приходит из оболочки; null — ещё не спросили.
  const [browsers, setBrowsers] = useState<InstalledBrowser[] | null>(null);
  useEffect(() => {
    void browsersInstalled().then((v) => setBrowsers(v ?? []));
  }, []);

  const { s, setSetting, setSmartRouting, openQuickSetup, go, fullAvailable } = useStore();
  const [advOpen, setAdvOpen] = useState(false);
  const [upd, setUpd] = useState<{ state: 'idle' | 'checking' | 'done' | 'installing'; info?: UpdateInfo; error?: string }>({ state: 'idle' });

  const checkUpdate = () => {
    setUpd({ state: 'checking' });
    void updateCheck()
      .then((info) => setUpd({ state: 'done', info }))
      .catch((e: unknown) => setUpd({ state: 'idle', error: String(e) }));
  };
  const installUpdate = () => {
    setUpd((u) => ({ ...u, state: 'installing' }));
    void updateInstall().catch((e: unknown) => setUpd((u) => ({ ...u, state: 'done', error: String(e) })));
  };

  useEffect(() => {
    if (!inTauri) return;
    // Запись автозапуска мог убрать кто угодно — читаем реестр, а не память.
    void autostartGet().then((v) => {
      if (v !== s.settings.autostart) setSetting('autostart', v);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="viewport">
      <h1 className="screen-title">Настройки</h1>
      <p className="screen-sub">Поведение приложения и внешний вид.</p>

      <div className="section-label first">Запуск</div>
      <Row
        title="Запускать вместе с Windows"
        on={s.settings.autostart}
        onChange={(v) => {
          setSetting('autostart', v);
          void autostartSync(v, s.settings.tunnel);
        }}
      />
      <Row
        title="Подключаться автоматически"
        note="Сразу после запуска"
        on={s.settings.autoconnect}
        onChange={(v) => setSetting('autoconnect', v)}
      />
      <Row title="Сворачивать в трей" on={s.settings.tray} onChange={(v) => setSetting('tray', v)} />

      <div className="section-label">Маршрутизация</div>
      {fullAvailable ? (
        <Row
          title="Умная маршрутизация"
          note={s.smartRouting ? 'Через VPN идёт только нужное' : 'Выключена: весь трафик через VPN'}
          on={s.smartRouting}
          onChange={setSmartRouting}
        />
      ) : (
        <Row
          title="Умная маршрутизация"
          note="Всегда включена: полный VPN появится, если его выдаст провайдер"
          on
          onChange={() => {}}
        />
      )}
      <Row
        title="Обновлять списки автоматически"
        on={s.settings.autoUpdateLists}
        onChange={(v) => setSetting('autoUpdateLists', v)}
      />
      <button className="btn btn-outline btn-block btn-sm" style={{ marginTop: 10 }} onClick={openQuickSetup}>
        Быстрая настройка
      </button>

      <div className="section-label">Подписка</div>
      <button
        className="item"
        style={{ width: '100%' }}
        onClick={() => go('connection')}
      >
        <span className="item-main">
          <span className="item-name">Текущая подписка</span>
          <span className="item-meta mono">{s.subscription.url || 'не подключена'}</span>
        </span>
        <span style={{ color: 'var(--text-muted-2)', display: 'grid' }}>
          <IconChevron size={15} />
        </span>
      </button>

      <Row
        title="Локальная сеть — напрямую"
        note="Роутер, NAS и внутренние сайты в обход VPN"
        on={s.settings.bypassLocal}
        onChange={(v) => setSetting('bypassLocal', v)}
      />

      <div className="section-label">Расширение для браузера</div>
      <div className="hint" style={{ marginBottom: 10 }}>
        Позволяет прямо на сайте выбрать, как он ходит — через VPN или напрямую. Правило
        сразу попадает в ваш список здесь.
      </div>
      {browsers === null ? (
        <div className="item"><span className="item-main"><span className="item-meta">Смотрим, что установлено…</span></span></div>
      ) : browsers.length === 0 ? (
        <div className="item"><span className="item-main"><span className="item-meta">Браузеров не нашли</span></span></div>
      ) : (
        browsers.map((b) => (
          <div key={b.id} className="item">
            <span className="avatar" style={{ background: `${lookOf(b.id).color}28`, color: lookOf(b.id).color }}>
              {b.name.charAt(0)}
            </span>
            <span className="item-main">
              <span className="item-name">{b.name}</span>
              <span className="item-meta">Найден</span>
            </span>
          </div>
        ))
      )}
      {/* Расширения в магазинах ещё нет — не показываем кнопку, которая ведёт в никуда. */}
      <div className="hint" style={{ marginTop: 10 }}>
        Расширение пока ставится вручную: распакуйте архив, откройте в браузере страницу
        расширений, включите «Режим разработчика» и нажмите «Загрузить распакованное
        расширение». Пошагово — в инструкции на сайте.
      </div>

      <div className="section-label">Обновления</div>
      <div className="card" style={{ padding: '15px 16px' }}>
        <div className="row-between">
          <div>
            <div className="t-name">
              {upd.info?.available ? `Доступна версия ${upd.info.latest}` : `Версия ${__APP_VERSION__}`}
            </div>
            <div className="t-note" style={{ marginTop: 3 }}>
              {upd.state === 'checking'
                ? 'Проверяем…'
                : upd.state === 'installing'
                  ? 'Скачиваем и запускаем установщик…'
                  : upd.info?.available
                    ? upd.info.notes || 'Готово к установке'
                    : upd.state === 'done'
                      ? 'Установлена последняя версия'
                      : 'Проверьте наличие обновлений'}
            </div>
          </div>
          {upd.info?.available ? (
            <button className="btn btn-primary btn-sm" disabled={upd.state === 'installing'} onClick={installUpdate}>
              Обновить
            </button>
          ) : (
            <button className="btn btn-secondary btn-sm" disabled={upd.state === 'checking'} onClick={checkUpdate}>
              <IconRefresh size={16} /> Проверить
            </button>
          )}
        </div>
        {upd.error ? (
          <div className="notice notice-red" style={{ marginTop: 12 }}>
            {upd.error}
          </div>
        ) : null}
      </div>
      <Row
        title="Обновляться автоматически"
        note="Проверка при запуске"
        on={s.settings.autoUpdateApp}
        onChange={(v) => setSetting('autoUpdateApp', v)}
      />

      <div className="section-label">Размер интерфейса</div>
      <div className="segmented">
        {SCALES.map((t) => (
          <button key={t.id} aria-pressed={s.settings.uiScale === t.id} onClick={() => setSetting('uiScale', t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="t-note" style={{ marginTop: 8 }}>
        Окно ограничено по размеру, поэтому масштаб меняется здесь — как зум в браузере.
      </div>

      <div className="section-label">Тема</div>
      <div className="segmented">
        {THEMES.map((t) => (
          <button key={t.id} aria-pressed={s.settings.theme === t.id} onClick={() => setSetting('theme', t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="t-note" style={{ marginTop: 8 }}>
        «Системная» следует за темой Windows и меняется вместе с ней.
      </div>

      <div className="section-label">Дополнительно</div>
      <button className="item" style={{ width: '100%' }} onClick={() => setAdvOpen((v) => !v)}>
        <span className="item-main">
          <span className="item-name">Расширенные настройки</span>
          <span className="item-meta">Для тех, кто знает, зачем сюда зашёл</span>
        </span>
        <span
          style={{
            color: 'var(--text-muted-2)',
            display: 'grid',
            transform: advOpen ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        >
          <IconChevron size={15} />
        </span>
      </button>

      {advOpen ? <AdvancedSettings /> : null}

      <div className="mono" style={{ fontSize: 12, color: 'var(--text-fainter)', marginTop: 26, textAlign: 'center' }}>
        {`NoVPN Desktop ${__APP_VERSION__}`}
      </div>
    </div>
  );
}
