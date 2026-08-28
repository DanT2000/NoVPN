/* Подключение: подписка и сервер. Всё, что связано с доступом, — здесь. */

import { useState } from 'react';
import { useStore } from '../state/store';
import { Dialog, StatusDot } from '../components/ui';
import { IconCheck, IconChevron, IconRefresh } from '../components/icons';

export function Connection() {
  const { s, resetSubscription, checkSubscription } = useStore();
  const [picking, setPicking] = useState(false);
  const [changing, setChanging] = useState(false);
  const server = s.servers.find((x) => x.id === s.serverId) ?? null;
  const valid = s.subscription.status === 'active';

  return (
    <div className="viewport">
      <h1 className="screen-title">Подключение</h1>
      <p className="screen-sub">Подписка и выбор сервера.</p>

      <div className="section-label first">Подписка</div>
      <div className="card" style={{ padding: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <StatusDot tone={valid ? 'green' : 'red'} />
          <span className="t-strong" style={{ color: valid ? 'var(--green-fg)' : 'var(--red-fg)' }}>
            {valid ? 'Активна' : 'Недействительна'}
          </span>
        </div>
        {s.subscription.url ? (
          <div
            className="mono t-note"
            style={{
              marginTop: 10,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {s.subscription.url}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 8, marginTop: 13 }}>
          <button
            className="btn btn-secondary btn-sm"
            style={{ flex: 1 }}
            onClick={() => checkSubscription(s.subscription.url || 'https://vpn.example.ru/sub/demo')}
          >
            <IconRefresh /> Обновить
          </button>
          <button className="btn btn-outline btn-sm" style={{ flex: 1 }} onClick={() => setChanging(true)}>
            Изменить
          </button>
        </div>
      </div>

      <div className="section-label">Сервер</div>
      <button
        className="card"
        style={{ padding: '14px', width: '100%', textAlign: 'left', cursor: 'default', fontFamily: 'inherit' }}
        onClick={() => setPicking(true)}
      >
        <div className="row-between">
          <div>
            <div className="t-strong">{server ? server.name : 'Не выбран'}</div>
            <div className="mono t-meta" style={{ marginTop: 4 }}>
              {server ? `${server.host}:${server.port} · ${server.kind}` : '—'}
            </div>
          </div>
          <span style={{ color: 'var(--text-muted-2)', display: 'grid' }}>
            <IconChevron />
          </span>
        </div>
      </button>

      <div className="t-note" style={{ marginTop: 12 }}>
        Список серверов приходит из подписки и обновляется вместе с ней.
      </div>

      {picking ? <ServerDialog onClose={() => setPicking(false)} /> : null}
      {changing ? (
        <ChangeSubDialog
          onClose={() => setChanging(false)}
          onSubmit={(url) => {
            resetSubscription();
            checkSubscription(url);
            setChanging(false);
          }}
        />
      ) : null}
    </div>
  );
}

function ServerDialog({ onClose }: { onClose: () => void }) {
  const { s, setServer } = useStore();
  return (
    <Dialog title="Выберите сервер" onClose={onClose}>
      {s.servers.map((v) => (
        <button
          key={v.id}
          type="button"
          className="choice"
          role="radio"
          aria-checked={v.id === s.serverId}
          onClick={() => {
            setServer(v.id);
            onClose();
          }}
        >
          <span className="radio" />
          <span style={{ flex: 1 }}>
            <span className="t-name" style={{ display: 'block' }}>{v.name}</span>
            <span className="t-note mono" style={{ display: 'block', marginTop: 3 }}>{v.host}</span>
          </span>
          {/* Задержка известна только после замера — до него честнее промолчать. */}
          {v.ping != null ? (
            <span className="mono" style={{ fontSize: 13, color: pingColor(v.ping) }}>
              {v.ping} ms
            </span>
          ) : (
            <span className="mono t-note">{v.kind}</span>
          )}
        </button>
      ))}
    </Dialog>
  );
}

function pingColor(ms: number): string {
  if (ms < 60) return 'var(--green-fg)';
  if (ms < 110) return 'var(--amber-fg)';
  return 'var(--red-fg)';
}

function ChangeSubDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (url: string) => void }) {
  const [v, setV] = useState('');
  return (
    <Dialog title="Изменить подписку" onClose={onClose}>
      <div className="field">
        <label className="field-label" htmlFor="sub">
          Ссылка
        </label>
        <input
          id="sub"
          className="input mono"
          placeholder="https://..."
          value={v}
          autoFocus
          onChange={(e) => setV(e.target.value)}
        />
      </div>
      <button
        className="btn btn-primary btn-block"
        style={{ marginTop: 16 }}
        disabled={!v.trim()}
        onClick={() => onSubmit(v.trim())}
      >
        <IconCheck size={15} /> Применить
      </button>
    </Dialog>
  );
}
