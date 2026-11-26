// Инструкции приложений: Markdown-гайды с картинками, открываются отдельной
// красивой страницей (/guide/<appId>). Ассеты лежат в apps/web/public/guides/<id>/
// (guide.md + images/…) → Vite копирует их в dist, панель отдаёт статикой; сам
// Markdown рендерим на бэкенде (marked) и оборачиваем в самодостаточную HTML-страницу.

import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { config } from '../config.js';

/** Приложения, у которых есть гайд (id = id приложения в каталоге).
 *  mdRel — путь к Markdown относительно config.desktopDir; imgBase — публичный
 *  префикс, на который переписываются относительные пути картинок images/… */
export const GUIDES: Record<string, { title: string; mdRel?: string; md?: string; imgBase: string }> = {
  'novpn-desktop': {
    title: 'NoVPN для компьютера — инструкция',
    mdRel: 'guide/novpn-desktop-guide.md',
    imgBase: '/desktop/guide/images/',
  },
  // Короткая, без картинок — текст прямо здесь: папка канала desktop на томе засевается
  // один раз, новый файл до уже работающих панелей не дошёл бы.
  'ios-region': {
    title: 'Happ на iPhone и Mac из России',
    imgBase: '/',
    md: `# Happ на iPhone и Mac из России

В российском App Store Happ сейчас нет — его убрали. В других странах (Казахстан, США и др.) он есть.
Бета-версия через TestFlight закрыта для новых участников, поэтому самый простой путь — **сменить
страну своего Аккаунта Apple**. Это несколько минут в настройках; фото, iCloud, сообщения и уже
установленные приложения остаются.

## Перед сменой

- **Баланс аккаунта — ноль.** Потратьте остаток; если он меньше цены любой покупки — напишите в поддержку Apple.
- **Подписки.** Apple может попросить отменить мешающие подписки и дождаться конца оплаченного периода
  (по опыту весны 2026: iCloud+ смене не мешает, Apple Music — мешает).
- **Семейный доступ.** Если вы в семье, смена может быть недоступна — временно выйдите из неё.
- Дождитесь окончания предзаказов, прокатов фильмов и возвратов денег.

## Как сменить страну (iPhone)

1. **Настройки** → ваше имя → **Медиаматериалы и покупки** (на некоторых версиях iOS ещё **Просмотреть**).
2. **Страна/регион** → **Изменить страну или регион**.
3. Выберите страну (например, **Казахстан**) → **Принимаю**.
4. Способ оплаты — **Нет**, если такой вариант есть. Адрес — любой реальный адрес выбранной страны.
5. **Готово.** Вернитесь на страницу подключения и нажмите **App Store** у Happ — откроется настоящее приложение.

Если варианта «Нет» не оказалось, можно не трогать основной аккаунт: создайте отдельный Аккаунт Apple
нужной страны и войдите им **только в App Store** (Настройки → ваше имя → Медиаматериалы и покупки →
Выйти → войти другим). iCloud, фото и сообщения останутся на основном.

## Потом

Страну можно вернуть обратно тем же путём, с теми же условиями. Установленный Happ продолжит работать;
обновлять его из App Store получится, пока аккаунт в стране, где он есть.

Официальная инструкция Apple: [Изменение страны или региона Аккаунта Apple](https://support.apple.com/ru-ru/118283).
`,
  },
};

export const hasGuide = (appId: string): boolean => Object.prototype.hasOwnProperty.call(GUIDES, appId);

const esc = (s: string): string =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

/** Слаг заголовка для якорей оглавления (совместим с GitHub-стилем ссылок в гайде). */
function slug(inner: string): string {
  return inner
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z0-9#]+;/gi, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .replace(/\s+/g, '-');
}

/** Отрендерить страницу инструкции. null → гайда нет или файл не найден. */
export function renderGuidePage(appId: string): string | null {
  if (!hasGuide(appId)) return null;
  const g = GUIDES[appId]!;
  let md: string;
  if (g.md != null) {
    md = g.md;
  } else {
    try {
      md = fs.readFileSync(path.join(config.desktopDir, g.mdRel ?? ''), 'utf8');
    } catch {
      return null;
    }
  }
  // Относительные пути картинок images/… → публичный путь статики канала desktop.
  // imgBase уже заканчивается на «/», а закрывающая кавычка берётся из исходного тега —
  // добавлять свою НЕЛЬЗЯ (иначе src="…/"01.png" рвётся). Покрываем HTML <img src="…">
  // и markdown ![](…).
  md = md.replace(/src="images\//g, `src="${g.imgBase}`).replace(/\]\(images\//g, `](${g.imgBase}`);
  let body = marked.parse(md, { async: false, gfm: true }) as string;
  // Проставить id заголовкам (для якорей оглавления).
  body = body.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, lvl, inner) => `<h${lvl} id="${esc(slug(inner))}">${inner}</h${lvl}>`);
  return wrap(GUIDES[appId]!.title, body);
}

function wrap(title: string, body: string): string {
  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--tx:#e8eaed;--mut:#9aa1ad;--acc:#4c8dff;--bd:#272c36;--code:#1e222b}
  @media (prefers-color-scheme: light){:root{--bg:#f4f5f7;--card:#fff;--tx:#14161a;--mut:#5b6470;--bd:#e2e5ea;--code:#f0f2f5}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
       font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);
       backdrop-filter:blur(8px);border-bottom:1px solid var(--bd);padding:12px 16px}
  .top a{color:var(--acc);text-decoration:none;font-size:14px;font-weight:600}
  .wrap{max-width:760px;margin:0 auto;padding:24px 20px 64px}
  h1{font-size:28px;line-height:1.25;margin:8px 0 20px}
  h2{font-size:22px;margin:34px 0 12px;padding-top:8px;border-top:1px solid var(--bd)}
  h3{font-size:18px;margin:22px 0 8px}
  p{margin:12px 0}
  a{color:var(--acc)}
  ul,ol{margin:12px 0;padding-left:24px}
  li{margin:6px 0}
  img{max-width:100%;height:auto;border-radius:12px;border:1px solid var(--bd)}
  p[align="center"]{text-align:center}
  blockquote{margin:16px 0;padding:12px 16px;border-left:3px solid var(--acc);
             background:var(--card);border-radius:0 10px 10px 0;color:var(--mut)}
  blockquote p{margin:6px 0}
  blockquote strong{color:var(--tx)}
  code{background:var(--code);padding:2px 6px;border-radius:6px;font-size:.9em;
       font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  table{border-collapse:collapse;width:100%;margin:16px 0;font-size:15px;display:block;overflow-x:auto}
  th,td{border:1px solid var(--bd);padding:9px 12px;text-align:left;vertical-align:top}
  th{background:var(--card);font-weight:600}
  hr{border:0;border-top:1px solid var(--bd);margin:28px 0}
  sub{color:var(--mut)}
  h2:first-of-type{border-top:0}
</style></head><body>
<div class="top"><a href="javascript:history.length>1?history.back():window.close()">‹ Назад</a></div>
<div class="wrap">
${body}
</div>
</body></html>`;
}
