// Маленькие пометки в карточках приложений (страница подключения и мастер выдачи).
import type { AppClient, AppPlatform } from '@novpn/shared';

const noteStyle = { fontSize: 12.5, lineHeight: 1.45, color: 'var(--text-muted)' } as const;

/** Приложения нет в российском App Store — ссылка на короткую инструкцию «как поставить». */
export function RegionNote() {
  return (
    <div style={noteStyle}>
      ⓘ В российском App Store его нет —{' '}
      <a href="/guide/ios-region" target="_blank" rel="noopener" style={{ color: 'var(--accent, #4c8dff)', fontWeight: 600 }}>
        как установить из России
      </a>
    </div>
  );
}

/**
 * «Безопасно» у нашего приложения: Windows (SmartScreen, антивирус) и Android (Play
 * Protect, «приложение не из магазина») пугают предупреждением любое новое приложение с
 * сайта, которое настраивает VPN, — люди думают, что это вирус, и бросают установку.
 */
export function SafeNote({ platform }: { platform: AppPlatform }) {
  const text =
    platform === 'Android'
      ? 'Android может предупредить, что приложение не из Google Play или «может быть опасным», — так он встречает любое VPN-приложение с сайта. Нажмите «Всё равно установить».'
      : 'Windows или антивирус могут предупредить — приложение новое и настраивает VPN, угрозы в этом нет. Нажмите «Подробнее» → «Выполнить в любом случае».';
  return (
    <div style={noteStyle}>
      <span style={{ color: 'var(--green, #2e9e5b)', fontWeight: 700 }}>✓ Безопасно.</span> {text}
    </div>
  );
}

/** Какие пометки нужны карточке. */
export function AppNotes({ app, entry }: { app: AppClient; entry: { platform: AppPlatform; regionNote?: boolean } }) {
  const safe = app.id.startsWith('novpn-') && (entry.platform === 'Windows' || entry.platform === 'Android');
  if (!safe && !entry.regionNote) return null;
  return (
    <>
      {safe ? <SafeNote platform={entry.platform} /> : null}
      {entry.regionNote ? <RegionNote /> : null}
    </>
  );
}
