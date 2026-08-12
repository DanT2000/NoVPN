// Страница подключения: человек выбирает протокол, получает готовую ссылку и
// приложение под свою систему.
//
// Развилка нужна потому, что способы принципиально разные:
//   Xray      — ПОДПИСКА: одна ссылка на все устройства, приложение само
//               обновляет конфиги. Ничего выпускать не нужно.
//   AmneziaWG — отдельная конфигурация на устройство: ссылка vpn:// для
//               приложения AmneziaVPN либо файл .conf для приложения AmneziaWG.

import { useState } from 'react';
import type { AppClient, AppPlatform } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { BackButton, Chip, EmptyState } from '../components/ui';
import { copyText, openUrl } from '../lib/clipboard';

const mb = (bytes: number): string => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(0)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);

const PLATFORMS: AppPlatform[] = ['Android', 'iOS', 'Windows', 'macOS', 'Linux'];

function detectPlatform(): AppPlatform {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/mac/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Windows';
}

function normalizeUrl(u: string): string {
  const t = u.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}
function storeOf(url: string): string | null {
  if (/play\.google\.com/i.test(url)) return 'Google Play';
  if (/apps\.apple\.com|itunes\.apple/i.test(url)) return 'App Store';
  if (/(microsoft\.com\/.*store|apps\.microsoft)/i.test(url)) return 'Microsoft Store';
  return null;
}

/**
 * Ссылка «добавить подписку одним нажатием».
 * Возвращаем ТОЛЬКО для схем, которые проверены по документации клиента —
 * выдуманная схема молча не сработает, и человек решит, что сломана подписка.
 */
function oneTapImport(app: AppClient, subUrl: string): string | null {
  const sc = app.urlScheme;
  if (!sc) return null;
  // Схема либо с параметром (…url=), либо путём (…/) — дописываем соответственно.
  return sc.endsWith('=') ? sc + encodeURIComponent(subUrl) : sc + subUrl;
}

type Branch = 'xray' | 'amneziawg';

