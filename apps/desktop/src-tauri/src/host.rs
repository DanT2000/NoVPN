//! Хост нативных сообщений для расширения браузера.
//!
//! Chrome запускает наш же исполняемый файл отдельным процессом и передаёт
//! origin расширения первым аргументом. Общение идёт по stdin/stdout: перед
//! каждым сообщением — его длина четырьмя байтами.
//!
//! Правила из браузера пишутся в отдельный файл, а не в общий `state.json`.
//! Приложение держит своё состояние в памяти и периодически его сохраняет —
//! писать туда из другого процесса значило бы гонку, в которой чьи-то правки
//! молча пропадут.

use crate::core::Ports;
use crate::store;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub const RULES: &str = "browser-rules";

/// Chrome передаёт origin расширения первым аргументом — по нему и узнаём,
/// что нас запустили как хост, а не как приложение.
pub fn requested() -> bool {
    std::env::args().any(|a| a.starts_with("chrome-extension://"))
}

fn read_message(stdin: &mut impl Read) -> Option<Value> {
    let mut len = [0u8; 4];
    stdin.read_exact(&mut len).ok()?;
    let n = u32::from_le_bytes(len) as usize;
    // Защита от мусора на входе: осмысленное сообщение сюда не поместится.
    if n == 0 || n > 1024 * 1024 {
        return None;
    }
    let mut buf = vec![0u8; n];
    stdin.read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn write_message(stdout: &mut impl Write, v: &Value) {
    let body = v.to_string();
    let _ = stdout.write_all(&(body.len() as u32).to_le_bytes());
    let _ = stdout.write_all(body.as_bytes());
    let _ = stdout.flush();
}

fn rules() -> Vec<Value> {
    store::read(RULES)
        .and_then(|v| v.get("items").cloned())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

fn save_rules(items: Vec<Value>) -> Result<(), String> {
    store::write(RULES, &json!({ "version": 1, "items": items }))
}

/// Подключение проверяем не по сохранённому состоянию, а по тому, слушает ли
/// движок свой порт: файл на диске отстаёт, а человеку нужен ответ про сейчас.
fn connected() -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], Ports::default().mixed).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// Ищем правило: сначала среди добавленных из браузера, затем среди тех, что
/// приложение уже знает из списков.
fn lookup(domain: &str) -> (Option<String>, &'static str) {
    for r in rules() {
        if r.get("domain").and_then(|d| d.as_str()) == Some(domain) {
            return (
                r.get("route").and_then(|x| x.as_str()).map(String::from),
                "manual",
            );
        }
    }
    if let Some(state) = store::read("state") {
        if let Some(sites) = state.get("sites").and_then(|x| x.as_array()) {
            for s in sites {
                if s.get("domain").and_then(|d| d.as_str()) == Some(domain) {
                    let src = s.get("source").and_then(|x| x.as_str()).unwrap_or("list");
                    return (
                        s.get("route").and_then(|x| x.as_str()).map(String::from),
                        if src == "manual" { "manual" } else { "list" },
                    );
                }
            }
        }
    }
    (None, "none")
}

/// Приводит домен к виду, в котором он хранится: нижний регистр без «www.».
///
/// Регистр приводится первым — иначе «WWW.» не совпадёт с «www.», префикс
/// останется в имени, и правило не найдётся при следующем обращении.
pub fn normalize_domain(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    lower.strip_prefix("www.").unwrap_or(&lower).to_string()
}

pub fn handle_test(msg: &Value) -> Value {
    handle(msg)
}

