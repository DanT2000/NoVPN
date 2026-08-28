//! Настоящие приложения на машине: установленные и запущенные.
//!
//! Раньше эти списки были выдуманы (Obsidian, Spotify — у кого-то их нет). Здесь
//! всё берётся с реальной машины: установленные — из реестра деинсталляции,
//! запущенные — из живых процессов. По ним человек выбирает, что пустить через
//! VPN, а маршрутизация Mihomo работает по ИМЕНИ ПРОЦЕССА, поэтому главное для
//! нас — имя исполняемого файла.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppItem {
    /// Человеческое имя.
    pub name: String,
    /// Имена процессов (файлов .exe) — то, по чему маршрутизирует движок.
    pub processes: Vec<String>,
    /// Полный путь, если известен (для расширенного режима).
    pub path: Option<String>,
    /// Запущено ли прямо сейчас.
    pub running: bool,
}

/// Служебные и системные процессы, которые незачем показывать человеку.
const NOISE: &[&str] = &[
    "svchost.exe",
    "runtimebroker.exe",
    "dllhost.exe",
    "conhost.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "smss.exe",
    "fontdrvhost.exe",
    "dwm.exe",
    "sihost.exe",
    "taskhostw.exe",
    "ctfmon.exe",
    "explorer.exe",
    "searchhost.exe",
    "startmenuexperiencehost.exe",
    "textinputhost.exe",
    "shellexperiencehost.exe",
    "applicationframehost.exe",
    "systemsettings.exe",
    "backgroundtaskhost.exe",
    "smartscreen.exe",
    "audiodg.exe",
    "spoolsv.exe",
    "wmiprvse.exe",
    "registry",
    "memory compression",
    "system",
    "system idle process",
    "mihomo.exe",
    "novpn-desktop.exe",
];

fn is_noise(exe: &str) -> bool {
    let low = exe.to_lowercase();
    if NOISE.contains(&low.as_str()) {
        return true;
    }
    // Вспомогательные процессы и установщики маршрутизировать незачем.
    low.ends_with("host.exe")
        || low.ends_with("service.exe")
        || low.ends_with("svc.exe")
        || low.contains("setup")
        || low.contains("installer")
        || low == "update.exe"
        || low.contains("crashpad")
        || low.contains("crashhandler")
        || low.contains("watchdog")
        || low.contains("helper")
        || low.contains("broker")
        || low == "maintenancetool.exe"
}

/// Известные приложения → их настоящие имена процессов. Discord и GitHub Desktop
/// прописывают в реестр `Update.exe`, а трафик идёт через `Discord.exe` — по нему
/// и правило.
fn known_processes(name: &str) -> Option<Vec<String>> {
    let n = name.to_lowercase();
    let table: &[(&str, &[&str])] = &[
        ("discord", &["Discord.exe"]),
        ("telegram", &["Telegram.exe"]),
        ("github desktop", &["GitHubDesktop.exe"]),
        ("visual studio code", &["Code.exe"]),
        ("vs code", &["Code.exe"]),
        ("docker desktop", &["Docker Desktop.exe", "com.docker.backend.exe"]),
        ("epic games", &["EpicGamesLauncher.exe"]),
        ("steam", &["steam.exe"]),
        ("spotify", &["Spotify.exe"]),
        ("whatsapp", &["WhatsApp.exe"]),
        ("signal", &["Signal.exe"]),
        ("slack", &["slack.exe"]),
        ("obsidian", &["Obsidian.exe"]),
        ("cursor", &["Cursor.exe"]),
        ("figma", &["Figma.exe"]),
        ("notion", &["Notion.exe"]),
    ];
    for (key, procs) in table {
        // Совпадение по границе слова, а не по любой подстроке: иначе «X» матчил
        // бы половину имён, а случайное «...steam...» подменяло бы процесс.
        let matches = n == *key
            || n.starts_with(&format!("{key} "))
            || n.ends_with(&format!(" {key}"))
            || n.contains(&format!(" {key} "));
        if matches {
            return Some(procs.iter().map(|p| p.to_string()).collect());
        }
    }
    None
}

/// Красивое имя из канонического процесса: «Discord.exe» → «Discord».
fn canonical_name(exe: &str) -> String {
    pretty_from_exe(exe)
}

fn pretty_from_exe(exe: &str) -> String {
    let stem = Path::new(exe).file_stem().and_then(|s| s.to_str()).unwrap_or(exe);
    // «Discord» из «Discord.exe», «VS Code» из «Code» — грубо, но узнаваемо.
    let mut c = stem.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => stem.to_string(),
    }
}

