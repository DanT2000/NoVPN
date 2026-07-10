// Генерация QR как data URL. Используется только там, где QR действительно
// поддерживается клиентом (Xray-ссылка, AmneziaWG .conf). Не показываем QR
// для того, что клиент не умеет импортировать.

import QRCode from 'qrcode';

export async function toQrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    scale: 6,
    color: { dark: '#0a0a0b', light: '#ffffff' },
  });
}
