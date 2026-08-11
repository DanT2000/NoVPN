// Диалоги управления конфигами: массовая очистка с галочками и переименование.
// Используются одинаково в кабинете (Devices) и в админ-карточке (UserCard).

import { useState } from 'react';
import { PROTOCOL_LABELS } from '@novpn/shared';
import type { Device } from '@novpn/shared';
import { rel, dateShort } from '../lib/format';

/** Конфиг «неактивен»: активная запись, но последняя активность (или, если её нет,
 *  дата создания) старше `days` дней. Кандидат на очистку — решение за пользователем. */
export function isInactive(d: Device, days = 30): boolean {
  if (!d.isActive) return false;
  const ref = d.lastSeenAt ?? d.createdAt;
  return ref ? new Date(ref).getTime() < Date.now() - days * 86400000 : false;
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 150,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
};
const dialog: React.CSSProperties = {
  background: 'var(--surface-dialog)', borderRadius: 'var(--r-dialog)', padding: 24,
  width: 'min(460px, 100%)', maxHeight: '85vh', display: 'flex', flexDirection: 'column', gap: 12,
};

/** Массовая очистка: список кандидатов с галочками (все отмечены), можно снять
 *  лишние перед удалением. Пользователь сам решает, что удалить. */
export function CleanupDialog({
  devices,
  serverName,
  onClose,
  onCleanup,
}: {
  devices: Device[];
  serverName: (id: string) => string;
  onClose: () => void;
  onCleanup: (ids: string[]) => Promise<void>;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(devices.map((d) => [d.id, true])),
  );
  const [busy, setBusy] = useState(false);
  const selected = devices.filter((d) => checked[d.id]).map((d) => d.id);
  const toggle = (id: string) => setChecked((c) => ({ ...c, [id]: !c[id] }));

  const run = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      await onCleanup(selected);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Очистить неактивные конфиги</div>
        <div className="small muted">
          Не использовались более 30 дней. Снимите галочки с тех, что хотите оставить — остальные будут отозваны и удалены.
        </div>

        <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, margin: '4px 0' }}>
          {devices.map((d) => (
            <label
              key={d.id}
              className="row"
              style={{ gap: 10, alignItems: 'flex-start', cursor: 'pointer', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 10 }}
            >
              <input type="checkbox" checked={!!checked[d.id]} onChange={() => toggle(d.id)} style={{ marginTop: 3 }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ fontWeight: 600, display: 'block' }}>{d.name}</span>
                <span className="small muted" style={{ display: 'block' }}>
                  {serverName(d.serverId)} · {PROTOCOL_LABELS[d.protocol]} · последняя активность: {rel(d.lastSeenAt)}
                </span>
                <span className="small" style={{ display: 'block', color: 'var(--text-faint)' }}>
                  создано {dateShort(d.createdAt)}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button className="btn btn-secondary" style={{ flex: 1, height: 46, borderRadius: 12 }} onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button
            className="btn btn-danger"
            style={{ flex: 1, height: 46, borderRadius: 12 }}
            onClick={() => void run()}
            disabled={busy || selected.length === 0}
          >
            {busy ? 'Удаляем…' : `Удалить выбранные (${selected.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Переименование одного конфига. */
export function RenameDialog({
  device,
  onClose,
  onRename,
}: {
  device: Device;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length > 0 && name.trim() !== device.name;

  const run = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await onRename(name.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...dialog, width: 'min(360px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Переименовать конфиг</div>
        <input
          className="input"
          value={name}
          maxLength={60}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
          }}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button className="btn btn-secondary" style={{ flex: 1, height: 46, borderRadius: 12 }} onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className="btn btn-primary" style={{ flex: 1, height: 46, borderRadius: 12 }} onClick={() => void run()} disabled={!valid || busy}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}
