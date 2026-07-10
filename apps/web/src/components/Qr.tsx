// QR-картинка. Показываем только там, где клиент реально умеет импортировать
// содержимое (Xray-ссылка, AmneziaWG .conf).

import { useEffect, useState } from 'react';
import { toQrDataUrl } from '../lib/qrcode';

export function Qr({ text, size = 196, caption }: { text: string; size?: number; caption?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setError(false);
    toQrDataUrl(text)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [text]);

  return (
    <div className="stack" style={{ alignItems: 'center', gap: 8 }}>
      <div
        style={{
          width: size, height: size, background: '#fff', borderRadius: 'var(--r-card)', padding: 12,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {error ? (
          <span className="small" style={{ color: '#0a0a0b' }}>QR недоступен</span>
        ) : url ? (
          <img src={url} alt="QR-код конфигурации" width={size - 24} height={size - 24} />
        ) : (
          <span className="spinner" style={{ borderTopColor: '#0a0a0b' }} />
        )}
      </div>
      {caption ? <span className="small muted">{caption}</span> : null}
    </div>
  );
}
