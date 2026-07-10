// Ввод шестизначного кода: 6 боксов + прозрачный input поверх (one-time-code).

import React, { useRef } from 'react';

export function CodeInput({
  value, onChange, onEnter, length = 6,
}: {
  value: string; onChange: (v: string) => void; onEnter?: () => void; length?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const boxes = Array.from({ length });

  return (
    <div style={{ position: 'relative' }} onClick={() => inputRef.current?.focus()}>
      <div className="row" style={{ gap: 8 }}>
        {boxes.map((_, i) => {
          const current = i === value.length;
          return (
            <div
              key={i}
              className="mono"
              style={{
                flex: 1, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--surface)', border: `1px solid ${current ? 'var(--accent)' : 'var(--border-input)'}`,
                borderRadius: 'var(--r-ctrl)', fontSize: 24, fontWeight: 500, letterSpacing: '0.02em',
              }}
            >
              {value[i] ?? ''}
            </div>
          );
        })}
      </div>
      <input
        ref={inputRef}
        value={value}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={length}
        aria-label="Шестизначный код доступа"
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, length))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter?.();
        }}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0,
          border: 0, background: 'transparent', color: 'transparent', cursor: 'text', caretColor: 'transparent',
        }}
        autoFocus
      />
    </div>
  );
}
