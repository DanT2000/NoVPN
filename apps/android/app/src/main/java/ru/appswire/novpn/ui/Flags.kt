package ru.appswire.novpn.ui

/**
 * Флаг страны для строки сервера.
 *
 * Панель кладёт флаг прямо в имя профиля («🇫🇷 Франция · Умная маршрутизация»),
 * и в этом случае мы его просто вынимаем. У чужих подписок и старых панелей
 * флага в имени нет — тогда угадываем страну по названию. Это подсказка для
 * глаз, а не данные: не угадали — строка остаётся без флага, и ничего не ломается.
 */
object Flags {

    /** Имя сервера, разобранное на флаг и текст без него. */
    data class Split(val flag: String, val name: String)

    /** Название страны (нижним регистром, русское и английское) → ISO-код. */
    private val COUNTRIES: List<Pair<String, String>> = listOf(
        "нидерланды" to "NL", "netherlands" to "NL", "holland" to "NL", "амстердам" to "NL", "amsterdam" to "NL",
        "германия" to "DE", "germany" to "DE", "франкфурт" to "DE", "frankfurt" to "DE", "берлин" to "DE",
        "франция" to "FR", "france" to "FR", "париж" to "FR", "paris" to "FR",
        "финляндия" to "FI", "finland" to "FI", "хельсинки" to "FI", "helsinki" to "FI",
        "швеция" to "SE", "sweden" to "SE", "стокгольм" to "SE", "stockholm" to "SE",
        "польша" to "PL", "poland" to "PL", "варшава" to "PL", "warsaw" to "PL",
        "турция" to "TR", "turkey" to "TR", "türkiye" to "TR", "стамбул" to "TR", "istanbul" to "TR",
        "сша" to "US", "usa" to "US", "united states" to "US", "америка" to "US", "america" to "US",
        "казахстан" to "KZ", "kazakhstan" to "KZ", "алматы" to "KZ", "almaty" to "KZ",
        "латвия" to "LV", "latvia" to "LV", "рига" to "LV", "riga" to "LV",
        "литва" to "LT", "lithuania" to "LT", "вильнюс" to "LT", "vilnius" to "LT",
        "эстония" to "EE", "estonia" to "EE", "таллин" to "EE", "tallinn" to "EE",
        "великобритания" to "GB", "англия" to "GB", "united kingdom" to "GB", "britain" to "GB", "england" to "GB", "лондон" to "GB", "london" to "GB",
        "чехия" to "CZ", "czech" to "CZ", "прага" to "CZ", "prague" to "CZ",
        "австрия" to "AT", "austria" to "AT", "вена" to "AT", "vienna" to "AT",
        "швейцария" to "CH", "switzerland" to "CH", "цюрих" to "CH", "zurich" to "CH",
        "испания" to "ES", "spain" to "ES", "мадрид" to "ES", "madrid" to "ES",
        "италия" to "IT", "italy" to "IT", "милан" to "IT", "milan" to "IT",
        "япония" to "JP", "japan" to "JP", "токио" to "JP", "tokyo" to "JP",
        "сингапур" to "SG", "singapore" to "SG",
        "гонконг" to "HK", "hong kong" to "HK", "hongkong" to "HK",
        "канада" to "CA", "canada" to "CA", "торонто" to "CA", "toronto" to "CA",
        "россия" to "RU", "russia" to "RU", "москва" to "RU", "moscow" to "RU", "петербург" to "RU",
        "армения" to "AM", "armenia" to "AM", "ереван" to "AM",
        "грузия" to "GE", "georgia" to "GE", "тбилиси" to "GE",
        "сербия" to "RS", "serbia" to "RS", "белград" to "RS",
        "болгария" to "BG", "bulgaria" to "BG", "софия" to "BG",
        "румыния" to "RO", "romania" to "RO", "бухарест" to "RO",
        "венгрия" to "HU", "hungary" to "HU", "будапешт" to "HU",
        "норвегия" to "NO", "norway" to "NO", "осло" to "NO",
        "дания" to "DK", "denmark" to "DK", "копенгаген" to "DK",
        "ирландия" to "IE", "ireland" to "IE", "дублин" to "IE",
        "португалия" to "PT", "portugal" to "PT", "лиссабон" to "PT",
        "бельгия" to "BE", "belgium" to "BE", "брюссель" to "BE",
        "люксембург" to "LU", "luxembourg" to "LU",
        "молдова" to "MD", "молдавия" to "MD", "moldova" to "MD", "кишинёв" to "MD",
        "украина" to "UA", "ukraine" to "UA", "киев" to "UA",
        "беларусь" to "BY", "белоруссия" to "BY", "belarus" to "BY", "минск" to "BY",
        "узбекистан" to "UZ", "uzbekistan" to "UZ", "ташкент" to "UZ",
        "кыргызстан" to "KG", "киргизия" to "KG", "kyrgyzstan" to "KG",
        "оаэ" to "AE", "uae" to "AE", "emirates" to "AE", "дубай" to "AE", "dubai" to "AE",
        "израиль" to "IL", "israel" to "IL",
        "индия" to "IN", "india" to "IN",
        "корея" to "KR", "korea" to "KR", "сеул" to "KR",
        "австралия" to "AU", "australia" to "AU", "сидней" to "AU",
        "бразилия" to "BR", "brazil" to "BR",
        "мексика" to "MX", "mexico" to "MX",
        "кипр" to "CY", "cyprus" to "CY",
        "греция" to "GR", "greece" to "GR",
        "исландия" to "IS", "iceland" to "IS",
        "словакия" to "SK", "slovakia" to "SK",
        "словения" to "SI", "slovenia" to "SI",
        "хорватия" to "HR", "croatia" to "HR",
        "тайвань" to "TW", "taiwan" to "TW",
        "вьетнам" to "VN", "vietnam" to "VN",
        "таиланд" to "TH", "thailand" to "TH",
        "малайзия" to "MY", "malaysia" to "MY",
        "индонезия" to "ID", "indonesia" to "ID",
        "филиппины" to "PH", "philippines" to "PH",
        "юар" to "ZA", "south africa" to "ZA",
        "аргентина" to "AR", "argentina" to "AR",
        "чили" to "CL", "chile" to "CL",
    )

