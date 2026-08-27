// A1 — Обзор / Состояние системы.

import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { User } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import type { StatsPoint, ServerHealth } from '../api/types';
import { Panel, Dot, ScreenHeader, Loading, Chip } from '../components/ui';
import { BarChart, type Bar } from '../components/Chart';
import { statusOf } from '../lib/status';
import { gb, rel, daysLeft } from '../lib/format';

const WINDOWS: Array<{ days: number; label: string }> = [
  { days: 1, label: 'Сутки' },
  { days: 7, label: 'Неделя' },
  { days: 30, label: 'Месяц' },
];

type Metric = 'traffic' | 'used';
const METRICS: Array<{ key: Metric; label: string; hint: string }> = [
  { key: 'traffic', label: 'Трафик за период', hint: 'Сколько трафика прошло за период — за час (сутки) или за день (неделя/месяц). Не общий накопленный.' },
  { key: 'used', label: 'Активность', hint: 'Сколько конфигов реально использовалось (были на связи), а не сколько выдано.' },
];

const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const pad = (n: number) => String(n).padStart(2, '0');

/** Раскладываем накопительную серию по корзинам: сутки → по часам, неделя/месяц → по
 *  дням. Трафик = ПРИРОСТ за корзину (реальное использование за период), активность =
 *  пик реально используемых конфигов в корзине.
 *
 *  Защита от артефакта рестарта: серверный кумулятив может кратковременно «просесть»
 *  (цикл синка увидел не все устройства из-за холодного SSH) и на следующем снимке
 *  вернуться назад. Этот «возврат» — не реальный трафик. Запоминаем провал и гасим им
 *  последующий скачок, иначе фантомные сотни ГБ «за час». */
