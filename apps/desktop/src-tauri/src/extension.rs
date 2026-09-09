//! Расширение для браузера в папке приложения.
//!
//! Магазины расширений NoVPN ещё не одобрили, а ставить «распакованное расширение»
//! из вручную скачанного и разархивированного zip людям сложно. Поэтому приложение
//! само держит распакованную копию в `%APPDATA%\NoVPN\extension\{chrome,firefox}`.
//! Человек один раз указывает эту папку браузеру («Загрузить распакованное»), а
//! дальше она обновляется без него: при запуске приложения (в том числе после
//! самообновления), раз в час вместе со списками и по кнопке в настройках.
//!
//! Архивы раздаёт панель с того же origin, что и подписка. Скачиваем оба (Chrome и
//! Firefox собираются по-разному), меняем папку только если sha256 архива другой,
//! и меняем атомарно: распаковка рядом, потом переименование. Если папку держит
//! браузер и переименовать нельзя — переписываем файлы на месте.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const KINDS: [&str; 2] = ["chrome", "firefox"];
/// Архив расширения — десятки килобайт; больше нескольких мегабайт — точно не он.
const MAX_ZIP: usize = 5 * 1024 * 1024;

pub fn dir() -> PathBuf {
    crate::store::dir().join("extension")
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtKind {
    pub kind: String,
    pub path: String,
    pub version: Option<String>,
    pub installed: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtInfo {
    pub dir: String,
    pub items: Vec<ExtKind>,
    /// Какие папки только что обновились (после синхронизации).
    pub updated: Vec<String>,
    pub error: Option<String>,
}

fn read_version(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join("manifest.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("version")?.as_str().map(str::to_string)
}

fn kind_info(kind: &str) -> ExtKind {
    let p = dir().join(kind);
    let version = read_version(&p);
    ExtKind {
        kind: kind.to_string(),
        path: p.to_string_lossy().into_owned(),
        installed: version.is_some(),
        version,
    }
}

pub fn info() -> ExtInfo {
    ExtInfo {
        dir: dir().to_string_lossy().into_owned(),
        items: KINDS.iter().map(|k| kind_info(k)).collect(),
        updated: Vec::new(),
        error: None,
    }
}

fn sha_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Общий корневой каталог архива, если он есть: некоторые архиваторы кладут файлы
/// в `novpn-extension/…`. Браузеру нужен manifest.json в корне папки, поэтому
/// такой префикс срезаем.
fn common_root(names: &[String]) -> Option<String> {
    if names.iter().any(|n| n == "manifest.json") {
        return None;
    }
    let mut root: Option<String> = None;
    for n in names {
        let first = n.split('/').next().unwrap_or("").to_string();
        if first.is_empty() || !n.contains('/') {
            return None;
        }
        match &root {
            None => root = Some(first),
            Some(r) if *r != first => return None,
            _ => {}
        }
    }
    root
}

/// Распаковывает архив в `target` (папка пересоздаётся). Пути берём только через
/// `enclosed_name`: записи с `..` или абсолютным путём молча пропускаем — архив
/// приходит по сети, и доверять его именам файлов нельзя.
pub fn unpack(bytes: &[u8], target: &Path) -> Result<(), String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("архив не читается: {e}"))?;
    let names: Vec<String> = (0..z.len())
        .filter_map(|i| z.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let root = common_root(&names);
    if target.exists() {
        fs::remove_dir_all(target).map_err(|e| format!("не удалось очистить папку: {e}"))?;
    }
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = f.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };
        let rel = match &root {
            Some(r) => match rel.strip_prefix(r) {
                Ok(p) => p.to_path_buf(),
                Err(_) => continue,
            },
            None => rel,
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = target.join(&rel);
        if f.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        fs::write(&out, &buf).map_err(|e| format!("не удалось записать {}: {e}", rel.display()))?;
    }
    if !target.join("manifest.json").exists() {
        return Err("в архиве нет manifest.json".into());
    }
    Ok(())
}

fn copy_over(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let dest = to.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_over(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), &dest)
                .map_err(|e| format!("не удалось обновить {}: {e}", dest.display()))?;
        }
    }
    Ok(())
}

