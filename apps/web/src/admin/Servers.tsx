// A6 — Серверы. Список серверов с метриками и управлением выдачей.

import type React from 'react';
import { PROTOCOL_LABELS } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { Dot, EmptyState, ScreenHeader, Toggle } from '../components/ui';
import { serverAgentView, serverEndpointView } from '../lib/status';
import { gb, plural, rel } from '../lib/format';

function Metric({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: color ?? 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </div>
    </div>
  );
}

export function Servers() {
  const { data, isMobile, goAdmin, setServerAutoIssue, setServerDefault, showToast } = useApp();
  if (!data) return null;

  const servers = data.servers;
  const n = servers.length;
  const statCols = isMobile ? '1fr 1fr' : 'repeat(auto-fit, minmax(130px, 1fr))';

  return (
    <>
      <ScreenHeader
        eyebrow="Серверы"
        title={`${n} ${plural(n, 'сервер', 'сервера', 'серверов')}`}
        right={
          <button className="btn btn-primary" onClick={() => goAdmin('server-wizard')}>
            + Добавить сервер
          </button>
        }
      />

      <div className="notice notice-amber" style={{ marginBottom: 16 }}>
        Раздел работает на mock API-контракте: реальные SSH-подключения и установка появятся на этапе backend-агентов.
      </div>

      {n === 0 ? (
        <EmptyState
          title="Серверов пока нет"
          text="Добавьте первый сервер, чтобы выдавать конфиги пользователям."
          action={
            <button className="btn btn-primary" onClick={() => goAdmin('server-wizard')}>
              + Добавить сервер
            </button>
          }
        />
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {servers.map((s) => {
            const agentV = serverAgentView(s);
            const endpointV = serverEndpointView(s);
            const dotColor = s.agent === 'online' ? 'var(--green-dot)' : 'var(--red-fg)';
            const title = s.country ? `${s.name} · ${s.country}` : s.name;
            const protocols = s.protocols.length
              ? s.protocols.map((p) => PROTOCOL_LABELS[p]).join(', ')
              : '—';

            return (
              <div key={s.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Заголовок карточки */}
                <div className="row-between" style={{ gap: 12, alignItems: 'center' }}>
                  <div className="row" style={{ gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
                    <Dot color={dotColor} />
                    <span style={{ fontWeight: 700, fontSize: 15 }}>{title}</span>
                    {s.isDefault ? <span className="badge">по умолчанию</span> : null}
                  </div>
                  <span
                    className="mono small"
                    style={{ color: 'var(--text-muted)', textAlign: 'right', wordBreak: 'break-all' }}
                  >
                    {s.host}
                  </span>
                </div>

                {/* Метрики */}
                <div style={{ display: 'grid', gridTemplateColumns: statCols, gap: 12 }}>
                  <Metric label="Агент" value={agentV.label} color={agentV.fg} />
                  <Metric label="VPN endpoint" value={endpointV.label} color={endpointV.fg} />
                  <Metric label="Протоколы" value={protocols} />
                  <Metric label="Трафик" value={gb(s.trafficGb)} />
                  <Metric label="Пользователи" value={String(s.users)} />
                  <Metric label="Синхронизация" value={rel(s.lastSyncAt)} />
                </div>

                {/* Футер */}
                <div
                  className="row-between"
                  style={{ gap: 12, flexWrap: 'wrap', borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}
                >
                  <div className="row" style={{ gap: 10 }}>
                    <Toggle
                      on={s.autoIssue}
                      onChange={(v) => void setServerAutoIssue(s.id, v)}
                      ariaLabel="Автоматическая выдача"
                    />
                    <span className="small">Автоматическая выдача</span>
                  </div>
                  {!s.isDefault ? (
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={async () => {
                        await setServerDefault(s.id);
                        showToast(`«${s.name}» — сервер по умолчанию`);
                      }}
                    >
                      Сделать по умолчанию
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
