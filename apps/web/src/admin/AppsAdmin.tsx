// A9 — Приложения. Редактируемый каталог клиентов и инструкций.

import { useState } from 'react';
import type { AppClient } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { Chip, EmptyState, Field, ScreenHeader, Toggle } from '../components/ui';
import { readFileAsDataUrl, dataUrlWithName, isDataFile, dataFileName, dataFileSizeKb } from '../lib/clipboard';

const MAX_APP_FILE_MB = 40;

type Platform = AppClient['platform'];
type CompatValue = AppClient['compat'][number];
type Filter = 'Все' | Platform;

const PLATFORMS: Platform[] = ['Android', 'iOS', 'Windows', 'macOS', 'Linux'];
const FILTERS: Filter[] = ['Все', 'Android', 'iOS', 'Windows', 'macOS', 'Linux'];
const COMPAT_OPTIONS: Array<{ value: CompatValue; label: string }> = [
  { value: 'xray', label: 'Xray' },
  { value: 'amnezia-app', label: 'AmneziaVPN' },
  { value: 'amneziawg', label: 'AmneziaWG' },
];

function kindLabel(compat: AppClient['compat']): string {
  if (compat.includes('xray')) return 'Xray · VLESS-ссылка + QR';
  if (compat.includes('amnezia-app')) return 'AmneziaVPN · vpn:// (скоро) + .conf';
  if (compat.includes('amneziawg')) return 'AmneziaWG · .conf + QR';
  return 'формат не задан';
}

