//! Проверка и установка обновлений.
//!
//! Два правила безопасности, оба выучены на ошибке:
//!
//! 1. Обновление берётся ТОЛЬКО с официального канала NoVPN, а не с домена
//!    подписки. Подписку можно ввести любого провайдера — но апдейт от чужого
//!    (или взломанного) провайдера означал бы запуск чужого .exe. Официальный
//!    канал фиксирован в коде.
//!
//! 2. Установщик проверяется подписью Ed25519 доверенным ключом, вшитым в
//!    приложение. Контрольная сумма из того же манифеста защищает лишь от
//!    повреждения в транспорте — подделать её вместе с файлом тривиально.
//!    Подпись же может поставить только владелец приватного ключа (разработчик),
//!    поэтому даже подменённый на канале файл без валидной подписи не запустится.

use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Официальные каналы манифеста по порядку. Панель NoVPN первой — raw.github в
/// РФ часто режется, а обновляться нужно и без уже поднятого VPN. Оба адреса
/// фиксированы: домен подписки сюда НЕ попадает.
const MANIFESTS: &[&str] = &[
    "https://vpn.appswire.ru/desktop/latest.json",
    "https://raw.githubusercontent.com/DanT2000/NoVPN/main/desktop/latest.json",
];

/// Доверенный публичный ключ обновлений (Ed25519, base64). Приватный ключ
/// хранится только у разработчика и в репозиторий не попадает.
const UPDATE_PUBKEY_B64: &str = "mAKrDKVxw35ZXElNCksRYgzEmzESGvfXMx5Zbc2oCUw=";

#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    sha256: String,
    /// Подпись Ed25519 над файлом установщика, base64.
    #[serde(default)]
    signature: String,
    #[serde(default)]
    notes: String,
    #[serde(default, rename = "sizeBytes")]
    size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current: String,
    pub latest: String,
    pub notes: String,
    pub size_bytes: u64,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())
}

/// Отдельный клиент для скачивания установщика. Файл ~16 МБ, а канал (особенно
/// без VPN и через GitHub) бывает медленным. Короткий общий таймаут рвал
/// загрузку на середине — тело не докачивалось, и reqwest возвращал
/// «error decoding response body». Здесь большой общий таймаут и отдельный
/// таймаут на установку соединения.
fn download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())
}

/// Скачивает установщик с несколькими попытками: обрыв тела на медленном канале
/// — обычное дело, поэтому одну неудачу не считаем окончательной.
async fn download_installer(url: &str) -> Result<Vec<u8>, String> {
    let client = download_client()?;
    let mut last = String::new();
    for _ in 0..3 {
        match client.get(url).send().await {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) => return Ok(b.to_vec()),
                Err(e) => last = format!("загрузка прервалась ({e})"),
            },
            Ok(r) => last = format!("сервер ответил {}", r.status().as_u16()),
            Err(e) => last = format!("{e}"),
        }
    }
    Err(format!(
        "Не удалось скачать обновление: {last}. Проверьте подключение и попробуйте ещё раз."
    ))
}

/// Числовое сравнение версий: `0.10.0` больше `0.9.0`, не по алфавиту.
fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split(|c: char| !c.is_ascii_digit())
            .filter(|p| !p.is_empty())
            .filter_map(|p| p.parse().ok())
            .collect()
    };
    let (a, b) = (parse(latest), parse(current));
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

async fn fetch_manifest() -> Result<Manifest, String> {
    let client = client()?;
    let mut last = String::from("Сервер обновлений недоступен");
    for url in MANIFESTS {
        match client.get(*url).send().await {
            Ok(r) if r.status().is_success() => match r.json::<Manifest>().await {
                Ok(m) if !m.version.trim().is_empty() => return Ok(m),
                _ => last = "Манифест обновления не разобран".into(),
            },
            Ok(r) => last = format!("Сервер обновлений ответил {}", r.status().as_u16()),
            Err(e) => last = format!("Не удалось проверить обновление: {e}"),
        }
    }
    Err(last)
}

#[tauri::command]
pub async fn update_check() -> Result<UpdateInfo, String> {
    let m = fetch_manifest().await?;
    let current = env!("CARGO_PKG_VERSION").to_string();
    Ok(UpdateInfo {
        available: is_newer(&m.version, &current),
        current,
        latest: m.version,
        notes: m.notes,
        size_bytes: m.size_bytes,
    })
}

