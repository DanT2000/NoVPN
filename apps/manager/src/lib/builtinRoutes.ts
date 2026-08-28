// Встроенные правила AutoRoute — то, что обязано быть в умном профиле независимо от
// внешних источников. Сейчас это Telegram: MTProto ходит на IP дата-центров БЕЗ DNS,
// доменные правила его не видят, а в списках источников его подсети встречаются лишь
// отдельными /32 (владелец: «Telegram через умную не работает»). Диапазоны — официальный
// https://core.telegram.org/resources/cidr.txt (стабильны годами; сам URL из России
// недоступен, поэтому зашито, а не скачивается).
import type { ParsedRule } from './routingRules.js';

export const BUILTIN_SOURCE_ID = 'rs_builtin';
export const BUILTIN_SOURCE_TITLE = 'Встроенные · Telegram (подсети дата-центров)';

export const TELEGRAM_CIDRS: string[] = [
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
];

/** Правила в порядке приоритета: подсети первыми — они и есть смысл списка. */
export function builtinRules(): ParsedRule[] {
  return [
    ...TELEGRAM_CIDRS.map((v) => ({ kind: 'ip' as const, value: v })),
    ...TELEGRAM_DOMAINS.map((v) => ({ kind: 'domain' as const, value: v })),
  ];
}