export function AppsAdmin() {
  const { data, saveApps, showConfirm, showToast } = useApp();
  const [localApps, setLocalApps] = useState<AppClient[]>(() =>
    data ? data.apps.map((a) => ({ ...a, compat: [...a.compat] })) : [],
  );
  const [filter, setFilter] = useState<Filter>('Все');
  const [saving, setSaving] = useState(false);

  if (!data) return null;

  const total = localApps.length;
  const shown = filter === 'Все' ? localApps : localApps.filter((a) => a.platform === filter);

  const patchApp = (id: string, patch: Partial<AppClient>) =>
    setLocalApps((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const toggleCompat = (app: AppClient, value: CompatValue) => {
    const compat = app.compat.includes(value)
      ? app.compat.filter((c) => c !== value)
      : [...app.compat, value];
    patchApp(app.id, { compat });
  };

  const moveApp = (id: string, dir: -1 | 1) =>
    setLocalApps((prev) => {
      const index = prev.findIndex((a) => a.id === id);
      const j = index + dir;
      if (index < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const a = next[index];
      const b = next[j];
      if (!a || !b) return prev;
      next[index] = b;
      next[j] = a;
      return next;
    });

  const removeApp = (app: AppClient) =>
    showConfirm({
      title: 'Удалить клиента?',
      text: `«${app.client}» будет удалён из списка приложений. Действие нельзя отменить.`,
      confirmLabel: 'Удалить',
      danger: true,
      onConfirm: () => setLocalApps((prev) => prev.filter((a) => a.id !== app.id)),
    });

  const addClient = () => {
    const platform: Platform = filter === 'Все' ? 'Android' : filter;
    const item: AppClient = {
      id: `a${Date.now()}`,
      platform,
      client: 'Новый клиент',
      compat: ['xray'],
      source: '',
      store: null,
      version: '—',
      localFile: null,
      instruction: '',
      enabled: true,
    };
    setLocalApps((prev) => [...prev, item]);
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveApps(localApps);
      showToast('Сохранено');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <ScreenHeader
        eyebrow="Приложения"
        title="Клиенты и инструкции"
        right={
          <button className="btn btn-primary" onClick={addClient}>
            + Добавить клиента
          </button>
        }
      />

      <p className="body" style={{ marginTop: 0, marginBottom: 16, lineHeight: 1.6 }}>
        Пользователь выбирает систему → приложение. Протокол и формат конфигурации подбираются автоматически
        по совместимости, указанной в карточке. На каждой платформе показываются только активные клиенты.
      </p>

      <div className="row-between" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="chip-row">
          {FILTERS.map((f) => (
            <Chip key={f} label={f} size="sm" active={filter === f} onClick={() => setFilter(f)} />
          ))}
        </div>
        <span className="small muted mono">{shown.length} из {total}</span>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title="Нет клиентов для этой платформы"
          text="Добавьте клиента кнопкой выше — платформа подставится автоматически."
        />
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {shown.map((app) => {
            const idx = localApps.findIndex((a) => a.id === app.id);
            const noCompat = app.compat.length === 0;
            return (
              <div
                key={app.id}
                className="card stack"
                style={{ gap: 12, opacity: app.enabled ? 1 : 0.62 }}
              >
                {/* Верхняя строка: иконка, имя, платформа, управление */}
                <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <label
                    title="Загрузить иконку"
                    style={{
                      width: 48, height: 48, borderRadius: 12, flex: 'none', cursor: 'pointer', overflow: 'hidden',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'var(--surface)', border: '1px solid var(--border-input)', fontSize: 20,
                    }}
                  >
                    {app.icon ? (
                      <img src={app.icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <span className="muted">＋</span>
                    )}
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        if (file.size > 1024 * 1024) {
                          showToast('Иконка больше 1 МБ — выберите меньше');
                          return;
                        }
                        patchApp(app.id, { icon: await readFileAsDataUrl(file) });
                      }}
                    />
                  </label>
                  <div style={{ flex: '1 1 180px', minWidth: 160 }}>
                    <Field label="Клиент">
                      <input
                        className="input"
                        value={app.client}
                        onChange={(e) => patchApp(app.id, { client: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div style={{ flex: '0 1 160px', minWidth: 130 }}>
                    <Field label="Платформа">
                      <select
                        className="select"
                        value={app.platform}
                        onChange={(e) => patchApp(app.id, { platform: e.target.value as Platform })}
                      >
                        {PLATFORMS.map((p) => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      className="btn btn-outline btn-sm"
                      style={{ width: 36, padding: 0 }}
                      aria-label="Выше"
                      disabled={idx <= 0}
                      onClick={() => moveApp(app.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className="btn btn-outline btn-sm"
                      style={{ width: 36, padding: 0 }}
                      aria-label="Ниже"
                      disabled={idx >= localApps.length - 1}
                      onClick={() => moveApp(app.id, 1)}
                    >
                      ↓
                    </button>
                    <button
                      className="btn btn-danger-outline btn-sm"
                      style={{ width: 36, padding: 0 }}
                      aria-label="Удалить"
                      onClick={() => removeApp(app)}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <Toggle
                      on={app.enabled}
                      onChange={(v) => patchApp(app.id, { enabled: v })}
                      ariaLabel="Активна"
                    />
                    <span className="small">{app.enabled ? 'Активна' : 'Отключена'}</span>
                  </div>
                </div>

                {/* Совместимость */}
                <Field label="Совместимость">
                  <div className="chip-row">
                    {COMPAT_OPTIONS.map((opt) => (
                      <Chip
                        key={opt.value}
                        label={opt.label}
                        size="sm"
                        active={app.compat.includes(opt.value)}
                        onClick={() => toggleCompat(app, opt.value)}
                      />
                    ))}
                  </div>
                </Field>

                {noCompat ? (
                  <div className="notice notice-red">
                    Выберите хотя бы один формат — иначе клиент не появится у пользователя.
                  </div>
                ) : null}

                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="small muted">Пользователь получит</span>
                  <span className="badge">{kindLabel(app.compat)}</span>
                </div>

                {/* Поля */}
                <div className="grid-2">
                  <Field label="Версия">
                    <input
                      className="input"
                      value={app.version}
                      onChange={(e) => patchApp(app.id, { version: e.target.value })}
                    />
                  </Field>
                  <Field label="Магазин / стор">
                    <input
                      className="input"
                      placeholder="Google Play / App Store / —"
                      value={app.store ?? ''}
                      onChange={(e) => patchApp(app.id, { store: e.target.value || null })}
                    />
                  </Field>
                </div>
                <div className="grid-2">
                  <Field label="Официальный источник (GitHub / сайт)">
                    <input
                      className="input"
                      placeholder="https://…"
                      value={app.source}
                      onChange={(e) => patchApp(app.id, { source: e.target.value })}
                    />
                  </Field>
                  <Field label="Прямая ссылка на скачивание">
                    <input
                      className="input"
                      placeholder="ссылка на .apk / .exe / .zip"
                      value={app.downloadUrl ?? ''}
                      onChange={(e) => patchApp(app.id, { downloadUrl: e.target.value || null })}
                    />
                  </Field>
                </div>
                {app.icon ? (
                  <div>
                    <button className="btn btn-outline btn-sm" onClick={() => patchApp(app.id, { icon: null })}>
                      Убрать иконку
                    </button>
                  </div>
                ) : null}
                <Field label="Инструкция">
                  <textarea
                    className="textarea"
                    value={app.instruction}
                    onChange={(e) => patchApp(app.id, { instruction: e.target.value })}
                  />
                </Field>

                {/* Файл */}
                <div className="row-between" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <span className="small muted mono">
                    {app.localFile
                      ? `файл: ${dataFileName(app.localFile)}${isDataFile(app.localFile) ? ` (${dataFileSizeKb(app.localFile)} КБ)` : ''}`
                      : 'локальный файл не загружен'}
                  </span>
                  <div className="row" style={{ gap: 8 }}>
                    <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
                      {app.localFile ? 'Заменить файл' : 'Загрузить файл'}
                      <input
                        type="file"
                        style={{ display: 'none' }}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (!file) return;
                          if (file.size > MAX_APP_FILE_MB * 1024 * 1024) {
                            showToast(`Файл больше ${MAX_APP_FILE_MB} МБ — используйте ссылку в поле «Источник»`);
                            return;
                          }
                          const dataUrl = dataUrlWithName(await readFileAsDataUrl(file), file.name);
                          patchApp(app.id, { localFile: dataUrl });
                          showToast('Файл прикреплён (не забудьте «Сохранить»)');
                        }}
                      />
                    </label>
                    {app.localFile ? (
                      <button className="btn btn-outline btn-sm" onClick={() => patchApp(app.id, { localFile: null })}>
                        Убрать
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          Сохранить
        </button>
      </div>
    </>
  );
}
