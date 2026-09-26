//! Определение российских серверов — порт логики Android `Flags.isRussian`.
//!
//! Для аварийного пула (обход белых списков) российские серверы бесполезны: из
//! России российское ограничение не обойти. Узнаём по флагу 🇷🇺 в начале имени
//! или по слову-названию РФ в тексте.

/// Флаг РФ 🇷🇺 — два региональных индикатора U+1F1F7 U+1F1FA.
const RU_FLAG: &str = "\u{1F1F7}\u{1F1FA}";

/// Слова-маркеры РФ (нижним регистром).
const RU_WORDS: &[&str] = &[
    "россия", "russia", "russian", "москва", "moscow", "петербург",
];

/// Похоже ли, что сервер российский.
pub fn is_russian(name: &str) -> bool {
    if name.trim_start().starts_with(RU_FLAG) {
        return true;
    }
    let lower = name.to_lowercase();
    RU_WORDS.iter().any(|w| lower.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn russian_detected_by_flag_and_word() {
        assert!(is_russian("\u{1F1F7}\u{1F1FA} YouTube без рекламы"));
        assert!(is_russian("\u{1F1F7}\u{1F1FA} Москва · Умная"));
        assert!(is_russian("Russia Premium"));
        assert!(is_russian("Сервер Москва 2"));
    }

    #[test]
    fn foreign_not_russian() {
        assert!(!is_russian("\u{1F1F3}\u{1F1F1} Нидерланды"));
        assert!(!is_russian("\u{1F1E9}\u{1F1EA} Германия 10 Гбит/с"));
        assert!(!is_russian("Finland 1"));
        assert!(!is_russian("\u{1F1E8}\u{1F1FF} Прага"));
    }
}
