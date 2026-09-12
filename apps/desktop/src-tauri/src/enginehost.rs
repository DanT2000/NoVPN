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
    std::fs::write(control_path(), text).map_err(|e| format!("Не удалось записать команду движку: {e}"))
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
    })
}

/// Попросить движок выключиться. Безвредно, даже если хост не запущен.
pub fn request_stop() {
    let prev = read_control().unwrap_or_default();
    let _ = write_control(&Control { want: false, ..prev });
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
    let mut off_since: Option<Instant> = None;
    let pid = std::process::id();

    loop {
        let ctl = read_control().unwrap_or_default();
        if ctl.want {
            off_since = None;
            let alive = engine.as_mut().map(|e| e.alive()).unwrap_or(false);
            if ctl.epoch != cur_epoch || !alive {
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
                        write_status(&HostStatus { pid, up: true, epoch: cur_epoch, beat: now_ms(), error: String::new() });
                    }
                    Err(err) => {
                        // Не удалось — не долбим повтором в цикле (иначе tight loop):
                        // ждём новой команды (новый epoch). Причину кладём в статус.
                        write_status(&HostStatus { pid, up: false, epoch: cur_epoch, beat: now_ms(), error: err });
                    }
                }
            } else {
                write_status(&HostStatus { pid, up: true, epoch: cur_epoch, beat: now_ms(), error: String::new() });
            }
        } else {
            if let Some(mut e) = engine.take() {
                e.stop();
            }
            cur_epoch = u64::MAX;
            write_status(&HostStatus { pid, up: false, epoch: 0, beat: now_ms(), error: String::new() });
            // Долго висеть без дела незачем — выходим после паузы простоя. Если
            // туннель снова понадобится, задача поднимет нас заново по требованию.
            let now = Instant::now();
            match off_since {
                None => off_since = Some(now),
                Some(t) if now.duration_since(t) > Duration::from_secs(8) => {
                    let _ = std::fs::remove_file(status_path());
                    return;
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
        let _ = std::fs::write(status_path(), text);
    }
}
