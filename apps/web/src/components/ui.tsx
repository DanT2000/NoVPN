// Мелкие переиспользуемые примитивы UI. Стили — из components.css / theme.css.

import React from 'react';
import type { StatusView } from '../lib/status';

export function Wordmark({ suffix }: { suffix?: string }) {
  return (
    <span className="mono" style={{ fontSize: 16, fontWeight: 600, letterSpacing: '0.01em' }}>
      no<span style={{ color: 'var(--accent-light)' }}>vpn</span>
      {suffix ? <span style={{ color: 'var(--text-faint)' }}> / {suffix}</span> : null}
    </span>
  );
}

export function Pill({ s, size = 'md' }: { s: StatusView; size?: 'md' | 'sm' }) {
  const pad = size === 'sm' ? '4px 10px' : '5px 12px';
  return (
    <span className="pill" style={{ color: s.fg, background: s.bg, padding: pad, fontSize: size === 'sm' ? 11 : 12 }}>
      {s.label}
    </span>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="dot" style={{ background: color }} />;
}

export function Toggle({ on, onChange, ariaLabel }: { on: boolean; onChange: (v: boolean) => void; ariaLabel?: string }) {
  return (
    <button
      type="button"
      className={`toggle ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange(!on)}
    />
  );
}

export function Chip({
  label, active, onClick, size = 'md', disabled,
}: {
  label: React.ReactNode; active?: boolean; onClick?: () => void; size?: 'md' | 'sm'; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`chip ${size === 'sm' ? 'chip-sm' : ''} ${active ? 'active' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  );
}

export function Field({
  label, children, hint,
}: {
  label: string; children: React.ReactNode; hint?: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="small muted">{hint}</span> : null}
    </label>
  );
}

export function Panel({
  title, extra, children, bodyStyle,
}: {
  title?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode; bodyStyle?: React.CSSProperties;
}) {
  return (
    <section className="panel">
      {title ? (
        <div className="panel-head">
          <span>{title}</span>
          {extra}
        </div>
      ) : null}
      <div className="panel-body" style={bodyStyle}>
        {children}
      </div>
    </section>
  );
}

export function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

export function EmptyState({ title, text, action }: { title: string; text?: string; action?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      {text ? <div className="small">{text}</div> : null}
      {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
    </div>
  );
}

export function Loading({ text }: { text?: string }) {
  return (
    <div className="empty-state" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <span className="spinner" />
      {text ? <span className="small muted">{text}</span> : null}
    </div>
  );
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-outline"
      aria-label="Назад"
      onClick={onClick}
      style={{ width: 38, height: 38, padding: 0, fontSize: 20, lineHeight: 1 }}
    >
      ‹
    </button>
  );
}

export function ScreenHeader({
  back, eyebrow, title, right,
}: {
  back?: () => void; eyebrow?: string; title: React.ReactNode; right?: React.ReactNode;
}) {
  return (
    <div className="row-between" style={{ marginBottom: 18, alignItems: 'flex-start' }}>
      <div className="row" style={{ gap: 12, alignItems: 'center', minWidth: 0 }}>
        {back ? <BackButton onClick={back} /> : null}
        <div style={{ minWidth: 0 }}>
          {eyebrow ? <div className="eyebrow" style={{ marginBottom: 4 }}>{eyebrow}</div> : null}
          <div style={{ fontSize: 22, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
        </div>
      </div>
      {right ? <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>{right}</div> : null}
    </div>
  );
}

/** Моноширинный блок с конфигом/ссылкой (перенос строк). */
export function ConfigBox({ text, truncate }: { text: string; truncate?: boolean }) {
  return (
    <pre
      className="mono"
      style={{
        background: 'var(--bg-app)', border: '1px solid var(--border-input)', borderRadius: 'var(--r-ctrl)',
        padding: 12, margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)',
        whiteSpace: truncate ? 'nowrap' : 'pre-wrap', overflowX: 'auto', wordBreak: truncate ? 'normal' : 'break-all',
      }}
    >
      {text}
    </pre>
  );
}
