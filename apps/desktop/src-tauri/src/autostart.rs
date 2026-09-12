//! Автозапуск и привилегированный движок — два независимых механизма.
//!
//! 1. **Ключ реестра Run** — автозапуск окна-интерфейса вместе с Windows. Окно
//!    теперь ВСЕГДА работает с обычными правами (и в режиме прокси, и в режиме
//!    адаптера), поэтому автозапуск один на все случаи и повышения не требует.
//! 2. **Задача планировщика «NoVPN Engine»** — поднимает фоновый движок VPN
//!    (`--engine-host`) с наивысшими правами и БЕЗ запроса UAC. Нужна только режиму
//!    адаптера (TUN). Создаётся один раз (при первом включении TUN, с разовым
//!    согласием в UAC), запускается по требованию из окна-интерфейса.
//!
//! Раньше существовала задача «NoVPN Autostart», которая поднимала с правами ВСЁ
//! приложение вместе с окном — из-за чего окно администратора по UIPI глушило
//! чужие горячие клавиши. Она больше не нужна: `delete_legacy_task` сносит её при
//! запуске (миграция).

#[cfg(windows)]
mod win {
    use std::os::windows::process::CommandExt;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    const RUN_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const NAME: &str = "NoVPN";
    /// Задача привилегированного фонового движка (режим адаптера).
    const ENGINE_TASK: &str = "NoVPN Engine";
    /// Старая задача, поднимавшая с правами всё окно. Сносим при миграции.
    const LEGACY_TASK: &str = "NoVPN Autostart";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn exe() -> Result<String, String> {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .map_err(|e| e.to_string())
    }

    // ── Ключ реестра Run (окно-интерфейс, обычные права) ─────
    pub fn run_key_enabled() -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(RUN_PATH, KEY_READ)
            .and_then(|k| k.get_value::<String, _>(NAME))
            .is_ok()
    }

    fn set_run_key(on: bool) -> Result<(), String> {
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(RUN_PATH, KEY_WRITE)
            .map_err(|e| format!("Не удалось открыть автозапуск: {e}"))?;
        if on {
            key.set_value(NAME, &format!("\"{}\"", exe()?))
                .map_err(|e| format!("Не удалось включить автозапуск: {e}"))
        } else {
            match key.delete_value(NAME) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("Не удалось выключить автозапуск: {e}")),
            }
        }
    }

    // ── Задача планировщика «NoVPN Engine» (движок, elevated, по требованию) ──
    pub fn task_exists() -> bool {
        std::process::Command::new("schtasks")
            .args(["/Query", "/TN", ENGINE_TASK])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Запускает задачу-движок по требованию (`schtasks /Run`) — поднимает
    /// `--engine-host` с правами без запроса UAC. Второй запуск при уже живом
    /// движке гасится политикой IgnoreNew внутри самой задачи.
    pub fn run_task() -> bool {
        std::process::Command::new("schtasks")
            .args(["/Run", "/TN", ENGINE_TASK])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    }

    /// Пишет файл в UTF-16LE с BOM — schtasks /XML требует Unicode.
    fn write_utf16le(path: &std::path::Path, text: &str) -> std::io::Result<()> {
        let mut bytes = vec![0xFF, 0xFE];
        for u in text.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        std::fs::write(path, bytes)
    }

    /// Создаёт (или обновляет) задачу-движок. Требует прав администратора — её
    /// вызывает `--install-task` из повышенного процесса при первом включении TUN.
    ///
    /// Структура XML намеренно повторяет прежнюю рабочую задачу (её принимал
    /// планировщик на машинах пользователей): те же безопасные для VPN настройки
    /// (не падать на батарее, без лимита времени), InteractiveToken для рабочего
    /// стола, HighestAvailable для прав без UAC. Отличия: действие запускает
    /// `--engine-host`, а триггер входа ВЫКЛЮЧЕН — задачу дёргает окно по
    /// требованию (AllowStartOnDemand), сама при входе она не стартует.
    pub fn create_engine_task() -> Result<(), String> {
        let exe_path = exe()?;
        let user = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
            (Ok(d), Ok(u)) if !d.is_empty() => format!("{d}\\{u}"),
            (_, Ok(u)) => u,
            _ => return Err("Не удалось определить пользователя для задачи движка".into()),
        };
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Фоновый движок NoVPN (режим адаптера)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>false</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>--engine-host</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
            user = xml_escape(&user),
            exe = xml_escape(&exe_path),
        );

        let xml_path = std::env::temp_dir().join("novpn-engine.xml");
        write_utf16le(&xml_path, &xml).map_err(|e| format!("Не удалось подготовить задачу: {e}"))?;
        let out = std::process::Command::new("schtasks")
            .args(["/Create", "/TN", ENGINE_TASK, "/XML"])
            .arg(&xml_path)
            .arg("/F")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Планировщик недоступен: {e}"))?;
        let _ = std::fs::remove_file(&xml_path);
        if out.status.success() {
            Ok(())
        } else {
            Err("Не удалось создать задачу движка (нужны права администратора)".into())
        }
    }

    /// Сносит старую задачу «NoVPN Autostart» (поднимала с правами всё окно) —
    /// миграция на схему «обычное окно + отдельный движок».
    pub fn delete_legacy_task() {
        let _ = std::process::Command::new("schtasks")
            .args(["/Delete", "/TN", LEGACY_TASK, "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    /// Приводит автозапуск окна к нужному виду. Окно всегда обычное, поэтому это
    /// просто ключ реестра Run — в любом режиме. Заодно сносим устаревшую
    /// elevated-задачу. Аргументы `tunnel`/`elevated` больше не влияют на выбор
    /// механизма и сохранены только ради совместимости вызовов.
    pub fn sync(autostart: bool, _tunnel: bool, _elevated: bool) -> Result<(), String> {
        delete_legacy_task();
        set_run_key(autostart)
    }

    /// Признак «автозапуск окна включён» для интерфейса.
    pub fn any_enabled() -> bool {
        run_key_enabled()
    }
}

#[cfg(windows)]
pub use win::{any_enabled, create_engine_task, delete_legacy_task, run_task, sync, task_exists};

#[cfg(not(windows))]
pub fn any_enabled() -> bool {
    false
}
#[cfg(not(windows))]
pub fn task_exists() -> bool {
    false
}
#[cfg(not(windows))]
pub fn run_task() -> bool {
    false
}
#[cfg(not(windows))]
pub fn create_engine_task() -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
pub fn delete_legacy_task() {}
#[cfg(not(windows))]
pub fn sync(_autostart: bool, _tunnel: bool, _elevated: bool) -> Result<(), String> {
    Ok(())
}
