import { useState } from 'react';
import { PROTOCOL_LABELS } from '@novpn/shared';
import type { Device } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { BackButton, Pill, EmptyState } from '../components/ui';
import { CleanupDialog, RenameDialog, isInactive } from '../components/DeviceDialogs';
import { dateShort, gb, rel } from '../lib/format';
import { devStatusOf } from '../lib/status';

export function Devices() {
  const { publicUser: user, publicData: data, goPublic, showConfirm, showToast, reissueDevice, revokeDevice, deleteDevice, renameDevice, cleanupDevices } = useApp();
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Device | null>(null);
  if (!user || !data) return null;

  const devices = data.devices.filter((d) => d.userId === user.id);
  const active = devices.filter((d) => d.isActive).length;
  const uDevBig = user.deviceLimit == null ? String(active) : `${active} из ${user.deviceLimit}`;
  const inactive = devices.filter((d) => isInactive(d));

  const serverName = (id: string) => data.servers.find((s) => s.id === id)?.name ?? id;

  const onReissue = (d: Device) =>
    showConfirm({
      title: 'Перевыпустить конфиг?',
      text: `Старая конфигурация «${d.name}» перестанет работать — устройство нужно будет настроить заново. Новый конфиг откроется сразу после перевыпуска.`,
      confirmLabel: 'Перевыпустить',
      onConfirm: async () => {
        await reissueDevice(d.id);
        // Перевыпуск без показа нового конфига бессмыслен: старый уже мёртв,
        // а новым человек не может воспользоваться. Открываем его сразу.
        goPublic('wizard', { wizardMode: 'view', deviceId: d.id });
      },
    });

  const onRevoke = (d: Device) =>
    showConfirm({
      title: 'Отключить устройство?',
      text: `«${d.name}» больше не сможет подключаться по этой конфигурации.`,
      confirmLabel: 'Отключить',
      danger: true,
      onConfirm: async () => {
        await revokeDevice(d.id);
        showToast('Устройство отключено');
      },
    });

  const onDelete = (d: Device) =>
    showConfirm({
      title: 'Удалить запись?',
      text: `Запись об устройстве «${d.name}» будет удалена.`,
      confirmLabel: 'Удалить',
      danger: true,
      onConfirm: async () => {
        await deleteDevice(d.id);
        showToast('Запись удалена');
      },
    });

  const doCleanup = async (ids: string[]) => {
    const n = await cleanupDevices(ids);
    showToast(n ? `Удалено конфигов: ${n}` : 'Ничего не удалено');
  };
  const doRename = async (id: string, name: string) => {
    await renameDevice(id, name);
    showToast('Название изменено');
  };

  return (
    <div className="stack" style={{ gap: 14, paddingTop: 12 }}>
      <div className="row-between">
        <div className="row" style={{ gap: 12 }}>
          <BackButton onClick={() => goPublic('cabinet')} />
          <div style={{ fontSize: 22, fontWeight: 700 }}>Мои устройства</div>
        </div>
        <span className="mono muted" style={{ fontSize: 13 }}>{uDevBig}</span>
      </div>

      {inactive.length > 0 ? (
        <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div className="small">
            <b>{inactive.length}</b> {inactive.length === 1 ? 'конфиг не использовался' : 'конфигов не использовались'} более 30 дней.
          </div>
          <button className="btn btn-outline btn-sm" onClick={() => setCleanupOpen(true)}>
            Очистить неактивные
          </button>
        </div>
      ) : null}

      {devices.length === 0 ? (
        <EmptyState
          title="Пока нет устройств"
          text="Подключите первое устройство — это займёт меньше минуты."
          action={
            <button className="btn btn-primary" onClick={() => goPublic('wizard', { wizardMode: 'issue' })}>
              Подключить устройство
            </button>
          }
        />
      ) : (
        devices.map((d) => {
          const trafficText =
            d.monitoringAvailable === false ? 'Мониторинг недоступен' : `Трафик: ${gb(d.trafficGb)}`;
          return (
            <div key={d.id} className="card" style={{ opacity: d.isActive ? 1 : 0.55 }}>
              <div className="row-between" style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{d.name}</div>
                <Pill s={devStatusOf(d)} size="sm" />
              </div>
              <div className="small muted">
                {serverName(d.serverId)} · {PROTOCOL_LABELS[d.protocol]} · был в сети: {rel(d.lastSeenAt)}
              </div>
              <div className="small muted" style={{ marginTop: 2 }}>
                {trafficText} · создано {dateShort(d.createdAt)}
              </div>
              <div className="small" style={{ marginTop: 2, color: 'var(--text-faint)' }}>
                {d.osHint ?? 'Тип устройства не определён'}
              </div>

              <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                {d.isActive ? (
                  <>
                    <button className="btn btn-secondary btn-sm" onClick={() => goPublic('wizard', { wizardMode: 'view', deviceId: d.id })}>
                      Конфиг
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={() => onReissue(d)}>
                      Перевыпуск
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={() => setRenameTarget(d)}>
                      Переименовать
                    </button>
                    <button className="btn btn-danger-outline btn-sm" onClick={() => onRevoke(d)}>
                      Отключить
                    </button>
                  </>
                ) : (
                  <button className="btn btn-danger-outline btn-sm" onClick={() => onDelete(d)}>
                    Удалить запись
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}

      {cleanupOpen ? (
        <CleanupDialog
          devices={inactive}
          serverName={serverName}
          onClose={() => setCleanupOpen(false)}
          onCleanup={doCleanup}
        />
      ) : null}
      {renameTarget ? (
        <RenameDialog
          device={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRename={(name) => doRename(renameTarget.id, name)}
        />
      ) : null}
    </div>
  );
}
