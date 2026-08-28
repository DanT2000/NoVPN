//! Системный прокси Windows.
//!
//! Без этого движок бесполезен: он поднимается и слушает локальный порт, но
//! трафик туда никто не направляет. Именно на этом «Подключено» оказывалось
//! правдой про процесс и неправдой про трафик.
//!
//! Прежние значения запоминаются и возвращаются при отключении: на машине
//! может стоять другой клиент со своим прокси, и затереть его настройку
//! молча — значит сломать человеку то, чем он пользовался.

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    const PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    // Без этих уведомлений уже запущенные программы продолжат ходить мимо
    // прокси: настройку они читают один раз и ждут сигнала об изменении.
    const INTERNET_OPTION_SETTINGS_CHANGED: u32 = 39;
    const INTERNET_OPTION_REFRESH: u32 = 37;

    #[link(name = "wininet")]
    extern "system" {
        fn InternetSetOptionW(
            h_internet: *mut c_void,
            dw_option: u32,
            lp_buffer: *mut c_void,
            dw_buffer_length: u32,
        ) -> i32;
    }

    fn notify() {
        unsafe {
            InternetSetOptionW(std::ptr::null_mut(), INTERNET_OPTION_SETTINGS_CHANGED, std::ptr::null_mut(), 0);
            InternetSetOptionW(std::ptr::null_mut(), INTERNET_OPTION_REFRESH, std::ptr::null_mut(), 0);
        }
    }

    fn key(write: bool) -> Result<RegKey, String> {
        let access = if write { KEY_READ | KEY_WRITE } else { KEY_READ };
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(PATH, access)
            .map_err(|e| format!("Не удалось открыть настройки прокси: {e}"))
    }

    /// Что стояло до нас — чтобы вернуть в точности это.
    #[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
    pub struct Saved {
        pub enable: u32,
        pub server: String,
        pub bypass: String,
    }

    pub fn read() -> Saved {
        let Ok(k) = key(false) else { return Saved::default() };
        Saved {
            enable: k.get_value("ProxyEnable").unwrap_or(0u32),
            server: k.get_value("ProxyServer").unwrap_or_default(),
            bypass: k.get_value("ProxyOverride").unwrap_or_default(),
        }
    }

    pub fn set(port: u16) -> Result<(), String> {
        let k = key(true)?;
        k.set_value("ProxyEnable", &1u32).map_err(|e| e.to_string())?;
        k.set_value("ProxyServer", &format!("127.0.0.1:{port}"))
            .map_err(|e| e.to_string())?;
        // Локальные адреса мимо прокси — иначе панели роутеров и сервисы в
        // домашней сети пойдут через туннель и перестанут открываться.
        k.set_value(
            "ProxyOverride",
            &"localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>",
        )
        .map_err(|e| e.to_string())?;
        notify();
        Ok(())
    }

    // Ключ бэкапа для деинсталлятора. NSIS не умеет читать наш JSON, поэтому
    // при подключении дублируем прежний прокси сюда — при удалении «на ходу»
    // (когда приложение не успело вернуть настройку) деинсталлятор возьмёт её
    // отсюда и вернёт чужой прокси, а не сотрёт его. Значение "Had"=1 отличает
    // «был прокси» от «прокси не было».
    const BACKUP_KEY: &str = r"Software\NoVPN\ProxyBackup";

    pub fn save_registry_backup(saved: &Saved) {
        let Ok((k, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(BACKUP_KEY) else {
            return;
        };
        let _ = k.set_value("Had", &1u32);
        let _ = k.set_value("Enable", &saved.enable);
        let _ = k.set_value("Server", &saved.server);
        let _ = k.set_value("Override", &saved.bypass);
    }

    pub fn clear_registry_backup() {
        let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(BACKUP_KEY);
    }

    pub fn restore(saved: &Saved) -> Result<(), String> {
        let k = key(true)?;
        k.set_value("ProxyEnable", &saved.enable).map_err(|e| e.to_string())?;
        if saved.server.is_empty() {
            let _ = k.delete_value("ProxyServer");
        } else {
            k.set_value("ProxyServer", &saved.server).map_err(|e| e.to_string())?;
        }
        if saved.bypass.is_empty() {
            let _ = k.delete_value("ProxyOverride");
        } else {
            k.set_value("ProxyOverride", &saved.bypass).map_err(|e| e.to_string())?;
        }
        notify();
        Ok(())
    }
}

#[cfg(windows)]
pub use win::{clear_registry_backup, read, restore, save_registry_backup, set, Saved};

#[cfg(not(windows))]
mod other {
    #[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
    pub struct Saved;
    pub fn read() -> Saved {
        Saved
    }
    pub fn set(_port: u16) -> Result<(), String> {
        Err("Системный прокси настраивается только в Windows".into())
    }
    pub fn restore(_s: &Saved) -> Result<(), String> {
        Ok(())
    }
    pub fn save_registry_backup(_s: &Saved) {}
    pub fn clear_registry_backup() {}
}

#[cfg(not(windows))]
pub use other::{clear_registry_backup, read, restore, save_registry_backup, set, Saved};
