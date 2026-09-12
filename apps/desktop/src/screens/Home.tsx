/* Главный экран. Один смысловой центр — развилка и кнопка под ней.
   Всё остальное намеренно тише и мельче. */

import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { Banner, STATE_INFO, StatusDot, Toggle } from '../components/ui';
import { count } from '../lib/plural';
import { FlagName } from '../components/Flag';
import { HomeHero } from '../components/HomeHero';
import { inTauri, isElevated, relaunchElevated, vpnConflicts } from '../lib/tauri';

const BTN: Record<string, string> = {
  connect: 'Запустить',
  disconnect: 'Отключить',
  retry: 'Повторить',
  none: 'Подключение…',
};

/** «полчаса» / «час» / «2 часа» — понятная человеку длительность таймера возврата. */
function fmtTimeout(hours: number): string {
  if (hours < 1) {
    const m = Math.round(hours * 60);
    return m === 30 ? 'полчаса' : count(m, 'минуту', 'минуты', 'минут');
  }
  return Number.isInteger(hours) ? count(hours, 'час', 'часа', 'часов') : `${hours} ч`;
}

export function Home() {
  const { s, connect, disconnect, setSmartRouting, setSetting, error, reconnecting, noInternet, fullAvailable, selectedNode } = useStore();
  const [admin, setAdmin] = useState(true);
  useEffect(() => {
    if (inTauri) void isElevated().then(setAdmin);
  }, []);
  const info = STATE_INFO[s.conn];
  const server = s.servers.find((x) => x.id === s.serverId) ?? null;

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


  const live = s.conn === 'on' || s.conn === 'config-updating' || s.conn === 'config-updated';

  const onMain = () => {
    if (info.action === 'connect' || info.action === 'retry') connect();
    else if (info.action === 'disconnect') disconnect();
  };

  return (
    <div className="viewport home">
      <Banner conn={s.conn} onAction={connect} detail={error} />

      {/* Круглая кнопка-логотип на глобусе — главный переключатель. Блок «Ваш
          трафик» убран: то же самое настраивается в разделе «Маршрутизация». */}
      <HomeHero />

      <div style={{ textAlign: 'center', marginTop: 4 }}>
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
          <StatusDot tone={noInternet ? 'red' : info.tone} />
          {noInternet ? 'Нет интернета' : info.label}
        </div>
        <div className="mono" style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 7 }}>
          {noInternet ? (
            'Интернет пропал. Подключимся сами, как только он вернётся'
          ) : reconnecting ? (
            'Переподключение…'
          ) : live && server ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <FlagName name={(selectedNode ?? server).name} height={12} />
              {server.ping != null ? `· ${server.ping} ms` : ''}
            </span>
          ) : (
            info.note || '—'
          )}
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
                : fullTimeoutHours > 0
                  ? `Полный VPN. Вернётся на умную маршрутизацию через ${fmtTimeout(fullTimeoutHours)}`
                  : 'Полный VPN: весь трафик идёт через туннель'}
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
              ? ` Ничего делать не нужно — через ${fmtTimeout(fullTimeoutHours)} умная маршрутизация включится автоматически.`
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
        {/* Подпись под сегментами убрана по просьбе владельца: «Прокси» и «TUN»
            говорят сами за себя, дублировать текстом не нужно. */}
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

      {/* Строка «Через VPN» убрана по просьбе владельца: дублировала раздел
          «Маршрутизация», где то же самое настраивается. */}

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
