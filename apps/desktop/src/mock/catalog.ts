/* Справочник известных сервисов: человеческое название, домен, фирменный цвет.
   Нужен для двух вещей — узнаваемые значки в списках и подсказки при добавлении
   сайта, чтобы не заставлять человека вспоминать домен.

   Настоящие фавиконки сюда не тянем: сайты из этого списка ровно те, которые
   без VPN и не открываются, — значок бы не загрузился именно тогда, когда он
   нужнее всего. Поэтому цвет и буква зашиты в приложение и работают офлайн. */

export interface Service {
  name: string;
  domain: string;
  /** Фирменный цвет. Идёт и на подложку (приглушённо), и на букву. */
  color: string;
  /** Если первая буква названия не годится — например, кириллица у «Госуслуг». */
  letter?: string;
}

export const CATALOG: Service[] = [
  { name: 'YouTube', domain: 'youtube.com', color: '#FF3B30' },
  { name: 'ChatGPT', domain: 'chatgpt.com', color: '#10A37F' },
  { name: 'Claude', domain: 'claude.ai', color: '#D97757' },
  { name: 'OpenAI', domain: 'openai.com', color: '#10A37F' },
  { name: 'Codex', domain: 'codex.openai.com', color: '#10A37F' },
  { name: 'Gemini', domain: 'gemini.google.com', color: '#4285F4' },
  { name: 'GitHub', domain: 'github.com', color: '#A6B0BF' },
  { name: 'Instagram', domain: 'instagram.com', color: '#E4405F' },
  { name: 'Facebook', domain: 'facebook.com', color: '#1877F2' },
  { name: 'X', domain: 'x.com', color: '#9AA4AF' },
  { name: 'Telegram', domain: 'telegram.org', color: '#2AABEE' },
  { name: 'Discord', domain: 'discord.com', color: '#5865F2' },
  { name: 'Twitch', domain: 'twitch.tv', color: '#9146FF' },
  { name: 'Netflix', domain: 'netflix.com', color: '#E50914' },
  { name: 'Spotify', domain: 'spotify.com', color: '#1DB954' },
  { name: 'Reddit', domain: 'reddit.com', color: '#FF4500' },
  { name: 'TikTok', domain: 'tiktok.com', color: '#25F4EE' },
  { name: 'LinkedIn', domain: 'linkedin.com', color: '#0A66C2' },
  { name: 'Steam', domain: 'steampowered.com', color: '#66C0F4' },
  { name: 'Notion', domain: 'notion.so', color: '#B9BDC4' },
  { name: 'Figma', domain: 'figma.com', color: '#F24E1E' },
  { name: 'Docker', domain: 'docker.com', color: '#2496ED' },
  { name: 'npm', domain: 'npmjs.com', color: '#CB3837' },
  { name: 'Cloudflare', domain: 'cloudflare.com', color: '#F38020' },
  { name: 'Медиум', domain: 'medium.com', color: '#C7CCD4', letter: 'M' },
  { name: 'Госуслуги', domain: 'gosuslugi.ru', color: '#3D7BFF', letter: 'Г' },
  { name: 'Сбербанк', domain: 'sberbank.ru', color: '#21A038', letter: 'С' },
  { name: 'Тинькофф', domain: 'tbank.ru', color: '#FFDD2D', letter: 'Т' },
  { name: 'Альфа-Банк', domain: 'alfabank.ru', color: '#EF3124', letter: 'А' },
  { name: 'Яндекс', domain: 'ya.ru', color: '#FC3F1D', letter: 'Я' },
  { name: 'ВКонтакте', domain: 'vk.com', color: '#3D8BFF', letter: 'В' },
  { name: 'Авито', domain: 'avito.ru', color: '#97CF26', letter: 'А' },
  { name: 'Ozon', domain: 'ozon.ru', color: '#3D7BFF' },
  { name: 'Wildberries', domain: 'wildberries.ru', color: '#CB11AB' },
  { name: '2ГИС', domain: '2gis.ru', color: '#19AA1E', letter: '2' },
  { name: 'Аэрофлот', domain: 'aeroflot.ru', color: '#3DA5DC', letter: 'А' },
];

const BY_DOMAIN = new Map(CATALOG.map((s) => [s.domain, s]));

/** Ищем сервис по домену, поднимаясь к корневому: `m.youtube.com` → YouTube. */
export function lookup(domain: string): Service | undefined {
  const d = domain.toLowerCase();
  const exact = BY_DOMAIN.get(d);
  if (exact) return exact;
  const parts = d.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const found = BY_DOMAIN.get(parts.slice(i).join('.'));
    if (found) return found;
  }
  return CATALOG.find((s) => d.endsWith('.' + s.domain));
}

/** Подсказки при вводе: и по названию, и по домену. */
export function search(q: string, limit = 6): Service[] {
  const v = q.trim().toLowerCase();
  if (!v) return [];
  return CATALOG.filter((s) => s.name.toLowerCase().includes(v) || s.domain.includes(v)).slice(0, limit);
}

/** Цвет для того, чего нет в справочнике: стабильный, но не случайный на вид. */
const FALLBACK = ['#7E9CD8', '#8FB58A', '#C9A227', '#B98AC9', '#5FA8A0', '#C98A8A'];

export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

/** Домен известного приложения по его названию — для проверки конфликтов
    «приложение напрямую, а его сайт через VPN». */
export function domainForApp(appName: string): string | undefined {
  const n = appName.trim().toLowerCase();
  if (n.length < 3) return undefined; // «X», «vk» и т.п. — слишком коротко для надёжного совпадения
  // Совпадение по границе слова, а не по любой подстроке: иначе «Notion Helper»
  // или случайное вхождение давали бы ложный конфликт.
  const hit = CATALOG.find((c) => {
    const name = c.name.toLowerCase();
    if (name.length < 3) return false;
    return n === name || n.startsWith(name + ' ') || n.endsWith(' ' + name) || n.includes(' ' + name + ' ');
  });
  return hit?.domain;
}