/// Учёт попыток установки одной и той же версии. Если установщик не смог заменить
/// файлы, приложение запускается снова на старой версии — и при автообновлении тут
/// же ставит ту же версию опять. Так было в 0.3.33 → 0.3.34: бесконечный круг, и
/// каждый его виток рвал VPN. После двух неудач подряд автоматически не повторяем.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Attempt {
    version: String,
    count: u32,
    /// Время первой попытки этой версии в окне (unix-мс).
    first_at: u64,
}

const MAX_ATTEMPTS: u32 = 2;
const ATTEMPT_WINDOW_MS: u64 = 6 * 3600 * 1000;
const MANUAL_DOWNLOAD: &str = "https://vpn.appswire.ru/download";

/// Можно ли ставить `version` сейчас, и какую запись попытки сохранить. Чистая
/// функция — логику круга проверяем тестом.
fn next_attempt(prev: Option<&Attempt>, version: &str, now: u64) -> Result<Attempt, u32> {
    match prev {
        Some(p) if p.version == version && now.saturating_sub(p.first_at) < ATTEMPT_WINDOW_MS => {
            if p.count >= MAX_ATTEMPTS {
                Err(p.count)
            } else {
                Ok(Attempt { count: p.count + 1, ..p.clone() })
            }
        }
        _ => Ok(Attempt { version: version.to_string(), count: 1, first_at: now }),
    }
}