function bucketize(series: StatsPoint[], days: number, metric: Metric): Bar[] {
  if (series.length === 0) return [];
  const now = Date.now();
  const byHour = days <= 1;
  const bucketMs = byHour ? 3_600_000 : 86_400_000;
  const start = now - days * 86_400_000;
  const map = new Map<number, { traffic: number; used: number }>();
  let prevCum: number | null = null;
  let dropCarry = 0; // непогашенное падение кумулятива с прошлого шага (артефакт рестарта)
  for (const s of series) {
    const t = new Date(s.at).getTime();
    if (t < start) { prevCum = s.trafficGb; continue; }
    const bk = Math.floor(t / bucketMs) * bucketMs;
    const b = map.get(bk) ?? { traffic: 0, used: 0 };
    if (prevCum != null) {
      const d = s.trafficGb - prevCum;
      if (d < 0) {
        dropCarry = -d; // просадка — ждём возврат на следующем снимке, трафиком не считаем
      } else {
        const real = dropCarry > 0 ? Math.max(0, d - dropCarry) : d; // возврат гасим провалом
        dropCarry = 0;
        if (real > 0) b.traffic += real;
      }
    }
    b.used = Math.max(b.used, s.usedDevices);
    map.set(bk, b);
    prevCum = s.trafficGb;
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bk, v]) => {
      const d = new Date(bk);
      const label = byHour ? `${pad(d.getHours())}:00` : `${WD[d.getDay()]}, ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
      return { label, value: metric === 'traffic' ? v.traffic : v.used };
    });
}

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

/** Подпись для строки «Требуют внимания». */
function attentionText(u: User): string {
  const key = statusOf(u).key;
  if (key === 'expiring') return `истекает через ${daysLeft(u.expiresAt) ?? 0} дн`;
  if (key === 'traffic') return 'лимит трафика';
  return 'срок истёк'; // expired
}

const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

export function Dashboard() {
  const { data, loading, loadError, isMobile, goAdmin } = useApp();
  const [win, setWin] = useState(7);
  const [metric, setMetric] = useState<Metric>('traffic');
  const [series, setSeries] = useState<StatsPoint[] | null>(null);
  const [health, setHealth] = useState<ServerHealth[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.getStats(win).then((r) => { if (alive) setSeries(r.series); }).catch(() => { if (alive) setSeries([]); });
    return () => { alive = false; };
  }, [win]);
  useEffect(() => {
    let alive = true;
    api.getHealth().then((r) => { if (alive) setHealth(r.servers); }).catch(() => { if (alive) setHealth([]); });
    return () => { alive = false; };
  }, []);

  if (loadError) return <div className="notice notice-red">{loadError}</div>;
  if (loading || !data) return <Loading text="Загружаем данные…" />;

  const bars = series ? bucketize(series, win, metric) : [];
  const periodTotal = bars.reduce((s, b) => s + b.value, 0);
  const metricInfo = METRICS.find((m) => m.key === metric)!;

  const { users, devices, servers, jobErrors, adminLog } = data;

  const activeUsers = users.filter((u) => {
    const key = statusOf(u).key;
    return key === 'active' || key === 'expiring';
  }).length;
  // Реальные числа: считаем только активные конфиги существующих пользователей.
  const existingIds = new Set(users.map((u) => u.id));
  const activeDevices = devices.filter((d) => d.isActive && d.userId && existingIds.has(d.userId)).length;
  const totalTraffic = servers.reduce((sum, s) => sum + (s.trafficGb || 0), 0);
  const onlineServers = servers.filter((s) => s.agent === 'online').length;

  const attention = users.filter((u) => {
    const key = statusOf(u).key;
    return key === 'expiring' || key === 'expired' || key === 'traffic';
  });

  const recentLog = adminLog.slice(0, 6);

  // На дашборде — только СВЕЖИЕ ошибки задач (за двое суток). Журнал отдаёт последние
  // 20 записей без отсечки по времени, поэтому после разовой аварии дашборд неделями
  // показывал стену провалов — часто по серверам, которых уже нет. Полная история
  // никуда не делась: она на экране «Логи», с расшифровкой каждой ошибки.
  const FRESH_MS = 48 * 3600 * 1000;
  const nowMs = Date.now();
  const freshErrors = jobErrors.filter((j) => {
    const t = Date.parse(j.at);
    return Number.isNaN(t) || nowMs - t <= FRESH_MS;
  });
  const staleErrors = jobErrors.length - freshErrors.length;

  // Трафик по серверам — компактные горизонтальные бары (из текущих метрик).
  const trafficRows = servers
    .map((s) => ({ id: s.id, name: s.name, country: s.country, gb: s.trafficGb || 0, online: s.agent === 'online' }))
    .sort((a, b) => b.gb - a.gb);
  const maxTraffic = Math.max(1, ...trafficRows.map((r) => r.gb));

  const stats = [
    { label: 'Активные пользователи', value: String(activeUsers), sub: `из ${users.length} всего` },
    { label: 'Активные конфиги', value: String(activeDevices), sub: '' },
    { label: 'Трафик', value: gb(totalTraffic), sub: 'суммарно по серверам' },
    { label: 'Серверы', value: `${onlineServers}/${servers.length}`, sub: 'онлайн' },
  ];

  const linkBtn = {
    background: 'none', border: 0, color: 'var(--link)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  } as const;

  return (
    <>
      <ScreenHeader eyebrow="Обзор" title="Состояние системы" />

      <div className="stack" style={{ gap: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 12 }}>
          {stats.map((c) => (
            <div key={c.label} className="card">
              <div className="eyebrow" style={{ marginBottom: 10 }}>{c.label}</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 700 }}>{c.value}</div>
              {c.sub ? <div className="small muted" style={{ marginTop: 4 }}>{c.sub}</div> : null}
            </div>
          ))}
        </div>

        {/* История: трафик/активность по времени с переключением окна */}
        <Panel
          title="История"
          extra={
            <div className="chip-row">
              {METRICS.map((m) => (
                <Chip key={m.key} label={m.label} size="sm" active={metric === m.key} onClick={() => setMetric(m.key)} />
              ))}
            </div>
          }
        >
          <div className="row-between" style={{ marginBottom: 12, gap: 10, flexWrap: 'wrap' }}>
            <div className="chip-row">
              {WINDOWS.map((w) => (
                <Chip key={w.days} label={w.label} size="sm" active={win === w.days} onClick={() => setWin(w.days)} />
              ))}
            </div>
            {series && bars.length > 0 ? (
              <span className="small muted mono">
                {metric === 'traffic' ? `всего за период: ${gb(periodTotal)}` : `пик: ${Math.max(0, ...bars.map((b) => b.value))} конфигов`}
              </span>
            ) : null}
          </div>
          <div className="body small muted" style={{ marginBottom: 10 }}>{metricInfo.hint}</div>
          {series === null ? (
            <div className="small muted" style={{ padding: '24px 0', textAlign: 'center' }}>Загрузка…</div>
          ) : (
            <BarChart
              bars={bars}
              format={metric === 'traffic' ? (v) => gb(v) : (v) => `${Math.round(v)} конф.`}
            />
          )}
        </Panel>

        {/* Здоровье серверов: аптайм за сутки/неделю (в стиле Uptime-мониторинга) */}
        {health && health.length > 0 ? (
          <Panel
            title="Здоровье серверов"
            extra={<button type="button" style={linkBtn} onClick={() => goAdmin('servers')}>все →</button>}
            bodyStyle={{ gap: 0 }}
          >
            {health.map((h) => (
              <div key={h.id} className="divide-row">
                <div className="row" style={{ gap: 10, minWidth: 0 }}>
                  <Dot color={h.online ? 'var(--green-dot)' : 'var(--red-fg)'} />
                  <span style={{ fontWeight: 600, ...ellipsis }}>{h.name}{h.country ? ` (${h.country})` : ''}</span>
                </div>
                <span className="small muted mono" style={{ flex: 'none' }}>
                  {h.online ? 'онлайн' : 'офлайн'} · аптайм 24ч {h.uptime24h}% · 7д {h.uptime7d}%
                </span>
              </div>
            ))}
          </Panel>
        ) : null}

        {trafficRows.length > 0 ? (
          <Panel
            title="Трафик по серверам"
            extra={<button type="button" style={linkBtn} onClick={() => goAdmin('servers')}>все →</button>}
          >
            <div className="stack" style={{ gap: 12 }}>
              {trafficRows.map((r) => (
                <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div className="row-between" style={{ alignItems: 'baseline' }}>
                    <span className="row" style={{ gap: 8, minWidth: 0 }}>
                      <Dot color={r.online ? 'var(--green-dot)' : 'var(--red-fg)'} />
                      <span style={{ fontWeight: 600, ...ellipsis }}>{r.name}{r.country ? ` (${r.country})` : ''}</span>
                    </span>
                    <span className="small muted mono" style={{ flex: 'none' }}>{gb(r.gb)}</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 6, background: 'var(--surface-btn-2, rgba(127,127,127,.15))', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.max(2, Math.round((r.gb / maxTraffic) * 100))}%`, background: 'var(--accent)', borderRadius: 6 }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="small muted" style={{ marginTop: 10 }}>
              Суммарный трафик по каждому серверу за всё время. Разбивка по дням/неделям —
              в ближайших обновлениях (нужен сбор истории).
            </div>
          </Panel>
        ) : null}

        <Panel title="Требуют внимания" bodyStyle={{ gap: 0 }}>
          {attention.length === 0 ? (
            <div className="small muted">Всё в порядке — нет истекающих и исчерпанных доступов.</div>
          ) : (
            attention.map((u) => (
              <div
                key={u.id}
                className="divide-row"
                style={{ cursor: 'pointer' }}
                {...rowProps(() => goAdmin('user-card', { userId: u.id }))}
              >
                <div className="row" style={{ gap: 10, minWidth: 0 }}>
                  <Dot color={statusOf(u).dot} />
                  <span style={{ fontWeight: 600, ...ellipsis }}>{u.name}</span>
                </div>
                <span className="small muted mono" style={{ flex: 'none' }}>{attentionText(u)}</span>
              </div>
            ))
          )}
        </Panel>

        <div className="grid-2">
          <Panel
            title="Серверы"
            extra={<button type="button" style={linkBtn} onClick={() => goAdmin('servers')}>все →</button>}
            bodyStyle={{ gap: 0 }}
          >
            {servers.length === 0 ? (
              <div className="small muted">Серверы ещё не добавлены.</div>
            ) : (
              servers.map((s) => {
                const online = s.agent === 'online';
                return (
                  <div key={s.id} className="divide-row">
                    <div className="row" style={{ gap: 10, minWidth: 0 }}>
                      <Dot color={online ? 'var(--green-dot)' : 'var(--red-fg)'} />
                      <span style={ellipsis}>{s.name}{s.country ? ` (${s.country})` : ''}</span>
                    </div>
                    <span className="small muted mono" style={{ flex: 'none' }}>
                      {online ? `sync ${rel(s.lastSyncAt)}` : 'offline'}
                    </span>
                  </div>
                );
              })
            )}

            <div style={{ marginTop: 14 }}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Ошибки заданий · за 2 суток</div>
              {freshErrors.length === 0 ? (
                <div className="small muted">
                  Свежих ошибок нет. ✅
                  {staleErrors > 0 ? <> Старые ({staleErrors}) — в разделе «Логи».</> : null}
                </div>
              ) : (
                <div className="stack" style={{ gap: 10 }}>
                  {freshErrors.map((j, i) => (
                    <div key={`${j.server}-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span className="small mono muted">{j.server} · {rel(j.at)}</span>
                      <span className="small">{j.text}</span>
                    </div>
                  ))}
                  {staleErrors > 0 ? (
                    <span className="small muted">Ещё {staleErrors} старых — в разделе «Логи».</span>
                  ) : null}
                </div>
              )}
            </div>
          </Panel>

          <Panel title="Последние действия">
            {recentLog.length === 0 ? (
              <div className="small muted">Пока нет событий.</div>
            ) : (
              recentLog.map((l, i) => (
                <div key={`${l.at}-${i}`} className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                  <span className="small mono muted" style={{ flex: 'none', minWidth: 92 }}>{rel(l.at)}</span>
                  <span className="small">{l.text}</span>
                </div>
              ))
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
