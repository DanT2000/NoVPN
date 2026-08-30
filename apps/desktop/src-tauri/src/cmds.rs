//! Команды, доступные интерфейсу.

use crate::core::{self, DomainRule, Engine, Ports, Rules};
use crate::apps;
use crate::autostart;
use crate::elevate;
use crate::lists;
use crate::proxy;
use crate::store;
use crate::sub::{self, Parsed};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;

/// Живой движок. Отдельно от прочего состояния: его нельзя ни сериализовать,
/// ни потерять при перерисовке интерфейса.
///
/// `.0` — сам движок. `.1` — замок подключения: держится на всё время
/// `vpn_connect`, чтобы два подключения (например авто-переподключение и клик
/// человека) не наложились. Иначе провалившаяся параллельная попытка могла бы
/// вернуть системный прокси и сломать уже живое соединение.
#[derive(Default)]
pub struct Running(pub Mutex<Option<Engine>>, pub Mutex<()>);

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    pub server: String,
    pub port: u64,
    pub kind: String,
    /// Профиль панели NoVPN (из meta.novpn конфига). У чужих подписок — None.
    pub profile_id: Option<String>,
    pub server_id: Option<String>,
    /// `smart` | `full`. Без meta.novpn — всегда smart.
    pub mode: String,
}

