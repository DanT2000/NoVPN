import { PROTOCOL_LABELS } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { Dot } from '../components/ui';
import { dateShort, daysLeft, gb, plural } from '../lib/format';
import { statusOf } from '../lib/status';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="divide-row" style={{ alignItems: 'flex-start' }}>
      <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted-2)', textTransform: 'uppercase', letterSpacing: '0.08em', paddingTop: 2 }}>
        {label}
      </span>
      <div style={{ textAlign: 'right', maxWidth: '70%' }}>{children}</div>
    </div>
  );
}

function Tile({ title, sub, onClick, chevron }: { title: string; sub: string; onClick: () => void; chevron?: boolean }) {
  return (
    <button type="button" className="card" onClick={onClick} style={{ textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
        <div className="small muted" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
      </div>
      {chevron ? <span style={{ color: 'var(--text-faint)', fontSize: 20 }}>›</span> : null}
    </button>
  );
}

export function Cabinet() {
  const { publicUser: user, data, goPublic, logoutPublic, showToast } = useApp();
  if (!user || !data) return null;

  const devices = data.devices.filter((d) => d.userId === user.id);
  const active = devices.filter((d) => d.isActive).length;
  const status = statusOf(user);
  const dl = daysLeft(user.expiresAt);

  const serverNames = user.allowedServers
    .map((id) => data.servers.find((s) => s.id === id)?.name)
    .filter(Boolean)
    .join(' · ');
  const protoNames = user.allowedProtocols.map((p) => PROTOCOL_LABELS[p]).join(' · ');

  const devSub = devices.length
    ? devices.slice(0, 2).map((d) => d.name).join(', ')
    : 'пока нет';

  return (
    <div className="stack" style={{ gap: 16, paddingTop: 12 }}>
      <div className="row-between">
        <div>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Доступ</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{user.name}</div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <Dot color={status.dot} />
          <span className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: status.fg }}>
            {status.label}
          </span>
        </div>
      </div>

      <div className="card" style={{ padding: '4px 16px' }}>
        <Row label="Срок">
          <div style={{ fontWeight: 700 }}>
            {user.expiresAt == null ? 'Бессрочно' : dl != null && dl < 0 ? 'истёк' : `${dl} ${plural(dl ?? 0, 'день', 'дня', 'дней')}`}
          </div>
          <div className="small muted">{user.expiresAt ? `до ${dateShort(user.expiresAt)}` : 'без даты окончания'}</div>
        </Row>
        <Row label="Устройства">
          <div style={{ fontWeight: 700 }}>{user.deviceLimit == null ? active : `${active} из ${user.deviceLimit}`}</div>
          <div className="small muted">
            {user.deviceLimit == null
              ? 'без ограничений'
              : user.deviceLimit - active > 0
                ? `можно ещё ${user.deviceLimit - active}`
                : 'лимит достигнут'}
          </div>
        </Row>
        <Row label="Трафик">
          <div style={{ fontWeight: 700 }}>
            {user.trafficLimitGb == null ? `${gb(user.trafficUsedGb)} · без лимита` : `${gb(user.trafficUsedGb)} из ${gb(user.trafficLimitGb)}`}
          </div>
          {user.trafficLimitGb != null ? (
            <>
              <div className="progress" style={{ margin: '8px 0 4px' }}>
                <span style={{ width: `${Math.min(100, (user.trafficUsedGb / user.trafficLimitGb) * 100)}%` }} />
              </div>
              <div className="small muted">осталось {gb(Math.max(0, user.trafficLimitGb - user.trafficUsedGb))}</div>
            </>
          ) : null}
        </Row>
        <Row label="Серверы">
          <div style={{ fontWeight: 600 }}>{serverNames || '—'}</div>
        </Row>
        <Row label="Протоколы">
          <div style={{ fontWeight: 600 }}>{protoNames || '—'}</div>
        </Row>
      </div>

      <button className="btn btn-primary btn-lg btn-block" onClick={() => goPublic('wizard', { wizardMode: 'issue' })}>
        + Подключить новое устройство
      </button>

      <div className="grid-2">
        <Tile title="Мои устройства" sub={devSub} onClick={() => goPublic('devices')} />
        <Tile
          title="Telegram"
          sub={user.telegramLinked ? 'Привязан' : 'Не привязан'}
          onClick={() =>
            showToast(user.telegramLinked ? 'Telegram привязан' : 'Привязка Telegram — через бота, когда администратор его включит')
          }
        />
      </div>

      <Tile title="Приложения и инструкции" sub="Android · iOS · Windows · macOS · Linux" onClick={() => goPublic('apps')} chevron />

      <div style={{ paddingTop: 8 }}>
        <button type="button" onClick={logoutPublic} className="mono" style={{ background: 'none', border: 0, color: 'var(--text-faint)', fontSize: 12, cursor: 'pointer' }}>
          ← выйти
        </button>
      </div>
    </div>
  );
}
