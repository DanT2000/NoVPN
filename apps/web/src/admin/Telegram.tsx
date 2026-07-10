// A8 — Telegram. Настройки бота, прокси, шаблон сообщений и привязки.

import { useState } from 'react';
import type { TelegramMode, ProxyType } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import type { SaveTelegramInput } from '../api/types';
import { Chip, Field, Panel, Toggle } from '../components/ui';

export function Telegram() {
  const { data, goAdmin, saveTelegram, showToast } = useApp();
  const tg = data?.telegram;

  const [enabled, setEnabled] = useState(tg?.enabled ?? false);
  const [token, setToken] = useState('');
  const [mode, setMode] = useState<TelegramMode>(tg?.mode ?? 'polling');
  const [proxyOn, setProxyOn] = useState(tg?.proxyOn ?? false);
  const [proxyType, setProxyType] = useState<ProxyType>(tg?.proxyType ?? 'http');
  const [proxyHost, setProxyHost] = useState(tg?.proxyHost ?? '');
  const [proxyPort, setProxyPort] = useState(tg?.proxyPort ?? '');
  const [proxyLogin, setProxyLogin] = useState(tg?.proxyLogin ?? '');
  const [proxyPass, setProxyPass] = useState('');
  const [template, setTemplate] = useState(tg?.template ?? '');

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  if (!data) return null;

  const savedMasked = data.telegram.tokenMasked;
  const hasToken = !!savedMasked || token.trim().length > 0;
  const tgStatusLabel = enabled ? (hasToken ? 'работает' : 'включён, ожидает токен') : 'выключен';

  const linkedUsers = data.users.filter((u) => data.telegram.linkedUserIds.includes(u.id));

  const save = async () => {
    setSaving(true);
    try {
      const input: SaveTelegramInput = {
        enabled,
        token: token.trim() ? token.trim() : undefined,
        mode,
        proxyOn,
        proxyType,
        proxyHost,
        proxyPort,
        proxyLogin,
        proxyPass: proxyPass ? proxyPass : undefined,
        template,
      };
      await saveTelegram(input);
      setToken('');
      setProxyPass('');
      showToast('Настройки Telegram сохранены');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testTelegram(token.trim()));
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <div className="eyebrow" style={{ marginBottom: 4 }}>Telegram</div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>Бот и привязки</div>
      </div>

      <div className="stack" style={{ gap: 16, maxWidth: 640 }}>
        {/* Бот */}
        <Panel
          title="Telegram-бот"
          extra={
            <div className="row" style={{ gap: 10 }}>
              <span className="small muted">статус: {tgStatusLabel}</span>
              <Toggle on={enabled} onChange={setEnabled} ariaLabel="Включить бота" />
            </div>
          }
        >
          <Field label="Bot Token" hint={savedMasked ? `сохранён: ${savedMasked}` : undefined}>
            <input
              className="input mono"
              type="password"
              placeholder={savedMasked ? '•••••• (сохранён)' : '123456:ABC-DEF…'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>

          <Field label="Режим">
            <div className="chip-row">
              <Chip label="Polling" active={mode === 'polling'} onClick={() => setMode('polling')} />
              <Chip label="Webhook" active={mode === 'webhook'} onClick={() => setMode('webhook')} />
            </div>
          </Field>

          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
              Сохранить
            </button>
            <button className="btn btn-secondary" disabled={testing} onClick={() => void runTest()}>
              {testing ? 'Проверяем…' : 'Проверить соединение'}
            </button>
          </div>

          {testResult ? (
            <div className={testResult.ok ? 'notice notice-green' : 'notice notice-red'}>
              {testResult.message}
            </div>
          ) : null}
        </Panel>

        {/* Прокси */}
        <Panel
          title="Proxy для бота"
          extra={<Toggle on={proxyOn} onChange={setProxyOn} ariaLabel="Включить прокси" />}
        >
          {proxyOn ? (
            <>
              <Field label="Тип">
                <div className="chip-row">
                  <Chip label="HTTP" active={proxyType === 'http'} onClick={() => setProxyType('http')} />
                  <Chip label="SOCKS5" active={proxyType === 'socks5'} onClick={() => setProxyType('socks5')} />
                </div>
              </Field>
              <div className="grid-2">
                <Field label="host">
                  <input className="input mono" value={proxyHost} onChange={(e) => setProxyHost(e.target.value)} />
                </Field>
                <Field label="port">
                  <input className="input mono" value={proxyPort} onChange={(e) => setProxyPort(e.target.value)} />
                </Field>
                <Field label="login (необязательно)">
                  <input className="input" value={proxyLogin} onChange={(e) => setProxyLogin(e.target.value)} />
                </Field>
                <Field label="password">
                  <input
                    className="input"
                    type="password"
                    value={proxyPass}
                    onChange={(e) => setProxyPass(e.target.value)}
                  />
                </Field>
              </div>
            </>
          ) : (
            <span className="small muted">Прокси выключен.</span>
          )}
        </Panel>

        {/* Шаблон */}
        <Panel title="Шаблон сообщений">
          <Field label="Текст" hint="переменные: {code} {url} {expires}">
            <textarea className="textarea" value={template} onChange={(e) => setTemplate(e.target.value)} />
          </Field>
        </Panel>

        {/* Привязки */}
        <Panel title="Привязанные пользователи">
          {linkedUsers.length === 0 ? (
            <span className="small muted">Пока никто не привязал Telegram.</span>
          ) : (
            <div>
              {linkedUsers.map((u) => (
                <div
                  key={u.id}
                  className="divide-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => goAdmin('user-card', { userId: u.id })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') goAdmin('user-card', { userId: u.id });
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <span style={{ fontWeight: 600 }}>{u.name}</span>
                  <span className="mono small" style={{ color: 'var(--text-muted)' }}>{u.telegram}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
