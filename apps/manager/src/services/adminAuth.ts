// Пароль администратора: хранится в базе (чтобы менялся из панели), с откатом
// на переменную окружения при первом запуске.
//
// Логина нет — панель одноадминная, и лишнее поле только путает при
// самостоятельном развёртывании. По умолчанию пароль «admin»: человек
// разворачивает панель, заходит и сразу меняет его (панель об этом напоминает,
// пока пароль дефолтный).

import crypto from 'node:crypto';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db.js';

const KEY = 'adminPasswordHash';
const DEFAULT_PASSWORD = 'admin';

interface StoredHash {
  salt: string;
  hash: string;
}

function hashWith(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

/** Сохранить новый пароль администратора. */
export function setAdminPassword(password: string): void {
  const salt = crypto.randomBytes(16).toString('hex');
  setSetting(KEY, { salt, hash: hashWith(password, salt) } satisfies StoredHash);
}

/** Проверить пароль. Пока свой пароль не задан — сверяем с переменной окружения. */
export function verifyAdminPassword(password: string): boolean {
  const stored = getSetting<StoredHash | null>(KEY, null);
  if (!stored?.salt || !stored?.hash) {
    // Пароль ещё не менялся: сверяем с ADMIN_PASSWORD (по умолчанию «admin»).
    const expected = config.adminPassword || DEFAULT_PASSWORD;
    return timingSafeEqual(password, expected);
  }
  const got = hashWith(password, stored.salt);
  return timingSafeEqual(got, stored.hash);
}

/** Пароль всё ещё дефолтный? Панель показывает предупреждение, пока это так. */
export function isDefaultAdminPassword(): boolean {
  const stored = getSetting<StoredHash | null>(KEY, null);
  if (stored?.salt && stored?.hash) return false;
  return (config.adminPassword || DEFAULT_PASSWORD) === DEFAULT_PASSWORD;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