/// Запущенные процессы, свёрнутые по имени файла. Один Discord показывается
/// один раз, даже если у него пять вспомогательных процессов.
pub fn running() -> Vec<AppItem> {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};
    let sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::new()),
    );

    let mut by_exe: BTreeMap<String, AppItem> = BTreeMap::new();
    for proc in sys.processes().values() {
        let exe_name = proc.name().to_string_lossy().to_string();
        if exe_name.is_empty() || is_noise(&exe_name) {
            continue;
        }
        let path = proc.exe().map(|p| p.to_string_lossy().to_string());
        let pretty = pretty_from_exe(&exe_name);
        let processes = known_processes(&pretty).unwrap_or_else(|| vec![exe_name.clone()]);
        // Схлопываем по каноническому процессу: Discord и его вспомогательные
        // процессы (если что-то просочилось) — одна строка, не пять.
        let key = processes[0].to_lowercase();
        by_exe.entry(key).or_insert(AppItem {
            name: known_processes(&pretty)
                .map(|_| canonical_name(&processes[0]))
                .unwrap_or(pretty),
            processes,
            path,
            running: true,
        });
    }
    by_exe.into_values().collect()
}

/// Установленные программы из реестра деинсталляции. Отсекаем обновления,
/// системные компоненты и записи без пути к приложению.
#[cfg(windows)]
pub fn installed() -> Vec<AppItem> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
    use winreg::RegKey;

    let roots = [
        (HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY),
        (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY),
        (HKEY_CURRENT_USER, KEY_WOW64_64KEY),
    ];
    const PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";

    let mut by_name: BTreeMap<String, AppItem> = BTreeMap::new();
    for (hive, flag) in roots {
        let Ok(base) = RegKey::predef(hive).open_subkey_with_flags(PATH, KEY_READ | flag) else {
            continue;
        };
        for sub in base.enum_keys().flatten() {
            let Ok(k) = base.open_subkey_with_flags(&sub, KEY_READ | flag) else {
                continue;
            };
            let name: String = k.get_value("DisplayName").unwrap_or_default();
            if name.trim().is_empty() {
                continue;
            }
            // Системные и служебные записи человеку не нужны.
            if k.get_value::<u32, _>("SystemComponent").unwrap_or(0) == 1 {
                continue;
            }
            if k.get_value::<String, _>("ParentKeyName").is_ok() {
                continue; // обновление/патч
            }
            let low = name.to_lowercase();
            // Отсекаем только явно системное/служебное. Раньше фильтр по
            // подстрокам «update/runtime/driver» выкидывал и нормальные
            // программы (например с «Update» в названии) — теперь точнее.
            if low.contains("redistributable")
                || low.contains(" runtime")
                || low.ends_with("runtime")
                || low.contains(" driver")
                || low.ends_with("driver")
                || low.starts_with("microsoft visual c++")
                || low.starts_with("microsoft .net")
                || low.starts_with("windows software development")
                || low.starts_with("windows sdk")
                || low.contains("hotfix")
                || low.starts_with("security update")
                || low.starts_with("update for")
            {
                continue;
            }

            let exe = exe_from_reg(&k);
            let detected = exe
                .as_ref()
                .and_then(|p| Path::new(p).file_name().map(|f| f.to_string_lossy().to_string()));

            // Для известных приложений имя процесса берём из таблицы — реестр у
            // них часто указывает на служебный exe, по которому правило не сработает.
            let processes = match known_processes(&name) {
                Some(procs) => procs,
                None => match detected {
                    Some(ref e) if !is_noise(e) => vec![e.clone()],
                    // Неизвестное приложение без внятного exe маршрутизировать
                    // по «Update.exe» бессмысленно — пропускаем.
                    _ => continue,
                },
            };

            by_name.entry(low).or_insert(AppItem {
                name: name.trim().to_string(),
                processes,
                path: exe,
                running: false,
            });
        }
    }
    let mut v: Vec<AppItem> = by_name.into_values().collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    v
}

/// Достаём путь к .exe из записи деинсталляции: сначала DisplayIcon (обычно
/// указывает прямо на исполняемый файл), затем InstallLocation.
#[cfg(windows)]
fn exe_from_reg(k: &winreg::RegKey) -> Option<String> {
    if let Ok(icon) = k.get_value::<String, _>("DisplayIcon") {
        let path = icon.split(',').next().unwrap_or(&icon).trim().trim_matches('"');
        if path.to_lowercase().ends_with(".exe") && Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    if let Ok(loc) = k.get_value::<String, _>("InstallLocation") {
        let loc = loc.trim().trim_matches('"');
        if !loc.is_empty() {
            if let Some(exe) = first_exe_in(Path::new(loc)) {
                return Some(exe);
            }
        }
    }
    None
}

/// Первый подходящий .exe в папке установки — без рекурсии вглубь, чтобы не
/// перебирать тысячи файлов у крупных пакетов.
#[cfg(windows)]
fn first_exe_in(dir: &Path) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut candidates: Vec<String> = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("exe")) == Some(true) {
            let name = p.file_name()?.to_string_lossy().to_lowercase();
            // Пропускаем деинсталляторы и вспомогательные.
            if name.contains("unins") || name.contains("setup") || name.contains("crash") {
                continue;
            }
            candidates.push(p.to_string_lossy().to_string());
        }
    }
    // Берём самый большой .exe: обычно это и есть основное приложение.
    candidates.into_iter().max_by_key(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
}

#[cfg(not(windows))]
pub fn installed() -> Vec<AppItem> {
    Vec::new()
}
