// A6 — Серверы. Список серверов с метриками, редактированием и управлением выдачей.

import type React from 'react';
import { useState } from 'react';
import type { Server } from '@novpn/shared';
import { PROTOCOL_LABELS } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import type { ServerProxyConfig } from '../api/types';
import { copyText } from '../lib/clipboard';
import { Chip, Dot, EmptyState, Field, ScreenHeader, Toggle } from '../components/ui';
import { serverAgentView, serverEndpointView } from '../lib/status';
import { gb, plural, rel } from '../lib/format';
import { COUNTRIES, countryValue } from '../lib/countries';

type Proto = 'xray' | 'amneziawg' | 'http' | 'https' | 'socks5';
const PROTO_OPTS: Proto[] = ['xray', 'amneziawg', 'http', 'https', 'socks5'];

function ProxyBox({ proxy }: { proxy: ServerProxyConfig }) {
  const { showToast } = useApp();
  const line = (label: string, val: string) => (
    <div className="row-between" style={{ gap: 8 }}>
      <span className="small muted">{label}</span>
      <span className="mono small" style={{ wordBreak: 'break-all' }}>{val}</span>
    </div>
  );
  return (
    <div className="notice notice-green" style={{ display: 'grid', gap: 4 }}>
      <div style={{ fontWeight: 700 }}>Прокси установлены</div>
      {line('Логин', proxy.user)}
      {line('Пароль', proxy.pass)}
      {proxy.httpPort ? line('HTTP', `${proxy.user}:${proxy.pass}@host:${proxy.httpPort}`) : null}
      {proxy.socksPort ? line('SOCKS5', `${proxy.user}:${proxy.pass}@host:${proxy.socksPort}`) : null}
      {proxy.httpsPort ? line('HTTPS', `${proxy.user}:${proxy.pass}@${proxy.httpsHost}:${proxy.httpsPort}`) : null}
      <button
        className="btn btn-outline btn-sm"
        style={{ marginTop: 6, justifySelf: 'start' }}
        onClick={async () => {
          await copyText(`login: ${proxy.user}\npassword: ${proxy.pass}` +
            (proxy.httpPort ? `\nHTTP: host:${proxy.httpPort}` : '') +
            (proxy.socksPort ? `\nSOCKS5: host:${proxy.socksPort}` : '') +
            (proxy.httpsPort ? `\nHTTPS: ${proxy.httpsHost}:${proxy.httpsPort}` : ''));
          showToast('Скопировано');
        }}
      >
        Копировать
      </button>
    </div>
  );
}

