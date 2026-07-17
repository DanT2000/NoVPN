// Защита входа по коду от перебора.
//
// Зачем: код — 6 цифр, это миллион вариантов. Без ограничения попыток при
// десятке активных кодов перебор находит рабочий примерно за час. Лимит
// превращает этот час в годы: 20 попыток/час с адреса → ~5 лет на 6 цифр.
//
// Счётчики в памяти: панель живёт одним процессом, а переживать перезапуск
// им не нужно — атака идёт минутами, а не неделями.

import * as repo from '../repo.js';

interface Bucket {
  fails: number;
  /** Время, до которого адрес заблокирован (мс epoch). */
  blockedUntil: number;
  /** Когда счётчик последний раз трогали — для уборки мусора. */
  seenAt: number;
}

const byIp = new Map<string, Bucket>();

/** Глобальный счётчик: ловит распределённый перебор, когда каждый адрес
 *  сам по себе ниже лимита. Скользящее окно в час. */
const globalFails: number[] = [];

const HOUR = 3600_000;

function settings(): { attempts: number; cooldownMin: number } {
  const s = repo.getSettings();
  // Разумные границы: настройка не должна случайно отключить защиту.
  const attempts = Math.min(Math.max(Number(s?.codeAttempts ?? 5), 1), 50);
  const cooldownMin = Math.min(Math.max(Number(s?.codeCooldownMin ?? 15), 1), 24 * 60);
  return { attempts, cooldownMin };
}

function bucket(ip: string): Bucket {
  let b = byIp.get(ip);
  if (!b) {
    b = { fails: 0, blockedUntil: 0, seenAt: Date.now() };
    byIp.set(ip, b);
  }
  return b;
}

/** Периодическая уборка: не держим в памяти тех, кто давно не заходил. */
function sweep(now: number): void {
  if (byIp.size < 1000) return;
  for (const [ip, b] of byIp) if (now - b.seenAt > 6 * HOUR) byIp.delete(ip);
}

export interface GuardVerdict {
  allowed: boolean;
  /** Сколько ещё ждать, секунд (для сообщения пользователю). */
  retryAfterSec?: number;
  message?: string;
}

/** Можно ли этому адресу пробовать код прямо сейчас? */
export function checkAllowed(ip: string): GuardVerdict {
  const now = Date.now();
  sweep(now);
  const b = bucket(ip);
  if (b.blockedUntil > now) {
    const sec = Math.ceil((b.blockedUntil - now) / 1000);
    return {
      allowed: false,
      retryAfterSec: sec,
      message: `Слишком много попыток. Попробуйте через ${Math.ceil(sec / 60)} мин.`,
    };
  }
  return { allowed: true };
}

/** Учесть неудачную попытку. Возвращает вердикт уже с учётом этой попытки. */
export function noteFailure(ip: string): GuardVerdict {
  const now = Date.now();
  const { attempts, cooldownMin } = settings();
  const b = bucket(ip);
  b.seenAt = now;
  b.fails += 1;

  while (globalFails.length && now - globalFails[0]! > HOUR) globalFails.shift();
  globalFails.push(now);

  if (b.fails >= attempts) {
    b.blockedUntil = now + cooldownMin * 60_000;
    b.fails = 0;
    repo.addLog(`Вход по коду заблокирован для ${ip}: ${attempts} неудачных попыток подряд`);
    return {
      allowed: false,
      retryAfterSec: cooldownMin * 60,
      message: `Слишком много попыток. Попробуйте через ${cooldownMin} мин.`,
    };
  }
  return { allowed: true };
}

/** Успешный вход — счётчик адреса обнуляем. */
export function noteSuccess(ip: string): void {
  byIp.delete(ip);
}

/** Сколько неудачных попыток по всей панели за последний час.
 *  Нужно для тревоги администратору: всплеск = кто-то перебирает. */
export function globalFailsLastHour(): number {
  const now = Date.now();
  while (globalFails.length && now - globalFails[0]! > HOUR) globalFails.shift();
  return globalFails.length;
}

/** Только для тестов. */
export function resetGuard(): void {
  byIp.clear();
  globalFails.length = 0;
}