/// Ставит распакованную в `staged` папку на место `kind`.
fn swap_in(kind: &str, staged: &Path) -> Result<(), String> {
    let live = dir().join(kind);
    let old = dir().join(format!("{kind}.old"));
    let _ = fs::remove_dir_all(&old);
    if live.exists() && fs::rename(&live, &old).is_err() {
        // Папку держит браузер — переписываем файлы на месте.
        copy_over(staged, &live)?;
        let _ = fs::remove_dir_all(staged);
        return Ok(());
    }
    if let Err(e) = fs::rename(staged, &live) {
        // Вернуть старую, чтобы не остаться без расширения.
        let _ = fs::rename(&old, &live);
        return Err(format!("не удалось заменить папку: {e}"));
    }
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

/// true — папка обновлена; false — архив тот же и папка на месте.
fn install_if_changed(kind: &str, bytes: &[u8]) -> Result<bool, String> {
    let root = dir();
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let sha_file = root.join(format!("{kind}.sha256"));
    let sha = sha_hex(bytes);
    let same = fs::read_to_string(&sha_file).map(|s| s.trim() == sha).unwrap_or(false);
    if same && root.join(kind).join("manifest.json").exists() {
        return Ok(false);
    }
    let staged = root.join(format!("{kind}.new"));
    unpack(bytes, &staged)?;
    swap_in(kind, &staged)?;
    fs::write(&sha_file, &sha).map_err(|e| e.to_string())?;
    Ok(true)
}

async fn fetch(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let r = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("сервер ответил {}", r.status().as_u16()));
    }
    let b = r.bytes().await.map_err(|e| format!("загрузка прервалась ({e})"))?;
    if b.len() > MAX_ZIP {
        return Err("архив подозрительно большой".into());
    }
    if b.len() < 4 || &b[..2] != b"PK" {
        return Err("сервер отдал не zip-архив".into());
    }
    Ok(b.to_vec())
}

/// Что лежит в папке сейчас — без обращения к сети.
#[tauri::command]
pub fn extension_info() -> ExtInfo {
    info()
}

/// Скачать архивы с панели и обновить папки, если они изменились.
#[tauri::command]
pub async fn extension_sync(origin: String) -> Result<ExtInfo, String> {
    let origin = origin.trim().trim_end_matches('/').to_string();
    if !(origin.starts_with("https://") || origin.starts_with("http://")) {
        return Err("Некорректный адрес панели".into());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    let mut updated = Vec::new();
    let mut errors = Vec::new();
    for kind in KINDS {
        let url = format!("{origin}/extension/novpn-extension-{kind}.zip");
        match fetch(&client, &url).await {
            Ok(bytes) => match install_if_changed(kind, &bytes) {
                Ok(true) => updated.push(kind.to_string()),
                Ok(false) => {}
                Err(e) => errors.push(format!("{kind}: {e}")),
            },
            Err(e) => errors.push(format!("{kind}: {e}")),
        }
    }
    let mut out = info();
    out.updated = updated;
    out.error = (!errors.is_empty()).then(|| errors.join("; "));
    Ok(out)
}

/// Открыть папку расширения в проводнике — её человек указывает браузеру.
#[tauri::command]
pub fn open_extension_dir(kind: String) -> Result<(), String> {
    let target = if KINDS.contains(&kind.as_str()) { dir().join(&kind) } else { dir() };
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    crate::cmds::open_in_explorer(&target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn archive(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            for (name, body) in entries {
                w.start_file(*name, SimpleFileOptions::default()).unwrap();
                w.write_all(body.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("novpn-ext-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn unpacks_flat_archive() {
        let z = archive(&[("manifest.json", r#"{"version":"0.2.0"}"#), ("icons/16.png", "png")]);
        let t = tmp("flat");
        unpack(&z, &t).unwrap();
        assert_eq!(read_version(&t).as_deref(), Some("0.2.0"));
        assert!(t.join("icons/16.png").exists());
        let _ = fs::remove_dir_all(&t);
    }

    #[test]
    fn strips_common_root_folder() {
        let z = archive(&[("novpn/manifest.json", r#"{"version":"0.3.0"}"#), ("novpn/background.js", "x")]);
        let t = tmp("root");
        unpack(&z, &t).unwrap();
        assert_eq!(read_version(&t).as_deref(), Some("0.3.0"));
        assert!(t.join("background.js").exists());
        assert!(!t.join("novpn").exists());
        let _ = fs::remove_dir_all(&t);
    }

    #[test]
    fn rejects_archive_without_manifest() {
        let z = archive(&[("readme.txt", "hi")]);
        let t = tmp("nomanifest");
        assert!(unpack(&z, &t).is_err());
        let _ = fs::remove_dir_all(&t);
    }

    #[test]
    fn common_root_detection() {
        assert_eq!(common_root(&["a/x".into(), "a/y/z".into()]).as_deref(), Some("a"));
        assert_eq!(common_root(&["manifest.json".into(), "a/x".into()]), None);
        assert_eq!(common_root(&["a/x".into(), "b/y".into()]), None);
        assert_eq!(common_root(&["a/x".into(), "y".into()]), None);
    }
}