function ServerEditForm({ server, onClose }: { server: Server; onClose: () => void }) {
  const { editServer, showToast, reload } = useApp();
  const [pxHttp, setPxHttp] = useState(server.protocols.includes('http'));
  const [pxHttps, setPxHttps] = useState((server.protocols as string[]).includes('https'));
  const [pxSocks, setPxSocks] = useState(server.protocols.includes('socks5'));
  const [pxBusy, setPxBusy] = useState(false);
  const [pxResult, setPxResult] = useState<ServerProxyConfig | null>(null);
  const [pxErr, setPxErr] = useState<string | null>(null);

  async function installProxies() {
    if (!pxHttp && !pxHttps && !pxSocks) {
      setPxErr('Отметьте хотя бы один тип прокси.');
      return;
    }
    setPxBusy(true);
    setPxErr(null);
    try {
      const r = await api.installServerProxies(server.id, { http: pxHttp, https: pxHttps, socks: pxSocks });
      setPxResult(r.proxy);
      await reload();
      showToast('Прокси установлены');
    } catch (e) {
      setPxErr(e instanceof Error ? e.message : 'Не удалось установить прокси');
    } finally {
      setPxBusy(false);
    }
  }
  async function showExisting() {
    try {
      const r = await api.getServerProxy(server.id);
      if (r.proxy) setPxResult(r.proxy);
      else setPxErr('Прокси ещё не установлены на этом сервере.');
    } catch {
      setPxErr('Не удалось получить данные прокси.');
    }
  }
  const [name, setName] = useState(server.name);
  const [country, setCountry] = useState(server.country ?? '');
  const [vpnHost, setVpnHost] = useState(server.host);
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [sshAuth, setSshAuth] = useState<'password' | 'key'>('password');
  const [secret, setSecret] = useState('');
  const [protocols, setProtocols] = useState<Proto[]>(server.protocols as Proto[]);
  const [xPub, setXPub] = useState('');
  const [xSid, setXSid] = useState('');
  const [xSni, setXSni] = useState('');
  const [awgPub, setAwgPub] = useState('');
  const [saving, setSaving] = useState(false);

  const toggle = (p: Proto) => setProtocols((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  async function save() {
    setSaving(true);
    try {
      const serverKeys =
        xPub || xSid || xSni || awgPub
          ? { xrayRealityPubKey: xPub || undefined, xrayShortId: xSid || undefined, xraySni: xSni || undefined, awgServerPubKey: awgPub || undefined }
          : undefined;
      await editServer(server.id, {
        name: name.trim() || server.name,
        country: country.trim() || null,
        vpnHost: vpnHost.trim() || server.host,
        sshPort: parseInt(sshPort, 10) || 22,
        sshUser: sshUser.trim() || 'root',
        authMethod: sshAuth,
        secret: secret.trim() || undefined,
        components: protocols,
        serverKeys,
      });
      showToast('Сервер изменён');
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 12, borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}>
      <div className="grid-2">
        <Field label="Название"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Страна (флаг)">
          <select className="select" value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">— не указана —</option>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={countryValue(c)}>
                {c.flag} {c.name}
              </option>
            ))}
            {country && !COUNTRIES.some((c) => countryValue(c) === country) ? (
              <option value={country}>{country}</option>
            ) : null}
          </select>
        </Field>
        <Field label="Домен или IP (VPN-endpoint)"><input className="input mono" value={vpnHost} onChange={(e) => setVpnHost(e.target.value)} /></Field>
        <Field label="SSH-порт"><input className="input" inputMode="numeric" value={sshPort} onChange={(e) => setSshPort(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="SSH-пользователь"><input className="input" value={sshUser} onChange={(e) => setSshUser(e.target.value)} /></Field>
        <Field label="Способ входа по SSH">
          <div className="chip-row">
            <Chip label="Пароль" size="sm" active={sshAuth === 'password'} onClick={() => setSshAuth('password')} />
            <Chip label="Приватный ключ" size="sm" active={sshAuth === 'key'} onClick={() => setSshAuth('key')} />
          </div>
        </Field>
      </div>
      <Field label={sshAuth === 'key' ? 'Новый приватный ключ (пусто = не менять)' : 'Новый SSH-пароль (пусто = не менять)'}>
        {sshAuth === 'key' ? (
          <textarea className="textarea mono" rows={4} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
        ) : (
          <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••" />
        )}
      </Field>

      <div className="field">
        <span className="field-label">Протоколы (установленные на сервере)</span>
        <div className="chip-row">
          {PROTO_OPTS.map((p) => (
            <Chip key={p} label={PROTOCOL_LABELS[p]} size="sm" active={protocols.includes(p)} onClick={() => toggle(p)} />
          ))}
        </div>
        <span className="small muted">
          Отмечайте только реально установленные протоколы — по ним выдаются конфиги. Для выпуска нужен серверный
          ключ протокола (ниже).
        </span>
      </div>

      <details>
        <summary className="small muted" style={{ cursor: 'pointer' }}>Серверные ключи (заполните при добавлении протокола; пусто = не менять)</summary>
        <div className="grid-2" style={{ marginTop: 10 }}>
          <Field label="Xray Reality pubkey"><input className="input mono" value={xPub} onChange={(e) => setXPub(e.target.value)} placeholder="pbk…" /></Field>
          <Field label="Xray shortId"><input className="input mono" value={xSid} onChange={(e) => setXSid(e.target.value)} placeholder="sid…" /></Field>
          <Field label="Xray SNI"><input className="input mono" value={xSni} onChange={(e) => setXSni(e.target.value)} placeholder="www.microsoft.com" /></Field>
          <Field label="AmneziaWG server pubkey"><input className="input mono" value={awgPub} onChange={(e) => setAwgPub(e.target.value)} placeholder="awg pubkey…" /></Field>
        </div>
      </details>

      {/* Прокси-комплект — реальная установка по SSH */}
      <div className="field" style={{ borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}>
        <span className="field-label">Прокси на сервере (устанавливаются реально по SSH)</span>
        <div className="chip-row">
          <Chip label="HTTP" size="sm" active={pxHttp} onClick={() => setPxHttp((v) => !v)} />
          <Chip label="HTTPS" size="sm" active={pxHttps} onClick={() => setPxHttps((v) => !v)} />
          <Chip label="SOCKS5" size="sm" active={pxSocks} onClick={() => setPxSocks((v) => !v)} />
        </div>
        <span className="small muted">
          3proxy (HTTP/SOCKS5) + certbot/stunnel (HTTPS). Для HTTPS нужен домен (не IP) и свободный порт 80.
        </span>
        {pxErr ? <div className="notice notice-red small">{pxErr}</div> : null}
        {pxResult ? <ProxyBox proxy={pxResult} /> : null}
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn btn-secondary btn-sm" disabled={pxBusy} onClick={() => void installProxies()}>
            {pxBusy ? 'Устанавливаем… (до минуты)' : 'Установить / обновить прокси'}
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => void showExisting()}>
            Показать текущие
          </button>
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Сохраняем…' : 'Сохранить сервер'}
        </button>
        <button className="btn btn-outline btn-sm" onClick={onClose}>Отмена</button>
      </div>
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: color ?? 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </div>
    </div>
  );
}

export function Servers() {
  const { data, isMobile, goAdmin, setServerAutoIssue, setServerDefault, deleteServer, showToast, showConfirm } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  if (!data) return null;

  const servers = data.servers;
  const n = servers.length;
  const statCols = isMobile ? '1fr 1fr' : 'repeat(auto-fit, minmax(130px, 1fr))';

  return (
    <>
      <ScreenHeader
        eyebrow="Серверы"
        title={`${n} ${plural(n, 'сервер', 'сервера', 'серверов')}`}
        right={
          <button className="btn btn-primary" onClick={() => goAdmin('server-wizard')}>
            + Добавить сервер
          </button>
        }
      />

      {n === 0 ? (
        <EmptyState
          title="Серверов пока нет"
          text="Добавьте первый сервер, чтобы выдавать конфиги пользователям."
          action={
            <button className="btn btn-primary" onClick={() => goAdmin('server-wizard')}>
              + Добавить сервер
            </button>
          }
        />
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {servers.map((s) => {
            const agentV = serverAgentView(s);
            const endpointV = serverEndpointView(s);
            const dotColor = s.agent === 'online' ? 'var(--green-dot)' : 'var(--red-fg)';
            const title = s.country ? `${s.name} · ${s.country}` : s.name;
            const protocols = s.protocols.length
              ? s.protocols.map((p) => PROTOCOL_LABELS[p]).join(', ')
              : '—';

            return (
              <div key={s.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Заголовок карточки */}
                <div className="row-between" style={{ gap: 12, alignItems: 'center' }}>
                  <div className="row" style={{ gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
                    <Dot color={dotColor} />
                    <span style={{ fontWeight: 700, fontSize: 15 }}>{title}</span>
                    {s.isDefault ? <span className="badge">по умолчанию</span> : null}
                  </div>
                  <span
                    className="mono small"
                    style={{ color: 'var(--text-muted)', textAlign: 'right', wordBreak: 'break-all' }}
                  >
                    {s.host}
                  </span>
                </div>

                {/* Метрики */}
                <div style={{ display: 'grid', gridTemplateColumns: statCols, gap: 12 }}>
                  <Metric label="Агент" value={agentV.label} color={agentV.fg} />
                  <Metric label="VPN endpoint" value={endpointV.label} color={endpointV.fg} />
                  <Metric label="Протоколы" value={protocols} />
                  <Metric label="Трафик" value={gb(s.trafficGb)} />
                  <Metric label="Пользователи" value={String(s.users)} />
                  <Metric label="Синхронизация" value={rel(s.lastSyncAt)} />
                </div>

                {/* Футер */}
                <div
                  className="row-between"
                  style={{ gap: 12, flexWrap: 'wrap', borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}
                >
                  <div className="row" style={{ gap: 10 }}>
                    <Toggle
                      on={s.autoIssue}
                      onChange={(v) => void setServerAutoIssue(s.id, v)}
                      ariaLabel="Автоматическая выдача"
                    />
                    <span className="small">Автоматическая выдача</span>
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => setEditing((cur) => (cur === s.id ? null : s.id))}
                    >
                      {editing === s.id ? 'Скрыть' : 'Изменить'}
                    </button>
                    {!s.isDefault ? (
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={async () => {
                          await setServerDefault(s.id);
                          showToast(`«${s.name}» — сервер по умолчанию`);
                        }}
                      >
                        Сделать по умолчанию
                      </button>
                    ) : null}
                    <button
                      className="btn btn-danger-outline btn-sm"
                      onClick={() =>
                        showConfirm({
                          title: 'Удалить сервер?',
                          text: `«${s.name}» и все подписки, выпущенные на этот сервер, будут удалены. Действие нельзя отменить.`,
                          confirmLabel: 'Удалить',
                          danger: true,
                          onConfirm: async () => {
                            await deleteServer(s.id);
                            showToast('Сервер удалён');
                          },
                        })
                      }
                    >
                      Удалить
                    </button>
                  </div>
                </div>

                {editing === s.id ? <ServerEditForm server={s} onClose={() => setEditing(null)} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
