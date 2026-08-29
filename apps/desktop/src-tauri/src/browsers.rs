//! Какие браузеры реально стоят на компьютере.
//!
//! Раньше список был ЗАГЛУШКОЙ: Chrome, Edge и Яндекс всегда значились найденными,
//! Firefox — нет, независимо от машины. Владелец справедливо возмутился: «пишет, что
//! найден Яндекс, а у меня такого браузера вообще нет».
//!
//! Определяем по реестру `StartMenuInternet` — туда браузер прописывается при установке
//! (и HKLM, и HKCU: часть ставится только для пользователя). Оттуда же берём путь к
//! исполняемому файлу и проверяем, что он существует: удалённый браузер иногда
//! оставляет ключ.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Browser {
    /// Наш идентификатор: chrome / edge / yandex / firefox / opera / brave / vivaldi.
    pub id: String,
    /// Название, как показывать человеку.
    pub name: String,
    /// Путь к exe — по нему же видно, что браузер не удалён.
    pub path: String,
}

/// Ключ реестра → наш идентификатор и человеческое имя. Ключи именно такие, какими их
/// пишут установщики браузеров.
const KNOWN: &[(&str, &str, &str)] = &[
    ("chrome.exe", "chrome", "Google Chrome"),
    ("msedge.exe", "edge", "Microsoft Edge"),
    ("browser.exe", "yandex", "Яндекс Браузер"),
    ("firefox.exe", "firefox", "Mozilla Firefox"),
    ("opera.exe", "opera", "Opera"),
    ("brave.exe", "brave", "Brave"),
    ("vivaldi.exe", "vivaldi", "Vivaldi"),
];

/// Опознать браузер по ключу реестра или пути к файлу.
pub fn classify(key_or_path: &str) -> Option<(&'static str, &'static str)> {
    let low = key_or_path.to_lowercase();
    // Яндекс держит exe с общим именем browser.exe — отличаем по пути.
    if low.contains("yandex") {
        return Some(("yandex", "Яндекс Браузер"));
    }
    // Сравниваем ИМЯ ФАЙЛА, а не подстроку: иначе «chrome.exe» нашёлся бы и в пути
    // какого-нибудь «chrome.exe.bak».
    let file = low.rsplit(['\\', '/']).next().unwrap_or("");
    for (exe, id, name) in KNOWN {
        if file == *exe {
            return Some((id, name));
        }
    }
    None
}

#[cfg(windows)]
pub fn installed() -> Vec<Browser> {
    use std::path::Path;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let mut out: Vec<Browser> = Vec::new();
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let Ok(clients) = RegKey::predef(root).open_subkey_with_flags(r"SOFTWARE\Clients\StartMenuInternet", KEY_READ)
        else {
            continue;
        };
        for key in clients.enum_keys().flatten() {
            // Путь к exe: ...\<Ключ>\shell\open\command, значение по умолчанию.
            let cmd: Option<String> = clients
                .open_subkey_with_flags(format!(r"{key}\shell\open\command"), KEY_READ)
                .ok()
                .and_then(|k| k.get_value("").ok());
            let Some(cmd) = cmd else { continue };
            let path = cmd.trim().trim_matches('"').to_string();
            if !Path::new(&path).exists() {
                continue; // ключ остался от удалённого браузера
            }
            let Some((id, name)) = classify(&path).or_else(|| classify(&key)) else { continue };
            if out.iter().any(|b| b.id == id) {
                continue;
            }
            out.push(Browser { id: id.to_string(), name: name.to_string(), path });
        }
    }
    out
}

#[cfg(not(windows))]
pub fn installed() -> Vec<Browser> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_path() {
        assert_eq!(classify(r"C:\Program Files\Google\Chrome\Application\chrome.exe").unwrap().0, "chrome");
        assert_eq!(classify(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe").unwrap().0, "edge");
        assert_eq!(classify(r"C:\Users\u\AppData\Local\Mozilla Firefox\firefox.exe").unwrap().0, "firefox");
    }

    #[test]
    fn yandex_is_told_apart_from_generic_browser_exe() {
        // У Яндекса exe называется browser.exe — по одному имени его не отличить.
        let y = classify(r"C:\Users\u\AppData\Local\Yandex\YandexBrowser\Application\browser.exe");
        assert_eq!(y.unwrap().0, "yandex");
    }

    #[test]
    fn unknown_program_is_not_a_browser() {
        assert!(classify(r"C:\Windows\notepad.exe").is_none());
        assert!(classify("").is_none());
    }
}