fn attempts_path() -> std::path::PathBuf {
    let engine = crate::store::engine_dir();
    engine.parent().map(|p| p.join("update-attempt.json")).unwrap_or_else(|| engine.join("update-attempt.json"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn verifying_key() -> Result<VerifyingKey, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(UPDATE_PUBKEY_B64)
        .map_err(|_| "Испорчен встроенный ключ обновлений")?;
    let arr: [u8; 32] = raw.try_into().map_err(|_| "Неверная длина ключа обновлений")?;
    VerifyingKey::from_bytes(&arr).map_err(|_| "Неверный ключ обновлений".into())
}

/// Скачивает установщик, проверяет подпись и сумму, гасит приложение и
/// запускает установку.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    let m = fetch_manifest().await?;
    let current = env!("CARGO_PKG_VERSION");
    if !is_newer(&m.version, current) {
        return Err("Установлена актуальная версия".into());
    }
    if m.url.is_empty() {
        return Err("В манифесте нет ссылки на установщик".into());
    }
    if m.signature.trim().is_empty() {
        return Err("В манифесте нет подписи — установка отменена".into());
    }

    let prev: Option<Attempt> = std::fs::read_to_string(attempts_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let attempt = next_attempt(prev.as_ref(), &m.version, now_ms()).map_err(|n| {
        format!(
            "Обновление до {} не установилось уже {n} раза подряд. Скачайте установщик \
             вручную: {MANUAL_DOWNLOAD} — или попробуйте позже.",
            m.version
        )
    })?;

    let bytes = download_installer(&m.url).await?;

    // Сумма — от повреждения в транспорте (если задана).
    if !m.sha256.trim().is_empty() {
        let got = hex(&Sha256::digest(&bytes));
        if !got.eq_ignore_ascii_case(m.sha256.trim()) {
            return Err("Контрольная сумма не совпала — файл повреждён".into());
        }
    }

    // Подпись — от подмены. Единственная настоящая защита: без приватного ключа
    // разработчика валидную подпись не сделать.
    let key = verifying_key()?;
    let sig_raw = base64::engine::general_purpose::STANDARD
        .decode(m.signature.trim())
        .map_err(|_| "Подпись обновления испорчена")?;
    let sig_arr: [u8; 64] = sig_raw.try_into().map_err(|_| "Неверная длина подписи")?;
    let sig = Signature::from_bytes(&sig_arr);
    key.verify(&bytes, &sig)
        .map_err(|_| "Подпись не совпала — обновление отклонено как небезопасное")?;

    let path = std::env::temp_dir().join("NoVPN-update-setup.exe");
    std::fs::write(&path, &bytes).map_err(|e| format!("Не удалось сохранить установщик: {e}"))?;

    // Попытку записываем ДО запуска установщика: если он не справится, следующий
    // запуск увидит счётчик и не пойдёт на тот же круг.
    if let Ok(text) = serde_json::to_string(&attempt) {
        let _ = crate::store::atomic_write(&attempts_path(), text.as_bytes());
    }

    // Гасим движок и возвращаем прокси до установки: пока mihomo.exe и наш exe
    // живы, они держат файлы, и NSIS не перезапишет их поверх.
    crate::cmds::shutdown(&app);

    // Движок режима адаптера — отдельный процесс ИЗ ТОГО ЖЕ exe с правами
    // администратора. Установщик ставится без прав и убить его не может: встроенная
    // проверка Tauri в тихом режиме молча прерывала установку, приложение вставало
    // на старой версии и снова шло обновляться. Просим хост выйти сразу и ждём,
    // пока он отпустит exe (установщик дополнительно ждёт и сам).
    crate::enginehost::request_quit();
    let _ = tauri::async_runtime::spawn_blocking(|| {
        if crate::enginehost::wait_host_exit(std::time::Duration::from_secs(20)) {
            // Статус удалён чуть раньше, чем система закроет дескрипторы процесса.
            std::thread::sleep(std::time::Duration::from_millis(700));
        }
    })
    .await;

    // Тихо и без единого клика: отсоединённый cmd ставит обновление в фоне
    // (/S), а затем сам запускает новую версию. Никаких окон установщика.
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED: u32 = 0x0000_0008;
        // Задержка даёт нам выйти и освободить exe перед перезаписью.
        //
        // ВНИМАНИЕ: команда идёт через `raw_arg`, а НЕ через `.args(["/C", line])`.
        // std экранирует внутренние кавычки как \" по правилам C-runtime, а cmd.exe
        // Ключ /B у start: без него команда создаёт НОВОЕ окно консоли для
        // запускаемого процесса, и при обновлении на секунду мигает чёрный
        // прямоугольник. Сам cmd мы запускаем скрыто — мигал именно start.
        // их не понимает (у неё экранирование через ^), поэтому пути установщика и
        // exe разбирались как мусор — установка и перезапуск молча не выполнялись,
        // приложение просто закрывалось на старой версии. Собираем строку сами и
        // отдаём как есть, обернув всё во внешние кавычки, которые снимет `/C`.
        let inner = format!(
            "ping 127.0.0.1 -n 2 >nul & \"{}\" /S & start \"\" /B \"{}\"",
            path.display(),
            exe.display()
        );
        std::process::Command::new("cmd")
            .raw_arg(format!("/C \"{inner}\""))
            .creation_flags(CREATE_NO_WINDOW | DETACHED)
            .spawn()
            .map_err(|e| format!("Не удалось запустить установку обновления: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(&path)
            .arg("/S")
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    app.exit(0);
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::{is_newer, next_attempt, Attempt, ATTEMPT_WINDOW_MS, MAX_ATTEMPTS};

    #[test]
    fn versions_are_in_sync() {
        // Регресс 0.3.34: версию подняли только в tauri.conf.json. Установщик вышел
        // «0.3.34», а программа сверяла себя по Cargo.toml (0.3.33), видела в канале
        // «новую» 0.3.34 и ставила её снова — бесконечный круг автообновления.
        let cargo = env!("CARGO_PKG_VERSION");
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let pkg: serde_json::Value = serde_json::from_str(include_str!("../../package.json")).unwrap();
        assert_eq!(conf["version"].as_str(), Some(cargo), "tauri.conf.json отстаёт от Cargo.toml");
        assert_eq!(pkg["version"].as_str(), Some(cargo), "package.json отстаёт от Cargo.toml");
    }

    #[test]
    fn update_loop_stops_after_repeated_failures() {
        let first = next_attempt(None, "0.3.35", 1_000).unwrap();
        assert_eq!(first.count, 1);
        let second = next_attempt(Some(&first), "0.3.35", 2_000).unwrap();
        assert_eq!(second.count, 2);
        assert_eq!(second.first_at, 1_000, "окно считается от первой попытки");
        // Третий раз ту же версию в окне — нет: иначе круг «установка не прошла →
        // старая версия → снова установка», рвущий VPN на каждом витке.
        assert_eq!(next_attempt(Some(&second), "0.3.35", 3_000), Err(MAX_ATTEMPTS));
        // Вышло окно — можно снова.
        assert_eq!(next_attempt(Some(&second), "0.3.35", 1_000 + ATTEMPT_WINDOW_MS).unwrap().count, 1);
        // Другая (новая) версия — счёт заново.
        let other = next_attempt(Some(&second), "0.3.36", 3_000).unwrap();
        assert_eq!(other, Attempt { version: "0.3.36".into(), count: 1, first_at: 3_000 });
    }

    #[test]
    fn version_compare_is_numeric_not_lexical() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(is_newer("0.10.0", "0.9.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(is_newer("0.1.1", "0.1"));
        assert!(!is_newer("0.1", "0.1.0"));
    }
}
