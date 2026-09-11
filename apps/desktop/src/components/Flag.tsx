/* Флаг страны картинкой. На компьютере эмодзи-флаги не рисуются (Windows
   показывает две буквы вместо флага), поэтому подгружаем настоящие SVG из
   src/assets/flags и показываем их. Набор — flag-icons (MIT), лежит в сборке,
   работает офлайн. Имя сервера превращаем в ISO-код (lib/flag.isoOf). */

import { bareName, isoOf, leadingEmoji } from '../lib/flag';

// Vite соберёт все флаги и отдаст их URL'ы (по одному разбору для всего набора).
const FLAG_URLS = import.meta.glob('../assets/flags/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function urlFor(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const key = `../assets/flags/${iso.toLowerCase()}.svg`;
  return FLAG_URLS[key];
}

/** Только картинка флага (или ничего, если страна не распознана). */
export function Flag({ name, height = 13 }: { name: string; height?: number }) {
  const url = urlFor(isoOf(name));
  if (!url) return null;
  return (
    <img
      src={url}
      alt=""
      height={height}
      style={{
        // Флаги 4:3, ширина считается по высоте.
        width: Math.round((height * 4) / 3),
        borderRadius: 2,
        flex: 'none',
        verticalAlign: 'middle',
        // Тонкая рамка, чтобы белые флаги не сливались с фоном.
        boxShadow: '0 0 0 0.5px rgba(0,0,0,0.25)',
      }}
    />
  );
}

/** Флаг + имя сервера (без ведущего эмодзи-флага) в одну строку. Если страны у
    сервера нет, но админ задал свой значок (например 🏠 у HomeVPN), показываем
    этот значок вместо флага — он и есть опознавательный знак сервера. */
export function FlagName({ name, height = 13, gap = 7 }: { name: string; height?: number; gap?: number }) {
  const url = urlFor(isoOf(name));
  const bare = bareName(name);
  const emoji = url ? '' : leadingEmoji(name);
  if (!url && !emoji) return <>{bare}</>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap }}>
      {url ? (
        <Flag name={name} height={height} />
      ) : (
        <span style={{ fontSize: height + 2, lineHeight: 1, flex: 'none' }}>{emoji}</span>
      )}
      {bare}
    </span>
  );
}
