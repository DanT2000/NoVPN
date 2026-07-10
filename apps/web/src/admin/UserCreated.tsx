// A4 — Пользователь создан. Итог + готовое сообщение и действия.

import { useState } from 'react';
import type { User } from '@novpn/shared';
import { PROTOCOL_LABELS } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { EmptyState } from '../components/ui';
import { dateShort, gb } from '../lib/format';
import { buildMessage } from '../lib/gen';
import { copyText, shareText } from '../lib/clipboard';

export function UserCreated() {
  const { data, nav, goAdmin } = useApp();
  if (!data) return null;

  const user = data.users.find((u) => u.id === nav.params.userId);
  if (!user) {
    return (
      <EmptyState
        title="Пользователь не найден"
        text="Возможно, он был удалён."
        action={
          <button className="btn btn-primary" onClick={() => goAdmin('users')}>
            К списку
          </button>
        }
      />
    );
  }

  return <UserCreatedInner key={user.id} user={user} />;
}

function UserCreatedInner({ user }: { user: User }) {
  const { data, isMobile, goAdmin, showToast } = useApp();
  const template = data?.settings.messageTemplate ?? '';
  const domain = data?.settings.domain ?? '';
  const [message, setMessage] = useState(() => buildMessage(template, user, domain));
  if (!data) return null;

  const serverNames = user.allowedServers
    .map((id) => data.servers.find((s) => s.id === id)?.name)
    .filter((n): n is string => Boolean(n))
    .join(' · ');
  const protoLabels = user.allowedProtocols.map((p) => PROTOCOL_LABELS[p]).join(', ');

  return (
    <div className="stack">
      <div className="notice notice-green">
        <div style={{ fontWeight: 700, fontSize: 15 }}>Пользователь «{user.name}» создан</div>
        <div className="small" style={{ marginTop: 4 }}>
          Отправьте код или готовое сообщение.
        </div>
      </div>

      <div className="card" style={{ textAlign: 'center', padding: 24 }}>
        <div className="eyebrow" style={{ marginBottom: 8 }}>
          Код доступа
        </div>
        <div className="mono" style={{ fontSize: 42, fontWeight: 700, letterSpacing: '0.08em' }}>
          {user.code}
        </div>
      </div>

      <div className="card">
        <div className="divide-row">
          <span className="muted">Срок</span>
          <span>{user.expiresAt ? `до ${dateShort(user.expiresAt)}` : 'бессрочно'}</span>
        </div>
        <div className="divide-row">
          <span className="muted">Лимиты</span>
          <span>
            {user.deviceLimit ?? '∞'} устр · {gb(user.trafficLimitGb)}
          </span>
        </div>
        <div className="divide-row">
          <span className="muted">Доступ</span>
          <span style={{ textAlign: 'right' }}>
            {serverNames || '—'} · {protoLabels || '—'}
          </span>
        </div>
      </div>

      <div className="field">
        <span className="field-label">Сообщение пользователю</span>
        <textarea className="textarea" rows={7} value={message} onChange={(e) => setMessage(e.target.value)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10 }}>
        <button
          className="btn btn-primary"
          onClick={async () => {
            await copyText(user.code);
            showToast('Код скопирован');
          }}
        >
          Скопировать код
        </button>
        <button
          className="btn btn-secondary"
          onClick={async () => {
            await copyText(message);
            showToast('Сообщение скопировано');
          }}
        >
          Скопировать сообщение
        </button>
        <button
          className="btn btn-secondary"
          onClick={async () => {
            const ok = await shareText(message);
            if (!ok) {
              await copyText(message);
              showToast('Скопировано (Web Share недоступен)');
            }
          }}
        >
          Поделиться
        </button>
        <button className="btn btn-outline" onClick={() => goAdmin('user-card', { userId: user.id })}>
          Открыть карточку
        </button>
        <button className="btn btn-outline" onClick={() => goAdmin('user-create')}>
          Создать ещё
        </button>
        <button className="btn btn-outline" onClick={() => goAdmin('users')}>
          К списку
        </button>
      </div>
    </div>
  );
}
