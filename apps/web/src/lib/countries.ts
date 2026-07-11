// Список стран с флагами-эмодзи для выбора страны сервера.
// Значение поля country хранится как «🇫🇮 Финляндия» — флаг + название.

export interface Country {
  code: string;
  name: string;
  flag: string;
}

export const COUNTRIES: Country[] = [
  { code: 'FI', name: 'Финляндия', flag: '🇫🇮' },
  { code: 'NL', name: 'Нидерланды', flag: '🇳🇱' },
  { code: 'DE', name: 'Германия', flag: '🇩🇪' },
  { code: 'FR', name: 'Франция', flag: '🇫🇷' },
  { code: 'SE', name: 'Швеция', flag: '🇸🇪' },
  { code: 'GB', name: 'Великобритания', flag: '🇬🇧' },
  { code: 'US', name: 'США', flag: '🇺🇸' },
  { code: 'CA', name: 'Канада', flag: '🇨🇦' },
  { code: 'NO', name: 'Норвегия', flag: '🇳🇴' },
  { code: 'PL', name: 'Польша', flag: '🇵🇱' },
  { code: 'LT', name: 'Литва', flag: '🇱🇹' },
  { code: 'LV', name: 'Латвия', flag: '🇱🇻' },
  { code: 'EE', name: 'Эстония', flag: '🇪🇪' },
  { code: 'CH', name: 'Швейцария', flag: '🇨🇭' },
  { code: 'AT', name: 'Австрия', flag: '🇦🇹' },
  { code: 'CZ', name: 'Чехия', flag: '🇨🇿' },
  { code: 'ES', name: 'Испания', flag: '🇪🇸' },
  { code: 'IT', name: 'Италия', flag: '🇮🇹' },
  { code: 'RO', name: 'Румыния', flag: '🇷🇴' },
  { code: 'BG', name: 'Болгария', flag: '🇧🇬' },
  { code: 'MD', name: 'Молдова', flag: '🇲🇩' },
  { code: 'UA', name: 'Украина', flag: '🇺🇦' },
  { code: 'KZ', name: 'Казахстан', flag: '🇰🇿' },
  { code: 'TR', name: 'Турция', flag: '🇹🇷' },
  { code: 'AE', name: 'ОАЭ', flag: '🇦🇪' },
  { code: 'RU', name: 'Россия', flag: '🇷🇺' },
  { code: 'JP', name: 'Япония', flag: '🇯🇵' },
  { code: 'SG', name: 'Сингапур', flag: '🇸🇬' },
  { code: 'HK', name: 'Гонконг', flag: '🇭🇰' },
  { code: 'IN', name: 'Индия', flag: '🇮🇳' },
];

/** Готовое значение для поля country: «🇫🇮 Финляндия». */
export const countryValue = (c: Country): string => `${c.flag} ${c.name}`;
