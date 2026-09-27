//! Привилегированный фоновый движок VPN (режим адаптера/TUN).
//!
//! Зачем отдельный процесс. Создать сетевой адаптер и переписать маршруты можно
//! только с правами администратора. Раньше ради этого повышалось ВСЁ приложение
//! вместе с окном — а окно администратора Windows защищает по UIPI: глобальные
//! горячие клавиши сторонних программ (скриншот-тулы и т.п.) над ним не работают.
//! Поэтому окно-интерфейс теперь всегда обычное, а под правами крутится только
//! этот headless-движок без окна. Запускает его задача планировщика по требованию
//! (без запроса UAC каждый раз), а интерфейс общается с ним через файлы в
//! `%APPDATA%\NoVPN\engine`: команду `control.json` и статус `host.json`. Правила и
//! статус связи идут напрямую по локальному API mihomo — он доступен процессу с
//! любыми правами, UIPI на сокеты не распространяется.

use crate::core::Ports;
#[cfg(windows)]
use crate::core::Engine;
use crate::store;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Команда интерфейса движку. Пишет интерфейс (обычные права), читает хост.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Control {
    /// Нужен ли туннель прямо сейчас.
    pub want: bool,
    /// Метка запуска: смена значения = «переподними движок заново» (свежий старт,
    /// не горячая перезагрузка правил — та идёт по API mihomo без участия хоста).
    pub epoch: u64,
    pub mixed_port: u16,
    pub controller_port: u16,
    /// Выйти совсем, а не просто погасить движок (перед установкой обновления).
    /// Хост работает с правами администратора и держит открытым тот же exe, что
    /// перезаписывает установщик, а установщик (ставится без прав) убить его не
    /// может — поэтому просим выйти сам и сразу, без паузы простоя. Старые хосты
    /// поле не знают и выходят по `want: false` через паузу простоя.
    #[serde(default)]
    pub quit: bool,
}

/// Статус движка. Пишет хост, читает интерфейс — чтобы отличать «хост поднят» от
/// «мёртв» и показывать причину отказа.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HostStatus {
    pub pid: u32,
    /// Движок реально слушает (mihomo запущен).
    pub up: bool,
    pub epoch: u64,
    /// Момент последнего «пульса» хоста (unix-мс) — по нему видно, жив ли он.
    pub beat: u64,
    /// Человеческая причина, если запуск не удался (конец журнала mihomo).
    pub error: String,
}

fn control_path() -> PathBuf {
    store::engine_dir().join("control.json")
}

