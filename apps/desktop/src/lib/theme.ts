/* Применение темы.

   Три режима: 'system' следует за настройкой ОС (и меняется вживую, если
   человек переключит тему системы), 'dark'/'light' — принудительно. Атрибут
   data-theme на <html> переключает палитру в theme.css.

   Последнюю применённую палитру кэшируем в localStorage и ставим ещё до первого
   кадра — иначе на запуске мигало бы тёмным поверх светлого, пока грузится
   сохранённое состояние с диска. */

export type Theme = 'system' | 'dark' | 'light';

const CACHE_KEY = 'novpn-effective-theme';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function effective(theme: Theme): 'dark' | 'light' {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return theme;
}

function paint(mode: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', mode);
  try {
    localStorage.setItem(CACHE_KEY, mode);
  } catch {
    /* приватный режим — не критично */
  }
}

/** Ставит тему до первого рендера по кэшу, чтобы не было вспышки. */
export function applyCachedTheme() {
  // Dev-параметр ?theme= имеет приоритет — чтобы снимки были детерминированы.
  const forced = new URLSearchParams(location.search).get('theme');
  if (forced === 'light' || forced === 'dark') {
    document.documentElement.setAttribute('data-theme', forced);
    return;
  }
  let mode: 'dark' | 'light';
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    mode = cached === 'light' || cached === 'dark' ? cached : systemPrefersDark() ? 'dark' : 'light';
  } catch {
    mode = systemPrefersDark() ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', mode);
}

let mediaCleanup: (() => void) | null = null;

/** Применяет выбранную тему и, для 'system', следит за сменой темы ОС. */
export function applyTheme(theme: Theme) {
  if (mediaCleanup) {
    mediaCleanup();
    mediaCleanup = null;
  }
  paint(effective(theme));

  if (theme === 'system' && typeof window !== 'undefined') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => paint(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    mediaCleanup = () => mq.removeEventListener('change', onChange);
  }
}
