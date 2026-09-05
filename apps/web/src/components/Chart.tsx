// Лёгкие графики без внешних зависимостей. BarChart — «за период» (сутки/день) с
// наведением и тултипом; умеет выделять один столбец или диапазон (клик, Shift+клик,
// протягивание мышкой) — для разбора «кто израсходовал за эти дни».
import { useState } from 'react';

export interface Bar {
  label: string; // подпись точки (напр. «14:00» или «пн, 12 авг»)
  value: number;
}

export function BarChart({
  bars,
  height = 180,
  format = (v: number) => String(Math.round(v)),
  empty = 'Пока мало данных — история копится (снимок раз в ~10 минут).',
  onSelect,
  onSelectRange,
  selectedRange = null,
}: {
  bars: Bar[];
  height?: number;
  format?: (v: number) => string;
  empty?: string;
  /** Клик по столбцу. `shift` — зажат Shift (расширить выделение до этого столбца). */
  onSelect?: (index: number, shift: boolean) => void;
  /** Протягивание мышкой: вызывается один раз, когда кнопку отпустили (a ≤ b). */
  onSelectRange?: (a: number, b: number) => void;
  /** Подсвеченный диапазон индексов (включительно); один день — [i, i]. */
  selectedRange?: [number, number] | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Откуда началось протягивание; пока мышь зажата, диапазон рисуем «вживую».
  const [drag, setDrag] = useState<number | null>(null);
  if (bars.length === 0) {
    return <div className="small muted" style={{ padding: '28px 0', textAlign: 'center' }}>{empty}</div>;
  }
  const max = Math.max(1e-9, ...bars.map((b) => b.value));
  const gap = bars.length > 40 ? 1 : bars.length > 14 ? 2 : 4;
  const h = hover != null ? bars[hover] : null;
  const live: [number, number] | null =
    drag != null && hover != null ? [Math.min(drag, hover), Math.max(drag, hover)] : selectedRange;
  const inRange = (i: number) => !!live && i >= live[0] && i <= live[1];
  const interactive = !!(onSelect || onSelectRange);

  const endDrag = () => {
    if (drag != null && hover != null && onSelectRange && drag !== hover) {
      onSelectRange(Math.min(drag, hover), Math.max(drag, hover));
    }
    setDrag(null);
  };

  return (
    <div style={{ position: 'relative', userSelect: interactive ? 'none' : undefined }}>
      {/* тултип */}
      {h ? (
        <div
          style={{
            position: 'absolute', top: -4, left: `${((hover! + 0.5) / bars.length) * 100}%`,
            transform: 'translate(-50%, -100%)', pointerEvents: 'none', zIndex: 5, whiteSpace: 'nowrap',
            background: 'var(--surface-btn-2, #1b2336)', border: '1px solid var(--border-inner, #2b3a63)',
            borderRadius: 8, padding: '6px 9px', boxShadow: '0 6px 18px rgba(0,0,0,.35)',
          }}
        >
          <div className="mono" style={{ fontSize: 14, fontWeight: 700 }}>{format(h.value)}</div>
          <div className="small muted" style={{ fontSize: 11 }}>{h.label}</div>
        </div>
      ) : null}
      <div
        style={{ display: 'flex', alignItems: 'flex-end', gap, height }}
        onMouseLeave={() => { setHover(null); setDrag(null); }}
        onMouseUp={endDrag}
      >
        {bars.map((b, i) => (
          <div
            key={i}
            onMouseEnter={() => setHover(i)}
            onMouseDown={onSelectRange ? (e) => { if (e.button === 0) setDrag(i); } : undefined}
            onClick={onSelect ? (e) => onSelect(i, e.shiftKey) : undefined}
            title=""
            style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: interactive ? 'pointer' : 'default' }}
          >
            <div
              style={{
                width: '100%', height: `${Math.max(2, (b.value / max) * 100)}%`,
                // Выделенные столбцы держим яркими, чтобы было видно, за какие дни разбивка.
                background: inRange(i) ? 'var(--accent-light, var(--accent))' : 'var(--accent)',
                opacity: hover === i || inRange(i) ? 1 : 0.5,
                borderRadius: '3px 3px 0 0', transition: 'opacity .1s',
              }}
            />
          </div>
        ))}
      </div>
      <div className="row-between small muted" style={{ marginTop: 6 }}>
        <span>{bars[0]!.label}</span>
        <span>{bars[bars.length - 1]!.label}</span>
      </div>
    </div>
  );
}

/** Линия изменения во времени — для непрерывных величин (нагрузка сервера): ЦП,
 *  память, скорость сети. Столбики хороши для «сколько за период», а ход нагрузки
 *  по минутам читается линией. Наведение — вертикальная метка и тултип, как у BarChart. */
export function LineChart({
  bars,
  height = 110,
  format = (v: number) => String(Math.round(v)),
  empty = 'Нет точек за период.',
}: {
  bars: Bar[];
  height?: number;
  format?: (v: number) => string;
  empty?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (bars.length === 0) {
    return <div className="small muted" style={{ padding: '28px 0', textAlign: 'center' }}>{empty}</div>;
  }
  // Ширина viewBox условная: SVG растягивается на контейнер (preserveAspectRatio=none),
  // высота фиксирована в пикселях, чтобы линия не плющилась при узком экране.
  const W = 1000;
  const n = bars.length;
  const max = Math.max(1e-9, ...bars.map((b) => b.value));
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => height - 3 - (v / max) * (height - 10);
  const line = bars.map((b, i) => `${x(i).toFixed(1)},${y(b.value).toFixed(1)}`).join(' ');
  const area = `0,${height} ${line} ${W},${height}`;
  const h = hover != null ? bars[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
      {h ? (
        <div
          style={{
            position: 'absolute', top: -4, left: `${(x(hover!) / W) * 100}%`,
            transform: 'translate(-50%, -100%)', pointerEvents: 'none', zIndex: 5, whiteSpace: 'nowrap',
            background: 'var(--surface-btn-2, #1b2336)', border: '1px solid var(--border-inner, #2b3a63)',
            borderRadius: 8, padding: '6px 9px', boxShadow: '0 6px 18px rgba(0,0,0,.35)',
          }}
        >
          <div className="mono" style={{ fontSize: 14, fontWeight: 700 }}>{format(h.value)}</div>
          <div className="small muted" style={{ fontSize: 11 }}>{h.label}</div>
        </div>
      ) : null}
      <div
        style={{ position: 'relative', height, cursor: 'crosshair' }}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const t = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
          setHover(Math.max(0, Math.min(n - 1, Math.round(t * (n - 1)))));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ display: 'block', width: '100%', height }}>
          <polygon points={area} fill="var(--accent)" opacity={0.15} />
          <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          {hover != null ? (
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={height} stroke="var(--accent-light, var(--accent))" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.7} />
          ) : null}
        </svg>
        {hover != null ? (
          <div
            style={{
              position: 'absolute', left: `${(x(hover) / W) * 100}%`, top: y(bars[hover]!.value),
              width: 8, height: 8, marginLeft: -4, marginTop: -4, borderRadius: '50%',
              background: 'var(--accent-light, var(--accent))', pointerEvents: 'none',
            }}
          />
        ) : null}
      </div>
      <div className="row-between small muted" style={{ marginTop: 6 }}>
        <span>{bars[0]!.label}</span>
        <span>{bars[bars.length - 1]!.label}</span>
      </div>
    </div>
  );
}
