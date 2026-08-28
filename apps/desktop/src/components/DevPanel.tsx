/* Стенд состояний. Открывается по F9.
   Нужен потому, что «нет интернета» или «подписка недействительна» руками не
   воспроизвести, а посмотреть на них до реализации надо. В боевую сборку не
   попадает: включается только при import.meta.env.DEV. */

import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { STATE_INFO, StatusDot } from './ui';
import type { ConnState } from '../state/types';

const ORDER: ConnState[] = [
  'off',
  'connecting',
  'on',
  'error',
  'no-internet',
  'sub-invalid',
  'config-updating',
  'config-updated',
];

export function DevPanel() {
  const { s, setConn, resetOnboarding } = useStore();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F9') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Стенд состояний (F9)"
        style={{
          position: 'fixed',
          right: 8,
          bottom: 62,
          zIndex: 60,
          width: 22,
          height: 22,
          borderRadius: 6,
          border: '1px solid var(--border-input)',
          background: 'var(--surface)',
          color: 'var(--text-fainter)',
          fontSize: 9,
          fontFamily: 'var(--font-mono)',
          cursor: 'default',
        }}
      >
        F9
      </button>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 'auto 8px 62px 8px',
        zIndex: 60,
        background: 'var(--surface-dialog)',
        border: '1px solid var(--border-input)',
        borderRadius: 'var(--r-card-lg)',
        padding: 12,
        boxShadow: 'var(--shadow-toast)',
        maxHeight: '70vh',
        overflowY: 'auto',
      }}
    >
      <div className="row-between" style={{ marginBottom: 9 }}>
        <span className="eyebrow">стенд состояний</span>
        <button className="link-btn" onClick={() => setOpen(false)}>
          закрыть
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
        {ORDER.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setConn(c)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 8px',
              borderRadius: 6,
              border: '1px solid ' + (s.conn === c ? 'var(--accent)' : 'var(--border)'),
              background: s.conn === c ? 'var(--blue-bg-soft)' : 'var(--surface)',
              color: 'var(--text-body)',
              font: 'inherit',
              fontSize: 11,
              cursor: 'default',
              textAlign: 'left',
            }}
          >
            <StatusDot tone={STATE_INFO[c].tone} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {STATE_INFO[c].label}
            </span>
          </button>
        ))}
      </div>

      <button className="btn btn-outline btn-sm btn-block" style={{ marginTop: 9 }} onClick={resetOnboarding}>
        Сбросить и пройти онбординг заново
      </button>

      <div className="eyebrow" style={{ margin: '14px 0 7px' }}>
        меню в трее
      </div>
      <TrayPreview />
    </div>
  );
}

/** Как выглядит меню трея. Само меню живёт в Rust-части. */
function TrayPreview() {
  const { s } = useStore();
  const info = STATE_INFO[s.conn];
  const server = s.servers.find((x) => x.id === s.serverId);
  const line = (t: string, muted?: boolean) => (
    <div style={{ padding: '5px 9px', fontSize: 11.5, color: muted ? 'var(--text-muted-2)' : 'var(--text-secondary)' }}>
      {t}
    </div>
  );
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 0' }}>
      <div style={{ padding: '5px 9px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700 }}>
        <StatusDot tone={info.tone} />
        {info.label}
      </div>
      {line(server ? server.name : 'сервер не выбран', true)}
      <div style={{ height: 1, background: 'var(--border-inner)', margin: '4px 0' }} />
      {line(`Умная маршрутизация ${s.smartRouting ? '✓' : ''}`)}
      <div style={{ height: 1, background: 'var(--border-inner)', margin: '4px 0' }} />
      {line('Открыть NoVPN')}
      {line(s.conn === 'on' ? 'Отключить' : 'Подключить')}
      {line('Выход')}
    </div>
  );
}