    /** ISO-код → эмодзи-флаг: буквы сдвигаются в диапазон региональных индикаторов. */
    fun emoji(iso: String): String {
        val code = iso.uppercase()
        if (code.length != 2 || !code.all { it in 'A'..'Z' }) return ""
        val sb = StringBuilder()
        for (ch in code) sb.appendCodePoint(0x1F1E6 + (ch - 'A'))
        return sb.toString()
    }

    /**
     * Эмодзи и то, из чего они склеиваются: символы от U+2600 (☀…🏠…🇫), селектор
     * начертания, соединитель и клавиша-обводка. Обычная пунктуация («·», «№») сюда
     * не попадает — иначе имя вроде «№3 Москва» потеряло бы начало.
     */
    private fun isEmojiPart(cp: Int) = cp >= 0x2600 || cp == 0xFE0F || cp == 0x200D || cp == 0x20E3

    /**
     * Длина (в char) префикса из эмодзи в начале строки — это и есть «флаг». Панель
     * ставит первым флаг страны, за ним значок сервера (🇫🇮🏠); у сервера без
     * страны остаётся один значок (🏠) — он тоже флаг для наших целей.
     */
    private fun emojiPrefix(name: String): Int {
        var i = 0
        while (i < name.length) {
            val cp = name.codePointAt(i)
            if (!isEmojiPart(cp)) break
            i += Character.charCount(cp)
        }
        return i
    }

    /**
     * Разбирает имя сервера. Флаг в начале имени вынимается как есть (вместе с
     * личным значком сервера, если панель его добавила, например «🏠»); иначе
     * страна ищется по словам названия.
     */
    fun split(rawName: String): Split {
        val name = rawName.trim()
        val end = emojiPrefix(name)
        if (end > 0) return Split(name.substring(0, end), name.substring(end).trim())
        val lower = name.lowercase()
        val iso = COUNTRIES.firstOrNull { (word, _) -> lower.contains(word) }?.second
        return Split(iso?.let { emoji(it) } ?: "", name)
    }

    /** Имя без служебного хвоста панели («· Умная маршрутизация»). */
    fun shortName(rawName: String): String = split(rawName).name.substringBefore(" · ").trim()

    /** Флаг + короткое имя — одной строкой для статуса на главной. */
    fun label(rawName: String): String {
        val s = split(rawName)
        val short = s.name.substringBefore(" · ").trim()
        return if (s.flag.isEmpty()) short else "${s.flag} $short"
    }
}
