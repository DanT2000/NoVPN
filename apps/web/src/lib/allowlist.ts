// Списки адресов (тест скорости, защита SSH): только IPv4 или подсеть — как проверяет сервер.
export const isAllowEntry = (v: string): boolean => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(v.trim());
  return !!m && [m[1], m[2], m[3], m[4]].every((o) => Number(o) <= 255) && (m[5] === undefined || Number(m[5]) <= 32);
};

/** «1.2.3.4, 5.6.7.0/24» / через пробелы или переводы строк → список. */
export const parseAllowList = (raw: string): string[] => raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
