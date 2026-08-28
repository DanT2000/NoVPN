//! Хранение на диске: `%APPDATA%\NoVPN`.
//!
//! Слоёв два, и они лежат раздельно намеренно. `lists/` приходит с сервера и
//! при обновлении заменяется целиком; `rules.json` пишет человек, и обновление
//! списков его не касается. Смешать их в одном файле значит рано или поздно
//! затереть чужой труд при очередной синхронизации.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;

pub fn dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("NoVPN")
}

pub fn lists_dir() -> PathBuf {
    dir().join("lists")
}

/// Рабочий каталог движка: конфиг и его временные файлы.
pub fn engine_dir() -> PathBuf {
    dir().join("engine")
}

/// Атомарная запись с fsync: временный файл сбрасывается на диск ДО
/// переименования, иначе после обрыва питания rename мог бы «состояться», а
/// содержимое файла — нет, и мы получили бы пустышку вместо конфига.
fn atomic_write(target: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = target.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, target).map_err(|e| e.to_string())
}

fn path_of(name: &str) -> PathBuf {
    dir().join(format!("{name}.json"))
}

pub fn read(name: &str) -> Option<Value> {
    let text = fs::read_to_string(path_of(name)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write(name: &str, value: &Value) -> Result<(), String> {
    fs::create_dir_all(dir()).map_err(|e| format!("Не удалось создать папку настроек: {e}"))?;
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let target = path_of(name);
    atomic_write(&target, text.as_bytes()).map_err(|e| format!("Не удалось сохранить {name}: {e}"))
}

/// Выставляет булев флаг в `state.settings` и пишет обратно, сохранив остальное.
/// Нужно, когда настройку меняет бэкенд (перезапуск с правами) раньше, чем её
/// успеет сохранить интерфейс со своей отложенной записью.
pub fn set_settings_flag(key: &str, value: bool) -> Result<(), String> {
    let mut state = read("state").filter(Value::is_object).unwrap_or_else(|| serde_json::json!({}));
    let obj = state.as_object_mut().unwrap();
    let settings = obj.entry("settings").or_insert_with(|| serde_json::json!({}));
    if !settings.is_object() {
        *settings = serde_json::json!({});
    }
    settings.as_object_mut().unwrap().insert(key.to_string(), Value::Bool(value));
    write("state", &state)
}

/// Сырой текст подписки: нужен, чтобы пересобрать конфиг без обращения к сети,
/// например при запуске без интернета.
pub fn write_raw(name: &str, text: &str) -> Result<(), String> {
    fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    // Атомарно с fsync, как и state.json: обрыв посреди записи не должен оставить
    // усечённую подписку, из-за которой приложение не поднимется офлайн.
    atomic_write(&dir().join(name), text.as_bytes())
        .map_err(|e| format!("Не удалось сохранить {name}: {e}"))
}

pub fn read_raw(name: &str) -> Option<String> {
    fs::read_to_string(dir().join(name)).ok()
}
