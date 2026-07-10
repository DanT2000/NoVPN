// A3 — Создание пользователя. Форма из четырёх панелей + отправка.

import { useState } from 'react';
import type { Protocol } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import type { CreateUserInput } from '../api/types';
import { Chip, Dot, Field, Panel, ScreenHeader } from '../components/ui';
import { DAY_MS } from '../lib/format';
import { serverAgentView } from '../lib/status';
import { genCode, isValidCode } from '../lib/gen';

const CATEGORIES = ['Общие', 'Семья', 'Друзья', 'Работа', 'Админ'] as const;

type DlMode = '1' | '10' | 'unlim' | 'custom';
type ExpMode = '7' | '30' | 'never' | 'custom';
type TrafMode = 'unlim' | 'custom';

const digits = (s: string) => s.replace(/\D+/g, '');
const posInt = (s: string): number | null => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const posNum = (s: string): number | null => {
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function UserCreate() {
  const { data, goAdmin, createUser } = useApp();

  const servers = data?.servers ?? [];
  const firstServerId = servers[0]?.id;
  const existingCodes = data?.users.map((u) => u.code) ?? [];

  // Основное
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [category, setCategory] = useState<string>('Общие');
  const [tagsRaw, setTagsRaw] = useState('');

  // Лимиты
  const [dlMode, setDlMode] = useState<DlMode>('custom');
  const [dlCustom, setDlCustom] = useState('3');
  const [expMode, setExpMode] = useState<ExpMode>('30');
  const [expCustom, setExpCustom] = useState('');
  const [trafMode, setTrafMode] = useState<TrafMode>('unlim');
  const [trafCustom, setTrafCustom] = useState('');
  const [resetPolicy, setResetPolicy] = useState<'never' | 'monthly'>('never');

  // Доступ
  const [allowedServers, setAllowedServers] = useState<string[]>(() => (firstServerId ? [firstServerId] : []));
  const [defaultServerId, setDefaultServerId] = useState<string | null>(() => firstServerId ?? null);
  const [protocols, setProtocols] = useState<Protocol[]>(['xray', 'amneziawg']);

  // Код доступа
  const [codeMode, setCodeMode] = useState<'auto' | 'manual'>('auto');
  const [autoCode, setAutoCode] = useState(() => genCode(existingCodes));
  const [manualCode, setManualCode] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!data) return null;

  const isAdmin = category === 'Админ';
  const selectedServers = servers.filter((s) => allowedServers.includes(s.id));

  function toggleServer(id: string) {
    const next = allowedServers.includes(id) ? allowedServers.filter((x) => x !== id) : [...allowedServers, id];
    setAllowedServers(next);
    if (next.length === 0) setDefaultServerId(null);
    else if (!defaultServerId || !next.includes(defaultServerId)) setDefaultServerId(next[0] ?? null);
  }

  function changeCategory(v: string) {
    setCategory(v);
    if (v !== 'Админ') setProtocols((prev) => prev.filter((p) => p === 'xray' || p === 'amneziawg'));
  }

  function toggleProtocol(p: Protocol) {
    setProtocols((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

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

  async function submit() {
    const code = codeMode === 'auto' ? autoCode : manualCode;
    const effProtocols = isAdmin ? protocols : protocols.filter((p) => p === 'xray' || p === 'amneziawg');

    if (!name.trim()) {
      setError('Укажите имя пользователя.');
      return;
    }
    if (!isValidCode(code)) {
      setError('Код должен состоять из 6 цифр.');
      return;
    }
    if (existingCodes.includes(code)) {
      setError('Такой код уже используется — выберите другой.');
      return;
    }
    if (allowedServers.length === 0) {
      setError('Выберите хотя бы один сервер.');
      return;
    }
    if (effProtocols.length === 0) {
      setError('Выберите хотя бы один протокол.');
      return;
    }
    setError(null);

    const deviceLimit =
      dlMode === '1' ? 1 : dlMode === '10' ? 10 : dlMode === 'unlim' ? null : posInt(dlCustom);
    let expiresAt: string | null = null;
    if (expMode !== 'never') {
      const days = expMode === '7' ? 7 : expMode === '30' ? 30 : posInt(expCustom);
      expiresAt = days == null ? null : new Date(Date.now() + days * DAY_MS).toISOString();
    }
    const trafficLimitGb = trafMode === 'unlim' ? null : posNum(trafCustom);

    const input: CreateUserInput = {
      name: name.trim(),
      comment: comment.trim(),
      category,
      tags: tagsRaw.split(',').map((t) => t.trim()).filter(Boolean),
      deviceLimit,
      expiresAt,
      trafficLimitGb,
      resetPolicy,
      allowedServers,
      defaultServerId,
      allowedProtocols: effProtocols,
      code,
    };

    setSubmitting(true);
    try {
      const created = await createUser(input);
      goAdmin('user-created', { userId: created.id });
    } catch {
      setSubmitting(false);
      setError('Не удалось создать пользователя. Попробуйте ещё раз.');
    }
  }

  return (
    <div className="stack">
      <ScreenHeader back={() => goAdmin('users')} title="Новый пользователь" />

      <Panel title="Основное">
        <Field label="Имя">
          <input className="input" placeholder="Например, Иван" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Комментарий">
          <input className="input" placeholder="Виден только вам" value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        <Field label="Категория">
          <select className="select" value={category} onChange={(e) => changeCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Теги">
          <input className="input" placeholder="vip, промо" value={tagsRaw} onChange={(e) => setTagsRaw(e.target.value)} />
        </Field>
      </Panel>

      <Panel title="Лимиты">
        <div className="field">
          <span className="field-label">Лимит устройств</span>
          <div className="chip-row">
            <Chip label="1" active={dlMode === '1'} onClick={() => setDlMode('1')} />
            <Chip label="10" active={dlMode === '10'} onClick={() => setDlMode('10')} />
            <Chip label="Без ограничений" active={dlMode === 'unlim'} onClick={() => setDlMode('unlim')} />
            <Chip label="Своё" active={dlMode === 'custom'} onClick={() => setDlMode('custom')} />
          </div>
          {dlMode === 'custom' && (
            <input
              className="input"
              inputMode="numeric"
              placeholder="число"
              value={dlCustom}
              onChange={(e) => setDlCustom(digits(e.target.value))}
              style={{ maxWidth: 200 }}
            />
          )}
        </div>

        <div className="field">
          <span className="field-label">Срок действия</span>
          <div className="chip-row">
            <Chip label="7 дней" active={expMode === '7'} onClick={() => setExpMode('7')} />
            <Chip label="30 дней" active={expMode === '30'} onClick={() => setExpMode('30')} />
            <Chip label="Без срока" active={expMode === 'never'} onClick={() => setExpMode('never')} />
            <Chip label="Своё" active={expMode === 'custom'} onClick={() => setExpMode('custom')} />
          </div>
          {expMode === 'custom' && (
            <input
              className="input"
              inputMode="numeric"
              placeholder="дней"
              value={expCustom}
              onChange={(e) => setExpCustom(digits(e.target.value))}
              style={{ maxWidth: 200 }}
            />
          )}
        </div>

        <div className="field">
          <span className="field-label">Лимит трафика</span>
          <div className="chip-row">
            <Chip label="Без ограничений" active={trafMode === 'unlim'} onClick={() => setTrafMode('unlim')} />
            <Chip label="Лимит, ГБ" active={trafMode === 'custom'} onClick={() => setTrafMode('custom')} />
          </div>
          {trafMode === 'custom' && (
            <input
              className="input"
              inputMode="decimal"
              placeholder="ГБ"
              value={trafCustom}
              onChange={(e) => setTrafCustom(e.target.value.replace(/[^\d.,]/g, ''))}
              style={{ maxWidth: 200 }}
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
          <span className="field-label">Сервер по умолчанию</span>
          {selectedServers.length === 0 ? (
            <span className="small muted">Сначала выберите серверы.</span>
          ) : (
            <div className="chip-row">
              {selectedServers.map((s) => (
                <Chip key={s.id} label={s.name} active={defaultServerId === s.id} onClick={() => setDefaultServerId(s.id)} />
              ))}
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
      </Panel>

      <Panel title="Код доступа">
        <div className="chip-row">
          <Chip label="Автоматически" active={codeMode === 'auto'} onClick={() => setCodeMode('auto')} />
          <Chip label="Задать вручную" active={codeMode === 'manual'} onClick={() => setCodeMode('manual')} />
        </div>
        {codeMode === 'auto' ? (
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 28, fontWeight: 700, letterSpacing: '0.08em' }}>
              {autoCode}
            </span>
            <button className="btn btn-outline btn-sm" onClick={() => setAutoCode(genCode(existingCodes))}>
              Сгенерировать заново
            </button>
          </div>
        ) : (
          <input
            className="input mono"
            inputMode="numeric"
            maxLength={6}
            placeholder="6 цифр"
            value={manualCode}
            onChange={(e) => setManualCode(digits(e.target.value))}
            style={{ maxWidth: 200 }}
          />
        )}
      </Panel>

      {error && <div className="notice notice-red">{error}</div>}

      <button className="btn btn-primary btn-lg btn-block" onClick={submit} disabled={submitting}>
        {submitting ? 'Создание…' : 'Создать пользователя'}
      </button>
    </div>
  );
}
