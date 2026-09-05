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

// Сортировка списка. «За 30 дней» — из почасового учёта: кто тратит СЕЙЧАС, а не за
// всё время; пока учёт копится, у всех там нули и порядок остаётся по имени.
type SortKey = 'name' | 'traffic' | 'traffic30' | 'activity';
const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'name', label: 'По имени' },
  { key: 'traffic', label: 'По трафику' },
  { key: 'traffic30', label: 'За 30 дней' },
  { key: 'activity', label: 'По активности' },
];

// Избранные — те, кто важнее остальных: всегда сверху, со звёздочкой. Это личный
// порядок админа в этом браузере, поэтому живёт в localStorage, а не в базе.
const FAV_KEY = 'novpn.favUsers';
function loadFav(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
function saveFav(s: Set<string>): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...s]));
  } catch {
    /* приватный режим — ну и ладно */
  }
}

export function Users() {
  const { data, loading, loadError, isMobile, goAdmin, setUserActive, showToast } = useApp();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [catFilter, setCatFilter] = useState<string>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('name');
  const [fav, setFav] = useState<Set<string>>(loadFav);
  const toggleFav = (id: string) => {
    const next = new Set(fav);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFav(next);
    saveFav(next);
  };

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
  // Избранные всегда сверху, внутри — выбранная сортировка (числовые — по убыванию).
  const cmp = (a: User, b: User): number => {
    switch (sort) {
      case 'traffic': return (b.trafficUsedGb ?? 0) - (a.trafficUsedGb ?? 0);
      case 'traffic30': return (b.traffic30Gb ?? 0) - (a.traffic30Gb ?? 0);
      case 'activity': return (b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0) - (a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0);
      default: return a.name.localeCompare(b.name, 'ru');
    }
  };
  const shown = [...filtered].sort((a, b) => Number(fav.has(b.id)) - Number(fav.has(a.id)) || cmp(a, b));

  // Категории: базовые + любые встречающиеся у пользователей (кастомные).
  const catList = Array.from(new Set([...CATEGORIES, ...users.map((u) => u.category ?? '').filter(Boolean)]));

  const total = users.length;
  const title = `${total} ${plural(total, 'пользователь', 'пользователя', 'пользователей')}`;

  const metricParts = (u: User) => {
    // Лимит устройств — только AmneziaWG (Xray вне лимита, общая подписка).
    const awg = countActiveDevices(u.id, devices, 'amneziawg');
    return {
      dev: `${awg}/${u.deviceLimit ?? '∞'}`,
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

        <div className="chip-row">
          <span className="small muted" style={{ alignSelf: 'center', marginRight: 4 }}>Сортировка:</span>
          {SORTS.map((s) => (
            <Chip key={s.key} label={s.label} size="sm" active={sort === s.key} onClick={() => setSort(s.key)} />
          ))}
          {fav.size > 0 ? <span className="small muted" style={{ alignSelf: 'center', marginLeft: 6 }}>★ избранные — всегда сверху</span> : null}
        </div>

        {shown.length === 0 ? (
          <EmptyState title="Никого не нашлось" text="Измените запрос или сбросьте фильтры." />
        ) : (
          <Panel bodyStyle={{ gap: 0 }}>
            {shown.map((u) => {
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
                      {/* Звёздочка — в избранное (всегда сверху). Клик не должен открывать карточку. */}
                      <span
                        role="button"
                        tabIndex={0}
                        title={fav.has(u.id) ? 'Убрать из избранных' : 'В избранные — всегда сверху'}
                        onClick={(e) => { e.stopPropagation(); toggleFav(u.id); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleFav(u.id); } }}
                        style={{ cursor: 'pointer', color: fav.has(u.id) ? 'var(--amber-fg)' : 'var(--text-muted-2)', fontSize: 15, lineHeight: 1 }}
                      >
                        {fav.has(u.id) ? '★' : '☆'}
                      </span>
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
