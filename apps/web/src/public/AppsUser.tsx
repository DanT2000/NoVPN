import { useState } from 'react';
import type { AppClient } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { BackButton, Chip, EmptyState } from '../components/ui';

const PLATFORMS = ['Android', 'iOS', 'Windows', 'macOS', 'Linux'] as const;
type Platform = (typeof PLATFORMS)[number];
function detectPlatform(): Platform {
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

export function AppsUser() {
  const { data, publicUser, goPublic, showToast } = useApp();
  const [platform, setPlatform] = useState<Platform>(detectPlatform());
  if (!data) return null;

  const apps = data.apps.filter((a) => a.enabled && a.platform === platform);

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
        apps.map((a) => (
          <div key={a.id} className="card">
            <div className="row" style={{ gap: 12, marginBottom: 8 }}>
              <div
                style={{
                  width: 38, height: 38, borderRadius: 'var(--r-ctrl)', background: 'var(--surface-btn-2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800,
                  color: 'var(--accent-light)', flex: 'none',
                }}
              >
                {a.client.charAt(0)}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{a.client}</div>
                <div className="small muted">
                  {a.platform} · v{a.version}
                </div>
              </div>
            </div>

            <div className="chip-row" style={{ marginBottom: 8 }}>
              {a.compat.map((c) => (
                <span key={c} className="badge">
                  {COMPAT_LABEL[c]}
                </span>
              ))}
            </div>

            <p className="small body" style={{ margin: '0 0 12px', lineHeight: 1.5 }}>
              {a.instruction}
            </p>

            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-outline btn-sm" onClick={() => showToast(`Ссылка: ${a.source}`)}>
                Официальный сайт
              </button>
              {a.store ? (
                <button className="btn btn-outline btn-sm" onClick={() => showToast(`Открыть ${a.store}`)}>
                  {a.store}
                </button>
              ) : null}
              {a.localFile ? (
                <button className="btn btn-secondary btn-sm" onClick={() => showToast(`Файл ${a.localFile} пока недоступен`)}>
                  Скачать {a.localFile}
                </button>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
