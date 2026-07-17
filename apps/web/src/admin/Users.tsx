// A2 — Список пользователей: поиск, фильтры, строки со статусами.

import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { User } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { Chip, Pill, Panel, EmptyState, ScreenHeader, Loading, Toggle } from '../components/ui';
import { statusOf, userFilterKey, countActiveDevices } from '../lib/status';
import { gb, dateShort, plural } from '../lib/format';

type FilterKey = 'all' | 'active' | 'expiring' | 'exhausted' | 'disabled';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'active', label: 'Активные' },
  { key: 'expiring', label: 'Истекают' },
  { key: 'exhausted', label: 'Исчерпаны' },
  { key: 'disabled', label: 'Отключены' },
];

function rowProps(onClick: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    },
  };
}

const CATEGORIES = ['Общие', 'Семья', 'Друзья', 'Работа', 'Админ'] as const;

export function Users() {
  const { data, loading, loadError, isMobile, goAdmin, setUserActive, showToast } = useApp();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [catFilter, setCatFilter] = useState<string>('all');
  const [busy, setBusy] = useState<string | null>(null);

  if (loadError) return <div className="notice notice-red">{loadError}</div>;
  if (loading || !data) return <Loading text="Загружаем пользователей…" />;

  const { users, devices } = data;

  const q = query.trim().toLowerCase();
  const filtered = users.filter((u) => {
    if (q) {
      const hay = [u.name, u.code, u.category ?? '', u.comment, ...u.tags].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter !== 'all' && userFilterKey(u) !== filter) return false;
    if (catFilter !== 'all' && (u.category ?? '') !== catFilter) return false;
    return true;
  });

  // Категории: базовые + любые встречающиеся у пользователей (кастомные).
  const catList = Array.from(new Set([...CATEGORIES, ...users.map((u) => u.category ?? '').filter(Boolean)]));

  const total = users.length;
  const title = `${total} ${plural(total, 'пользователь', 'пользователя', 'пользователей')}`;

  const metricParts = (u: User) => {
    const active = countActiveDevices(u.id, devices);
    return {
      dev: `${active}/${u.deviceLimit ?? '∞'}`,
      traf: `${gb(u.trafficUsedGb)} / ${gb(u.trafficLimitGb)}`,
      exp: u.expiresAt ? dateShort(u.expiresAt) : 'бессрочно',
    };
  };
  // Ровные колонки: одинаковая ширина у каждого показателя во всех строках.
  const Metrics = ({ u }: { u: User }) => {
    const m = metricParts(u);
    return (
      <>
        <span className="small mono muted" style={{ minWidth: 52, textAlign: 'right' }} title="устройства">{m.dev}</span>
        <span className="small mono muted" style={{ minWidth: 116, textAlign: 'right' }} title="трафик">{m.traf}</span>
        <span className="small mono muted" style={{ minWidth: 92, textAlign: 'right' }} title="срок">{m.exp}</span>
      </>
    );
  };

  return (
    <>
      <ScreenHeader
        eyebrow="Пользователи"
        title={title}
        right={
          <button type="button" className="btn btn-primary" onClick={() => goAdmin('user-create')}>
            + Создать пользователя
          </button>
        }
      />

      <div className="stack" style={{ gap: 14 }}>
        <input
          className="input"
          placeholder="Поиск: имя, код, тег, категория…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="chip-row">
          {FILTERS.map((f) => (
            <Chip
              key={f.key}
              label={f.label}
              size="sm"
              active={filter === f.key}
              onClick={() => setFilter(f.key)}
            />
          ))}
        </div>

        <div className="chip-row">
          <span className="small muted" style={{ alignSelf: 'center', marginRight: 4 }}>Категория:</span>
          <Chip label="Все" size="sm" active={catFilter === 'all'} onClick={() => setCatFilter('all')} />
          {catList.map((c) => (
            <Chip key={c} label={c} size="sm" active={catFilter === c} onClick={() => setCatFilter(c)} />
          ))}
        </div>

        {filtered.length === 0 ? (
          <EmptyState title="Никого не нашлось" text="Измените запрос или сбросьте фильтры." />
        ) : (
          <Panel bodyStyle={{ gap: 0 }}>
            {filtered.map((u) => {
              const catTags = [u.category, u.tags.join(', ')].filter(Boolean).join(' · ');
              return (
                <div
                  key={u.id}
                  className="divide-row"
                  style={{ cursor: 'pointer' }}
                  {...rowProps(() => goAdmin('user-card', { userId: u.id }))}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <span style={{ fontWeight: 600 }}>{u.name}</span>
                      {/* Код — только если у пользователя включён вход по нему. */}
                      {u.codeLoginUntil && new Date(u.codeLoginUntil) > new Date() ? (
                        <span className="mono small muted" title="Включён вход по коду">🔑 {u.code}</span>
                      ) : null}
                    </div>
                    {catTags ? <div className="small muted" style={{ marginTop: 2 }}>{catTags}</div> : null}
                    {isMobile ? (
                      <div className="row" style={{ gap: 10, marginTop: 4 }}><Metrics u={u} /></div>
                    ) : null}
                  </div>
                  <div className="row" style={{ gap: 14, flex: 'none', alignItems: 'center' }}>
                    {isMobile ? null : <Metrics u={u} />}
                    <Pill s={statusOf(u)} size="sm" />
                    <span
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      title={u.isActive ? 'Активен — нажмите, чтобы отключить' : 'Отключён — нажмите, чтобы включить'}
                      style={{ display: 'inline-flex', alignItems: 'center', padding: '10px 12px', margin: '-10px -4px -10px 0' }}
                    >
                      <Toggle
                        on={u.isActive}
                        ariaLabel={u.isActive ? 'Отключить пользователя' : 'Включить пользователя'}
                        onChange={async (v) => {
                          if (busy) return;
                          setBusy(u.id);
                          try {
                            await setUserActive(u.id, v);
                            showToast(v ? 'Включён' : 'Отключён — устройства отозваны');
                          } finally {
                            setBusy(null);
                          }
                        }}
                      />
                    </span>
                  </div>
                </div>
              );
            })}
          </Panel>
        )}
      </div>
    </>
  );
}
