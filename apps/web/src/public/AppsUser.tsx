import { useState } from 'react';
import type { AppClient, AppPlatform } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { BackButton, Chip, EmptyState } from '../components/ui';
import { isDataFile, dataFileName, downloadUrl, openUrl } from '../lib/clipboard';

const PLATFORMS: AppPlatform[] = ['Android', 'iOS', 'Windows', 'macOS', 'Linux'];
function detectPlatform(): AppPlatform {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/mac/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Windows';
}
const COMPAT_LABEL: Record<AppClient['compat'][number], string> = {
  xray: 'Xray',
  'amnezia-app': 'AmneziaVPN',
  amneziawg: 'AmneziaWG',
};

function normalizeUrl(u: string): string {
  const t = u.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

export function AppsUser() {
  const { data, publicUser, goPublic } = useApp();
  const [platform, setPlatform] = useState<AppPlatform>(detectPlatform());
  if (!data) return null;

  // Клиенты, у которых есть запись под выбранную платформу.
  const apps = data.apps
    .filter((a) => a.enabled)
    .map((a) => ({ app: a, entry: a.platforms.find((p) => p.platform === platform) }))
    .filter((x): x is { app: AppClient; entry: NonNullable<typeof x.entry> } => Boolean(x.entry));

  return (
    <div className="stack" style={{ gap: 14, paddingTop: 12 }}>
      <div className="row" style={{ gap: 12 }}>
        <BackButton onClick={() => goPublic(publicUser ? 'cabinet' : 'home')} />
        <div style={{ fontSize: 22, fontWeight: 700 }}>Приложения и инструкции</div>
      </div>

      <div className="chip-row">
        {PLATFORMS.map((p) => (
          <Chip key={p} label={p} active={platform === p} size="sm" onClick={() => setPlatform(p)} />
        ))}
      </div>

      {apps.length === 0 ? (
        <EmptyState title="Нет приложений для этой платформы" text="Выберите другую платформу выше." />
      ) : (
        apps.map(({ app: a, entry }) => (
          <div key={a.id} className="card">
            <div className="row" style={{ gap: 12, marginBottom: 8 }}>
              <div
                style={{
                  width: 40, height: 40, borderRadius: 'var(--r-ctrl)', background: 'var(--surface-btn-2)', overflow: 'hidden',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800,
                  color: 'var(--accent-light)', flex: 'none',
                }}
              >
                {a.icon ? (
                  <img src={a.icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  a.client.charAt(0)
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{a.client}</div>
                <div className="chip-row" style={{ marginTop: 2 }}>
                  {a.compat.map((c) => (
                    <span key={c} className="badge">{COMPAT_LABEL[c]}</span>
                  ))}
                </div>
              </div>
            </div>

            {a.instruction ? (
              <p className="small body" style={{ margin: '0 0 12px', lineHeight: 1.5 }}>
                {a.instruction}
              </p>
            ) : null}

            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {entry.url ? (
                <button className="btn btn-primary btn-sm" onClick={() => openUrl(normalizeUrl(entry.url!))}>
                  Установить / скачать
                </button>
              ) : null}
              {entry.file ? (
                <button className="btn btn-secondary btn-sm" onClick={() => downloadUrl(isDataFile(entry.file) ? dataFileName(entry.file) : 'file', entry.file!)}>
                  Скачать файл
                </button>
              ) : null}
              {a.source ? (
                <button className="btn btn-outline btn-sm" onClick={() => openUrl(normalizeUrl(a.source))}>
                  Официальный сайт
                </button>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
