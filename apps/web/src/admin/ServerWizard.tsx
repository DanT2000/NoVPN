// A7 — Добавление сервера. 5-шаговый мастер (данные → проверка → компоненты →
// установка → готово). Установка симулируется; сервер добавляется через store.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { TestServerConnectionResult } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import type { AddServerInput } from '../api/types';
import { Chip, Field, ProgressBar, ScreenHeader } from '../components/ui';

type AuthMethod = 'key' | 'password';
type Component = 'xray' | 'amneziawg' | 'http' | 'socks5';

const isIpLike = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h.trim());
function isValidHost(h: string): boolean {
  const t = h.trim();
  if (!t) return false;
  if (isIpLike(t)) return t.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(t);
}

const STEP_LABELS = ['1. Данные', '2. Проверка', '3. Компоненты', '4. Установка', '5. Готово'];

const INSTALL_LOG = [
  'Подключение по SSH…',
  'Проверка окружения: Ubuntu 24.04, Docker 27.1',
  'Загрузка образа xray-core…',
  'Генерация ключей Reality…',
  'Загрузка образа amneziawg…',
  'Генерация серверных ключей AWG…',
  'Настройка firewall (ufw)…',
  'Запуск агента novpn-agent…',
  'Регистрация агента в Manager… OK',
];

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
  const { goAdmin, addServer } = useApp();
  const [step, setStep] = useState(1);

  // Шаг 1 — данные
  const [name, setName] = useState('');
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
  const addedRef = useRef(false);

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
    vpnHost: host.trim(), // домен/IP один раз — он же и публичный VPN-endpoint
    components: components(),
    country: null,
  });

  // Симуляция установки на шаге 4.
  useEffect(() => {
    if (step !== 4) return;
    setPct(0);
    setLog([]);
    addedRef.current = false;
    let i = 0;
    let p = 0;
    const inc = Math.ceil(100 / INSTALL_LOG.length);
    const timer = window.setInterval(() => {
      if (i < INSTALL_LOG.length) {
        const line = INSTALL_LOG[i];
        if (line) setLog((prev) => [...prev, line]);
        i += 1;
      }
      p = Math.min(100, p + inc);
      setPct(p);
      if (i >= INSTALL_LOG.length && p >= 100) {
        window.clearInterval(timer);
        setPct(100);
        if (!addedRef.current) {
          addedRef.current = true;
          void addServer(buildInput()).then(() => setStep(5));
        }
      }
    }, 380);
    return () => window.clearInterval(timer);
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
              ⚠️ Рекомендуем указывать <b>домен</b>, а не IP. Подписки, выпущенные на IP-адрес,
              привязаны к нему: при удалении сервера они станут недействительными. Домен можно
              переназначить на другой сервер — подписки сохранятся.
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
              {audit.audit.map((item, idx) => (
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
            <span style={{ fontWeight: 700 }}>Установка…</span>
            <span className="mono" style={{ color: 'var(--text-muted)' }}>{pct}%</span>
          </div>
          <ProgressBar pct={pct} />
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
