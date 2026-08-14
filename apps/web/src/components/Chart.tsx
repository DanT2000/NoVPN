// Лёгкий SVG-график (area + line) без внешних зависимостей. Тема-адаптивный через
// var(--accent). Используется на «Обзоре» для истории трафика/активности.

interface Point {
  t: number; // время (мс) — для равномерности по X
  v: number; // значение
}

export function AreaChart({
  points,
  height = 160,
  format = (v: number) => String(Math.round(v)),
  color = 'var(--accent)',
}: {
  points: Point[];
  height?: number;
  format?: (v: number) => string;
  color?: string;
}) {
  if (points.length < 2) {
    return <div className="small muted" style={{ padding: '24px 0', textAlign: 'center' }}>Пока мало данных для графика — история копится (снимок раз в ~10 минут).</div>;
  }
  const W = 600;
  const H = height;
  const padY = 10;
  const xs = points.map((p) => p.t);
  const vs = points.map((p) => p.v);
  const minT = Math.min(...xs);
  const maxT = Math.max(...xs);
  const minV = Math.min(...vs);
  const maxV = Math.max(...vs);
  const spanT = maxT - minT || 1;
  const spanV = maxV - minV || 1;
  const x = (t: number) => ((t - minT) / spanT) * W;
  const y = (v: number) => H - padY - ((v - minV) / spanV) * (H - padY * 2);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const gid = `g${Math.round(minV)}${Math.round(maxV)}${points.length}`;
  return (
    <div style={{ width: '100%' }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="row-between small muted" style={{ marginTop: 4 }}>
        <span className="mono">{format(minV)}</span>
        <span className="mono">макс {format(maxV)}</span>
      </div>
    </div>
  );
}

export type { Point as ChartPoint };
