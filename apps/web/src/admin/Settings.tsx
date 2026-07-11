// A10 — Настройки. Брендинг, значения по умолчанию, шаблон и параметры безопасности.

import { useState } from 'react';
import type { AppSettings, UserProtocol } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { Chip, Field, Panel } from '../components/ui';

const PROTO_OPTIONS: Array<{ value: UserProtocol; label: string }> = [
  { value: 'xray', label: 'Xray' },
  { value: 'amneziawg', label: 'Amnezia' },
];

function numOr(raw: string, fallback: number): number {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function Settings() {
  const { data, saveSettings, showToast } = useApp();
  const s = data?.settings;

  const [appName, setAppName] = useState(s?.appName ?? '');
  const [domain, setDomain] = useState(s?.domain ?? '');
  const [defaultServerId, setDefaultServerId] = useState<string | null>(s?.defaultServerId ?? null);
  const [defaultProtocols, setDefaultProtocols] = useState<UserProtocol[]>(s?.defaultProtocols ?? []);
  const [messageTemplate, setMessageTemplate] = useState(s?.messageTemplate ?? '');
  const [activeThresholdDays, setActiveThresholdDays] = useState(s?.activeThresholdDays ?? 0);
  const [ipRetentionDays, setIpRetentionDays] = useState(s?.ipRetentionDays ?? 0);
  const [logsRetentionDays, setLogsRetentionDays] = useState(s?.logsRetentionDays ?? 0);
  const [sessionTtlHours, setSessionTtlHours] = useState(s?.sessionTtlHours ?? 0);
  const [codeAttempts, setCodeAttempts] = useState(s?.codeAttempts ?? 0);
  const [codeCooldownMin, setCodeCooldownMin] = useState(s?.codeCooldownMin ?? 0);
  const [saving, setSaving] = useState(false);

  if (!data || !s) return null;

  const logoLetter = (appName.trim().charAt(0) || 'N').toUpperCase();

  const toggleProtocol = (value: UserProtocol) =>
    setDefaultProtocols((prev) => (prev.includes(value) ? prev.filter((p) => p !== value) : [...prev, value]));

  const save = async () => {
    setSaving(true);
    try {
      const input: AppSettings = {
        ...s,
        appName,
        domain,
        defaultServerId,
        defaultProtocols,
        messageTemplate,
        activeThresholdDays,
        ipRetentionDays,
        logsRetentionDays,
        sessionTtlHours,
        codeAttempts,
        codeCooldownMin,
      };
      await saveSettings(input);
      showToast('Настройки сохранены');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <div className="eyebrow" style={{ marginBottom: 4 }}>Настройки</div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>Система</div>
      </div>

      <div className="stack" style={{ gap: 16, maxWidth: 640 }}>
        {/* Брендинг */}
        <Panel title="Брендинг и домен">
          <Field label="Название">
            <input className="input" value={appName} onChange={(e) => setAppName(e.target.value)} />
          </Field>
          <Field label="Основной домен">
            <input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value)} />
          </Field>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
            <div
              aria-hidden
              style={{
                width: 56, height: 56, borderRadius: 'var(--r-card)', flex: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--accent)', color: 'var(--text-on-accent)', fontSize: 24, fontWeight: 700,
              }}
            >
              {logoLetter}
            </div>
            <button className="btn btn-outline" onClick={() => showToast('Загрузка логотипа пока недоступна')}>
              Загрузить логотип
            </button>
          </div>
        </Panel>

        {/* Значения по умолчанию */}
        <Panel title="Значения по умолчанию">
          <Field label="Сервер по умолчанию">
            {data.servers.length === 0 ? (
              <span className="small muted">Серверы ещё не добавлены.</span>
            ) : (
              <div className="chip-row">
                {data.servers.map((srv) => (
                  <Chip
                    key={srv.id}
                    label={srv.name}
                    size="sm"
                    active={defaultServerId === srv.id}
                    onClick={() => setDefaultServerId(srv.id)}
                  />
                ))}
              </div>
            )}
          </Field>
          <Field label="Протоколы по умолчанию">
            <div className="chip-row">
              {PROTO_OPTIONS.map((opt) => (
                <Chip
                  key={opt.value}
                  label={opt.label}
                  size="sm"
                  active={defaultProtocols.includes(opt.value)}
                  onClick={() => toggleProtocol(opt.value)}
                />
              ))}
            </div>
          </Field>
        </Panel>

        {/* Шаблон */}
        <Panel title="Шаблон сообщения пользователю">
          <Field label="Текст" hint="переменные: {code} {url} {expires}">
            <textarea className="textarea" value={messageTemplate} onChange={(e) => setMessageTemplate(e.target.value)} />
          </Field>
        </Panel>

        {/* Безопасность */}
        <Panel title="Активность, журналы, безопасность">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <Field label="Порог «активного устройства», дней">
              <input
                className="input"
                type="number"
                min={0}
                value={activeThresholdDays}
                onChange={(e) => setActiveThresholdDays(numOr(e.target.value, 0))}
              />
            </Field>
            <Field label="Хранение IP, дней">
              <input
                className="input"
                type="number"
                min={0}
                value={ipRetentionDays}
                onChange={(e) => setIpRetentionDays(numOr(e.target.value, 0))}
              />
            </Field>
            <Field label="Хранение журналов, дней">
              <input
                className="input"
                type="number"
                min={0}
                value={logsRetentionDays}
                onChange={(e) => setLogsRetentionDays(numOr(e.target.value, 0))}
              />
            </Field>
            <Field label="Сессия пользователя, часов">
              <input
                className="input"
                type="number"
                min={0}
                value={sessionTtlHours}
                onChange={(e) => setSessionTtlHours(numOr(e.target.value, 0))}
              />
            </Field>
            <Field label="Попыток ввода кода">
              <input
                className="input"
                type="number"
                min={0}
                value={codeAttempts}
                onChange={(e) => setCodeAttempts(numOr(e.target.value, 0))}
              />
            </Field>
            <Field label="Пауза после ошибок, минут">
              <input
                className="input"
                type="number"
                min={0}
                value={codeCooldownMin}
                onChange={(e) => setCodeCooldownMin(numOr(e.target.value, 0))}
              />
            </Field>
          </div>
        </Panel>

        <div>
          <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            Сохранить настройки
          </button>
        </div>
      </div>
    </>
  );
}
