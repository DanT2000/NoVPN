// Лёгкие графики без внешних зависимостей. BarChart — «за период» (сутки/день) с
// наведением и тултипом; AreaChart — накопительная линия (оставлен на всякий случай).
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
  selected = null,
}: {
  bars: Bar[];
  height?: number;
  format?: (v: number) => string;
  empty?: string;
  /** Клик по столбцу (напр. «показать, кто израсходовал в этот день»). */
  onSelect?: (index: number) => void;
  /** Подсвеченный столбец. */
  selected?: number | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (bars.length === 0) {
    return <div className="small muted" style={{ padding: '28px 0', textAlign: 'center' }}>{empty}</div>;
  }
  const max = Math.max(1e-9, ...bars.map((b) => b.value));
  const gap = bars.length > 40 ? 1 : bars.length > 14 ? 2 : 4;
  const h = hover != null ? bars[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
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
      <div style={{ display: 'flex', alignItems: 'flex-end', gap, height }} onMouseLeave={() => setHover(null)}>
        {bars.map((b, i) => (
          <div
            key={i}
            onMouseEnter={() => setHover(i)}
            onClick={onSelect ? () => onSelect(i) : undefined}
            title=""
            style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: onSelect ? 'pointer' : 'default' }}
          >
            <div
              style={{
                width: '100%', height: `${Math.max(2, (b.value / max) * 100)}%`,
                // Выбранный столбец держим ярким, чтобы было видно, за какой день разбивка.
                background: selected === i ? 'var(--accent-light, var(--accent))' : 'var(--accent)',
                opacity: hover === i || selected === i ? 1 : 0.5,
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
