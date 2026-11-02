// A8 — Telegram. Настройки бота, прокси, шаблон сообщений и привязки.

import { useEffect, useState } from 'react';
import type { ProxyType } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import type { SaveTelegramInput } from '../api/types';
import { Chip, Field, Panel, Toggle } from '../components/ui';

/** Отмеченные серверы-прокси бота (прежний одиночный выбор — как список из одного). */
function savedProxyIds(tg: { proxyServerIds?: string[]; proxyServerId?: string | null } | null | undefined): string[] {
  if (tg?.proxyServerIds?.length) return tg.proxyServerIds;
  return tg?.proxyServerId ? [tg.proxyServerId] : [];
}

export function Telegram() {
  const { data, goAdmin, saveTelegram, showToast } = useApp();
  const tg = data?.telegram;

  const [enabled, setEnabled] = useState(tg?.enabled ?? false);
  const [token, setToken] = useState('');
  const [proxyOn, setProxyOn] = useState(tg?.proxyOn ?? false);
  const [proxySource, setProxySource] = useState<'server' | 'manual'>(tg?.proxySource ?? 'manual');
  const [proxyServerIds, setProxyServerIds] = useState<string[]>(savedProxyIds(tg));
  // socks5 больше не поддерживается (undici ProxyAgent его не умеет) — если был
  // сохранён раньше, показываем как http, чтобы выбор был из рабочих вариантов.
  const [proxyType, setProxyType] = useState<ProxyType>(
    tg?.proxyType === 'https' ? 'https' : 'http',
  );
  const [proxyHost, setProxyHost] = useState(tg?.proxyHost ?? '');
  const [proxyPort, setProxyPort] = useState(tg?.proxyPort ?? '');
  const [proxyLogin, setProxyLogin] = useState(tg?.proxyLogin ?? '');
  const [proxyPass, setProxyPass] = useState('');
  const [template, setTemplate] = useState(tg?.template ?? '');

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Ресинк формы с сервером. Раньше useState-инициализация происходила ДО прихода
  // data (компонент монтировался с data=null после входа), поля фиксировались
  // пустыми, и «Сохранить» затирало реальные настройки (бот выкл, прокси/шаблон
  // стёрты). Пересобираем локальный стейт при каждом изменении сохранённых настроек.
  const tgSig = tg
    ? JSON.stringify([tg.enabled, tg.proxyOn, tg.proxySource, tg.proxyServerId, tg.proxyServerIds, tg.proxyType, tg.proxyHost, tg.proxyPort, tg.proxyLogin, tg.template, tg.tokenMasked])
    : '';
  useEffect(() => {
    if (!tg) return;
    setEnabled(tg.enabled ?? false);
    setProxyOn(tg.proxyOn ?? false);
    setProxySource(tg.proxySource ?? 'manual');
    setProxyServerIds(savedProxyIds(tg));
    setProxyType(tg.proxyType === 'https' ? 'https' : 'http');
    setProxyHost(tg.proxyHost ?? '');
    setProxyPort(tg.proxyPort ?? '');
    setProxyLogin(tg.proxyLogin ?? '');
    setTemplate(tg.template ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tgSig]);

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
        mode: 'polling', // webhook не реализован — всегда long-polling
        proxyOn,
        proxySource,
        proxyServerIds: proxySource === 'server' ? proxyServerIds : [],
        proxyServerId: proxySource === 'server' ? (proxyServerIds[0] ?? null) : null,
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
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось сохранить настройки Telegram');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testTelegram(token.trim()));
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : 'Не удалось проверить бота' });
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

          <button className="btn btn-secondary" disabled={testing} onClick={() => void runTest()}>
            {testing ? 'Проверяем…' : token.trim() ? 'Проверить введённый токен' : 'Проверить сохранённого бота'}
          </button>
          <span className="small muted">
            Сначала сохраните бота и прокси (кнопка внизу), затем проверяйте. Если сервер в РФ — Telegram обычно
            недоступен напрямую, включите прокси для бота.
          </span>

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
                  <Chip label="HTTPS" active={proxyType === 'https'} onClick={() => setProxyType('https')} />
                </div>
                {proxyType === 'https' ? (
                  <span className="small muted">HTTPS — трафик к прокси шифруется, предпочтительный вариант.</span>
                ) : null}
              </Field>

              <Field label="Источник">
                <div className="chip-row">
                  <Chip label="Выбрать сервер" active={proxySource === 'server'} onClick={() => setProxySource('server')} />
                  <Chip label="Указать вручную" active={proxySource === 'manual'} onClick={() => setProxySource('manual')} />
                </div>
              </Field>

              {proxySource === 'server' ? (
                <Field label="Серверы-прокси">
                  {data.servers.length === 0 ? (
                    <span className="small muted">Серверов пока нет — добавьте сервер или укажите прокси вручную.</span>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {data.servers.map((s) => {
                        const on = proxyServerIds.includes(s.id);
                        const hasProxy = (s.protocols as string[]).some((p) => ['http', 'https'].includes(p));
                        return (
                          <label key={s.id} className="row" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => setProxyServerIds(on ? proxyServerIds.filter((x) => x !== s.id) : [...proxyServerIds, s.id])}
                            />
                            <span>
                              {s.name}{s.country ? ` ${s.country}` : ''} · <span className="mono">{s.host}</span>
                              {on ? <span className="small muted"> · {proxyServerIds.indexOf(s.id) + 1}-й по очереди</span> : null}
                              {!hasProxy ? <span className="small" style={{ color: 'var(--warn-fg, #b7791f)' }}> · нет HTTP-прокси</span> : null}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <span className="small muted">
                    Бот ходит в Telegram через первый отмеченный сервер. Не отвечает (лёг или заблокирован) — сам
                    переходит к следующему, поэтому оповещения доходят, пока жив хоть один. Отметьте все серверы.
                  </span>
                  {(() => {
                    const noProxy = data.servers.filter(
                      (s) => proxyServerIds.includes(s.id) && !(s.protocols as string[]).some((p) => ['http', 'https'].includes(p)),
                    );
                    if (noProxy.length)
                      return (
                        <div className="notice notice-amber small" style={{ marginTop: 6 }}>
                          На {noProxy.map((s) => `«${s.name}»`).join(', ')} не установлен HTTP-прокси. Откройте «Серверы» → «Изменить» →
                          «Установить прокси», иначе бот через этот сервер не пройдёт.
                        </div>
                      );
                    return null;
                  })()}
                </Field>
              ) : (
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
              )}
            </>
          ) : (
            <span className="small muted">Прокси выключен.</span>
          )}
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

        <button className="btn btn-primary btn-lg btn-block" disabled={saving} onClick={() => void save()}>
          {saving ? 'Сохраняем…' : 'Сохранить настройки Telegram'}
        </button>
      </div>
    </>
  );
}
