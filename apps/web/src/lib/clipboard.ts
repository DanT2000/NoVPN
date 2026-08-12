// Копирование / скачивание / шаринг. Возвращают статус для тостов.

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Файлы как data URL (переживают редеплой — хранятся в БД) ---------------
// В data URL зашиваем имя файла: data:<mime>;name=<enc>;base64,<...>

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Не удалось прочитать файл'));
    r.readAsDataURL(file);
  });
}

export function dataUrlWithName(dataUrl: string, name: string): string {
  const i = dataUrl.indexOf(';base64,');
  if (i < 0) return dataUrl;
  return dataUrl.slice(0, i) + ';name=' + encodeURIComponent(name) + dataUrl.slice(i);
}

export function isDataFile(s: string | null | undefined): s is string {
  return !!s && s.startsWith('data:');
}

export function dataFileName(s: string | null | undefined): string {
  if (!s) return '';
  if (!s.startsWith('data:')) return s; // старое поведение — просто имя файла
  const m = s.match(/;name=([^;,]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : 'файл';
}

export function dataFileSizeKb(s: string): number {
  const i = s.indexOf(';base64,');
  if (i < 0) return 0;
  return Math.round(((s.length - i - 8) * 3) / 4 / 1024);
}

export function downloadUrl(filename: string, url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** Дописать https://, если у ссылки нет схемы (админ мог ввести «example.com»).
 *  Без этого openUrl уходит на относительный путь вместо сайта. */
export function normalizeUrl(u: string): string {
  const t = u.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

export function openUrl(url: string): void {
  // http(s) — обычная вкладка. Кастомные схемы (vpn://, happ://, v2raytun://…)
  // через window.open('_blank') НЕ открывают приложение: браузер молча создаёт
  // пустую вкладку. Навигация в текущем окне отдаёт ссылку ОС, и она запускает
  // установленное приложение (Android BROWSABLE-intent, Windows scheme-handler).
  if (/^https?:\/\//i.test(url)) {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else {
    window.location.href = url;
  }
}

/** true — поделились нативно; false — Web Share недоступен (нужен fallback-copy). */
export async function shareText(text: string): Promise<boolean> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
