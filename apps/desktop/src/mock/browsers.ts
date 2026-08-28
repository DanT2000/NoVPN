/* Браузеры, найденные на компьютере. Заглушка: настоящее определение — работа
   оболочки, а не интерфейса. */

export interface BrowserInfo {
  id: string;
  name: string;
  color: string;
  found: boolean;
  installed: boolean;
  /** Страница расширения в магазине браузера. */
  store: string;
}

export const BROWSERS: BrowserInfo[] = [
  { id: 'chrome', name: 'Chrome', color: '#4285F4', found: true, installed: false, store: 'https://chromewebstore.google.com/' },
  { id: 'edge', name: 'Edge', color: '#0F8FE9', found: true, installed: false, store: 'https://microsoftedge.microsoft.com/addons' },
  { id: 'yandex', name: 'Яндекс Браузер', color: '#FC3F1D', found: true, installed: false, store: 'https://chromewebstore.google.com/' },
  { id: 'firefox', name: 'Firefox', color: '#FF7139', found: false, installed: false, store: 'https://addons.mozilla.org/' },
];
