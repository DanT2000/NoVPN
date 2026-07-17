// A5 — Карточка пользователя. Единый профиль (как при создании), код, срок,
// выпуск конфигов, устройства, история.

import { useState } from 'react';
import type { IssueDeviceResult, Protocol, Server, User } from '@novpn/shared';
import { PROTOCOL_LABELS } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { CategoryPicker, Chip, ConfigBox, Dot, EmptyState, Field, Panel, Pill, ProgressBar, ScreenHeader } from '../components/ui';
import { Qr } from '../components/Qr';
import { dateShort, daysLeft, gb, rel, DAY_MS } from '../lib/format';
import { countActiveDevices, devStatusOf, serverAgentView, statusOf } from '../lib/status';
import { copyText, downloadText } from '../lib/clipboard';

const CATEGORIES = ['Общие', 'Семья', 'Друзья', 'Работа', 'Админ'] as const;
const digits = (s: string) => s.replace(/\D+/g, '');
const posInt = (s: string): number | null => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const posNum = (s: string): number | null => {
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Какие VPN-протоколы реально установлены хотя бы на одном из выбранных серверов. */
function installedOn(servers: Server[], ids: string[]): Protocol[] {
  const set = new Set<Protocol>();
  for (const s of servers) if (ids.includes(s.id)) for (const p of s.protocols) set.add(p);
  return [...set];
}

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

type DlMode = '1' | '10' | 'unlim' | 'custom';
type TrafMode = 'unlim' | 'custom';

function UserCardInner({ user }: { user: User }) {
  const {
    data, isMobile, goAdmin, showToast, showConfirm,
    updateUser, extendUser, setUserActive, reissueCode, reissueLink, setUserCode, deleteUser,
    reissueDevice, revokeDevice, issueDevice,
  } = useApp();

  const servers = data?.servers ?? [];

  // ── Профиль (единая форма как при создании) ──
  const [name, setName] = useState(user.name);
  const [category, setCategory] = useState<string>(user.category ?? 'Общие');
  const [comment, setComment] = useState(user.comment);
  const [tagsRaw, setTagsRaw] = useState(user.tags.join(', '));

  const [dlMode, setDlMode] = useState<DlMode>(
    user.deviceLimit == null ? 'unlim' : user.deviceLimit === 1 ? '1' : user.deviceLimit === 10 ? '10' : 'custom',
  );
  const [dlCustom, setDlCustom] = useState(user.deviceLimit && ![1, 10].includes(user.deviceLimit) ? String(user.deviceLimit) : '3');
  const [trafMode, setTrafMode] = useState<TrafMode>(user.trafficLimitGb == null ? 'unlim' : 'custom');
  const [trafCustom, setTrafCustom] = useState(user.trafficLimitGb == null ? '' : String(user.trafficLimitGb));
  const [resetPolicy, setResetPolicy] = useState<'never' | 'monthly'>(user.resetPolicy);

  const [allowedServers, setAllowedServers] = useState<string[]>([...user.allowedServers]);
  const [defaultServerId, setDefaultServerId] = useState<string | null>(user.defaultServerId ?? user.allowedServers[0] ?? null);
  const [protocols, setProtocols] = useState<Protocol[]>([...user.allowedProtocols]);
  const [savingProfile, setSavingProfile] = useState(false);

  // ── Код ──
  const [manualCode, setManualCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  // ── Личная ссылка ──
  // Домен берём из настроек, а если не задан — из адресной строки, чтобы
  // ссылка была рабочей сразу, без похода в настройки.
  const accessLink = user.accessToken
    ? `${(data?.settings.domain || window.location.origin).replace(/\/$/, '')}/k/${user.accessToken}`
    : 'ссылка не выдана';
  const codeLoginActive = !!user.codeLoginUntil && new Date(user.codeLoginUntil) > new Date();
  const codeLoginLine = codeLoginActive
    ? `Код доступа — старый способ, работает до ${dateShort(user.codeLoginUntil!)}`
    : 'Код доступа — вход по нему отключён, остаётся только для Telegram-бота';
  const reissueLinkFor = () =>
    showConfirm({
      title: 'Выдать новую ссылку?',
      text: `Старая ссылка «${user.name}» сразу перестанет работать. Новую нужно будет отправить человеку заново.`,
      confirmLabel: 'Выдать новую',
      onConfirm: async () => {
        await reissueLink(user.id);
        showToast('Ссылка перевыпущена');
      },
    });

  // ── Срок ──
  const [extendDays, setExtendDays] = useState('');

  // ── Выпуск конфига ──
  const [issueOpen, setIssueOpen] = useState(false);
  const [issServer, setIssServer] = useState<string>(user.allowedServers[0] ?? '');
  const issuableFor = (sid: string): Protocol[] => {
    const inst = servers.find((s) => s.id === sid)?.protocols ?? [];
    return (['xray', 'amneziawg'] as Protocol[]).filter((p) => inst.includes(p) && user.allowedProtocols.includes(p as User['allowedProtocols'][number]));
  };
  const [issProto, setIssProto] = useState<Protocol>(() => issuableFor(user.allowedServers[0] ?? '')[0] ?? 'xray');
  const [issName, setIssName] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<IssueDeviceResult | null>(null);
  const [issErr, setIssErr] = useState<string | null>(null);

  if (!data) return null;

  const isAdmin = category === 'Админ';
  const activeDevices = countActiveDevices(user.id, data.devices);
  const userDevices = data.devices.filter((d) => d.userId === user.id);
  const history = data.history[user.id] ?? [];
  const usagePct = user.trafficLimitGb ? Math.min(100, (user.trafficUsedGb / user.trafficLimitGb) * 100) : 0;
  const selectedServers = servers.filter((s) => allowedServers.includes(s.id));
  const installed = installedOn(servers, allowedServers);

  // Протоколы к показу: только установленные (xray/amnezia) + прокси для админа.
  const protocolOptions: Array<{ key: Protocol; label: string }> = [
    ...(['xray', 'amneziawg'] as Protocol[])
      .filter((p) => installed.includes(p))
      .map((p) => ({ key: p, label: p === 'xray' ? 'Xray' : 'Amnezia' })),
    ...(isAdmin
      ? ([
          { key: 'http', label: 'HTTP-прокси' },
          { key: 'socks5', label: 'SOCKS5' },
        ] as Array<{ key: Protocol; label: string }>)
      : []),
  ];

  let expLine: string;
  if (!user.expiresAt) expLine = 'Бессрочно';
  else if (new Date(user.expiresAt).getTime() < Date.now()) expLine = `Срок истёк ${dateShort(user.expiresAt)}`;
  else expLine = `Осталось ${daysLeft(user.expiresAt) ?? 0} дн · до ${dateShort(user.expiresAt)}`;

  const issuable = issuableFor(issServer);
  const effIssProto = issuable.includes(issProto) ? issProto : issuable[0];

  function toggleServer(id: string) {
    setAllowedServers((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      if (next.length === 0) setDefaultServerId(null);
      else if (!defaultServerId || !next.includes(defaultServerId)) setDefaultServerId(next[0] ?? null);
      return next;
    });
  }
  function changeCategory(v: string) {
    setCategory(v);
    if (v !== 'Админ') setProtocols((prev) => prev.filter((p) => p === 'xray' || p === 'amneziawg'));
  }
  function toggleProtocol(p: Protocol) {
    setProtocols((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  async function saveProfile() {
    if (allowedServers.length === 0) {
      showToast('Выберите хотя бы один сервер');
      return;
    }
    const eff = protocols.filter((p) =>
      p === 'xray' || p === 'amneziawg' ? installed.includes(p) : isAdmin && (p === 'http' || p === 'socks5'),
    );
    if (eff.length === 0) {
      showToast('Выберите хотя бы один установленный протокол');
      return;
    }
    const deviceLimit = dlMode === '1' ? 1 : dlMode === '10' ? 10 : dlMode === 'unlim' ? null : posInt(dlCustom);
    const trafficLimitGb = trafMode === 'unlim' ? null : posNum(trafCustom);
    const def = defaultServerId && allowedServers.includes(defaultServerId) ? defaultServerId : allowedServers[0] ?? null;
    setSavingProfile(true);
    try {
      await updateUser(user.id, {
        name: name.trim() || user.name,
        category,
        comment,
        tags: tagsRaw.split(',').map((t) => t.trim()).filter(Boolean),
        deviceLimit,
        trafficLimitGb,
        resetPolicy,
        allowedServers,
        defaultServerId: def,
        allowedProtocols: eff as User['allowedProtocols'],
      });
      showToast('Профиль сохранён');
    } finally {
      setSavingProfile(false);
    }
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
  async function makeUnlimited() {
    await updateUser(user.id, { expiresAt: null });
    showToast('Срок снят — доступ бессрочный');
  }
  async function setExactDays(days: number) {
    const expiresAt = new Date(Date.now() + days * DAY_MS).toISOString();
    await updateUser(user.id, { expiresAt });
    showToast(`Срок: ${days} дн от сегодня`);
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

  async function doIssue() {
    if (!issServer || !effIssProto || issuing) return;
    setIssuing(true);
    setIssErr(null);
    try {
      const r = await issueDevice({ userId: user.id, name: issName.trim() || 'Устройство', serverId: issServer, protocol: effIssProto as 'xray' | 'amneziawg' });
      setIssued(r);
    } catch (e) {
      setIssErr(e instanceof Error ? e.message : 'Ошибка выпуска конфига');
    } finally {
      setIssuing(false);
    }
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
              <button className="btn btn-secondary" onClick={() => void setUserActive(user.id, true)}>
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
        <StatCard label="Трафик" value={`${gb(user.trafficUsedGb)} / ${gb(user.trafficLimitGb)}`} />
        <StatCard label="Активность" value={rel(user.lastActivityAt)} />
      </div>

      {/* Код + Срок в две колонки */}
      <div className="grid-2">
        <Panel title="Доступ">
          {/* Личная ссылка — основной способ. Её отправляют человеку, вводить
              ничего не надо, а длинный токен не подобрать. */}
          <Field label="Личная ссылка — отправьте её человеку">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="input mono" readOnly value={accessLink} style={{ flex: '1 1 260px', fontSize: 12 }} />
              <button
                className="btn btn-primary btn-sm"
                disabled={!user.accessToken}
                onClick={async () => {
                  showToast((await copyText(accessLink)) ? 'Ссылка скопирована' : 'Не удалось скопировать');
                }}
              >
                Копировать
              </button>
              <button className="btn btn-outline btn-sm" onClick={reissueLinkFor}>
                Новая ссылка
              </button>
            </div>
          </Field>
          <div className="body small muted" style={{ marginTop: -4 }}>
            «Новая ссылка» мгновенно ломает старую — на случай, если утекла.
          </div>

          {/* Код — устаревший способ. Живёт только у тех, кто получил его раньше. */}
          <Field label={codeLoginLine}>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="mono" style={{ fontSize: 22, fontWeight: 700, letterSpacing: '0.06em', opacity: codeLoginActive ? 1 : 0.45 }}>
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
          </Field>
          <Field label="Задать код вручную">
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input mono"
                inputMode="numeric"
                maxLength={6}
                placeholder="6 цифр"
                value={manualCode}
                onChange={(e) => {
                  setManualCode(digits(e.target.value));
                  setCodeError(null);
                }}
                style={{ maxWidth: 160 }}
              />
              <button className="btn btn-primary btn-sm" onClick={() => void saveCode()}>
                Сохранить
              </button>
            </div>
          </Field>
          {codeError && <div className="notice notice-red">{codeError}</div>}
        </Panel>

        <Panel title="Срок действия">
          <div style={{ fontWeight: 600 }}>{expLine}</div>
          <div className="chip-row">
            <Chip label="+7 дн" onClick={() => void doExtend(7)} />
            <Chip label="+30 дн" onClick={() => void doExtend(30)} />
            <Chip label="+90 дн" onClick={() => void doExtend(90)} />
            <Chip label="∞ снять срок" active={!user.expiresAt} onClick={() => void makeUnlimited()} />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input"
              inputMode="numeric"
              placeholder="дней от сегодня"
              value={extendDays}
              onChange={(e) => setExtendDays(digits(e.target.value))}
              style={{ maxWidth: 150 }}
            />
            <button className="btn btn-outline btn-sm" onClick={extendCustom}>
              Продлить
            </button>
            <button
              className="btn btn-outline btn-sm"
              onClick={() => {
                const n = parseInt(extendDays, 10);
                if (Number.isFinite(n) && n > 0) {
                  void setExactDays(n);
                  setExtendDays('');
                }
              }}
            >
              Задать срок
            </button>
          </div>
        </Panel>
      </div>

      {/* ЕДИНЫЙ ПРОФИЛЬ — как при создании, поля предзаполнены */}
      <Panel
        title="Профиль"
        extra={
          <button className="btn btn-primary btn-sm" disabled={savingProfile} onClick={() => void saveProfile()}>
            {savingProfile ? 'Сохраняем…' : 'Сохранить профиль'}
          </button>
        }
      >
        <div className="grid-2">
          <Field label="Имя">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Категория" hint="можно менять из списка или задать свою">
            <CategoryPicker
              value={category}
              onChange={changeCategory}
              suggestions={[...CATEGORIES, ...(data?.users.map((u) => u.category ?? '') ?? [])]}
            />
          </Field>
          <Field label="Комментарий">
            <input className="input" placeholder="Виден только вам" value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
          <Field label="Теги">
            <input className="input" placeholder="vip, промо" value={tagsRaw} onChange={(e) => setTagsRaw(e.target.value)} />
          </Field>
        </div>

        <div className="grid-2" style={{ marginTop: 4 }}>
          <div className="field">
            <span className="field-label">Лимит устройств</span>
            <div className="chip-row">
              <Chip label="1" active={dlMode === '1'} onClick={() => setDlMode('1')} />
              <Chip label="10" active={dlMode === '10'} onClick={() => setDlMode('10')} />
              <Chip label="∞" active={dlMode === 'unlim'} onClick={() => setDlMode('unlim')} />
              <Chip label="Своё" active={dlMode === 'custom'} onClick={() => setDlMode('custom')} />
            </div>
            {dlMode === 'custom' && (
              <input
                className="input"
                inputMode="numeric"
                placeholder="число"
                value={dlCustom}
                onChange={(e) => setDlCustom(digits(e.target.value))}
                style={{ maxWidth: 200, marginTop: 8 }}
              />
            )}
          </div>
          <div className="field">
            <span className="field-label">Лимит трафика</span>
            <div className="chip-row">
              <Chip label="∞" active={trafMode === 'unlim'} onClick={() => setTrafMode('unlim')} />
              <Chip label="Лимит, ГБ" active={trafMode === 'custom'} onClick={() => setTrafMode('custom')} />
            </div>
            {trafMode === 'custom' && (
              <input
                className="input"
                inputMode="decimal"
                placeholder="ГБ"
                value={trafCustom}
                onChange={(e) => setTrafCustom(e.target.value.replace(/[^\d.,]/g, ''))}
                style={{ maxWidth: 200, marginTop: 8 }}
              />
            )}
          </div>
          <div className="field">
            <span className="field-label">Сброс трафика</span>
            <div className="chip-row">
              <Chip label="Никогда" active={resetPolicy === 'never'} onClick={() => setResetPolicy('never')} />
              <Chip label="Ежемесячно" active={resetPolicy === 'monthly'} onClick={() => setResetPolicy('monthly')} />
            </div>
          </div>
          <div className="field">
            <span className="field-label">Расход трафика</span>
            <ProgressBar pct={usagePct} />
            <div className="small muted" style={{ marginTop: 4 }}>
              {gb(user.trafficUsedGb)} / {gb(user.trafficLimitGb)}
            </div>
          </div>
        </div>

        <div className="field" style={{ marginTop: 4 }}>
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
                        {defaultServerId === s.id ? <span className="small muted"> · по умолчанию</span> : null}
                      </span>
                    </span>
                    <span className="mono small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.protocols.map((p) => PROTOCOL_LABELS[p]).join(' · ') || s.host}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {selectedServers.length > 1 ? (
          <div className="field">
            <span className="field-label">Сервер по умолчанию</span>
            <div className="chip-row">
              {selectedServers.map((s) => (
                <Chip key={s.id} label={s.name} active={defaultServerId === s.id} onClick={() => setDefaultServerId(s.id)} />
              ))}
            </div>
          </div>
        ) : null}

        <div className="field">
          <span className="field-label">Разрешённые протоколы</span>
          {protocolOptions.length === 0 ? (
            <span className="small muted">На выбранных серверах нет установленных протоколов.</span>
          ) : (
            <div className="chip-row">
              {protocolOptions.map((p) => (
                <Chip key={p.key} label={p.label} active={protocols.includes(p.key)} onClick={() => toggleProtocol(p.key)} />
              ))}
            </div>
          )}
          <span className="small muted">
            Показаны только протоколы, установленные на выбранных серверах{isAdmin ? '. Для «Админ» доступны прокси HTTP/SOCKS5.' : '.'}
          </span>
        </div>
      </Panel>

      <Panel
        title="Устройства и конфиги"
        extra={
          <button
            className="btn btn-outline btn-sm"
            onClick={() => {
              setIssueOpen((v) => !v);
              setIssued(null);
              setIssErr(null);
            }}
          >
            {issueOpen ? 'Закрыть' : '+ Выпустить конфиг'}
          </button>
        }
      >
        {issueOpen ? (
          <div className="card stack" style={{ gap: 12, marginBottom: 8 }}>
            {!issued ? (
              <>
                <Field label="Сервер">
                  <select
                    className="select"
                    value={issServer}
                    onChange={(e) => {
                      setIssServer(e.target.value);
                      setIssProto(issuableFor(e.target.value)[0] ?? 'xray');
                    }}
                  >
                    {user.allowedServers.map((sid) => {
                      const srv = servers.find((s) => s.id === sid);
                      return (
                        <option key={sid} value={sid}>
                          {srv ? `${srv.name}${srv.country ? ` (${srv.country})` : ''}` : sid}
                        </option>
                      );
                    })}
                  </select>
                </Field>
                {issuable.length === 0 ? (
                  <div className="notice notice-amber small">
                    На этом сервере нет установленных протоколов, разрешённых пользователю. Добавьте протокол в
                    настройках сервера или разрешите его пользователю.
                  </div>
                ) : (
                  <Field label="Протокол">
                    <div className="chip-row">
                      {issuable.map((p) => (
                        <Chip key={p} label={PROTOCOL_LABELS[p]} active={effIssProto === p} size="sm" onClick={() => setIssProto(p)} />
                      ))}
                    </div>
                  </Field>
                )}
                <Field label="Название устройства">
                  <input className="input" placeholder="Например, Телефон" value={issName} onChange={(e) => setIssName(e.target.value)} />
                </Field>
                {issErr ? <div className="notice notice-red small">{issErr}</div> : null}
                <button className="btn btn-primary btn-sm" disabled={!issServer || issuable.length === 0 || issuing} onClick={() => void doIssue()}>
                  {issuing ? 'Выпускаем…' : 'Создать конфиг'}
                </button>
              </>
            ) : (
              <>
                <div className="notice notice-green small">Конфиг готов — скопируй и передай пользователю.</div>
                <Qr text={(issued.link ?? issued.conf)!} caption="Или отсканируйте QR" />
                <div className="field-label">{issued.link ? 'Ссылка (Xray)' : 'Конфигурация AmneziaWG (.conf)'}</div>
                <ConfigBox text={(issued.link ?? issued.conf)!} />
                {issued.vpnKeyNote ? <div className="notice notice-amber small">{issued.vpnKeyNote}</div> : null}
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={async () => {
                      await copyText((issued.link ?? issued.conf)!);
                      showToast(issued.link ? 'Ссылка скопирована' : 'Конфигурация скопирована');
                    }}
                  >
                    Копировать
                  </button>
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() =>
                      issued.link
                        ? downloadText(`novpn-${issued.device.name}.txt`, issued.link)
                        : downloadText(`novpn-${issued.device.name}.conf`, issued.conf!)
                    }
                  >
                    Скачать
                  </button>
                  <button className="btn btn-outline btn-sm" onClick={() => { setIssued(null); setIssName(''); }}>
                    Ещё один
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}
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

      <Panel title="Telegram">
        <div>{user.telegram ? `Привязан: ${user.telegram}` : 'Не привязан'}</div>
        <span className="small muted">Привязка выполняется пользователем через бота.</span>
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