export function Connect() {
  const { publicData: data, publicUser: user, goPublic, showToast } = useApp();
  const [platform, setPlatform] = useState<AppPlatform>(detectPlatform());
  const [branch, setBranch] = useState<Branch | null>(null);
  if (!data) return null;

  const allowed = (user?.allowedProtocols ?? ['xray', 'amneziawg']) as string[];
  const canXray = allowed.includes('xray');
  const canAwg = allowed.includes('amneziawg');
  // Если доступен только один протокол — развилку не показываем.
  const effBranch: Branch | null = branch ?? (canXray && canAwg ? null : canXray ? 'xray' : canAwg ? 'amneziawg' : null);

  // Продвинутый режим (по умолчанию вкл) → подписка /full: обход белых списков +
  // аварийный фоллбэк. Выключен → обычная подписка (только ссылки). Приложение тянет
  // тот же URL и обновляет маршрутизацию само.
  const subUrl = data.subLink ? (data.xrayWhitelist !== false ? `${data.subLink}/full` : data.subLink) : '';

  // Приложения, подходящие выбранному протоколу и платформе.
  const appsFor = (b: Branch) =>
    data.apps
      .filter((a) => a.enabled)
      .filter((a) => (b === 'xray' ? a.compat.includes('xray') : a.compat.includes('amneziawg') || a.compat.includes('amnezia-app')))
      .map((a) => ({ app: a, entry: a.platforms.find((p) => p.platform === platform) }))
      .filter((x): x is { app: AppClient; entry: NonNullable<typeof x.entry> } => Boolean(x.entry));

  return (
    <div className="stack" style={{ gap: 16, paddingTop: 12 }}>
      <div className="row" style={{ gap: 12 }}>
        <BackButton onClick={() => (effBranch && branch ? setBranch(null) : goPublic(user ? 'cabinet' : 'home'))} />
        <div style={{ fontSize: 22, fontWeight: 700 }}>Подключение</div>
      </div>

      {/* Шаг 1 — выбор протокола */}
      {!effBranch ? (
        <div className="stack" style={{ gap: 12 }}>
          <p className="body small" style={{ margin: 0 }}>
            Выберите способ подключения. Если не уверены — берите Xray: одна ссылка на все
            устройства, ничего настраивать не нужно.
          </p>

          {canXray ? (
            <button className="card stack" style={{ gap: 6, textAlign: 'left', cursor: 'pointer' }} onClick={() => setBranch('xray')}>
              <div className="row-between">
                <span style={{ fontWeight: 700, fontSize: 16 }}>Xray · подписка</span>
                <span className="badge">рекомендуем</span>
              </div>
              <span className="body small muted">
                Одна ссылка добавляется в приложение — конфигурации подтянутся сами и будут
                обновляться. Подходит для нескольких устройств сразу.
              </span>
            </button>
          ) : null}

          {canAwg ? (
            <button className="card stack" style={{ gap: 6, textAlign: 'left', cursor: 'pointer' }} onClick={() => setBranch('amneziawg')}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>AmneziaWG</div>
              <span className="body small muted">
                Отдельная конфигурация на каждое устройство. Выбирайте, если Xray не подходит
                или провайдер его блокирует.
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Шаг 2 — способ + приложения */}
      {effBranch ? (
        <>
          {effBranch === 'xray' ? (
            subUrl ? (
              <div className="card stack" style={{ gap: 10 }}>
                <div>
                  <div className="eyebrow" style={{ marginBottom: 4 }}>Ваша ссылка-подписка</div>
                  <div className="body small muted">
                    Добавьте её в приложение один раз. Все конфигурации появятся сами,
                    новые серверы — тоже.
                  </div>
                </div>
                <input className="input mono" readOnly value={subUrl} style={{ fontSize: 12 }} />
                <button
                  className="btn btn-primary btn-sm"
                  onClick={async () => {
                    showToast((await copyText(subUrl)) ? 'Ссылка скопирована' : 'Не удалось скопировать');
                  }}
                >
                  Копировать ссылку
                </button>
              </div>
            ) : (
              <div className="notice">
                Ссылка-подписка появится после входа в кабинет.
              </div>
            )
          ) : (
            <div className="notice">
              Для AmneziaWG конфигурация выдаётся отдельно на каждое устройство:
              откройте «Мои устройства» → «Конфиг», там будет кнопка для AmneziaVPN
              и файл .conf для приложения AmneziaWG.
            </div>
          )}

          <div>
            <div className="field-label" style={{ marginBottom: 8 }}>Ваша система</div>
            <div className="chip-row">
              {PLATFORMS.map((p) => (
                <Chip key={p} label={p} active={platform === p} size="sm" onClick={() => setPlatform(p)} />
              ))}
            </div>
          </div>

          <AppList
            items={appsFor(effBranch)}
            subUrl={effBranch === 'xray' ? subUrl : ''}
            showToast={showToast}
          />

          {effBranch === 'amneziawg' ? (
            <button className="btn btn-outline btn-block" onClick={() => goPublic('devices')}>
              К моим устройствам
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function AppList({
  items,
  subUrl,
  showToast,
}: {
  items: Array<{ app: AppClient; entry: { platform: AppPlatform; url?: string | null; downloadName?: string | null; downloadSize?: number | null } }>;
  subUrl: string;
  showToast: (t: string) => void;
}) {
  if (items.length === 0) {
    return <EmptyState title="Нет приложений для этой системы" text="Выберите другую систему выше." />;
  }
  return (
    <div className="stack" style={{ gap: 10 }}>
      {items.map(({ app, entry }) => {
        const store = entry.url ? storeOf(entry.url) : null;
        const oneTap = subUrl ? oneTapImport(app, subUrl) : null;
        return (
          <div key={app.id} className="card stack" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 12, alignItems: 'center' }}>
              {app.icon ? (
                <img
                  src={app.icon}
                  alt=""
                  width={44}
                  height={44}
                  style={{ borderRadius: 12, flex: 'none', objectFit: 'cover' }}
                />
              ) : (
                <div
                  aria-hidden
                  style={{
                    width: 44, height: 44, borderRadius: 12, flex: 'none', display: 'flex',
                    alignItems: 'center', justifyContent: 'center', background: 'var(--surface-btn-2)',
                    fontWeight: 700, fontSize: 18,
                  }}
                >
                  {app.client.slice(0, 1)}
                </div>
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{app.client}</div>
                {app.instruction ? (
                  <div className="body small muted" style={{ marginTop: 2 }}>{app.instruction}</div>
                ) : null}
              </div>
            </div>

            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {/* Скачать прямо с нашего сервера (файл залит в админке) — работает
                  даже когда офиц. сайт заблокирован в РФ. Иначе — ссылка в магазин. */}
              {entry.downloadName ? (
                <a className="btn btn-primary btn-sm" href={`/apps/file/${app.id}/${encodeURIComponent(entry.platform)}`}>
                  ⬇ Скачать{entry.downloadSize ? ` · ${mb(entry.downloadSize)}` : ''}
                </a>
              ) : entry.url ? (
                <button className="btn btn-primary btn-sm" onClick={() => openUrl(normalizeUrl(entry.url!))}>
                  {store ?? 'Установить'}
                </button>
              ) : null}
              {/* Магазин доступен и при наличии файла — для iOS и тех, кто хочет из стора. */}
              {entry.downloadName && store ? (
                <button className="btn btn-outline btn-sm" onClick={() => openUrl(normalizeUrl(entry.url!))}>
                  {store}
                </button>
              ) : null}
              {oneTap ? (
                <button className="btn btn-secondary btn-sm" onClick={() => openUrl(oneTap)}>
                  Добавить подписку
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