#[derive(Debug, Serialize)]
pub struct SubResult {
    pub servers: Vec<ServerInfo>,
    /// Как провайдер отдал подписку — показываем в расширенном режиме.
    pub format: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesIn {
    /// По умолчанию true: приложение без умной маршрутизации бессмысленно.
    #[serde(default = "yes")]
    pub smart: bool,
    /// Режим сетевого адаптера. По умолчанию выключен: он требует прав
    /// администратора, а окно должно открываться и без них.
    #[serde(default)]
    pub tunnel: bool,
    /// Серверная политика приватных подсетей из meta.json: false — LAN напрямую,
    /// true — LAN в туннель. По умолчанию false (и для чужих подписок без meta).
    #[serde(default)]
    pub lan_access: bool,
    #[serde(default)]
    pub bypass_local: bool,
    #[serde(default)]
    pub custom_local: Vec<String>,
    #[serde(default)]
    pub dns_provider: String,
    /// Домены, заданные человеком, уже в порядке важности.
    #[serde(default)]
    pub user_domains: Vec<DomainRuleIn>,
    #[serde(default)]
    pub list_direct_domains: Vec<String>,
    #[serde(default)]
    pub list_vpn_domains: Vec<String>,
    #[serde(default)]
    pub list_vpn_full: Vec<String>,
    #[serde(default)]
    pub list_vpn_keywords: Vec<String>,
    #[serde(default)]
    pub list_vpn_regex: Vec<String>,
    #[serde(default)]
    pub list_vpn_ips: Vec<String>,
    #[serde(default)]
    pub vpn_processes: Vec<String>,
    #[serde(default)]
    pub direct_processes: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct DomainRuleIn {
    pub domain: String,
    /// «vpn» или «direct» — других маршрутов в приложении не бывает.
    pub route: String,
}

fn yes() -> bool {
    true
}

impl From<RulesIn> for Rules {
    fn from(r: RulesIn) -> Self {
        Rules {
            smart: r.smart,
            lan_access: r.lan_access,
            tunnel: r.tunnel,
            bypass_local: r.bypass_local,
            custom_local: r.custom_local,
            dns_provider: if r.dns_provider.is_empty() { "cloudflare".into() } else { r.dns_provider },
            user_domains: r
                .user_domains
                .into_iter()
                .map(|d| DomainRule {
                    domain: d.domain,
                    vpn: d.route == "vpn",
                })
                .collect(),
            list_direct_domains: r.list_direct_domains,
            list_vpn_domains: r.list_vpn_domains,
            list_vpn_full: r.list_vpn_full,
            list_vpn_keywords: r.list_vpn_keywords,
            list_vpn_regex: r.list_vpn_regex,
            list_vpn_ips: r.list_vpn_ips,
            vpn_processes: r.vpn_processes,
            direct_processes: r.direct_processes,
        }
    }
}

fn describe(parsed: &Parsed) -> (Vec<ServerInfo>, String) {
    match parsed {
        Parsed::Nodes(nodes) => (
            nodes
                .iter()
                .map(|n| ServerInfo {
                    name: n.name.clone(),
                    server: n
                        .map
                        .get(serde_yaml::Value::String("server".into()))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    port: n
                        .map
                        .get(serde_yaml::Value::String("port".into()))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    kind: n
                        .map
                        .get(serde_yaml::Value::String("type".into()))
                        .and_then(|v| v.as_str())
                        .unwrap_or("vless")
                        .to_string(),
                    profile_id: n.profile.as_ref().map(|p| p.profile_id.clone()),
                    server_id: n.profile.as_ref().map(|p| p.server_id.clone()),
                    mode: n.profile.as_ref().map(|p| p.mode.clone()).unwrap_or_else(|| "smart".into()),
                })
                .collect(),
            "ссылки".into(),
        ),
        Parsed::Clash(v) => (
            v.get("proxies")
                .and_then(|p| p.as_sequence())
                .map(|seq| {
                    seq.iter()
                        .map(|p| ServerInfo {
                            name: p.get("name").and_then(|x| x.as_str()).unwrap_or("Сервер").to_string(),
                            server: p.get("server").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
                            port: p.get("port").and_then(|x| x.as_u64()).unwrap_or(0),
                            kind: p.get("type").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
                            profile_id: None,
                            server_id: None,
                            mode: "smart".into(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            "Clash".into(),
        ),
    }
}

/// Скачивает подписку и разбирает её. Сырой текст сохраняем — он понадобится,
/// чтобы подняться без сети.
#[tauri::command]
pub async fn sub_fetch(url: String) -> Result<SubResult, String> {
    let client = reqwest::Client::builder()
        .user_agent(sub::USER_AGENT)
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Не удалось получить подписку: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Сервер подписки ответил {}", resp.status().as_u16()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let parsed = sub::parse(&text)?;
    let (servers, format) = describe(&parsed);
    if servers.is_empty() {
        return Err("В подписке не нашлось ни одного сервера".into());
    }
    store::write_raw("subscription.txt", &text)?;
    Ok(SubResult { servers, format })
}

/// Разбирает уже сохранённую подписку — для запуска без интернета.
#[tauri::command]
pub fn sub_cached() -> Result<SubResult, String> {
    let text = store::read_raw("subscription.txt").ok_or("Подписка ещё не сохранена")?;
    let parsed = sub::parse(&text)?;
    let (servers, format) = describe(&parsed);
    Ok(SubResult { servers, format })
}

pub fn locate_engine_pub() -> Result<PathBuf, String> {
    locate_engine()
}

fn locate_engine() -> Result<PathBuf, String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(p) = exe.parent() {
            dirs.push(p.to_path_buf());
        }
    }
    // При разработке движок лежит в исходниках, рядом со сборкой его ещё нет.
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("bin"));
        dirs.push(cwd.join("src-tauri").join("bin"));
    }
    for d in dirs {
        let p = core::engine_path(&d);
        if p.exists() {
            return Ok(p);
        }
    }
    Err("Не найден движок подключения. Переустановите приложение.".into())
}

/// Имя файла с прежними настройками прокси. Лежит на диске, а не в памяти:
/// если приложение упадёт, настройку всё равно нужно будет вернуть.
const PROXY_BACKUP: &str = "proxy-backup";

fn make_config(selected: Option<&str>, rules: RulesIn, ports: Ports) -> Result<String, String> {
    let text = store::read_raw("subscription.txt").ok_or("Сначала подключите подписку")?;
    let parsed = sub::parse(&text)?;
    Ok(core::build_config(&parsed, &rules.into(), selected, ports))
}

/// Установленные программы — из реестра. Тяжёлая операция, поэтому async.
#[tauri::command]
pub async fn apps_installed() -> Vec<apps::AppItem> {
    tokio::task::spawn_blocking(apps::installed).await.unwrap_or_default()
}

/// Запущенные сейчас процессы, свёрнутые по имени файла.
#[tauri::command]
pub async fn apps_running() -> Vec<apps::AppItem> {
    tokio::task::spawn_blocking(apps::running).await.unwrap_or_default()
}

/// Автозапуск: читаем настоящее состояние (ключ реестра ИЛИ задача
/// планировщика), а не сохранённое в файле — человек мог убрать его вручную.
#[tauri::command]
pub fn autostart_get() -> bool {
    autostart::any_enabled()
}

/// Приводит автозапуск к нужному виду с учётом режима адаптера. В режиме TUN и с
/// правами — тихий elevated-автозапуск через планировщик; иначе обычный.
#[tauri::command]
pub fn autostart_sync(autostart: bool, tunnel: bool) -> Result<(), String> {
    autostart::sync(autostart, tunnel, elevate::is_elevated())
}

/// Настроен ли тихий elevated-автозапуск (задача планировщика). По нему
/// интерфейс понимает, что повторный запрос прав больше не нужен.
#[tauri::command]
pub fn autostart_has_task() -> bool {
    autostart::task_exists()
}

/// Вызывается при старте: восстанавливает верный вид автозапуска по сохранённым
/// настройкам. Путь к exe меняется при обновлении — задачу и ключ надо обновить.
pub fn sync_autostart_on_start() {
    let settings = store::read("state").and_then(|v| v.get("settings").cloned());
    let get = |k: &str, d: bool| {
        settings
            .as_ref()
            .and_then(|s| s.get(k))
            .and_then(|v| v.as_bool())
            .unwrap_or(d)
    };
    let autostart = get("autostart", true);
    let tunnel = get("tunnel", false);
    let _ = autostart::sync(autostart, tunnel, elevate::is_elevated());
}

/// Есть ли у приложения права администратора. Нужны только режиму адаптера.
#[tauri::command]
pub fn is_elevated() -> bool {
    elevate::is_elevated()
}

/// Перезапускает приложение с запросом прав.
#[tauri::command]
pub fn relaunch_elevated(app: tauri::AppHandle) -> Result<(), String> {
    // Сначала запрашиваем повышение. Если человек отказал в UAC, relaunch()
    // вернёт Err — и мы НЕ трогаем настройку и НЕ выходим: остаёмся в прежнем
    // (рабочем) режиме прокси. Раньше флаг tunnel писался до запроса, и отказ
    // оставлял приложение в режиме адаптера без прав — с вечной ошибкой.
    elevate::relaunch()?;
    // Повышение согласовано, старый процесс сейчас закроется. Фиксируем режим
    // адаптера на диске — повышенный экземпляр (он ждёт нашего выхода по
    // --await-pid) прочитает его уже после нас и создаст тихий автозапуск.
    let _ = store::set_settings_flag("tunnel", true);
    shutdown(&app);
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn vpn_connect(
    running: tauri::State<'_, Running>,
    selected: Option<String>,
    rules: RulesIn,
) -> Result<(), String> {
    // Сериализуем подключение целиком: замок держится до конца функции, поэтому
    // второе подключение (авто-переподключение либо повторный клик) дождётся
    // первого и не станет менять общий системный прокси у него из-под ног.
    let _connect = running.1.lock().map_err(|_| "Внутренняя ошибка состояния")?;

    let ports = Ports::default();
    let tunnel = rules.tunnel;
    // Права проверяем до запуска движка: иначе он поднимется, не сможет
    // создать адаптер и оставит человека с «подключено» без подключения.
    if tunnel && !elevate::is_elevated() {
        return Err("Режим адаптера требует прав администратора. Перезапустите приложение с ними или выключите режим в настройках.".into());
    }
    let config = make_config(selected.as_deref(), rules, ports)?;
    let exe = locate_engine()?;

    // Старый движок забираем под коротким замком и СРАЗУ отпускаем его: запуск
    // нового занимает секунды, и держать замок всё это время значило бы вешать
    // disconnect и опрос «жив ли» на время подключения.
    {
        let mut guard = running.0.lock().map_err(|_| "Внутренняя ошибка состояния")?;
        if let Some(mut old) = guard.take() {
            old.stop();
        }
    }
    core::wait_port_free(ports.mixed, std::time::Duration::from_secs(5));

    // Запускаем БЕЗ замка.
    let engine = match Engine::start(&exe, &store::engine_dir(), &config, ports.mixed, ports.controller) {
        Ok(e) => e,
        Err(e) => {
            // Старый движок уже погашен, а новый не поднялся — системный прокси
            // мог остаться указывать на мёртвый порт. Возвращаем его.
            restore_proxy();
            return Err(e);
        }
    };

    // В режиме адаптера системный прокси не трогаем: трафик и так весь наш,
    // а лишняя настройка увела бы его по кругу через самих себя.
    if !tunnel {
        if store::read(PROXY_BACKUP).is_none() {
            let saved = proxy::read();
            let _ = store::write(PROXY_BACKUP, &serde_json::to_value(&saved).unwrap_or(Value::Null));
            // Дубль бэкапа в реестр — его сможет прочитать деинсталлятор (NSIS
            // не разбирает JSON) и вернуть прежний прокси при удалении «на ходу».
            proxy::save_registry_backup(&saved);
        }
        if let Err(e) = proxy::set(ports.mixed) {
            // set мог примениться частично — прокси уже мог указывать на наш
            // порт. Возвращаем прежнее состояние, иначе останемся без интернета.
            let mut eng = engine;
            eng.stop();
            restore_proxy();
            return Err(e);
        }
    } else {
        // Переключились в режим адаптера — прежний системный прокси, если мы его
        // ставили, больше не нужен: возвращаем его пользователю.
        restore_proxy();
    }

    // Сохраняем движок. Если замок отравлен — гасим движок и возвращаем прокси,
    // иначе человек остался бы с «мёртвым» прокси и без интернета.
    match running.0.lock() {
        Ok(mut guard) => *guard = Some(engine),
        Err(_) => {
            let mut eng = engine;
            eng.stop();
            if !tunnel {
                restore_proxy();
            }
            return Err("Внутренняя ошибка состояния".into());
        }
    }
    Ok(())
}

/// Применяет изменённые правила к работающему движку.
///
/// Вызывается всякий раз, когда человек добавил сайт или переключил маршрут
/// приложения. Без этого правило лежало бы мёртвым до следующего подключения,
/// и выглядело бы это как «добавил, а не работает».
#[tauri::command]
pub fn vpn_reload(
    running: tauri::State<'_, Running>,
    selected: Option<String>,
    rules: RulesIn,
) -> Result<(), String> {
    let ports = Ports::default();
    // Если движок не поднят, применять нечего: правила уйдут в конфиг при
    // следующем подключении.
    {
        let mut guard = running.0.lock().map_err(|_| "Внутренняя ошибка состояния")?;
        let up = match guard.as_mut() {
            Some(e) => e.alive(),
            None => false,
        };
        if !up {
            return Ok(());
        }
    }

    let config = make_config(selected.as_deref(), rules, ports)?;
    let dir = store::engine_dir();
    let path = dir.join("config.yaml");
    std::fs::write(&path, &config).map_err(|e| format!("Не удалось записать конфиг: {e}"))?;
    core::reload(ports.controller, &path)?;
    // Переключение сервера на подключённом клиенте: reload сохраняет прежний выбор
    // группы select, поэтому явно указываем движку новый сервер — иначе смена
    // сервера не срабатывала бы без ручного «Отключить». Best-effort: если выбор
    // не задан или переключить не вышло, правила всё равно применены.
    if let Some(name) = selected.as_deref() {
        let _ = core::select_proxy(ports.controller, core::GROUP, name);
    }
    Ok(())
}

/// Возвращает системный прокси в то состояние, в котором мы его застали.
fn restore_proxy() {
    if let Some(v) = store::read(PROXY_BACKUP) {
        match serde_json::from_value::<proxy::Saved>(v) {
            // Бэкап удаляем ТОЛЬКО если восстановление удалось. Иначе оставляем
            // файл: следующая попытка (или очистка при старте) вернёт прокси.
            // Стереть его сейчас — значит потерять единственную запись о прежнем
            // прокси и оставить систему указывать на наш мёртвый порт.
            Ok(saved) if proxy::restore(&saved).is_err() => return,
            Ok(_) => {}
            Err(_) => {} // мусор в бэкапе — просто удалим ниже
        }
    }
    let _ = std::fs::remove_file(store::dir().join(format!("{PROXY_BACKUP}.json")));
    proxy::clear_registry_backup();
}

#[tauri::command]
pub fn vpn_disconnect(running: tauri::State<'_, Running>) -> Result<(), String> {
    let mut guard = running.0.lock().map_err(|_| "Внутренняя ошибка состояния")?;
    if let Some(mut e) = guard.take() {
        e.stop();
    }
    restore_proxy();
    Ok(())
}

/// Вызывается при запуске приложения: если прошлый сеанс завершился падением,
/// системный прокси остался указывать на несуществующий порт, и интернет у
/// человека просто не работает. Возвращаем настройку до того, как он это
/// заметит.
pub fn cleanup_after_crash() {
    // Осиротевший после падения mihomo.exe продолжает жить и держит порт —
    // новый экземпляр не смог бы занять его, а проверка «наш ли движок»
    // цеплялась бы к старому. Гасим таких до всего остального.
    kill_stray_engines();
    restore_proxy();
}

/// Завершает НАШ движок, оставшийся от прошлого сеанса. Берём PID из файла,
/// который пишет `Engine::start`, — так убиваем именно свой процесс, а чужой
/// clash/mihomo с тем же именем не трогаем.
fn kill_stray_engines() {
    let pid_path = store::engine_dir().join(core::PID_NAME);
    if let Ok(text) = std::fs::read_to_string(&pid_path) {
        if let Ok(pid) = text.trim().parse::<u32>() {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                // Windows переиспользует PID: к нашему запуску этот номер мог
                // достаться постороннему процессу. Убиваем ТОЛЬКО если это
                // действительно mihomo — фильтром сразу по PID И по имени образа.
                let killed = std::process::Command::new("taskkill")
                    .args([
                        "/F",
                        "/FI",
                        &format!("PID eq {pid}"),
                        "/FI",
                        "IMAGENAME eq mihomo.exe",
                    ])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
                // На случай имени с триплетом (dev-сборка) — второй фильтр.
                if killed
                    .as_ref()
                    .map(|o| !String::from_utf8_lossy(&o.stdout).contains("SUCCESS"))
                    .unwrap_or(true)
                {
                    let _ = std::process::Command::new("taskkill")
                        .args([
                            "/F",
                            "/FI",
                            &format!("PID eq {pid}"),
                            "/FI",
                            "IMAGENAME eq mihomo-x86_64-pc-windows-msvc.exe",
                        ])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                }
            }
        }
    }
    let _ = std::fs::remove_file(&pid_path);
}

/// Аккуратное завершение: гасим движок и возвращаем системный прокси.
/// Без этого выход из приложения оставлял бы человека без интернета — прокси
/// продолжал бы указывать на порт, которого больше нет.
pub fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<Running>() {
        if let Ok(mut g) = state.0.lock() {
            if let Some(mut e) = g.take() {
                e.stop();
            }
        }
    }
    restore_proxy();
}

/// Движок может упасть сам — интерфейс обязан это заметить, а не показывать
/// «Подключено» поверх мёртвого процесса.
#[tauri::command]
pub fn vpn_alive(running: tauri::State<'_, Running>) -> bool {
    let mut guard = match running.0.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    match guard.as_mut() {
        Some(e) => {
            let ok = e.alive();
            if !ok {
                *guard = None;
            }
            ok
        }
        None => false,
    }
}

/// Реальная проверка связи с сервером ЧЕРЕЗ туннель (не просто «движок жив»).
/// `true` — сервер отвечает; `false` — связи нет (сервер недоступен/заблокирован),
/// даже если процесс движка слушает порт. Интерфейс по этому сигналу
/// переподключается и отличает «подключено» от «реально работает».
#[tauri::command]
pub fn vpn_probe(running: tauri::State<'_, Running>) -> bool {
    // Движок должен быть поднят — иначе проверять нечего.
    {
        let mut guard = match running.0.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        let up = match guard.as_mut() {
            Some(e) => e.alive(),
            None => false,
        };
        if !up {
            return false;
        }
    }
    let ports = Ports::default();
    // gstatic generate_204 — лёгкий и стабильно доступный из большинства сетей.
    core::proxy_delay(ports.controller, core::GROUP, "http://www.gstatic.com/generate_204", 4000).is_ok()
}

/// Порт локального прокси — его показываем в расширенном режиме и отдаём
/// расширению браузера.
#[tauri::command]
pub fn vpn_port() -> u16 {
    Ports::default().mixed
}

/// Обновляет списки маршрутизации с сервера NoVPN. Адрес панели берём из
/// адреса подписки: отдельного поля для него человек заполнять не должен.
#[tauri::command]
pub async fn lists_sync() -> Result<lists::Lists, String> {
    let url = store::read("state")
        .and_then(|v| v.pointer("/subscription/url").and_then(|x| x.as_str()).map(String::from))
        .ok_or("Сначала подключите подписку")?;
    let base = lists::base_of(&url).ok_or("Не удалось определить адрес сервера из подписки")?;
    lists::sync(&base).await
}

/// Списки, уже лежащие на диске. Читаются при запуске — без обращения к сети.
#[tauri::command]
pub fn lists_load() -> lists::Lists {
    lists::load()
}

/// Метаданные подписки (профили и их режимы) с панели — по тому же sub-токену,
/// что в ссылке подписки. Никогда не бросает: отказ панели (4xx), «панель не
/// ответила» (кэш) и «старая панель / чужой провайдер» (нет meta) — это разные
/// исходы одного результата, интерфейс их различает.
#[tauri::command]
pub async fn meta_fetch(url: Option<String>) -> crate::meta::MetaResult {
    let sub_url = url.or_else(|| {
        store::read("state").and_then(|v| v.pointer("/subscription/url").and_then(|x| x.as_str()).map(String::from))
    });
    match sub_url {
        Some(u) => crate::meta::fetch(&u).await,
        None => crate::meta::MetaResult { meta: crate::meta::load_cached(), source: "none".into(), ..Default::default() },
    }
}

/// Правила, добавленные из браузера. Приложение опрашивает их и подмешивает
/// в свой список — так добавленное на сайте появляется в окне и в конфиге.
#[tauri::command]
pub fn browser_rules() -> Vec<Value> {
    store::read(crate::host::RULES)
        .and_then(|v| v.get("items").cloned())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

/// Открывает папку настроек NoVPN в проводнике — для диагностики.
#[tauri::command]
pub fn open_config_dir() -> Result<(), String> {
    open_in_explorer(&store::dir())
}

/// Открывает журнал движка. Если его ещё нет — открываем папку.
/// Открывает URL в браузере по умолчанию.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    // Только http(s), чтобы через команду нельзя было запустить что попало.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Некорректная ссылка".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Не удалось открыть браузер: {e}"))
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("Поддерживается только в Windows".into())
    }
}

/// Почему домен идёт туда, куда идёт: прогоняем его по тем же правилам, что уходят
/// в движок, и называем сработавшее. Правила приходят от интерфейса — он их и строит.
#[tauri::command]
pub fn explain_domain(domain: String, rules: RulesIn) -> crate::explain::Verdict {
    crate::explain::explain(&domain, &rules.into())
}

/// Браузеры, которые РЕАЛЬНО установлены на компьютере.
#[tauri::command]
pub fn browsers_installed() -> Vec<crate::browsers::Browser> {
    crate::browsers::installed()
}

/// Чужие VPN-туннели, поднятые прямо сейчас. Пустой список — конфликтов нет.
#[tauri::command]
pub fn vpn_conflicts() -> Vec<String> {
    crate::netcheck::foreign_tunnels()
}

#[tauri::command]
pub fn open_engine_log() -> Result<(), String> {
    let log = store::engine_dir().join(core::LOG_NAME);
    if log.exists() {
        open_in_explorer(&log)
    } else {
        open_in_explorer(&store::dir())
    }
}

#[cfg(windows)]
fn open_in_explorer(path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("explorer")
        .arg(path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Не удалось открыть проводник: {e}"))
}

#[cfg(not(windows))]
fn open_in_explorer(_path: &std::path::Path) -> Result<(), String> {
    Err("Поддерживается только в Windows".into())
}

#[tauri::command]
pub fn state_load(name: String) -> Option<Value> {
    store::read(&name)
}

#[tauri::command]
pub fn state_save(name: String, value: Value) -> Result<(), String> {
    store::write(&name, &value)
}
