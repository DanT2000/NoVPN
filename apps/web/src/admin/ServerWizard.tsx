// A7 — Добавление сервера. 5-шаговый мастер (данные → проверка → компоненты →
// установка → готово). Установка РЕАЛЬНАЯ: сервер добавляется через store, затем
// провижинится по SSH (xray/awg/прокси), прогресс приходит с сервера.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { TestServerConnectionResult } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import type { AddServerInput } from '../api/types';
import { Chip, Field, ProgressBar, ScreenHeader } from '../components/ui';
import { COUNTRIES, countryValue } from '../lib/countries';

type AuthMethod = 'key' | 'password';
type Component = 'xray' | 'amneziawg' | 'http' | 'https' | 'socks5';

const isIpLike = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h.trim());
function isValidHost(h: string): boolean {
  const t = h.trim();
  if (!t) return false;
  if (isIpLike(t)) return t.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(t);
}

const STEP_LABELS = ['1. Данные', '2. Проверка', '3. Компоненты', '4. Установка', '5. Готово'];


function CheckRow({
  checked, title, sub, onToggle,
}: {
  checked: boolean; title: string; sub: string; onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="row-between"
      style={{
        width: '100%', textAlign: 'left', gap: 12, cursor: 'pointer',
        background: 'var(--surface)', border: '1px solid var(--border-input)',
        borderRadius: 'var(--r-ctrl)', padding: 12,
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>{title}</span>
        <span className="small muted" style={{ display: 'block' }}>{sub}</span>
      </span>
      <span
        aria-hidden
        style={{
          flex: 'none', width: 22, height: 22, borderRadius: 5, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700,
          color: checked ? 'var(--text-on-accent)' : 'transparent',
          background: checked ? 'var(--accent)' : 'transparent',
          border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-control)'}`,
        }}
      >
        ✓
      </span>
    </button>
  );
}

export function ServerWizard() {
  const { goAdmin, addServer, reload } = useApp();
  const [step, setStep] = useState(1);

  // Шаг 1 — данные
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [host, setHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('key');
  const [secret, setSecret] = useState('');

  // Шаг 2 — проверка
  const [testing, setTesting] = useState(false);
  const [audit, setAudit] = useState<TestServerConnectionResult | null>(null);

  // Шаг 3 — компоненты
  const [compXray, setCompXray] = useState(true);
  const [compAwg, setCompAwg] = useState(true);
  const [compHttp, setCompHttp] = useState(false);
  const [compSocks, setCompSocks] = useState(false);

  // Шаг 4 — установка
  const [pct, setPct] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [installErr, setInstallErr] = useState<string | null>(null);
  const addedRef = useRef(false);
  // id уже созданного сервера: при повторе установки после ошибки НЕ создаём
  // дубль — переиспользуем существующий сервер и повторяем только провижининг.
  const createdIdRef = useRef<string | null>(null);

  const components = (): Component[] => {
    const out: Component[] = [];
    if (compXray) out.push('xray');
    if (compAwg) out.push('amneziawg');
    if (compHttp) out.push('http');
    if (compSocks) out.push('socks5');
    return out;
  };

  const buildInput = (): AddServerInput => ({
    name: name.trim(),
    host: host.trim(),
    sshPort: Number(sshPort) || 22,
    sshUser: sshUser.trim() || 'root',
    authMethod,
    secret: secret.trim() || undefined, // пароль/ключ — БЕЗ него панель не сможет управлять сервером
    vpnHost: host.trim(), // домен/IP один раз — он же и публичный VPN-endpoint
    components: components(),
    country: country || null,
  });

  // РЕАЛЬНАЯ установка на шаге 4: добавляем сервер и провижиним его по SSH.
  useEffect(() => {
    if (step !== 4 || addedRef.current) return;
    addedRef.current = true;
    setPct(4);
    setLog(['Добавляем сервер…']);
    setInstallErr(null);
    // Прогресс-бар — индикатор ожидания; строки лога приходят РЕАЛЬНЫЕ от сервера.
    const timer = window.setInterval(() => setPct((p) => Math.min(92, p + 2)), 1600);
    (async () => {
      const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
      try {
        // Сервер создаём только один раз. Повтор после ошибки переиспользует его.
        let srvId = createdIdRef.current;
        if (!srvId) {
          const srv = await addServer(buildInput());
          createdIdRef.current = srv.id;
          srvId = srv.id;
        }
        await api.provisionServer(srvId, components()); // запуск (асинхронно на сервере)
        const started = Date.now();
        let lastMsg = '';
        for (;;) {
          await sleep(5000);
          if (Date.now() - started > 8 * 60 * 1000) throw new Error('Установка заняла слишком долго — проверьте сервер.');
          const st = await api.provisionStatus(srvId);
          if (st.message && st.message !== lastMsg) {
            lastMsg = st.message;
            setLog((prev) => [...prev, st.message]);
          }
          if (st.state === 'done') {
            setLog((prev) => [...prev, st.restored ? '✓ Ключи восстановлены' : '✓ Установка завершена']);
            setPct(100);
            await reload();
            setStep(5);
            return;
          }
          if (st.state === 'error') throw new Error(st.message);
        }
      } catch (e) {
        setInstallErr(e instanceof Error ? e.message : 'Ошибка установки. Проверьте SSH-доступ и повторите.');
      } finally {
        window.clearInterval(timer);
      }
    })();
    return () => {
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const runTest = async () => {
    setTesting(true);
    try {
      setAudit(await api.testServerConnection(buildInput()));
    } finally {
      setTesting(false);
    }
  };

  // Найденный на сервере чужой VPN — показываем отдельным заметным блоком.
  const existingVpn = audit?.audit.find((i) => i.name.startsWith('⚠️')) ?? null;

  const back = step <= 3
    ? () => (step === 1 ? goAdmin('servers') : setStep((s) => s - 1))
    : undefined;

  return (
    <>
      <ScreenHeader back={back} title="Добавление сервера" />

      {/* Индикатор шагов */}
      <div className="chip-row" style={{ marginBottom: 18 }}>
        {STEP_LABELS.map((label, idx) => {
          const num = idx + 1;
          const done = num < step;
          const current = num === step;
          const style: CSSProperties = current
            ? { borderColor: 'var(--accent)', background: 'var(--blue-sel)', color: 'var(--text-primary)', cursor: 'default' }
            : done
              ? { borderColor: 'var(--blue-bg)', background: 'var(--blue-bg)', color: 'var(--blue-fg)', cursor: 'default' }
              : { cursor: 'default' };
          return (
            <span key={label} className="chip chip-sm" style={style}>
              {label}
            </span>
          );
        })}
      </div>

      {/* Шаг 1 — Данные */}
      {step === 1 ? (
        <div className="stack" style={{ maxWidth: 560 }}>
          <Field label="Название">
            <input className="input" placeholder="Финляндия" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Страна (флаг)">
            <select className="select" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">— не указана —</option>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={countryValue(c)}>
                  {c.flag} {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Домен или IP">
            <input
              className="input mono"
              placeholder="fi1.example.com"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
          </Field>
          {isIpLike(host) ? (
            <div className="notice notice-amber small">
              ⚠️ Рекомендуем указывать <b>домен</b>, а не IP. С IP-адресом:
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                <li>подписки привязаны к IP — при смене сервера станут недействительными (нет восстановления по домену);</li>
                <li>нельзя выпустить <b>HTTPS-прокси</b> (для него нужен домен и TLS-сертификат).</li>
              </ul>
              С доменом можно переназначить его на другой сервер — и старые конфиги продолжат работать.
            </div>
          ) : null}
          {host.trim() && !isValidHost(host) ? (
            <div className="notice notice-red small">Укажите корректный домен или IP-адрес.</div>
          ) : null}
          <div className="grid-2">
            <Field label="SSH-порт">
              <input className="input mono" value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
            </Field>
            <Field label="SSH-пользователь">
              <input className="input mono" value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
            </Field>
          </div>
          <Field label="Способ входа">
            <div className="chip-row">
              <Chip label="SSH-ключ" active={authMethod === 'key'} onClick={() => setAuthMethod('key')} />
              <Chip label="Пароль" active={authMethod === 'password'} onClick={() => setAuthMethod('password')} />
            </div>
          </Field>
          <Field
            label="Секрет"
            hint="Секрет хранится только на сервере Manager и не показывается повторно."
          >
            <textarea
              className="textarea mono"
              placeholder={authMethod === 'key' ? '-----BEGIN OPENSSH PRIVATE KEY-----' : 'пароль root'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
          <p className="small muted" style={{ margin: 0 }}>
            Этот адрес используется и для подключения по SSH, и как публичный VPN-endpoint —
            указывается один раз.
          </p>
          <button
            className="btn btn-primary"
            disabled={!isValidHost(host)}
            onClick={() => setStep(2)}
          >
            К проверке соединения
          </button>
        </div>
      ) : null}

      {/* Шаг 2 — Проверка */}
      {step === 2 ? (
        <div className="stack" style={{ maxWidth: 560 }}>
          <p className="body" style={{ margin: 0 }}>
            Проверим SSH-доступ и посмотрим, что уже установлено на {host || '—'}.
          </p>
          <button className="btn btn-secondary" disabled={testing} onClick={() => void runTest()}>
            {testing ? 'Проверяем соединение…' : 'Проверить соединение и ПО'}
          </button>

          {audit ? (
            <div className="card stack" style={{ gap: 12 }}>
              {audit.audit
                .filter((i) => !i.name.startsWith('⚠️'))
                .map((item, idx) => (
                  <div key={`${item.name}-${idx}`} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                    <span
                      style={{ flex: 'none', width: 16, fontWeight: 700, color: item.ok ? 'var(--green-fg)' : 'var(--amber-fg)' }}
                    >
                      {item.ok ? '✓' : '·'}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{item.name}</div>
                      <div className="small muted">{item.note}</div>
                    </div>
                  </div>
                ))}
            </div>
          ) : null}

          {existingVpn ? (
            <div className="notice notice-amber" style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontWeight: 700 }}>На этом сервере уже установлен VPN</div>
              <div className="small">{existingVpn.note}</div>
              <div className="small" style={{ marginTop: 2 }}>
                <b>Что делать:</b>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
                  <li><b>Оставить как есть</b> — просто продолжайте. Мы поставим свой VPN на свои порты рядом. Ваш старый VPN и его конфиги продолжат работать сами по себе, но панель ими управлять не будет.</li>
                  <li><b>Оставить только наш</b> — удалите старый VPN на сервере сами <i>перед</i> установкой. Тогда сервер будет полностью под панелью.</li>
                </ul>
              </div>
            </div>
          ) : null}

          {audit ? (
            <button className="btn btn-primary" onClick={() => setStep(3)}>
              К выбору компонентов
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Шаг 3 — Компоненты */}
      {step === 3 ? (
        <div className="stack" style={{ maxWidth: 560 }}>
          {existingVpn ? (
            <div className="notice notice-amber small">
              Напоминание: на сервере уже есть свой VPN. Мы ставим наш <b>рядом</b> и старый <b>не удаляем</b>.
              Если он не нужен — удалите его на сервере сами до установки.
            </div>
          ) : null}
          <p className="body" style={{ margin: 0 }}>Что установить на сервер:</p>
          <CheckRow
            checked={compXray}
            title="Xray (VLESS Reality)"
            sub="VPN-протокол, маскировка под HTTPS"
            onToggle={() => setCompXray((v) => !v)}
          />
          <CheckRow
            checked={compAwg}
            title="AmneziaWG"
            sub="Модифицированный WireGuard"
            onToggle={() => setCompAwg((v) => !v)}
          />
          <CheckRow
            checked={compHttp}
            title="HTTP proxy"
            sub="Только для служебного доступа"
            onToggle={() => setCompHttp((v) => !v)}
          />
          <CheckRow
            checked={compSocks}
            title="SOCKS5"
            sub="Только для служебного доступа"
            onToggle={() => setCompSocks((v) => !v)}
          />
          <button className="btn btn-primary" onClick={() => setStep(4)}>
            Начать установку
          </button>
        </div>
      ) : null}

      {/* Шаг 4 — Установка */}
      {step === 4 ? (
        <div className="stack" style={{ maxWidth: 560 }}>
          <div className="row-between" style={{ gap: 12 }}>
            <span style={{ fontWeight: 700 }}>{installErr ? 'Ошибка установки' : 'Устанавливаем ПО…'}</span>
            <span className="mono" style={{ color: 'var(--text-muted)' }}>{pct}%</span>
          </div>
          <ProgressBar pct={pct} />
          {!installErr ? (
            <span className="small muted">Реальная установка на сервер по SSH — это может занять 1–3 минуты. Не закрывайте страницу.</span>
          ) : null}
          <pre
            className="mono"
            style={{
              margin: 0, background: 'var(--bg-app)', border: '1px solid var(--border-input)',
              borderRadius: 'var(--r-ctrl)', padding: 12, fontSize: 12, lineHeight: 1.6,
              color: 'var(--text-secondary)', maxHeight: 260, overflowY: 'auto', whiteSpace: 'pre-wrap',
            }}
          >
            {log.map((line) => `→ ${line}`).join('\n')}
          </pre>
          {installErr ? (
            <>
              <div className="notice notice-red small">{installErr}</div>
              <div className="row" style={{ gap: 8 }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    addedRef.current = false;
                    setInstallErr(null);
                    setPct(0);
                    setLog([]);
                    setStep(3);
                  }}
                >
                  Назад к настройке
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {/* Шаг 5 — Готово */}
      {step === 5 ? (
        <div className="stack" style={{ maxWidth: 560 }}>
          <div className="notice notice-green">
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Сервер добавлен</div>
            Агент отвечает, компоненты установлены, сервер появился в списке и доступен для выдачи.
          </div>
          <button className="btn btn-primary" onClick={() => goAdmin('servers')}>
            К списку серверов
          </button>
        </div>
      ) : null}
    </>
  );
}
