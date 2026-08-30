//! Глубокая ссылка `novpn://subscribe?url=<подписка>`.
//!
//! На странице выпуска конфига есть кнопка «Добавить подписку»: она открывает
//! ссылку вида `novpn://subscribe?url=...`, Windows запускает нас (или передаёт
//! аргумент уже запущенному экземпляру через single-instance), а мы достаём из
//! неё ссылку-подписку и сразу подставляем её в приложении. Никакого копипаста.

/// Имя протокола, которое регистрируем за собой в системе.
pub const SCHEME: &str = "novpn";

/// Достать ссылку-подписку из аргументов запуска, если среди них есть наша
/// глубокая ссылка `novpn://subscribe?url=<urlencoded>`. Возвращает уже
/// раскодированную ссылку-подписку.
pub fn from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    for a in args {
        if let Some(u) = parse(&a) {
            return Some(u);
        }
    }
    None
}

/// Разобрать одну строку. Принимаем и `novpn://subscribe?url=...`, и вариант с
/// завершающим слэшем хоста. Возвращаем раскодированную подписку (непустую).
pub fn parse(arg: &str) -> Option<String> {
    let low = arg.trim();
    let rest = low
        .strip_prefix("novpn://subscribe/?")
        .or_else(|| low.strip_prefix("novpn://subscribe?"))?;
    for pair in rest.split('&') {
        if let Some(v) = pair.strip_prefix("url=") {
            let decoded = percent_decode(v);
            let decoded = decoded.trim();
            if !decoded.is_empty() {
                return Some(decoded.to_string());
            }
        }
    }
    None
}

/// Минимальный percent-decode: `%XX` → байт, `+` → пробел. Разбираем как UTF-8,
/// на битой последовательности возвращаем исходную строку (лучше показать сырое,
/// чем потерять ссылку).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// Зарегистрировать протокол `novpn://` за нашим exe (HKCU — без прав админа).
/// Путь к exe меняется при обновлении, поэтому переписываем каждый запуск.
#[cfg(windows)]
pub fn register() -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy().to_string();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let base = format!(r"Software\Classes\{SCHEME}");

    let (root, _) = hkcu.create_subkey_with_flags(&base, KEY_WRITE).map_err(|e| e.to_string())?;
    root.set_value("", &format!("URL:{SCHEME} Protocol")).map_err(|e| e.to_string())?;
    // Значение-маркер «это протокол» — пустая строка, так требует Windows.
    root.set_value("URL Protocol", &"").map_err(|e| e.to_string())?;

    let (cmd, _) = hkcu
        .create_subkey_with_flags(format!(r"{base}\shell\open\command"), KEY_WRITE)
        .map_err(|e| e.to_string())?;
    cmd.set_value("", &format!("\"{exe}\" \"%1\"")).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(windows))]
pub fn register() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_and_decodes_subscription() {
        let arg = "novpn://subscribe?url=https%3A%2F%2Fvpn.appswire.ru%2Fsub%2Fabc123";
        assert_eq!(parse(arg).as_deref(), Some("https://vpn.appswire.ru/sub/abc123"));
    }

    #[test]
    fn accepts_trailing_slash_host_form() {
        let arg = "novpn://subscribe/?url=https%3A%2F%2Fx.example%2Fsub%2Ft";
        assert_eq!(parse(arg).as_deref(), Some("https://x.example/sub/t"));
    }

    #[test]
    fn ignores_unrelated_args_and_finds_link_among_them() {
        let args = vec![
            "C:/NoVPN/novpn-desktop.exe".to_string(),
            "--something".to_string(),
            "novpn://subscribe?url=https%3A%2F%2Fx.example%2Fs".to_string(),
        ];
        assert_eq!(from_args(args).as_deref(), Some("https://x.example/s"));
    }

    #[test]
    fn empty_or_foreign_scheme_is_none() {
        assert_eq!(parse("novpn://subscribe?url="), None);
        assert_eq!(parse("https://x.example/s"), None);
        assert_eq!(parse("novpn://open"), None);
    }
}
