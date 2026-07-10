// A5 — Карточка пользователя. Статистика, код, срок, лимиты, доступ, устройства.

import { useState } from 'react';
import type { Protocol, User } from '@novpn/shared';
import { PROTOCOL_LABELS } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { Chip, Dot, EmptyState, Field, Panel, Pill, ProgressBar, ScreenHeader } from '../components/ui';
import { dateShort, daysLeft, gb, rel } from '../lib/format';
import { countActiveDevices, devStatusOf, serverAgentView, statusOf } from '../lib/status';
import { copyText } from '../lib/clipboard';

const CATEGORIES = ['Общие', 'Семья', 'Друзья', 'Работа', 'Админ'] as const;
const digits = (s: string) => s.replace(/\D+/g, '');

export function UserCard() {
  const { data, nav, goAdmin } = useApp();
  if (!data) return null;

  const user = data.users.find((u) => u.id === nav.params.userId);
  if (!user) {
    return (
      <EmptyState
        title="Пользователь не найден"
        text="Возможно, он был удалён."
        action={
          <button className="btn btn-primary" onClick={() => goAdmin('users')}>
            К списку
          </button>
        }
      />
    );
  }

  return <UserCardInner key={user.id} user={user} />;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="eyebrow" style={{ marginBottom: 6 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 18, fontWeight: 700, wordBreak: 'break-word' }}>
        {value}
      </div>
      {sub ? (
        <div className="small muted" style={{ marginTop: 4 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function UserCardInner({ user }: { user: User }) {
  const {
    data, isMobile, goAdmin, showToast, showConfirm,
    updateUser, extendUser, setUserActive, reissueCode, setUserCode, deleteUser,
    reissueDevice, revokeDevice,
  } = useApp();

  // Основное
  const [name, setName] = useState(user.name);
  const [category, setCategory] = useState<string>(user.category ?? 'Общие');
  const [comment, setComment] = useState(user.comment);
  const [tagsRaw, setTagsRaw] = useState(user.tags.join(', '));

  // Лимиты · трафик
  const [deviceLimitStr, setDeviceLimitStr] = useState(user.deviceLimit == null ? '' : String(user.deviceLimit));
  const [trafficStr, setTrafficStr] = useState(user.trafficLimitGb == null ? '' : String(user.trafficLimitGb));
  const [resetPolicy, setResetPolicy] = useState<'never' | 'monthly'>(user.resetPolicy);

  // Доступ
  const [allowedServers, setAllowedServers] = useState<string[]>([...user.allowedServers]);
  const [protocols, setProtocols] = useState<Protocol[]>([...user.allowedProtocols]);

  // Код
  const [manualCode, setManualCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  // Срок
  const [extendDays, setExtendDays] = useState('');

  if (!data) return null;

  const servers = data.servers;
  const isAdmin = category === 'Админ';
  const activeDevices = countActiveDevices(user.id, data.devices);
  const userDevices = data.devices.filter((d) => d.userId === user.id);
  const history = data.history[user.id] ?? [];
  const usagePct = user.trafficLimitGb ? Math.min(100, (user.trafficUsedGb / user.trafficLimitGb) * 100) : 0;

  let expLine: string;
  if (!user.expiresAt) expLine = 'Бессрочно';
  else if (new Date(user.expiresAt).getTime() < Date.now()) expLine = `Срок истёк ${dateShort(user.expiresAt)}`;
  else expLine = `Осталось ${daysLeft(user.expiresAt) ?? 0} дн · до ${dateShort(user.expiresAt)}`;

  const protocolOptions: Array<{ key: Protocol; label: string }> = [
    { key: 'xray', label: 'Xray' },
    { key: 'amneziawg', label: 'Amnezia' },
    ...(isAdmin
      ? ([
          { key: 'http', label: 'HTTP' },
          { key: 'socks5', label: 'SOCKS5' },
        ] as Array<{ key: Protocol; label: string }>)
      : []),
  ];

  function toggleServer(id: string) {
    setAllowedServers((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function toggleProtocol(p: Protocol) {
    setProtocols((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  function disableUser() {
    showConfirm({
      title: 'Отключить доступ?',
      text: `«${user.name}» не сможет подключаться, все активные устройства будут отозваны.`,
      confirmLabel: 'Отключить',
      danger: true,
      onConfirm: async () => {
        await setUserActive(user.id, false);
      },
    });
  }
  async function enableUser() {
    await setUserActive(user.id, true);
  }
  function removeUser() {
    showConfirm({
      title: 'Удалить пользователя?',
      text: `«${user.name}» и все его конфиги будут удалены безвозвратно.`,
      confirmLabel: 'Удалить',
      danger: true,
      onConfirm: async () => {
        await deleteUser(user.id);
        showToast('Удалено');
        goAdmin('users');
      },
    });
  }

  function reissue() {
    showConfirm({
      title: 'Перевыпустить код?',
      text: 'Старый код перестанет работать. Пользователю нужно сообщить новый.',
      confirmLabel: 'Перевыпустить',
      onConfirm: async () => {
        const u = await reissueCode(user.id);
        showToast(`Код перевыпущен: ${u.code}`);
      },
    });
  }
  async function saveCode() {
    const res = await setUserCode(user.id, manualCode);
    if (!res.ok) {
      setCodeError(res.message ?? 'Не удалось сохранить код.');
      return;
    }
    setCodeError(null);
    setManualCode('');
    showToast('Код сохранён');
  }

  async function doExtend(days: number) {
    await extendUser(user.id, days);
    showToast(`Продлено на ${days} дн`);
  }
  function extendCustom() {
    const n = parseInt(extendDays, 10);
    if (Number.isFinite(n) && n > 0) {
      void doExtend(n);
      setExtendDays('');
    }
  }

  async function saveBasic() {
    await updateUser(user.id, {
      name: name.trim() || user.name,
      category,
      comment,
      tags: tagsRaw.split(',').map((t) => t.trim()).filter(Boolean),
    });
    showToast('Сохранено');
  }

  async function saveLimits() {
    const dl = deviceLimitStr.trim() === '' ? null : (() => { const n = parseInt(deviceLimitStr, 10); return Number.isFinite(n) && n > 0 ? n : null; })();
    const tg = trafficStr.trim() === '' ? null : (() => { const n = parseFloat(trafficStr.replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; })();
    await updateUser(user.id, { deviceLimit: dl, trafficLimitGb: tg, resetPolicy });
    showToast('Лимиты сохранены');
  }

  async function saveAccess() {
    if (allowedServers.length === 0) {
      showToast('Выберите хотя бы один сервер');
      return;
    }
    const eff = isAdmin ? protocols : protocols.filter((p) => p === 'xray' || p === 'amneziawg');
    const defaultServerId =
      user.defaultServerId && allowedServers.includes(user.defaultServerId)
        ? user.defaultServerId
        : allowedServers[0] ?? null;
    await updateUser(user.id, {
      allowedServers,
      defaultServerId,
      allowedProtocols: eff as User['allowedProtocols'],
    });
    showToast('Доступ сохранён');
  }

  function confirmRevoke(deviceId: string, deviceName: string) {
    showConfirm({
      title: 'Отключить устройство?',
      text: `«${deviceName}» перестанет подключаться.`,
      confirmLabel: 'Отключить',
      danger: true,
      onConfirm: async () => {
        await revokeDevice(deviceId);
        showToast('Отключено');
      },
    });
  }

  return (
    <div className="stack">
      <ScreenHeader
        back={() => goAdmin('users')}
        title={user.name}
        right={
          <>
            <Pill s={statusOf(user)} />
            {user.isActive ? (
              <button className="btn btn-outline" onClick={disableUser}>
                Отключить
              </button>
            ) : (
              <button className="btn btn-secondary" onClick={() => void enableUser()}>
                Включить
              </button>
            )}
            <button className="btn btn-danger-outline" onClick={removeUser}>
              Удалить
            </button>
          </>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 12 }}>
        <StatCard label="Статус" value={statusOf(user).label} />
        <StatCard label="Устройства" value={`${activeDevices}/${user.deviceLimit ?? '∞'}`} />
        <StatCard label="Трафик" value={`${gb(user.trafficUsedGb)}/${gb(user.trafficLimitGb)}`} />
        <StatCard label="Активность" value={rel(user.lastActivityAt)} />
      </div>

      <Panel title="Код доступа">
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="mono" style={{ fontSize: 26, fontWeight: 700, letterSpacing: '0.06em' }}>
            {user.code}
          </span>
          <button
            className="btn btn-secondary btn-sm"
            onClick={async () => {
              await copyText(user.code);
              showToast('Код скопирован');
            }}
          >
            Копировать
          </button>
          <button className="btn btn-outline btn-sm" onClick={reissue}>
            Перевыпустить
          </button>
        </div>
        <Field label="Задать код вручную">
          <input
            className="input mono"
            inputMode="numeric"
            maxLength={6}
            placeholder="задать вручную"
            value={manualCode}
            onChange={(e) => {
              setManualCode(digits(e.target.value));
              setCodeError(null);
            }}
            style={{ maxWidth: 200 }}
          />
        </Field>
        {codeError && <div className="notice notice-red">{codeError}</div>}
        <div>
          <button className="btn btn-primary btn-sm" onClick={() => void saveCode()}>
            Сохранить код
          </button>
        </div>
      </Panel>

      <Panel title="Срок действия">
        <div>{expLine}</div>
        <div className="chip-row">
          <Chip label="+7 дн" onClick={() => void doExtend(7)} />
          <Chip label="+30 дн" onClick={() => void doExtend(30)} />
          <Chip label="+90 дн" onClick={() => void doExtend(90)} />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            inputMode="numeric"
            placeholder="дней"
            value={extendDays}
            onChange={(e) => setExtendDays(digits(e.target.value))}
            style={{ maxWidth: 140 }}
          />
          <button className="btn btn-primary btn-sm" onClick={extendCustom}>
            Продлить
          </button>
        </div>
      </Panel>

      <Panel title="Основное">
        <Field label="Имя">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Категория">
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Комментарий">
          <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        <Field label="Теги">
          <input className="input" placeholder="vip, промо" value={tagsRaw} onChange={(e) => setTagsRaw(e.target.value)} />
        </Field>
        <div>
          <button className="btn btn-primary btn-sm" onClick={() => void saveBasic()}>
            Сохранить
          </button>
        </div>
      </Panel>

      <Panel title="Лимиты · трафик">
        <div className="grid-2">
          <Field label="Устройств (пусто = ∞)">
            <input className="input" inputMode="numeric" value={deviceLimitStr} onChange={(e) => setDeviceLimitStr(digits(e.target.value))} />
          </Field>
          <Field label="Трафик, ГБ (пусто = ∞)">
            <input
              className="input"
              inputMode="decimal"
              value={trafficStr}
              onChange={(e) => setTrafficStr(e.target.value.replace(/[^\d.,]/g, ''))}
            />
          </Field>
        </div>
        <div className="chip-row">
          <Chip label="Сброс: никогда" active={resetPolicy === 'never'} onClick={() => setResetPolicy('never')} />
          <Chip label="Сброс: ежемесячно" active={resetPolicy === 'monthly'} onClick={() => setResetPolicy('monthly')} />
        </div>
        <ProgressBar pct={usagePct} />
        <div className="small muted">
          {gb(user.trafficUsedGb)} / {gb(user.trafficLimitGb)}
        </div>
        <div>
          <button className="btn btn-primary btn-sm" onClick={() => void saveLimits()}>
            Сохранить
          </button>
        </div>
      </Panel>

      <Panel title="Доступ">
        <div className="field">
          <span className="field-label">Разрешённые серверы</span>
          {servers.length === 0 ? (
            <span className="small muted">Нет доступных серверов.</span>
          ) : (
            <div className="stack" style={{ gap: 0 }}>
              {servers.map((s) => {
                const checked = allowedServers.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="divide-row"
                    onClick={() => toggleServer(s.id)}
                    style={{ width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--border-inner)', cursor: 'pointer', textAlign: 'left' }}
                  >
                    <span className="row" style={{ gap: 10, minWidth: 0 }}>
                      <span
                        aria-hidden
                        style={{
                          width: 18, height: 18, borderRadius: 5, flex: 'none',
                          border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-input)'}`,
                          background: checked ? 'var(--accent)' : 'transparent',
                          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
                        }}
                      >
                        {checked ? '✓' : ''}
                      </span>
                      <Dot color={serverAgentView(s).dot} />
                      <span style={{ fontWeight: 600 }}>
                        {s.name} ({s.country ?? '—'})
                        {user.defaultServerId === s.id ? <span className="small muted"> · по умолчанию</span> : null}
                      </span>
                    </span>
                    <span className="mono small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.host}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="field">
          <span className="field-label">Разрешённые протоколы</span>
          <div className="chip-row">
            {protocolOptions.map((p) => (
              <Chip key={p.key} label={p.label} active={protocols.includes(p.key)} onClick={() => toggleProtocol(p.key)} />
            ))}
          </div>
          <span className="small muted">
            {isAdmin
              ? 'Категория «Админ»: дополнительно доступны прокси HTTP и SOCKS5.'
              : 'HTTP и SOCKS5 доступны только для категории «Админ».'}
          </span>
        </div>
        <div>
          <button className="btn btn-primary btn-sm" onClick={() => void saveAccess()}>
            Сохранить
          </button>
        </div>
      </Panel>

      <Panel title="Telegram">
        <div>{user.telegram ? `Привязан: ${user.telegram}` : 'Не привязан'}</div>
        <span className="small muted">Привязка выполняется пользователем через бота.</span>
      </Panel>

      <Panel
        title="Устройства и конфиги"
        extra={
          <button className="btn btn-outline btn-sm" onClick={() => showToast('Выпуск конфига — в мастере устройства')}>
            + Выпустить конфиг
          </button>
        }
      >
        {userDevices.length === 0 ? (
          <span className="small muted">Конфигов пока нет.</span>
        ) : (
          userDevices.map((d) => {
            const serverName = servers.find((s) => s.id === d.serverId)?.name ?? d.serverId;
            return (
              <div key={d.id} className="divide-row">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{d.name}</div>
                  <div className="small muted">
                    {serverName} · {PROTOCOL_LABELS[d.protocol]} · {rel(d.lastSeenAt)}
                  </div>
                </div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <span className="mono small">{gb(d.trafficGb)}</span>
                  <Pill s={devStatusOf(d)} size="sm" />
                  {d.isActive && (
                    <>
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={async () => {
                          await reissueDevice(d.id);
                          showToast('Конфиг перевыпущен');
                        }}
                      >
                        Перевыпустить
                      </button>
                      <button className="btn btn-danger-outline btn-sm" onClick={() => confirmRevoke(d.id, d.name)}>
                        Отключить
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </Panel>

      <Panel title="История изменений">
        {history.length > 0 ? (
          history.map((h, i) => (
            <div key={i} className="divide-row">
              <span className="small muted mono">{dateShort(h.at)}</span>
              <span className="small" style={{ textAlign: 'right' }}>
                {h.text}
              </span>
            </div>
          ))
        ) : (
          <div className="divide-row">
            <span className="small muted mono">{dateShort(user.createdAt)}</span>
            <span className="small">Пользователь создан</span>
          </div>
        )}
      </Panel>
    </div>
  );
}
