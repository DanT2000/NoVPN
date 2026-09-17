// Валидация числовых лимитов и срока действия пользователя из админ-формы.
//
// Без неё было два дефекта: (1) нечисловые deviceLimit/trafficLimitGb уходили прямо в
// better-sqlite3 и роняли запрос TypeError'ом → 500 вместо понятного 400; (2) мусор в
// expiresAt («garbage») давал `new Date(x) < new Date()` == `NaN < number` == false —
// то есть срок ТИХО переставал действовать (пользователь становился бессрочным).

export type NormResult<T> = { ok: true; value: T } | { ok: false };

/** Целочисленный лимит ≥ 0 или null (deviceLimit). Пустое/none → null. */
export function normCount(v: unknown): NormResult<number | null> {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return { ok: false };
  return { ok: true, value: n };
}

/** Числовой лимит ≥ 0 или null (trafficLimitGb — допускаем дробное число ГБ). */
export function normGb(v: unknown): NormResult<number | null> {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/** Срок действия: реальная дата (нормализуем в ISO) или null. Мусор → ok:false. */
export function normExpiry(v: unknown): NormResult<string | null> {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false };
  const t = Date.parse(v);
  if (Number.isNaN(t)) return { ok: false };
  return { ok: true, value: new Date(t).toISOString() };
}
