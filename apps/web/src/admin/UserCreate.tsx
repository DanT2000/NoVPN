// A3 — Создание пользователя. Форма из четырёх панелей + отправка.

import { useState } from 'react';
import type { Protocol, ProxyType } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import type { CreateUserInput } from '../api/types';
import { CategoryPicker, Chip, Dot, Field, Panel, ScreenHeader } from '../components/ui';
import { DAY_MS } from '../lib/format';
import { serverAgentView } from '../lib/status';

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
  // Сервер по умолчанию из настроек, иначе первый доступный.
  const firstServerId = data?.settings.defaultServerId ?? servers[0]?.id;
  const defaultProtos: Protocol[] = (data?.settings.defaultProtocols ?? ['xray', 'amneziawg']).filter(
    (p) => p === 'xray' || p === 'amneziawg',
  ) as Protocol[];

  // Основное
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [category, setCategory] = useState<string>('Общие');
  const [tagsRaw, setTagsRaw] = useState('');

  // Лимиты
  const [dlMode, setDlMode] = useState<DlMode>('custom');
  const [dlCustom, setDlCustom] = useState('3');
  const [expMode, setExpMode] = useState<ExpMode>('never');
  const [expCustom, setExpCustom] = useState('');
  const [trafMode, setTrafMode] = useState<TrafMode>('unlim');
  const [trafCustom, setTrafCustom] = useState('');
  const resetPolicy = 'never' as const; // сброс трафика по расписанию убран — не был реализован

  // Доступ
  const [allowedServers, setAllowedServers] = useState<string[]>(() => (firstServerId ? [firstServerId] : []));
  const [defaultServerId, setDefaultServerId] = useState<string | null>(() => firstServerId ?? null);
  const [protocols, setProtocols] = useState<Protocol[]>(defaultProtos.length ? defaultProtos : ['xray', 'amneziawg']);
  // Прокси — отдельное разрешение (не VPN-протокол). Пользователь сможет выдать
  // их себе в кабинете, если они установлены на сервере.
  const [proxies, setProxies] = useState<ProxyType[]>([]);

  // Вход по коду — опционально. Основной способ доступа это личная ссылка,
  // код по умолчанию выключен. Сам код панель генерирует сама (нужен как
  // внутренний идентификатор), задавать его вручную незачем.
  const [codeLoginEnabled, setCodeLoginEnabled] = useState(false);

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
  }

  function toggleProtocol(p: Protocol) {
    setProtocols((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }
  function toggleProxy(p: ProxyType) {
    setProxies((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  const protocolOptions: Array<{ key: Protocol; label: string }> = [
    { key: 'xray', label: 'Xray' },
    { key: 'amneziawg', label: 'Amnezia' },
  ];
  const proxyOptions: Array<{ key: ProxyType; label: string }> = [
    { key: 'http', label: 'HTTP' },
    { key: 'socks5', label: 'SOCKS5' },
    { key: 'https', label: 'HTTPS' },
  ];

  async function submit() {
    const effProtocols = protocols.filter((p): p is 'xray' | 'amneziawg' => p === 'xray' || p === 'amneziawg');

    if (!name.trim()) {
      setError('Укажите имя пользователя.');
      return;
    }
    if (allowedServers.length === 0) {
      setError('Выберите хотя бы один сервер.');
      return;
    }
    if (effProtocols.length === 0 && proxies.length === 0) {
      setError('Выберите хотя бы один протокол или прокси.');
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
      allowedProxies: proxies,
      // Код генерирует сервер — пустая строка. Вход по коду по умолчанию выключен.
      code: '',
      codeLoginEnabled,
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
        <Field label="Категория" hint="можно выбрать из списка или задать свою (напр. «Церковь»)">
          <CategoryPicker value={category} onChange={changeCategory} suggestions={[...CATEGORIES]} />
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
              style={{ maxWidth: 200 }}
            />
          )}
        </div>

        <div className="field">
          <span className="field-label">Срок действия</span>
          <div className="chip-row">
            <Chip label="7 дней" active={expMode === '7'} onClick={() => setExpMode('7')} />
            <Chip label="30 дней" active={expMode === '30'} onClick={() => setExpMode('30')} />
            <Chip label="∞" active={expMode === 'never'} onClick={() => setExpMode('never')} />
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
              style={{ maxWidth: 200 }}
            />
          )}
        </div>

      </Panel>

      <Panel title="Серверы и протоколы">
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
          <span className="field-label">Разрешённые VPN-протоколы</span>
          <div className="chip-row">
            {protocolOptions.map((p) => (
              <Chip key={p.key} label={p.label} active={protocols.includes(p.key)} onClick={() => toggleProtocol(p.key)} />
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">Прокси (пользователь выдаст себе в кабинете)</span>
          <div className="chip-row">
            {proxyOptions.map((p) => (
              <Chip key={p.key} label={p.label} active={proxies.includes(p.key)} onClick={() => toggleProxy(p.key)} />
            ))}
          </div>
          <span className="small muted">
            Появятся в кабинете, только если соответствующий прокси установлен на сервере
            (Серверы → «Прокси на сервере»). Каждому пользователю выдаётся отдельный логин.
          </span>
        </div>
      </Panel>

      <Panel title="Способ входа">
        <div className="body small muted" style={{ marginBottom: 10 }}>
          Основной способ — личная ссылка. Она выдаётся автоматически, и после создания
          её можно скопировать и отправить человеку. Вводить код не нужно.
        </div>
        <label className="row" style={{ gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={codeLoginEnabled}
            onChange={(e) => setCodeLoginEnabled(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            <span style={{ fontWeight: 600 }}>Разрешить вход по коду доступа</span>
            <span className="body small muted" style={{ display: 'block', marginTop: 2 }}>
              Запасной способ: 6-значный код для входа на сайте. По умолчанию выключен —
              код короткий и подбирается, ссылка надёжнее.
            </span>
          </span>
        </label>
      </Panel>

      {error && <div className="notice notice-red">{error}</div>}

      <button className="btn btn-primary btn-lg btn-block" onClick={submit} disabled={submitting}>
        {submitting ? 'Создание…' : 'Создать пользователя'}
      </button>
    </div>
  );
}
