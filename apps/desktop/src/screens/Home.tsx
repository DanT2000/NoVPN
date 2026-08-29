/* Главный экран. Один смысловой центр — развилка и кнопка под ней.
   Всё остальное намеренно тише и мельче. */

import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { RouteFork } from '../components/RouteFork';
import { Banner, STATE_INFO, StatusDot, Toggle } from '../components/ui';
import { IconChevron } from '../components/icons';
import { count } from '../lib/plural';
import { inTauri, isElevated, relaunchElevated, vpnConflicts } from '../lib/tauri';

const BTN: Record<string, string> = {
  connect: 'Запустить',
  disconnect: 'Отключить',
  retry: 'Повторить',
  none: 'Подключение…',
};

export function Home() {
  const { s, go, goRouting, connect, disconnect, setSmartRouting, setSetting, error, reconnecting, fullAvailable, selectedNode } = useStore();
  const [admin, setAdmin] = useState(true);
  useEffect(() => {
    if (inTauri) void isElevated().then(setAdmin);
  }, []);
  const info = STATE_INFO[s.conn];
  const server = s.servers.find((x) => x.id === s.serverId) ?? null;

  const vpnApps = s.apps.filter((a) => a.enabled && a.route === 'vpn');
  // Число сайтов «через VPN»: берём размер включённых списков как основную
  // массу и добавляем только РУЧНЫЕ сайты (source!=='list'), чтобы не считать
  // одни и те же дважды.
  const manualVpnSites = s.sites.filter((v) => v.route === 'vpn' && v.source !== 'list').length;
  // Чужой туннель, поднятый одновременно с нашим, забирает маршрут по умолчанию —
  // интернет пропадает целиком, и понять причину со стороны невозможно. Проверяем при
  // появлении окна и раз в 15 секунд: фоновому webview таймеры душат, одного мало.
  // Срок возврата задаёт сервер (meta.routing.fullTimeoutHours); 0 — не возвращать.
  const fullTimeoutHours = selectedNode?.profileId
    ? (s.meta?.profiles.find((p) => p.profileId === selectedNode.profileId)?.fullTimeoutHours ?? 0)
    : 0;
  const [conflicts, setConflicts] = useState<string[]>([]);
  useEffect(() => {
    let stop = false;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      void vpnConflicts()
        .then((v) => {
          if (!stop) setConflicts(v ?? []); // вне Tauri команда возвращает null
        })
        .catch(() => {
          /* посмотреть не вышло — молчим: это подсказка, а не проверка доступа */
        });
    };
    check();
    const id = window.setInterval(check, 15000);
    window.addEventListener('focus', check);
    return () => {
      stop = true;
      window.clearInterval(id);
      window.removeEventListener('focus', check);
    };
  }, []);

  const listRules = s.lists.filter((l) => l.id !== 'apps' && l.enabled).reduce((n, l) => n + l.rules, 0);
  const totalSites = listRules + manualVpnSites;

  const live = s.conn === 'on' || s.conn === 'config-updating' || s.conn === 'config-updated';

  const onMain = () => {
    if (info.action === 'connect' || info.action === 'retry') connect();
    else if (info.action === 'disconnect') disconnect();
  };

  return (
    <div className="viewport home">
      <Banner conn={s.conn} onAction={connect} detail={error} />

      <RouteFork
        conn={s.conn}
        smart={s.smartRouting || !fullAvailable}
        vpnLabel={s.smartRouting || !fullAvailable ? count(totalSites, 'правило', 'правила', 'правил') : 'весь трафик'}
        directLabel="всё остальное"
      />

      <div style={{ textAlign: 'center', marginTop: 18 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 9,
            fontSize: 21,
            fontWeight: 700,
            letterSpacing: '-0.015em',
          }}
        >
          <StatusDot tone={info.tone} />
          {info.label}
        </div>
        <div className="mono" style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 7 }}>
          {reconnecting
            ? 'Переподключение…'
            : live && server
              ? `${(selectedNode ?? server).name}${server.ping != null ? ` · ${server.ping} ms` : ''}`
              : info.note || '—'}
        </div>
      </div>

      {/* Один тумблер: ВКЛ — умная маршрутизация, ВЫКЛ — полный VPN. Выключить можно
          только если сервер выдал полный профиль. Никаких «нужен полный VPN?» — если
          сервер его не даёт, тумблера просто нет, и объяснять человеку нечего.
          Когда у сервера задан срок возврата, пишем, когда режим сам выключится. */}
      <div className="card" style={{ marginTop: 20, padding: '15px 16px' }}>
        <div className="row-between">
          <div>
            <div className="t-name">Умная маршрутизация</div>
            <div className="t-note" style={{ marginTop: 3 }}>
              {!fullAvailable || s.smartRouting
                ? 'Через VPN идёт только нужное'
                : 'Выключена: весь трафик идёт через туннель'}
            </div>
          </div>
          {fullAvailable ? (
            <Toggle on={s.smartRouting} onChange={setSmartRouting} ariaLabel="Умная маршрутизация" />
          ) : null}
        </div>
        {fullAvailable && !s.smartRouting ? (
          <div className="t-note" style={{ marginTop: 10, color: 'var(--amber-fg)' }}>
            Российские сайты тоже пойдут через VPN, а трафик расходуется быстрее.
            {fullTimeoutHours > 0
              ? ` Через ${fullTimeoutHours < 1 ? `${Math.round(fullTimeoutHours * 60)} мин` : count(fullTimeoutHours, 'час', 'часа', 'часов')} умная маршрутизация включится сама.`
              : ''}
          </div>
        ) : null}
      </div>

      {/* Режим адаптера — сегментами, как в Hub: ежедневный выбор одним касанием,
          а не спрятанный тумблер. Подпись под сегментами объясняет разницу. */}
      <div className="card" style={{ marginTop: 9, padding: '15px 16px' }}>
        <div className="seg-mode" role="tablist" aria-label="Режим адаптера">
          <button
            role="tab"
            aria-selected={!s.settings.tunnel}
            className={!s.settings.tunnel ? 'active' : ''}
            onClick={() => {
              if (s.settings.tunnel) setSetting('tunnel', false);
            }}
          >
            <span className="seg-mode-title">Прокси</span>
            <span className="seg-mode-sub">браузеры</span>
          </button>
          <button
            role="tab"
            aria-selected={s.settings.tunnel}
            className={s.settings.tunnel ? 'active' : ''}
            onClick={() => {
              if (!s.settings.tunnel) {
                setSetting('tunnel', true);
                // Отказ в UAC возвращает нас в рабочий режим прокси, а не
                // оставляет в TUN без прав (там подключение только ошибалось бы).
                if (!admin) void relaunchElevated().catch(() => setSetting('tunnel', false));
              }
            }}
          >
            <span className="seg-mode-title">TUN</span>
            <span className="seg-mode-sub">+ программы</span>
          </button>
        </div>
        <div className="t-note" style={{ marginTop: 11 }}>
          {s.settings.tunnel
            ? 'Через VPN идут и программы (Discord, Telegram), не только браузеры'
            : 'Через VPN идут браузеры и то, что уважает системный прокси'}
        </div>
        {conflicts.length > 0 ? (
          <div className="notice notice-amber" style={{ marginTop: 12 }}>
            Обнаружен другой активный VPN: {conflicts.join(', ')}. Два туннеля сразу забирают
            маршрут по умолчанию каждый на себя — интернет может пропасть совсем. Отключите один
            из них.
          </div>
        ) : null}
        {s.settings.tunnel && !admin ? (
          <div className="notice notice-amber" style={{ marginTop: 12 }}>
            <div className="row-between">
              <span>Один раз нужны права администратора — дальше без запросов.</span>
              <button
                className="link-btn"
                onClick={() => void relaunchElevated().catch(() => setSetting('tunnel', false))}
              >
                Перезапустить
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {s.smartRouting ? (
        <button
          className="card"
          style={{
            marginTop: 9,
            padding: '15px 16px',
            width: '100%',
            textAlign: 'left',
            cursor: 'default',
            fontFamily: 'inherit',
            color: 'inherit',
          }}
          onClick={() => {
            goRouting('apps');
            go('routing');
          }}
        >
          <div className="row-between">
            <div className="t-name">Через VPN</div>
            <span style={{ color: 'var(--text-muted-2)', display: 'grid' }}>
              <IconChevron size={17} />
            </span>
          </div>
          <div className="t-body" style={{ marginTop: 9 }}>
            {count(totalSites, 'сайт', 'сайта', 'сайтов')}
            {vpnApps.length ? ` · ${vpnApps.map((a) => a.name).join(' · ')}` : ''}
          </div>
        </button>
      ) : null}

      {/* Отключение красное: это действие обрывает защиту. */}
      <div className="home-action">
        <button
          className={`btn btn-lg btn-block ${live ? 'btn-danger' : 'btn-primary'}`}
          disabled={info.action === 'none'}
          onClick={onMain}
        >
          {BTN[info.action]}
        </button>
      </div>
    </div>
  );
}