fn handle(msg: &Value) -> Value {
    let kind = msg.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let domain = normalize_domain(msg.get("domain").and_then(|x| x.as_str()).unwrap_or(""));

    match kind {
        "status" => json!({ "ok": true, "connected": connected() }),

        "get" => {
            if domain.is_empty() {
                return json!({ "ok": false, "error": "Не указан домен" });
            }
            let (route, source) = lookup(&domain);
            json!({ "ok": true, "route": route, "source": source })
        }

        "set" => {
            let route = msg.get("route").and_then(|x| x.as_str()).unwrap_or("");
            if domain.is_empty() || !matches!(route, "vpn" | "direct") {
                return json!({ "ok": false, "error": "Неверный запрос" });
            }
            let mut items: Vec<Value> = rules()
                .into_iter()
                .filter(|r| r.get("domain").and_then(|d| d.as_str()) != Some(domain.as_str()))
                .collect();
            items.push(json!({ "domain": domain, "route": route }));
            match save_rules(items) {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "error": e }),
            }
        }

        "remove" => {
            let items: Vec<Value> = rules()
                .into_iter()
                .filter(|r| r.get("domain").and_then(|d| d.as_str()) != Some(domain.as_str()))
                .collect();
            match save_rules(items) {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "error": e }),
            }
        }

        _ => json!({ "ok": false, "error": "Неизвестный запрос" }),
    }
}

pub fn run() {
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    while let Some(msg) = read_message(&mut stdin) {
        let reply = handle(&msg);
        write_message(&mut stdout, &reply);
    }
}

/// Идентификатор расширения зафиксирован открытым ключом в его манифесте,
/// поэтому он одинаков и при разработке, и после публикации в магазине.
pub const EXTENSION_ID: &str = "fcigljflnglmclncmdjmbfppppaoeech";
pub const HOST_NAME: &str = "ru.appswire.novpn";
/// Firefox опознаёт расширение не по chrome-extension://, а по идентификатору из
/// `browser_specific_settings.gecko.id`, и держит хосты в своей ветке реестра.
pub const FIREFOX_EXTENSION_ID: &str = "novpn@appswire.ru";

/// Прописывает хост в браузерах. Вызывается при каждом запуске: путь к
/// исполняемому файлу меняется при обновлении, и запись должна за ним следовать.
#[cfg(windows)]
pub fn register() -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let manifest = json!({
        "name": HOST_NAME,
        "description": "NoVPN",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    });

    // У Firefox манифест отличается: расширение перечисляется в allowed_extensions
    // по своему gecko-идентификатору, а не по chrome-extension://.
    let manifest_ff = json!({
        "name": HOST_NAME,
        "description": "NoVPN",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_extensions": [FIREFOX_EXTENSION_ID],
    });

    let dir = store::dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("native-host.json");
    std::fs::write(&path, serde_json::to_string_pretty(&manifest).unwrap_or_default())
        .map_err(|e| format!("Не удалось записать манифест хоста: {e}"))?;
    let path_ff = dir.join("native-host-firefox.json");
    std::fs::write(&path_ff, serde_json::to_string_pretty(&manifest_ff).unwrap_or_default())
        .map_err(|e| format!("Не удалось записать манифест хоста Firefox: {e}"))?;

    // Каждый браузер держит свою ветку. У семейства Chromium манифест общий,
    // Firefox получает свой.
    let branches = [
        (r"Software\Google\Chrome\NativeMessagingHosts", &path),
        (r"Software\Microsoft\Edge\NativeMessagingHosts", &path),
        (r"Software\Yandex\YandexBrowser\NativeMessagingHosts", &path),
        (r"Software\Chromium\NativeMessagingHosts", &path),
        (r"Software\Mozilla\NativeMessagingHosts", &path_ff),
    ];
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for (branch, manifest_path) in branches {
        let full = format!(r"{branch}\{HOST_NAME}");
        // Отсутствие браузера — не ошибка: ветка просто создаётся впрок и
        // сработает, если его поставят позже.
        if let Ok((key, _)) = hkcu.create_subkey_with_flags(&full, KEY_WRITE) {
            let _ = key.set_value("", &manifest_path.to_string_lossy().to_string());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn register() -> Result<(), String> {
    Ok(())
}
