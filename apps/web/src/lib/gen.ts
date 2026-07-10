// Клиентские генераторы/форматтеры. Код предлагается на клиенте (превью),
// но уникальность подтверждает backend. buildMessage — чистое форматирование.

import type { User } from '@novpn/shared';
import { dateLong } from './format';

/** Шестизначный код, не входящий в existing. */
export function genCode(existing?: string[]): string {
  let c: string;
  do {
    c = String(Math.floor(100000 + Math.random() * 900000));
  } while (existing && existing.includes(c));
  return c;
}

export function genUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Подстановка {code} {url} {expires} в шаблон сообщения. */
export function buildMessage(template: string, user: Pick<User, 'code' | 'expiresAt'>, url: string): string {
  const expires = user.expiresAt ? dateLong(user.expiresAt) : 'бессрочно';
  return template.replaceAll('{code}', user.code).replaceAll('{url}', url).replaceAll('{expires}', expires);
}

export function isValidCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}
