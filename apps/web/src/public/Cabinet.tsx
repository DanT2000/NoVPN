import { useState } from 'react';
import { PROTOCOL_LABELS } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import { Dot } from '../components/ui';
import { Qr } from '../components/Qr';
import { dateShort, daysLeft, gb, plural } from '../lib/format';
import { statusOf } from '../lib/status';
import { copyText, openUrl } from '../lib/clipboard';

const PROXY_LABELS: Record<string, string> = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="divide-row" style={{ alignItems: 'flex-start' }}>
      <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted-2)', textTransform: 'uppercase', letterSpacing: '0.08em', paddingTop: 2 }}>
        {label}
      </span>
      <div style={{ textAlign: 'right', maxWidth: '70%' }}>{children}</div>
    </div>
  );
}

function Tile({ title, sub, onClick, chevron }: { title: string; sub: string; onClick: () => void; chevron?: boolean }) {
  return (
    <button type="button" className="card" onClick={onClick} style={{ textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
        <div className="small muted" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
      </div>
      {chevron ? <span style={{ color: 'var(--text-faint)', fontSize: 20 }}>›</span> : null}
    </button>
  );
}

export function Cabinet() {
  const { publicUser: user, publicData: data, goPublic, logoutPublic, showToast, showConfirm, reloadPublic } = useApp();
  const [pxBusy, setPxBusy] = useState<string | null>(null);
  if (!user || !data) return null;

  const devices = data.devices.filter((d) => d.userId === user.id);
  // Лимит устройств — только AmneziaWG. Xray = одна общая подписка, в лимит не входит.
  const awgActive = devices.filter((d) => d.isActive && d.protocol === 'amneziawg').length;
  // Подписку Xray показываем, только когда в ней реально есть конфиги: иначе новый
  // пользователь добавил бы пустую ссылку и получил бы «нет серверов».
  const hasActiveXray = devices.some((d) => d.isActive && d.protocol === 'xray');
  const status = statusOf(user);
  const dl = daysLeft(user.expiresAt);

  const serverNames = user.allowedServers
    .map((id) => data.servers.find((s) => s.id === id)?.name)
    .filter(Boolean)
    .join(' · ');
  const protoNames = user.allowedProtocols.map((p) => PROTOCOL_LABELS[p]).join(' · ');
  const botReady = !!(data.telegram?.enabled && data.telegram?.botUsername);

  const devSub = devices.length
    ? devices.slice(0, 2).map((d) => d.name).join(', ')
    : 'пока нет';

  // Прокси: отдельный логин на пользователя. Показываем выданные аккаунты и
  // предлагаем выдать на серверах, где нужный тип установлен и разрешён.
  const allowedProxies = (data.allowedProxies ?? []) as string[];
  const proxyAccounts = data.proxyAccounts ?? [];
  const proxyServers = data.servers.filter(
    (s) =>
      user.allowedServers.includes(s.id) &&
      (s.protocols as string[]).some((p) => allowedProxies.includes(p)) &&
      !proxyAccounts.some((a) => a.serverId === s.id),
  );
  const showProxy = allowedProxies.length > 0 || proxyAccounts.length > 0;

  async function issueProxy(serverId: string) {
    setPxBusy(serverId);
    try {
      await api.issueProxy(serverId);
      await reloadPublic();
      showToast('Прокси выдан');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось выдать прокси');
    } finally {
      setPxBusy(null);
    }
  }
  function revokeProxy(id: string) {
    showConfirm({
      title: 'Отозвать прокси?',
      text: 'Логин перестанет работать. Позже можно выдать заново.',
      confirmLabel: 'Отозвать',
      onConfirm: async () => {
        try {
          await api.revokeProxyAccount(id);
          await reloadPublic();
          showToast('Прокси отозван');
        } catch (e) {
          showToast(e instanceof Error ? e.message : 'Не удалось отозвать');
        }
      },
    });
  }

  return (
    <div className="stack" style={{ gap: 16, paddingTop: 12 }}>
      <div className="row-between">
        <div>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Доступ</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{user.name}</div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <Dot color={status.dot} />
          <span className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: status.fg }}>
            {status.label}
          </span>
        </div>
      </div>

      <div className="card" style={{ padding: '4px 16px' }}>
        <Row label="Срок">
          <div style={{ fontWeight: 700 }}>
            {user.expiresAt == null ? 'Бессрочно' : dl != null && dl < 0 ? 'истёк' : `${dl} ${plural(dl ?? 0, 'день', 'дня', 'дней')}`}
          </div>
          <div className="small muted">{user.expiresAt ? `до ${dateShort(user.expiresAt)}` : 'без даты окончания'}</div>
        </Row>
        <Row label="Устройства AmneziaWG">
          <div style={{ fontWeight: 700 }}>{user.deviceLimit == null ? awgActive : `${awgActive} из ${user.deviceLimit}`}</div>
          <div className="small muted">
            {user.deviceLimit == null
              ? 'без ограничений'
              : user.deviceLimit - awgActive > 0
                ? `можно ещё ${user.deviceLimit - awgActive}`
                : 'лимит достигнут'}
          </div>
        </Row>
        <Row label="Трафик">
          <div style={{ fontWeight: 700 }}>
            {user.trafficLimitGb == null ? `${gb(user.trafficUsedGb)} · без лимита` : `${gb(user.trafficUsedGb)} из ${gb(user.trafficLimitGb)}`}
          </div>
          {user.trafficLimitGb != null ? (
            <>
              <div className="progress" style={{ margin: '8px 0 4px' }}>
                <span style={{ width: `${Math.min(100, (user.trafficUsedGb / user.trafficLimitGb) * 100)}%` }} />
              </div>
              <div className="small muted">осталось {gb(Math.max(0, user.trafficLimitGb - user.trafficUsedGb))}</div>
            </>
          ) : null}
        </Row>
        <Row label="Серверы">
          <div style={{ fontWeight: 600 }}>{serverNames || '—'}</div>
        </Row>
        <Row label="Протоколы">
          <div style={{ fontWeight: 600 }}>{protoNames || '—'}</div>
        </Row>
      </div>

      {/* Подписки Xray — ПЕР-СЕРВЕР: у каждого сервера своя ссылка со СВОИМИ правилами
          обхода/полным туннелем. Показываем только те серверы, где у пользователя есть
          активный Xray-конфиг (иначе ссылка вернула бы 404). Одна ссылка = один профиль
          в приложении, оно само тянет конфиг и держит актуальным. */}
      {(() => {
        if (!user.allowedProtocols.includes('xray') || !hasActiveXray) return null;
        const xrayServerIds = new Set(devices.filter((d) => d.isActive && d.protocol === 'xray').map((d) => d.serverId));
        const xrayServers = data.servers.filter((s) => s.subLink && xrayServerIds.has(s.id));
        if (xrayServers.length === 0) return null;
        const multi = xrayServers.length > 1;
        const flagOf = (s: (typeof xrayServers)[number]) =>
          (s.flagEmoji || '').trim() || ((s.country || '').trim().match(/^(\p{Regional_Indicator}{2})/u)?.[1] ?? '');
        return (
          <div className="card stack" style={{ gap: 10 }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 4 }}>{multi ? 'Подписки по серверам' : 'Подписка Xray'}</div>
              <div className="body small muted">
                {multi
                  ? 'У каждого сервера своя подписка со своими правилами. Добавьте нужные — каждый появится в приложении отдельным профилем, между ними можно переключаться.'
                  : 'Добавьте ссылку в приложение один раз — оно само подтянет конфигурацию и будет держать её актуальной. Если X-Ray заблокируют — включится резервный канал.'}
              </div>
            </div>
            {xrayServers.map((s) => {
              const subUrl = s.subLink!;
              const label = [flagOf(s), s.name].filter(Boolean).join(' ');
              return (
                <div key={s.id} className="card stack" style={{ gap: 8, background: 'var(--surface-2)' }}>
                  <b>{label}</b>
                  {!multi ? <Qr text={subUrl} caption="Отсканируйте в приложении" /> : null}
                  <input className="input mono" readOnly value={subUrl} style={{ fontSize: 12 }} />
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={async () => {
                        showToast((await copyText(subUrl)) ? 'Ссылка подписки скопирована' : 'Не удалось скопировать');
                      }}
                    >
                      Копировать{multi ? ` · ${s.name}` : ' подписку'}
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={() => goPublic('apps')}>
                      Куда вставить?
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {showProxy ? (
        <div className="card stack" style={{ gap: 10 }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 4 }}>Прокси</div>
            <div className="body small muted">
              Отдельный логин и пароль для прокси. Один логин работает для всех доступных
              типов (HTTP/SOCKS5/HTTPS) на сервере.
            </div>
          </div>
          {proxyAccounts.map((a) => (
            <div key={a.id} className="card stack" style={{ gap: 6, background: 'var(--surface-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <b>{a.serverName}</b>
                <button className="btn btn-outline btn-sm" onClick={() => revokeProxy(a.id)}>Отозвать</button>
              </div>
              <Row label="Логин"><span className="mono">{a.login}</span></Row>
              <Row label="Пароль"><span className="mono">{a.password}</span></Row>
              {a.endpoints.map((e) => (
                <Row key={e.type} label={PROXY_LABELS[e.type] ?? e.type}>
                  <span className="mono">{e.host}:{e.port}</span>
                </Row>
              ))}
              <Row label="Трафик"><span>{gb(a.trafficGb)}</span></Row>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  const txt =
                    `login: ${a.login}\npassword: ${a.password}\n` +
                    a.endpoints.map((e) => `${PROXY_LABELS[e.type] ?? e.type}: ${e.host}:${e.port}`).join('\n');
                  showToast((await copyText(txt)) ? 'Данные прокси скопированы' : 'Не удалось скопировать');
                }}
              >
                Копировать данные
              </button>
            </div>
          ))}
          {proxyServers.map((s) => (
            <button
              key={s.id}
              className="btn btn-secondary btn-sm"
              disabled={pxBusy === s.id}
              onClick={() => void issueProxy(s.id)}
            >
              {pxBusy === s.id ? 'Выдаём…' : `Выдать прокси — ${s.name}`}
            </button>
          ))}
          {proxyServers.length === 0 && proxyAccounts.length === 0 ? (
            <div className="body small muted">
              Прокси вам разрешены, но пока не установлены ни на одном доступном сервере.
              Обратитесь к администратору.
            </div>
          ) : null}
        </div>
      ) : null}

      <button className="btn btn-primary btn-lg btn-block" onClick={() => goPublic('wizard', { wizardMode: 'issue' })}>
        + Подключить новое устройство
      </button>

      <div className="grid-2">
        <Tile title="Мои устройства" sub={devSub} onClick={() => goPublic('devices')} />
        <Tile
          title="Telegram-бот"
          sub={user.telegramLinked ? 'Привязан' : botReady ? 'Привязать' : 'Не подключён'}
          onClick={() => {
            const botUrl = data.telegram.botUsername ? `https://t.me/${data.telegram.botUsername}` : null;
            if (user.telegramLinked) {
              // Уже привязан — просто открываем бота, там меню с конфигами.
              if (botUrl) openUrl(botUrl);
              else showToast('Telegram уже привязан.');
              return;
            }
            if (botReady && data.botLink) {
              // Привязка по личному токену (deep-link), а не по коду — код скоро отключат.
              openUrl(data.botLink);
              showToast('Открываем бота — нажмите «Запустить», привязка произойдёт автоматически.');
            } else {
              showToast('Бот пока не настроен администратором.');
            }
          }}
        />
      </div>

      <Tile title="Приложения и инструкции" sub="Android · iOS · Windows · macOS · Linux" onClick={() => goPublic('apps')} chevron />

      <div style={{ paddingTop: 8 }}>
        <button type="button" onClick={logoutPublic} className="mono" style={{ background: 'none', border: 0, color: 'var(--text-faint)', fontSize: 12, cursor: 'pointer' }}>
          ← выйти
        </button>
      </div>
    </div>
  );
}
