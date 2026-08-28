/* Мелкие элементы интерфейса. Разметка и классы совпадают с веб-панелью
   NoVPN — тумблер, карточки и уведомления должны выглядеть и вести себя
   одинаково в обоих продуктах. */

import type { ReactNode } from 'react';
import { IconCheck, IconClose } from './icons';
import { CATALOG, colorFor, lookup } from '../mock/catalog';
import type { ConnState, Route } from '../state/types';

/** Фирменный цвет приглушаем до подложки — иначе список превращается в витраж. */
function tint(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Значок сервиса: буква фирменным цветом на его же приглушённой подложке. */
export function Avatar({ name, domain }: { name: string; domain?: string }) {
  const n = name.toLowerCase();
  const svc =
    (domain ? lookup(domain) : undefined) ??
    CATALOG.find((s) => s.name.toLowerCase() === n) ??
    // «Claude Code» — это Claude: берём бренд по началу названия.
    CATALOG.find((s) => n.startsWith(s.name.toLowerCase() + ' '));
  const color = svc?.color ?? colorFor(name);
  const letter = svc?.letter ?? (svc?.name ?? name).charAt(0).toUpperCase();
  return (
    <span className="avatar" style={{ background: tint(color, 0.16), color }} aria-hidden>
      {letter}
    </span>
  );
}

export function Toggle({
  on,
  onChange,
  ariaLabel,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  ariaLabel?: string;
}) {
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

export function Check({
  on,
  onChange,
  title,
  note,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  title: string;
  note?: string;
}) {
  return (
    <button type="button" className="check" role="checkbox" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="box">{on ? <IconCheck size={11} /> : null}</span>
      <span style={{ flex: 1 }}>
        <span className="t-name" style={{ display: 'block' }}>{title}</span>
        {note ? (
          <span className="t-note" style={{ display: 'block', marginTop: 3 }}>{note}</span>
        ) : null}
      </span>
    </button>
  );
}

/** Маршрут переключателем: выключен — напрямую, включён — через VPN. Проще и
    привычнее радиокнопок; смысл подписан рядом, чтобы не гадать. */
export function RouteSwitch({ value, onChange }: { value: Route; onChange: (r: Route) => void }) {
  const vpn = value === 'vpn';
  return (
    <div
      className="row-between"
      style={{
        padding: '13px 14px',
        border: '1px solid var(--border-input)',
        borderRadius: 'var(--r-ctrl)',
        background: vpn ? 'var(--blue-bg-soft)' : 'transparent',
        transition: 'background 0.13s',
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="t-name">{vpn ? 'Через VPN' : 'Напрямую'}</span>
        <span className="t-note">{vpn ? 'Этот трафик пойдёт в туннель' : 'Мимо VPN, как обычно'}</span>
      </span>
      <Toggle on={vpn} onChange={(on) => onChange(on ? 'vpn' : 'direct')} ariaLabel="Через VPN" />
    </div>
  );
}

/** Выбор одного из двух маршрутов радиокнопками (там, где переключатель не к месту). */
export function RouteChoice({ value, onChange }: { value: Route; onChange: (r: Route) => void }) {
  return (
    <div role="radiogroup" aria-label="Маршрут">
      <button
        type="button"
        className="choice"
        role="radio"
        aria-checked={value === 'vpn'}
        onClick={() => onChange('vpn')}
      >
        <span className="radio" />
        <span className="t-name">Через VPN</span>
      </button>
      <button
        type="button"
        className="choice"
        role="radio"
        aria-checked={value === 'direct'}
        onClick={() => onChange('direct')}
      >
        <span className="radio" />
        <span className="t-name">Напрямую</span>
      </button>
    </div>
  );
}

export function RouteTag({ route }: { route: Route }) {
  return (
    <span className={`route ${route === 'vpn' ? 'route-vpn' : 'route-direct'}`}>
      {route === 'vpn' ? 'Через VPN' : 'Напрямую'}
    </span>
  );
}

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row-between" style={{ marginBottom: 14 }}>
          <h2 className="dialog-title" style={{ margin: 0 }}>
            {title}
          </h2>
          <button type="button" className="winbtn" style={{ width: 28, height: 28 }} onClick={onClose} aria-label="Закрыть">
            <IconClose size={13} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── Состояния подключения ────────────────────────────────── */

interface StateInfo {
  label: string;
  note: string;
  tone: 'green' | 'amber' | 'red' | 'gray';
  /** Что делает главная кнопка в этом состоянии. */
  action: 'connect' | 'disconnect' | 'retry' | 'none';
}

export const STATE_INFO: Record<ConnState, StateInfo> = {
  off: { label: 'Не подключено', note: 'Трафик идёт как обычно', tone: 'gray', action: 'connect' },
  connecting: { label: 'Подключение…', note: 'Устанавливаем соединение', tone: 'amber', action: 'none' },
  on: { label: 'Подключено', note: '', tone: 'green', action: 'disconnect' },
  error: { label: 'Не удалось подключиться', note: 'Сервер не отвечает', tone: 'red', action: 'retry' },
  'no-internet': { label: 'Нет интернета', note: 'Проверьте сеть и попробуйте снова', tone: 'red', action: 'retry' },
  'sub-invalid': { label: 'Подписка недействительна', note: 'Обновите её в разделе «Подключение»', tone: 'red', action: 'none' },
  'config-updating': { label: 'Обновляем списки…', note: 'Соединение не прерывается', tone: 'amber', action: 'disconnect' },
  'config-updated': { label: 'Списки обновлены', note: 'Правила применены', tone: 'green', action: 'disconnect' },
};

const TONE_FG: Record<StateInfo['tone'], string> = {
  green: 'var(--green-fg)',
  amber: 'var(--amber-fg)',
  red: 'var(--red-fg)',
  gray: 'var(--text-muted)',
};
const TONE_DOT: Record<StateInfo['tone'], string> = {
  green: 'var(--green-dot)',
  amber: 'var(--amber-fg)',
  red: 'var(--red-fg)',
  gray: 'var(--text-muted-2)',
};

export function StatusDot({ tone }: { tone: StateInfo['tone'] }) {
  return (
    <span
      style={{
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: TONE_DOT[tone],
        flex: 'none',
        display: 'inline-block',
      }}
    />
  );
}

/** Небольшая полоса уведомления. Крупных тревожных плашек в приложении нет. */
export function Banner({
  conn,
  onAction,
  detail,
}: {
  conn: ConnState;
  onAction?: () => void;
  /** Настоящая причина отказа. Без неё человеку остаётся только гадать. */
  detail?: string | null;
}) {
  const info = STATE_INFO[conn];
  if (conn === 'on' || conn === 'off' || conn === 'connecting') return null;
  const cls = info.tone === 'red' ? 'notice-red' : info.tone === 'amber' ? 'notice-amber' : 'notice-green';
  return (
    <div className={`notice ${cls}`} style={{ marginBottom: 14 }}>
      <div className="row-between">
        <span>
          <strong style={{ color: TONE_FG[info.tone] }}>{info.label}</strong>
          {detail ? (
            <span style={{ color: 'var(--text-body)', display: 'block', marginTop: 4, whiteSpace: 'pre-wrap' }}>
              {detail}
            </span>
          ) : info.note ? (
            <span style={{ color: 'var(--text-body)' }}> — {info.note}</span>
          ) : null}
        </span>
        {onAction && info.action === 'retry' ? (
          <button type="button" className="link-btn" onClick={onAction}>
            Повторить
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Empty({ title, note, action }: { title: string; note?: string; action?: ReactNode }) {
  return (
    <div
      style={{
        border: '1px dashed var(--border-input)',
        borderRadius: 'var(--r-card)',
        padding: '22px 16px',
        textAlign: 'center',
      }}
    >
      <div className="t-name">{title}</div>
      {note ? <div className="t-note" style={{ marginTop: 6 }}>{note}</div> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}
