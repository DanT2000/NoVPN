// Встроенные правила AutoRoute — то, что обязано быть в умном профиле независимо от
// внешних источников. Сейчас это Telegram: MTProto ходит на IP дата-центров БЕЗ DNS,
// доменные правила его не видят, а в списках источников его подсети встречаются лишь
// отдельными /32 (владелец: «Telegram через умную не работает»).
//
// Основа — официальный https://core.telegram.org/resources/cidr.txt (сам URL из России
// недоступен, поэтому зашит, а не скачивается). Но официальным списком дело не
// исчерпывается: часть боевых сетей мессенджера в нём отсутствует, и на них Telegram
// работал «через раз». Каждый диапазон ниже сверен по RIPE RDAP — источник и дата в
// комментарии. Автообновление поверх этого делают источники «Telegram · подсети»
// (см. сидирование в db.ts): туда попадает то, что появится позже.
import type { ParsedRule } from './routingRules.js';

export const BUILTIN_SOURCE_ID = 'rs_builtin';
export const BUILTIN_SOURCE_TITLE = 'Встроенные · Telegram (подсети дата-центров)';

export const TELEGRAM_CIDRS: string[] = [
  // Официальный cidr.txt (сверено 28.08.2026).
  '91.105.192.0/23',
  '91.108.4.0/22',
  '91.108.8.0/22',
  '91.108.12.0/22',
  '91.108.16.0/22',
  '91.108.20.0/22',
  '91.108.56.0/22',
  '149.154.160.0/20',
  '185.76.151.0/24',
  '2001:67c:4e8::/48',
  '2001:b28:f23c::/48',
  '2001:b28:f23d::/48',
  '2001:b28:f23f::/48',
  '2a0a:f280::/32',
  // В официальном списке ИХ НЕТ, а трафик туда идёт. RDAP RIPE, 28.08.2026:
  // 5.28.192.0/18 — TELEGRAM-MESSENGER-INFRA-NET (проверены все /21 внутри диапазона);
  '5.28.192.0/18',
  // 95.161.64.0/20 — TM-SUBNETS, те же контакты (TMI12-RIPE, ND2624-RIPE), что и у
  // 91.108.4.0/22 «Telegram_Messenger_Network»; подтверждается и данными AS62041.
  '95.161.64.0/20',
];

export const TELEGRAM_DOMAINS: string[] = [
  'telegram.org',
  'telegram.me',
  't.me',
  'telesco.pe',
  'tdesktop.com',
  'telegram.dog',
  'telegra.ph',
  'tg.dev',
  'tx.me',
  'cdn-telegram.org',
  'comments.app',
  'graph.org',
  'contest.com',
  'usercontent.dev',
  // Когда до дата-центров не достучаться напрямую, клиент ищет их адреса через
  // DoH-резолверы — это его штатный обход блокировки (ConnectionsManager.java:
  // dns.google.com/resolve, mozilla.cloudflare-dns.com/dns-query, плюс Firebase).
  // Если эти запросы идут мимо туннеля и блокируются, приложение не может
  // восстановиться — ровно то самое «Telegram работает через раз».
  // cloudflare-dns.com уже приходит из базы AutoRoute и покрывает mozilla-поддомен.
  'dns.google.com',
  'dns.google',
  'firebaseremoteconfig.googleapis.com',
];

/** ChatGPT/OpenAI: домены, которых нет ни в одном внешнем списке, а без них сервис
 *  ведёт себя так, будто «у вас другой IP». Основные (`openai.com`, `chatgpt.com`)
 *  приходят из базы и покрывают поддомены суффиксом — здесь только пробелы.
 *  `challenges.cloudflare.com` СЮДА НЕ ДОБАВЛЕН намеренно: он общий для тысяч сайтов,
 *  и завернув его в туннель, мы сломали бы проверку у российских сайтов, которые идут
 *  напрямую (их капча решалась бы с зарубежного адреса). */
export const OPENAI_DOMAINS: string[] = [
  'openai.org',
  'featuregates.org',
  'statsigapi.net',
];

/** Правила в порядке приоритета: подсети первыми — они и есть смысл списка. */
export function builtinRules(): ParsedRule[] {
  return [
    ...TELEGRAM_CIDRS.map((v) => ({ kind: 'ip' as const, value: v })),
    ...TELEGRAM_DOMAINS.map((v) => ({ kind: 'domain' as const, value: v })),
    ...OPENAI_DOMAINS.map((v) => ({ kind: 'domain' as const, value: v })),
  ];
}
