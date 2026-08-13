// A9 — Приложения. Клиент-центричный каталог: один клиент → платформы со
// ссылками/файлами. Иконка, совместимость, инструкция — на уровне клиента.

import { useState } from 'react';
import type { AppClient, AppPlatform, AppPlatformEntry } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { Chip, EmptyState, Field, ScreenHeader, Toggle } from '../components/ui';
import { readFileAsDataUrl } from '../lib/clipboard';
import { api } from '../api';

const mbFmt = (bytes: number): string => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);

type CompatValue = AppClient['compat'][number];

const PLATFORMS: AppPlatform[] = ['Android', 'iOS', 'Windows', 'macOS', 'Linux'];
const COMPAT_OPTIONS: Array<{ value: CompatValue; label: string }> = [
  { value: 'xray', label: 'Xray' },
  { value: 'amnezia-app', label: 'AmneziaVPN' },
  { value: 'amneziawg', label: 'AmneziaWG' },
];
const MAX_APP_FILE_MB = 300; // файлы стримятся на диск, не в базу — можно крупные инсталляторы

function kindLabel(compat: AppClient['compat']): string {
  if (compat.includes('xray')) return 'Xray · VLESS-ссылка + QR';
  if (compat.includes('amnezia-app')) return 'AmneziaVPN · .conf / ключ';
  if (compat.includes('amneziawg')) return 'AmneziaWG · .conf + QR';
  return 'формат не задан';
}

