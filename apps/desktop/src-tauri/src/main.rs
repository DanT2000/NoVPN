// NoVPN Desktop — оболочка приложения: окно, трей и связь интерфейса с движком.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use novpn_desktop::{cmds, host, selftest, update};

use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, Wry,
};

/// Пункт меню трея, текст которого меняется вместе с состоянием подключения,
/// и флаг «прятать окно в трей» — им управляет переключатель в настройках.
struct Tray {
    toggle: MenuItem<Wry>,
    close_to_tray: Mutex<bool>,
}

const ICON_ON: &[u8] = include_bytes!("../icons/tray-on.png");
const ICON_OFF: &[u8] = include_bytes!("../icons/tray-off.png");

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Интерфейс сообщает сюда своё состояние: трей красится синим или серым,
/// а пункт меню становится «Подключить» либо «Отключить».
#[tauri::command]
fn set_tray_state(app: tauri::AppHandle, connected: bool) {
    let state = app.state::<Tray>();
    let _ = state
        .toggle
        .set_text(if connected { "Отключить" } else { "Подключить" });
    if let Some(tray) = app.tray_by_id("main") {
        let bytes = if connected { ICON_ON } else { ICON_OFF };
        if let Ok(img) = Image::from_bytes(bytes) {
            let _ = tray.set_icon(Some(img));
        }
    }
}

/// Переключатель «Сворачивать в трей» из настроек.
#[tauri::command]
fn set_close_to_tray(app: tauri::AppHandle, enabled: bool) {
    if let Ok(mut v) = app.state::<Tray>().close_to_tray.lock() {
        *v = enabled;
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    cmds::shutdown(&app);
    app.exit(0);
}

/// Если запущены как перезапуск с повышением (`--await-pid N`), ждём завершения
/// прежнего процесса N — до нескольких секунд.
fn await_previous_instance() {
    let mut args = std::env::args();
    while let Some(a) = args.next() {
        if a == "--await-pid" {
            if let Some(pid) = args.next().and_then(|p| p.parse::<u32>().ok()) {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
                while std::time::Instant::now() < deadline && process_alive(pid) {
                    std::thread::sleep(std::time::Duration::from_millis(120));
                }
            }
            break;
        }
    }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // tasklist вернёт строку с PID, если процесс ещё жив.
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn process_alive(_pid: u32) -> bool {
    false
}

fn main() {
    // Chrome запускает нас же как хост нативных сообщений — тогда окна нет,
    // а есть разговор по stdin/stdout.
    if host::requested() {
        host::run();
        return;
    }

    // Скрытый режим самопроверки: headless-прогон боевого кода end-to-end.
    if selftest::requested() {
        let rt = tokio::runtime::Runtime::new().expect("нет runtime");
        rt.block_on(selftest::run());
        return;
    }

    // Перезапуск с правами администратора: дожидаемся, пока прежний
    // (непривилегированный) экземпляр освободит блокировку единственного
    // экземпляра, иначе single-instance закрыл бы нас как дубль.
    await_previous_instance();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Второй запуск (клик по ярлыку при живом трее) не поднимает новый
            // экземпляр и не снимает системный прокси — просто показывает окно.
            show_main(app);
        }))
        .manage(cmds::Running::default())
        .invoke_handler(tauri::generate_handler![
            set_tray_state,
            set_close_to_tray,
            quit_app,
            cmds::sub_fetch,
            cmds::sub_cached,
            cmds::vpn_connect,
            cmds::vpn_disconnect,
            cmds::vpn_reload,
            cmds::vpn_alive,
            cmds::vpn_port,
            cmds::apps_installed,
            cmds::apps_running,
            cmds::autostart_get,
            cmds::autostart_sync,
            cmds::autostart_has_task,
            cmds::is_elevated,
            cmds::relaunch_elevated,
            cmds::lists_sync,
            cmds::lists_load,
            cmds::meta_fetch,
            update::update_check,
            update::update_install,
            cmds::browser_rules,
            cmds::open_url,
            cmds::open_config_dir,
            cmds::open_engine_log,
            cmds::vpn_conflicts,
            cmds::browsers_installed,
            cmds::state_load,
            cmds::state_save,
        ])
        .setup(|app| {
            // Если прошлый сеанс оборвался, системный прокси остался указывать
            // на порт, которого больше нет, — у человека просто не было бы
            // интернета. Возвращаем настройку до того, как он это заметит.
            cmds::cleanup_after_crash();
            // Автозапуск приводим к нужному виду по сохранённым настройкам: если
            // включён режим адаптера и мы уже повышены (запущены задачей
            // планировщика) — ставим/обновляем тихий elevated-автозапуск.
            cmds::sync_autostart_on_start();
            // Путь к файлу меняется при обновлении — запись обновляем каждый раз.
            // Регистрируем всегда: при обычном UAC-повышении (пользователь сам
            // администратор) HKCU тот же, и пропуск лишь ломал бы расширение.
            // Приложение к тому же почти всегда стартует без повышения (автозапуск),
            // так что запись и так попадает в верный хайв.
            let _ = host::register();

            let toggle = MenuItem::with_id(app, "toggle", "Подключить", true, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Открыть NoVPN", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&toggle, &PredefinedMenuItem::separator(app)?, &open, &quit],
            )?;

            app.manage(Tray {
                toggle: toggle.clone(),
                close_to_tray: Mutex::new(true),
            });

            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(ICON_OFF)?)
                .tooltip("NoVPN")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    // Переключает интерфейс — состоянием владеет он.
                    "toggle" => {
                        let _ = app.emit("tray-toggle", ());
                    }
                    "open" => show_main(app),
                    "quit" => {
                        cmds::shutdown(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let hide = window
                    .app_handle()
                    .state::<Tray>()
                    .close_to_tray
                    .lock()
                    .map(|v| *v)
                    .unwrap_or(true);
                if hide {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    cmds::shutdown(window.app_handle());
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить NoVPN");
}
