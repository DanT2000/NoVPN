// A1 — Обзор / Состояние системы.

import type { KeyboardEvent } from 'react';
import type { User } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { Panel, Dot, ScreenHeader, Loading } from '../components/ui';
import { statusOf } from '../lib/status';
import { gb, rel, daysLeft } from '../lib/format';

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

  if (loadError) return <div className="notice notice-red">{loadError}</div>;
  if (loading || !data) return <Loading text="Загружаем данные…" />;

  const { users, devices, servers, jobErrors, adminLog } = data;

  const activeUsers = users.filter((u) => {
    const key = statusOf(u).key;
    return key === 'active' || key === 'expiring';
  }).length;
  const activeDevices = devices.filter((d) => d.isActive).length;
  const traffic30 = servers.reduce((sum, s) => sum + s.trafficGb, 0);

  const attention = users.filter((u) => {
    const key = statusOf(u).key;
    return key === 'expiring' || key === 'expired' || key === 'traffic';
  });

  const recentLog = adminLog.slice(0, 6);

  const stats = [
    { label: 'Активные пользователи', value: String(activeUsers), sub: `из ${users.length} всего` },
    { label: 'Активные устройства', value: String(activeDevices), sub: `выпущено конфигов: ${devices.length}` },
    { label: 'Трафик сегодня', value: '8,2 ГБ', sub: 'по всем серверам' },
    { label: 'Трафик за 30 дней', value: gb(traffic30), sub: 'суммарно' },
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
              <div className="small muted" style={{ marginTop: 4 }}>{c.sub}</div>
            </div>
          ))}
        </div>

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
              <div className="eyebrow" style={{ marginBottom: 8 }}>Ошибки заданий</div>
              {jobErrors.length === 0 ? (
                <div className="small muted">Ошибок нет.</div>
              ) : (
                <div className="stack" style={{ gap: 10 }}>
                  {jobErrors.map((j, i) => (
                    <div key={`${j.server}-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span className="small mono muted">{j.server} · {rel(j.at)}</span>
                      <span className="small">{j.text}</span>
                    </div>
                  ))}
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
