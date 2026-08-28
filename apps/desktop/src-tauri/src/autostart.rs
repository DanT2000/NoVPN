//! Автозапуск вместе с Windows — двумя способами.
//!
//! 1. **Ключ реестра Run** — для обычного режима (прокси). Прав администратора
//!    не требует, запускает приложение без повышения.
//! 2. **Задача планировщика с наивысшими правами** — для режима адаптера (TUN).
//!    Задача запускает приложение при входе в систему УЖЕ с правами
//!    администратора и БЕЗ запроса UAC. Создать её можно только из повышенного
//!    процесса (один раз), зато потом каждый вход — без единого клика.
//!
//! Оба способа не должны действовать одновременно, иначе приложение
//! запустится дважды. Кто активен — решает `sync`.

#[cfg(windows)]
mod win {
    use std::os::windows::process::CommandExt;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    const RUN_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const NAME: &str = "NoVPN";
    const TASK: &str = "NoVPN Autostart";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn exe() -> Result<String, String> {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .map_err(|e| e.to_string())
    }

    // ── Ключ реестра Run ─────────────────────────────────────
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

    // ── Задача планировщика (elevated, без UAC) ──────────────
    pub fn task_exists() -> bool {
        std::process::Command::new("schtasks")
            .args(["/Query", "/TN", TASK])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Экранирует спецсимволы XML (пути к exe их почти не содержат, но пусть).
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

    fn create_task() -> Result<(), String> {
        // Создаём задачу из XML, а не флагами schtasks: у CLI нет ключей для
        // условий питания и лимита времени, а их значения по умолчанию для
        // VPN-приложения на ноутбуке вредны:
        //   • DisallowStartIfOnBatteries — не запустится при входе на батарее;
        //   • StopIfGoingOnBatteries — упадёт (и VPN отвалится) при отключении зарядки;
        //   • ExecutionTimeLimit 72ч — процесс убьют через трое суток аптайма.
        // Отключаем всё это и снимаем лимит времени.
        //
        // RunLevel=HighestAvailable даёт повышенные права без UAC при входе,
        // LogonType=InteractiveToken — запуск в сессии пользователя (для TUN нужен
        // рабочий стол), пароль не требуется.
        let exe_path = exe()?;
        let user = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
            (Ok(d), Ok(u)) if !d.is_empty() => format!("{d}\\{u}"),
            (_, Ok(u)) => u,
            _ => return Err("Не удалось определить пользователя для автозапуска".into()),
        };
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Автозапуск NoVPN с правами (режим адаптера)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
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
    </Exec>
  </Actions>
</Task>
"#,
            user = xml_escape(&user),
            exe = xml_escape(&exe_path),
        );

        let xml_path = std::env::temp_dir().join("novpn-autostart.xml");
        write_utf16le(&xml_path, &xml).map_err(|e| format!("Не удалось подготовить задачу: {e}"))?;

        let out = std::process::Command::new("schtasks")
            .args(["/Create", "/TN", TASK, "/XML"])
            .arg(&xml_path)
            .arg("/F")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Планировщик недоступен: {e}"))?;
        let _ = std::fs::remove_file(&xml_path);
        if out.status.success() {
            Ok(())
        } else {
            Err("Не удалось создать задачу автозапуска (нужны права администратора)".into())
        }
    }

    fn delete_task() -> Result<(), String> {
        let _ = std::process::Command::new("schtasks")
            .args(["/Delete", "/TN", TASK, "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        Ok(())
    }

    /// Приводит автозапуск к нужному виду.
    ///
    /// `autostart` — хочет ли человек запуск вместе с Windows вообще.
    /// `tunnel` — включён ли режим адаптера. `elevated` — есть ли у нас права.
    ///
    /// Задача планировщика нужна ровно тогда, когда человек хочет и автозапуск,
    /// и режим адаптера (`autostart && tunnel`). Сносим её ТОЛЬКО когда она
    /// стала не нужна — то есть человек выключил автозапуск или TUN. Отсутствие
    /// прав у ТЕКУЩЕГО процесса — не повод удалять уже созданную задачу: иначе
    /// обычный (непривилегированный) запуск приложения молча сломал бы тихий
    /// автозапуск и вернул бесконечные запросы UAC.
    pub fn sync(autostart: bool, tunnel: bool, elevated: bool) -> Result<(), String> {
        let task_wanted = autostart && tunnel;
        if task_wanted {
            if elevated {
                // Есть права — создаём/обновляем задачу (путь к exe мог смениться
                // при обновлении) и убираем Run-ключ, чтобы не запускаться дважды.
                create_task()?;
                let _ = set_run_key(false);
            } else if task_exists() {
                // Задача уже есть — она и поднимет нас с правами при следующем
                // входе. Не трогаем её и снимаем Run-ключ.
                let _ = set_run_key(false);
            } else {
                // Задачу без прав не создать. Пока — обычный автозапуск (он
                // попросит повышение), а задача появится после первого запуска
                // с правами.
                let _ = set_run_key(true);
            }
            Ok(())
        } else {
            let _ = delete_task();
            set_run_key(autostart && !tunnel)
        }
    }

    /// Общий признак «автозапуск включён» для интерфейса.
    pub fn any_enabled() -> bool {
        run_key_enabled() || task_exists()
    }
}

#[cfg(windows)]
pub use win::{any_enabled, sync, task_exists};

#[cfg(not(windows))]
pub fn any_enabled() -> bool {
    false
}
#[cfg(not(windows))]
pub fn task_exists() -> bool {
    false
}
#[cfg(not(windows))]
pub fn sync(_autostart: bool, _tunnel: bool, _elevated: bool) -> Result<(), String> {
    Ok(())
}
