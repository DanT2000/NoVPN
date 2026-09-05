// Графики нагрузки одного сервера: ЦП, ОЗУ, диск, сеть — за сутки/неделю/месяц.
// Открывается кликом по серверу в «Здоровье серверов». Точка приходит раз в минуту,
// за месяц это ~43 тысячи; сжимаем до ~120 корзин на график: проценты усредняем,
// сеть берём по МАКСИМУМУ — иначе пики, ради которых всё и затевалось (хватает ли
// канала), размазались бы в среднее.

import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ServerMetricPoint } from '../api/types';
import { BarChart, type Bar } from '../components/Chart';
import { Chip } from '../components/ui';
import { gb } from '../lib/format';

const WINDOWS: Array<{ hours: number; label: string }> = [
  { hours: 24, label: '24 часа' },
  { hours: 24 * 7, label: 'Неделя' },
  { hours: 24 * 30, label: 'Месяц' },
];

const pad = (n: number) => String(n).padStart(2, '0');
/** Мбит/с из байт/с — привычная единица для «упираемся ли в канал». */
export const mbit = (bps: number) => {
  const v = (bps * 8) / 1e6;
  return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} Мбит/с`;
};

/** Сжать ряд до `target` корзин. avg — для процентов, max — для сети (пики). */
function bucketize(pts: ServerMetricPoint[], pick: (p: ServerMetricPoint) => number, mode: 'avg' | 'max', hours: number, target = 120): Bar[] {
  if (pts.length === 0) return [];
  const size = Math.max(1, Math.ceil(pts.length / target));
  const out: Bar[] = [];
  for (let i = 0; i < pts.length; i += size) {
    const chunk = pts.slice(i, i + size);
    const vals = chunk.map(pick);
    const value = mode === 'max' ? Math.max(...vals) : vals.reduce((s, v) => s + v, 0) / vals.length;
    const d = new Date(chunk[0]!.at);
    const label = hours <= 24 ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:00`;
    out.push({ label, value });
  }
  return out;
}

export function ServerCharts({ serverId, name }: { serverId: string; name: string }) {
  const [hours, setHours] = useState(24);
  const [pts, setPts] = useState<ServerMetricPoint[] | null>(null);

  useEffect(() => {
    let alive = true;
    setPts(null);
    api
      .getServerMetrics(serverId, hours)
      .then((r) => { if (alive) setPts(r.series); })
      .catch(() => { if (alive) setPts([]); });
    return () => { alive = false; };
  }, [serverId, hours]);

  const pct = (u: number, t: number) => (t > 0 ? (u / t) * 100 : 0);
  const peak = (pick: (p: ServerMetricPoint) => number) => (pts && pts.length ? Math.max(...pts.map(pick)) : 0);
  const last = pts && pts.length ? pts[pts.length - 1]! : null;

  const charts: Array<{ title: string; note: string; bars: Bar[]; format: (v: number) => string }> = pts
    ? [
        {
          title: 'Процессор',
          note: `сейчас ${last ? Math.round(last.cpuPct) : 0}% · пик ${Math.round(peak((p) => p.cpuPct))}%`,
          bars: bucketize(pts, (p) => p.cpuPct, 'avg', hours),
          format: (v) => `${Math.round(v)}%`,
        },
        {
          title: 'Память',
          note: last ? `сейчас ${Math.round(pct(last.memUsed, last.memTotal))}% (${gb(last.memUsed / 1e9)} из ${gb(last.memTotal / 1e9)})` : '',
          bars: bucketize(pts, (p) => pct(p.memUsed, p.memTotal), 'avg', hours),
          format: (v) => `${Math.round(v)}%`,
        },
        {
          title: 'Диск',
          note: last ? `занято ${Math.round(pct(last.diskUsed, last.diskTotal))}% (${gb(last.diskUsed / 1e9)} из ${gb(last.diskTotal / 1e9)})` : '',
          bars: bucketize(pts, (p) => pct(p.diskUsed, p.diskTotal), 'avg', hours),
          format: (v) => `${Math.round(v)}%`,
        },
        {
          title: 'Сеть · отдача (к пользователям)',
          note: `сейчас ${mbit(last?.netTxBps ?? 0)} · пик ${mbit(peak((p) => p.netTxBps))}`,
          bars: bucketize(pts, (p) => (p.netTxBps * 8) / 1e6, 'max', hours),
          format: (v) => `${v >= 10 ? Math.round(v) : v.toFixed(1)} Мбит/с`,
        },
        {
          title: 'Сеть · приём',
          note: `сейчас ${mbit(last?.netRxBps ?? 0)} · пик ${mbit(peak((p) => p.netRxBps))}`,
          bars: bucketize(pts, (p) => (p.netRxBps * 8) / 1e6, 'max', hours),
          format: (v) => `${v >= 10 ? Math.round(v) : v.toFixed(1)} Мбит/с`,
        },
      ]
    : [];

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}>
      <div className="row-between" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontWeight: 600 }}>Нагрузка: {name}</span>
        <div className="chip-row">
          {WINDOWS.map((w) => (
            <Chip key={w.hours} label={w.label} size="sm" active={hours === w.hours} onClick={() => setHours(w.hours)} />
          ))}
        </div>
      </div>
      {pts === null ? (
        <div className="small muted" style={{ padding: '18px 0', textAlign: 'center' }}>Загрузка…</div>
      ) : pts.length === 0 ? (
        <div className="small muted" style={{ padding: '18px 0', textAlign: 'center' }}>
          Нагрузка ещё не снята — точки копятся раз в минуту, график появится через несколько минут.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
          {charts.map((c) => (
            <div key={c.title}>
              <div className="row-between" style={{ marginBottom: 6, gap: 8 }}>
                <span className="small" style={{ fontWeight: 600 }}>{c.title}</span>
                <span className="small muted mono">{c.note}</span>
              </div>
              <BarChart bars={c.bars} height={110} format={c.format} empty="Нет точек за период." />
            </div>
          ))}
        </div>
      )}
      <div className="body small muted" style={{ marginTop: 10 }}>
        Проценты усреднены по корзинам, сеть — по максимуму, чтобы пики не терялись. Точка снимается раз в минуту, поэтому всплеск короче минуты покажется чуть ниже реального.
      </div>
    </div>
  );
}
