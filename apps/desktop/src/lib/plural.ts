/* Согласование существительного с числом. Без этого получается «12 631 сайтов»
   вместо «12 631 сайт» — мелочь, по которой сразу видно небрежность. */

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/** Число с разделителями и согласованным словом: «12 631 сайт». */
export function count(n: number, one: string, few: string, many: string): string {
  return `${n.toLocaleString('ru-RU')} ${plural(n, one, few, many)}`;
}