fn status_path() -> PathBuf {
    store::engine_dir().join("host.json")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── Сторона интерфейса (обычные права) ───────────────────────────────

/// Записать команду движку. Каталог движка общий с хостом (тот же пользователь).
pub fn write_control(c: &Control) -> Result<(), String> {
    let dir = store::engine_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать папку движка: {e}"))?;
    let text = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    // Атомарно: хост в другом процессе читает этот файл каждые 400мс, и порванное
    // чтение прежде трактовалось как want=false → погашенный на ровном месте туннель.
    store::atomic_write(&control_path(), text.as_bytes()).map_err(|e| format!("Не удалось записать команду движку: {e}"))
}

/// Прочитать текущий статус хоста (None — файла нет / мусор).
pub fn read_status() -> Option<HostStatus> {
    let text = std::fs::read_to_string(status_path()).ok()?;
    serde_json::from_str(&text).ok()
}

/// Свежий ли хост: пульс был недавно. Мёртвый хост оставляет старый файл, поэтому
/// смотрим не на факт файла, а на время последнего пульса.
pub fn host_fresh() -> bool {
    read_status()
        .map(|s| now_ms().saturating_sub(s.beat) < 5000)
        .unwrap_or(false)
}

/// Попросить движок включиться под данным конфигом (config.yaml уже записан).
pub fn request_start(ports: Ports) -> Result<(), String> {
    write_control(&Control {
        want: true,
        epoch: now_ms(),
        mixed_port: ports.mixed,
        controller_port: ports.controller,
        quit: false,
    })
}

/// Попросить движок выключиться. Безвредно, даже если хост не запущен.
pub fn request_stop() {
    let prev = read_control().unwrap_or_default();
    let _ = write_control(&Control { want: false, ..prev });
}

/// Попросить хост завершиться совсем (перед установкой обновления).
pub fn request_quit() {
    let prev = read_control().unwrap_or_default();
    let _ = write_control(&Control { want: false, quit: true, ..prev });
}

/// Хоста нет: статус удалён (штатный выход) или пульс давно не обновлялся
/// (хост пишет его каждые 400 мс).
fn host_gone(status: Option<&HostStatus>, now: u64) -> bool {
    match status {
        None => true,
        Some(s) => now.saturating_sub(s.beat) > 2500,
    }
}

/// Ждёт, пока хост завершится, не дольше `timeout`. `true` — вышел (или не был запущен).
pub fn wait_host_exit(timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if host_gone(read_status().as_ref(), now_ms()) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

fn read_control() -> Option<Control> {
    let text = std::fs::read_to_string(control_path()).ok()?;
    serde_json::from_str(&text).ok()
}

// ── Сторона хоста (права администратора, без окна) ───────────────────

/// Запущены ли мы как фоновый движок (`--engine-host`) или как разовая установка
/// задачи (`--install-task`, которая тоже переходит в режим движка).
pub fn requested() -> bool {
    std::env::args().any(|a| a == "--engine-host" || a == "--install-task")
}

/// Точка входа привилегированного движка. Окна нет: только цикл согласования
/// команды с процессом mihomo. Ничего постоянного не оставляет.
#[cfg(windows)]
pub fn run() {
    use std::time::{Duration, Instant};

    // Разовая установка: пришли с правами именно чтобы зарегистрировать задачу
    // (первое включение режима адаптера). Создаём её и сразу продолжаем как движок,
    // чтобы человек не ждал второго запуска.
    if std::env::args().any(|a| a == "--install-task") {
        let _ = crate::autostart::create_engine_task();
    }

    let exe = match crate::cmds::locate_engine_pub() {
        Ok(p) => p,
        Err(_) => return,
    };
    let dir = store::engine_dir();
    let _ = std::fs::create_dir_all(&dir);

    // Осиротевший от прошлого сеанса mihomo держит порт — гасим по pid-файлу.
    crate::cmds::kill_stray_engines_pub();

    let mut engine: Option<Engine> = None;
    let mut cur_epoch: u64 = u64::MAX; // заведомо «не совпадает» с первой командой
    let mut failed_epoch: Option<u64> = None; // старт этого epoch провалился — не долбим повтором
    let mut last_error = String::new();
    let mut last_ctl = Control::default(); // держим при порванном чтении, чтобы не гасить туннель
    let mut off_since: Option<Instant> = None;
    let pid = std::process::id();

    loop {
        // Порванное чтение (окно как раз переписывает control.json) НЕ должно читаться
        // как want=false — иначе хост погасил бы живой туннель. Держим прошлую команду.
        let ctl = match read_control() {
            Some(c) => {
                last_ctl = c.clone();
                c
            }
            None => last_ctl.clone(),
        };
        if ctl.want {
            off_since = None;
            let alive = engine.as_mut().map(|e| e.alive()).unwrap_or(false);
            if needs_restart(ctl.epoch, cur_epoch, alive, failed_epoch) {
                // Требуется свежий старт: гасим прежний и поднимаем новый.
                if let Some(mut old) = engine.take() {
                    old.stop();
                }
                cur_epoch = ctl.epoch;
                let ports = Ports {
                    mixed: if ctl.mixed_port != 0 { ctl.mixed_port } else { Ports::default().mixed },
                    controller: if ctl.controller_port != 0 {
                        ctl.controller_port
                    } else {
                        Ports::default().controller
                    },
                };
                let cfg = std::fs::read_to_string(dir.join("config.yaml")).unwrap_or_default();
                match Engine::start(&exe, &dir, &cfg, ports.mixed, ports.controller) {
                    Ok(e) => {
                        engine = Some(e);
                        failed_epoch = None;
                        last_error = String::new();
                    }
                    Err(err) => {
                        // Старт не удался: помечаем epoch, чтобы НЕ рестартовать повторно
                        // в цикле (был бы tight loop ~12с/попытка). Ждём новой команды.
                        failed_epoch = Some(cur_epoch);
                        last_error = err;
                    }
                }
            }
            // Один пульс на итерацию: up отражает реальную живость, а ошибка держится,
            // пока движок не поднимется. beat обновляется всегда → host_fresh точен.
            let up = engine.as_mut().map(|e| e.alive()).unwrap_or(false);
            write_status(&HostStatus {
                pid,
                up,
                epoch: cur_epoch,
                beat: now_ms(),
                error: if up { String::new() } else { last_error.clone() },
            });
        } else {
            if let Some(mut e) = engine.take() {
                e.stop();
            }
            if ctl.quit {
                // Обновление: выходим сразу — установщику нужен свободный exe.
                let _ = std::fs::remove_file(status_path());
                return;
            }
            cur_epoch = u64::MAX;
            failed_epoch = None;
            last_error = String::new();
            write_status(&HostStatus { pid, up: false, epoch: 0, beat: now_ms(), error: String::new() });
            // Долго висеть без дела незачем — выходим после паузы простоя. Если
            // туннель снова понадобится, задача поднимет нас заново по требованию.
            let now = Instant::now();
            match off_since {
                None => off_since = Some(now),
                Some(t) if now.duration_since(t) > Duration::from_secs(8) => {
                    // Перед выходом ПЕРЕЧИТЫВАЕМ команду: если между проверкой want и этим
                    // моментом попросили подняться (request_start), НЕ выходим — иначе гонка:
                    // ensure_engine_host видит свежий статус и не перезапускает, а мы уже
                    // удаляем статус и выходим, оставляя want=true без живого хоста.
                    if read_control().map(|c| c.want).unwrap_or(false) {
                        off_since = None;
                    } else {
                        let _ = std::fs::remove_file(status_path());
                        return;
                    }
                }
                _ => {}
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

#[cfg(not(windows))]
pub fn run() {}

#[cfg(windows)]
fn write_status(s: &HostStatus) {
    if let Ok(text) = serde_json::to_string_pretty(s) {
        let _ = store::atomic_write(&status_path(), text.as_bytes());
    }
}

/// Нужен ли (пере)старт движка. Чистая функция — чтобы протестировать логику цикла:
/// - новая команда (epoch сменился) → всегда стартуем;
/// - движок умер, но НЕ из-за неудачного старта именно этого epoch → перезапуск;
/// - старт этого epoch уже провалился → НЕ повторяем (ждём новой команды), иначе был
///   бы бесконечный tight loop перезапусков (~12с на попытку) при стойкой ошибке.
fn needs_restart(want_epoch: u64, cur_epoch: u64, alive: bool, failed_epoch: Option<u64>) -> bool {
    if want_epoch != cur_epoch {
        return true;
    }
    !alive && failed_epoch != Some(want_epoch)
}

#[cfg(test)]
mod tests {
    use super::{host_gone, needs_restart, Control, HostStatus};

    #[test]
    fn host_gone_by_missing_or_stale_status() {
        assert!(host_gone(None, 10_000), "статуса нет — хост вышел");
        let fresh = HostStatus { beat: 9_000, ..Default::default() };
        assert!(!host_gone(Some(&fresh), 10_000), "свежий пульс — ещё жив");
        let stale = HostStatus { beat: 1_000, ..Default::default() };
        assert!(host_gone(Some(&stale), 10_000), "пульс остановился — вышел");
    }

    #[test]
    fn quit_is_optional_for_old_control_files() {
        // Файл команды от прежних версий (без quit) читается, quit = false.
        let c: Control = serde_json::from_str(r#"{"want":true,"epoch":1,"mixed_port":7893,"controller_port":9893}"#).unwrap();
        assert!(c.want && !c.quit);
        // А то, что пишет установщик, — с quit.
        let c: Control = serde_json::from_str(r#"{"want":false,"quit":true,"epoch":0,"mixed_port":7893,"controller_port":9893}"#).unwrap();
        assert!(!c.want && c.quit);
    }

    #[test]
    fn restart_on_new_epoch() {
        assert!(needs_restart(2, 1, true, None));
        assert!(needs_restart(2, 1, false, Some(1)));
    }

    #[test]
    fn no_restart_when_alive_and_same_epoch() {
        assert!(!needs_restart(1, 1, true, None));
    }

    #[test]
    fn restart_when_engine_died_after_success() {
        assert!(needs_restart(1, 1, false, None));
    }

    #[test]
    fn no_infinite_retry_when_start_failed() {
        // Регресс: старт этого epoch провалился → повторно НЕ рестартуем (иначе tight loop).
        assert!(!needs_restart(1, 1, false, Some(1)));
    }
}
