/* Узнаваемые логотипы браузеров как inline SVG (data URI): без сетевых запросов и
   без внешних файлов. Раньше в интерфейсе была буква в цветном кружке — владелец
   просил настоящие значки. Формы упрощены до узнаваемого силуэта бренда. */

const uri = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

// Chrome: три сектора вокруг синего ядра.
const chrome = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 6a18 18 0 0 1 15.6 9H24a9 9 0 0 0-8.4 5.7L9.1 12.9A18 18 0 0 1 24 6z"/><path fill="#34A853" d="M39.6 15A18 18 0 0 1 24 42l7.8-13.5A9 9 0 0 0 33.6 15z"/><path fill="#FBBC05" d="M24 42A18 18 0 0 1 9.1 12.9l6.5 11.8A9 9 0 0 0 24 33z"/><circle cx="24" cy="24" r="8" fill="#fff"/><circle cx="24" cy="24" r="6" fill="#4285F4"/></svg>`;

// Edge: волна.
const edge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="#1CA0DA" d="M41 27c0 8-8 15-17 15-11 0-18-8-16-18 1 4 5 8 11 8 7 0 11-4 13-9 5-1 9 0 9 4z"/><path fill="#33B0C9" d="M8 22C10 12 17 6 25 6c8 0 13 5 14 12-3-3-7-4-11-3-7 2-11 8-11 15-5-2-8-4-9-8z"/></svg>`;

// Yandex: красный круг с буквой Я.
const yandex = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="19" fill="#FC3F1D"/><path fill="#fff" d="M27 13h-4c-4 0-7 3-7 7 0 3 1 5 4 6l-5 9h4l5-9h1v9h3zm-3 3v7h-1c-2 0-3-2-3-4s1-3 4-3z"/></svg>`;

// Firefox: огненный круг.
const firefox = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="26" r="17" fill="#FF9500"/><path fill="#FFCB00" d="M24 8c9 0 16 7 16 16 0 2-1 4-2 5 0-5-4-9-9-9-6 0-10 4-10 10 0 4 3 8 7 9-9 0-16-8-15-17C12 16 17 8 24 8z"/><circle cx="26" cy="25" r="7" fill="#FF5C00"/></svg>`;

export const BROWSER_ICON: Record<string, string> = {
  chrome: uri(chrome),
  edge: uri(edge),
  yandex: uri(yandex),
  firefox: uri(firefox),
};
