/* Флаг страны по имени сервера.

   Панель ставит флаг первым символом в remarks, если у сервера заполнена страна.
   Если не заполнена — имя вроде «Нидерланды #2» приходит без флага, и мы
   подбираем его по названию страны в имени: человек видит флаг, а не голое
   слово. Ничего не нашли — пустая строка, интерфейс просто не рисует флаг. */

const COUNTRIES: [RegExp, string][] = [
  [/нидерланд|netherlands|holland|amsterdam|амстердам/i, 'NL'],
  [/герман|germany|frankfurt|франкфурт|berlin/i, 'DE'],
  [/франц|france|paris|париж/i, 'FR'],
  [/финлянд|finland|helsinki|хельсинки/i, 'FI'],
  [/швеци|sweden|stockholm|стокгольм/i, 'SE'],
  [/норвег|norway/i, 'NO'],
  [/дани|denmark/i, 'DK'],
  [/польш|poland|warsaw|варшав/i, 'PL'],
  [/чех|czech|prague|прага/i, 'CZ'],
  [/австри|austria|vienna|вена/i, 'AT'],
  [/швейцар|switzerland|zurich|цюрих/i, 'CH'],
  [/великобритан|британ|england|united kingdom|london|лондон|\buk\b/i, 'GB'],
  [/ирланд|ireland/i, 'IE'],
  [/испан|spain|madrid|мадрид/i, 'ES'],
  [/португал|portugal/i, 'PT'],
  [/итал|italy|milan|милан/i, 'IT'],
  [/латв|latvia|riga|рига/i, 'LV'],
  [/литв|lithuania|vilnius|вильнюс/i, 'LT'],
  [/эстон|estonia|tallinn|таллин/i, 'EE'],
  [/турц|turkey|türkiye|istanbul|стамбул/i, 'TR'],
  [/казахстан|kazakhstan|almaty|алматы/i, 'KZ'],
  [/армени|armenia|yerevan|ереван/i, 'AM'],
  [/грузи|georgia|tbilisi|тбилиси/i, 'GE'],
  [/сша|usa|united states|america|new york|нью-йорк|los angeles/i, 'US'],
  [/канад|canada|toronto|торонто/i, 'CA'],
  [/япон|japan|tokyo|токио/i, 'JP'],
  [/сингапур|singapore/i, 'SG'],
  [/гонконг|hong kong|hongkong/i, 'HK'],
  [/корея|korea|seoul|сеул/i, 'KR'],
  [/оаэ|uae|emirates|dubai|дубай/i, 'AE'],
  [/израил|israel/i, 'IL'],
  [/сербия|serbia|belgrade|белград/i, 'RS'],
  [/румын|romania|bucharest|бухарест/i, 'RO'],
  [/болгар|bulgaria/i, 'BG'],
  [/венгр|hungary|budapest|будапешт/i, 'HU'],
  [/молдов|moldova|кишин/i, 'MD'],
  [/украин|ukraine|kyiv|киев/i, 'UA'],
  [/беларус|belarus|минск|minsk/i, 'BY'],
  [/росси|russia|москв|moscow|петербург/i, 'RU'],
  [/индия|india|mumbai/i, 'IN'],
  [/бразил|brazil|brasil/i, 'BR'],
  [/австрали|australia|sydney/i, 'AU'],
];

const RI = /^(\p{Regional_Indicator}{2})/u;

/** ISO-код → флаг из двух региональных символов. */
export function flagFromIso(iso: string): string {
  const up = iso.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(up)) return '';
  return String.fromCodePoint(...[...up].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * ISO-код страны для имени сервера: из ведущего эмодзи-флага (если панель его
 * поставила) либо подобранный по названию страны в имени. На компьютере эмодзи-
 * флаги не рисуются (Windows показывает буквы), поэтому по коду грузим картинку.
 */
export function isoOf(name: string): string | null {
  const ri = name.trim().match(/^(\p{Regional_Indicator})(\p{Regional_Indicator})/u);
  if (ri) {
    const a = ri[1].codePointAt(0)! - 0x1f1e6 + 65;
    const b = ri[2].codePointAt(0)! - 0x1f1e6 + 65;
    return String.fromCharCode(a, b);
  }
  for (const [re, iso] of COUNTRIES) if (re.test(name)) return iso;
  return null;
}

/**
 * Ведущий значок-эмодзи, не являющийся флагом страны (например 🏠 у HomeVPN).
 * Панель ставит его, когда у сервера в админке задан свой значок, а страны нет.
 * Флаги-эмодзи на компьютере не рисуются, а обычный значок вроде домика — можно,
 * как есть. Если впереди стоит флаг из региональных индикаторов, значка нет:
 * страну показываем картинкой, значок в этом случае опускаем.
 */
export function leadingEmoji(name: string): string {
  const s = name.trim();
  if (RI.test(s)) return '';
  const m = s.match(/^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/u);
  return m ? m[1] : '';
}

/** Флаг для имени сервера: готовый из remarks либо подобранный по стране в имени. */
export function flagOf(name: string): string {
  const ready = name.trim().match(RI)?.[1];
  if (ready) return ready;
  for (const [re, iso] of COUNTRIES) if (re.test(name)) return flagFromIso(iso);
  return '';
}

/** Имя без ведущего флага и значков — чтобы флаг не рисовался дважды. */
export function bareName(name: string): string {
  return name
    .trim()
    .replace(/^(\p{Regional_Indicator}{2}|\p{Extended_Pictographic}|️|\s)+/u, '')
    .trim();
}

/** «🇳🇱 Нидерланды #2» — флаг и имя одной строкой; без флага — просто имя. */
export function withFlag(name: string): string {
  const f = flagOf(name);
  const n = bareName(name);
  return f ? `${f} ${n}` : n;
}
