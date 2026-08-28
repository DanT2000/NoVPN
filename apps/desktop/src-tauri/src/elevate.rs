//! Права администратора.
//!
//! Нужны только режиму сетевого адаптера: создать адаптер и переписать таблицу
//! маршрутов иначе нельзя. Всё остальное — подписка, правила, обычный прокси —
//! работает от обычного пользователя, поэтому требовать повышения при каждом
//! запуске неправильно.

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    type Handle = *mut c_void;

    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_ELEVATION: u32 = 20;
    const SW_SHOWNORMAL: i32 = 1;

    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(h: Handle) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn GetTokenInformation(
            token: Handle,
            class: u32,
            info: *mut c_void,
            len: u32,
            ret: *mut u32,
        ) -> i32;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: Handle,
            operation: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> Handle;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn is_elevated() -> bool {
        unsafe {
            let mut token: Handle = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elevated: u32 = 0;
            let mut size: u32 = 0;
            let ok = GetTokenInformation(
                token,
                TOKEN_ELEVATION,
                &mut elevated as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>() as u32,
                &mut size,
            );
            CloseHandle(token);
            ok != 0 && elevated != 0
        }
    }

    /// Перезапускает приложение с запросом прав. Согласие даёт человек в окне
    /// Windows — обойти это нельзя и не нужно.
    pub fn relaunch() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let verb = wide("runas");
        let file = wide(&exe.to_string_lossy());
        // Новый экземпляр должен дождаться, пока текущий полностью завершится:
        // иначе защита от второго экземпляра примет его за дубль и закроет, а
        // прав администратора мы так и не получим. Передаём свой PID.
        let params = wide(&format!("--await-pid {}", std::process::id()));
        let dir = exe
            .parent()
            .map(|p| wide(&p.to_string_lossy()))
            .unwrap_or_else(|| wide(""));
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                params.as_ptr(),
                dir.as_ptr(),
                SW_SHOWNORMAL,
            )
        };
        // ShellExecuteW возвращает значение больше 32 при успехе; 5 означает,
        // что человек отказался в окне запроса прав.
        let code = result as isize;
        if code > 32 {
            Ok(())
        } else if code == 5 {
            Err("Запуск с правами администратора отменён".into())
        } else {
            Err(format!("Не удалось перезапустить с правами администратора (код {code})"))
        }
    }
}

#[cfg(windows)]
pub use win::{is_elevated, relaunch};

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    false
}

#[cfg(not(windows))]
pub fn relaunch() -> Result<(), String> {
    Err("Поддерживается только в Windows".into())
}
