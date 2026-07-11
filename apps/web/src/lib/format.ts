// Форматирование дат/чисел. Выводы совпадают с дизайн-компонентом.

export const DAY_MS = 86400000;

/** Русская плюрализация: plural(n, 'день','дня','дней'). */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/** «12,5 ГБ» / «45 МБ» / «∞». До 0.1 ГБ (~100 МБ) показываем в МБ, дальше в ГБ. */
export function gb(n: number | null | undefined): string {
  if (n == null) return '∞';
  if (n <= 0) return '0 МБ';
  if (n < 0.1) {
    const mb = n * 1024;
    const v = mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10;
    return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
  }
  return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ГБ`;
}

/** ru-RU «d MMM yyyy» без завершающего «г.». */
export function dateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return s.replace(/\s*г\.?$/, '');
}

/** ru-RU «d MMMM yyyy» (полный месяц) — для сообщений/сроков. */
export function dateLong(iso: string | null | undefined): string {
  if (!iso) return 'бессрочно';
  return new Date(iso)
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    .replace(/\s*г\.?$/, '');
}

/** «только что / N мин назад / N ч назад / N дн назад / {дата}» / «никогда». */
export function rel(iso: string | null | undefined): string {
  if (!iso) return 'никогда';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} дн назад`;
  return dateShort(iso);
}

/** Дней до даты (может быть отрицательным). null — если бессрочно. */
export function daysLeft(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / DAY_MS);
}