export function AppsAdmin() {
  const { data, saveApps, showConfirm, showToast } = useApp();
  const [localApps, setLocalApps] = useState<AppClient[]>(() =>
    data ? data.apps.map((a) => ({ ...a, compat: [...a.compat], platforms: a.platforms.map((p) => ({ ...p })) })) : [],
  );
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null); // ключ `${appId}:${platform}` пока идёт загрузка

  if (!data) return null;

  // Загрузка файла приложения стримом на сервер. Приложение должно уже существовать
  // на сервере (иначе привязывать файл не к чему), поэтому сперва сохраняем каталог.
  const uploadFile = async (app: AppClient, platform: AppPlatform, file: File) => {
    const key = `${app.id}:${platform}`;
    if (file.size > MAX_APP_FILE_MB * 1024 * 1024) return showToast(`Файл больше ${MAX_APP_FILE_MB} МБ`);
    setUploading(key);
    try {
      await saveApps(localApps); // персистим каталог, чтобы (app, platform) существовали на сервере
      const updated = await api.uploadAppFile(app.id, platform, file);
      const e = updated.platforms.find((p) => p.platform === platform);
      patchPlatform(app, platform, { downloadName: e?.downloadName ?? file.name, downloadSize: e?.downloadSize ?? file.size, file: null });
      showToast('Файл загружен');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Не удалось загрузить файл');
    } finally {
      setUploading(null);
    }
  };
  const removeFile = async (app: AppClient, platform: AppPlatform) => {
    try {
      await api.deleteAppFile(app.id, platform);
      patchPlatform(app, platform, { downloadName: null, downloadSize: null, file: null });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Не удалось удалить файл');
    }
  };

  const patchApp = (id: string, patch: Partial<AppClient>) =>
    setLocalApps((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const toggleCompat = (app: AppClient, value: CompatValue) => {
    const compat = app.compat.includes(value) ? app.compat.filter((c) => c !== value) : [...app.compat, value];
    patchApp(app.id, { compat });
  };

  const togglePlatform = (app: AppClient, platform: AppPlatform) => {
    const has = app.platforms.some((p) => p.platform === platform);
    const platforms = has
      ? app.platforms.filter((p) => p.platform !== platform)
      : [...app.platforms, { platform }];
    patchApp(app.id, { platforms });
  };

  const patchPlatform = (app: AppClient, platform: AppPlatform, patch: Partial<AppPlatformEntry>) => {
    patchApp(app.id, {
      platforms: app.platforms.map((p) => (p.platform === platform ? { ...p, ...patch } : p)),
    });
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
      text: `«${app.client}» будет удалён из каталога. Действие нельзя отменить.`,
      confirmLabel: 'Удалить',
      danger: true,
      onConfirm: () => setLocalApps((prev) => prev.filter((a) => a.id !== app.id)),
    });

  const addClient = () => {
    const item: AppClient = {
      id: `app_${Date.now()}`,
      client: 'Новый клиент',
      compat: ['xray'],
      source: '',
      instruction: '',
      enabled: true,
      icon: null,
      platforms: [],
    };
    setLocalApps((prev) => [...prev, item]);
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveApps(localApps);
      showToast('Сохранено');
    } catch (e) {
      // Раньше ошибка (напр. 413 — файл больше лимита тела) терялась молча:
      // тост «Сохранено» не показывался, но и ошибки не было видно.
      const msg = e instanceof Error ? e.message : 'Не удалось сохранить';
      showToast(/413|large|payload/i.test(msg) ? 'Файл слишком большой — используйте ссылку на скачивание' : msg);
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
        Один клиент — одна карточка. Отметьте платформы, на которых он доступен, и добавьте для каждой
        ссылку (стор/сайт/прямую) и/или файл. Пользователь выберет систему и увидит нужный вариант.
      </p>

      {localApps.length === 0 ? (
        <EmptyState title="Каталог пуст" text="Добавьте клиента кнопкой выше." />
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {localApps.map((app) => {
            const idx = localApps.findIndex((a) => a.id === app.id);
            const noCompat = app.compat.length === 0;
            return (
              <div key={app.id} className="card stack" style={{ gap: 12, opacity: app.enabled ? 1 : 0.62 }}>
                {/* Верхняя строка: иконка, имя, управление */}
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
                      <input className="input" value={app.client} onChange={(e) => patchApp(app.id, { client: e.target.value })} />
                    </Field>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn btn-outline btn-sm" style={{ width: 36, padding: 0 }} aria-label="Выше" disabled={idx <= 0} onClick={() => moveApp(app.id, -1)}>↑</button>
                    <button className="btn btn-outline btn-sm" style={{ width: 36, padding: 0 }} aria-label="Ниже" disabled={idx >= localApps.length - 1} onClick={() => moveApp(app.id, 1)}>↓</button>
                    <button className="btn btn-danger-outline btn-sm" style={{ width: 36, padding: 0 }} aria-label="Удалить" onClick={() => removeApp(app)}>✕</button>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <Toggle on={app.enabled} onChange={(v) => patchApp(app.id, { enabled: v })} ariaLabel="Активна" />
                    <span className="small">{app.enabled ? 'Активна' : 'Отключена'}</span>
                  </div>
                </div>

                {/* Совместимость */}
                <Field label="Совместимость">
                  <div className="chip-row">
                    {COMPAT_OPTIONS.map((opt) => (
                      <Chip key={opt.value} label={opt.label} size="sm" active={app.compat.includes(opt.value)} onClick={() => toggleCompat(app, opt.value)} />
                    ))}
                  </div>
                </Field>
                {noCompat ? (
                  <div className="notice notice-red small">Выберите хотя бы один формат — иначе клиент не появится у пользователя.</div>
                ) : (
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="small muted">Пользователь получит</span>
                    <span className="badge">{kindLabel(app.compat)}</span>
                  </div>
                )}

                <div className="grid-2">
                  <Field label="Официальный сайт">
                    <input className="input" placeholder="https://…" value={app.source} onChange={(e) => patchApp(app.id, { source: e.target.value })} />
                  </Field>
                  <Field label="Инструкция">
                    <input className="input" value={app.instruction} onChange={(e) => patchApp(app.id, { instruction: e.target.value })} />
                  </Field>
                </div>

                {/* Платформы */}
                <div className="field">
                  <span className="field-label">Платформы (отметьте и заполните ссылку/файл)</span>
                  <div className="chip-row" style={{ marginBottom: 8 }}>
                    {PLATFORMS.map((p) => (
                      <Chip key={p} label={p} size="sm" active={app.platforms.some((x) => x.platform === p)} onClick={() => togglePlatform(app, p)} />
                    ))}
                  </div>
                  <div className="stack" style={{ gap: 10 }}>
                    {PLATFORMS.filter((p) => app.platforms.some((x) => x.platform === p)).map((p) => {
                      const entry = app.platforms.find((x) => x.platform === p)!;
                      return (
                        <div key={p} className="card" style={{ gap: 8 }}>
                          <div className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 700 }}>{p}</span>
                            <span className="small muted mono">
                              {entry.downloadName ? `файл: ${entry.downloadName}${entry.downloadSize ? ` (${mbFmt(entry.downloadSize)})` : ''}` : 'файл не загружен'}
                            </span>
                          </div>
                          <input
                            className="input"
                            placeholder="Ссылка: стор (App Store / Google Play) — на случай, когда файла нет"
                            value={entry.url ?? ''}
                            onChange={(e) => patchPlatform(app, p, { url: e.target.value || null })}
                          />
                          <div className="row" style={{ gap: 8 }}>
                            <label className={`btn btn-outline btn-sm ${uploading === `${app.id}:${p}` ? 'disabled' : ''}`} style={{ cursor: 'pointer', margin: 0 }}>
                              {uploading === `${app.id}:${p}` ? 'Загрузка…' : entry.downloadName ? 'Заменить файл' : 'Загрузить файл (APK/EXE/AppImage)'}
                              <input
                                type="file"
                                style={{ display: 'none' }}
                                disabled={uploading === `${app.id}:${p}`}
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  e.target.value = '';
                                  if (file) void uploadFile(app, p, file);
                                }}
                              />
                            </label>
                            {entry.downloadName ? (
                              <button className="btn btn-outline btn-sm" onClick={() => void removeFile(app, p)}>Убрать файл</button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <button className="btn btn-primary" disabled={saving || uploading !== null} onClick={() => void save()}>
          {uploading !== null ? 'Идёт загрузка файла…' : 'Сохранить'}
        </button>
      </div>
    </>
  );
}
