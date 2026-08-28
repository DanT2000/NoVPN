//! Проверка работы с системным прокси.
//!
//! Тест трогает настоящий реестр — иначе смысла в нём нет: именно здесь
//! ломалось «Подключено». Прежние значения считываются до изменений и
//! возвращаются в конце при любом исходе, поэтому машина остаётся в том же
//! состоянии, в каком была.

#![cfg(windows)]

use novpn_desktop::proxy;

/// Возвращает исходную настройку, что бы ни случилось внутри проверки.
struct Guard(proxy::Saved);

impl Drop for Guard {
    fn drop(&mut self) {
        let _ = proxy::restore(&self.0);
    }
}

#[test]
fn set_and_restore_roundtrip() {
    let before = proxy::read();
    let _guard = Guard(before.clone());

    proxy::set(7893).expect("настройка прокси должна применяться");
    let during = proxy::read();
    assert_eq!(during.enable, 1, "прокси должен быть включён");
    assert_eq!(during.server, "127.0.0.1:7893");
    assert!(
        during.bypass.contains("192.168."),
        "локальные адреса обязаны идти мимо прокси, иначе домашняя сеть отвалится"
    );

    proxy::restore(&before).expect("восстановление должно проходить");
    let after = proxy::read();
    assert_eq!(after.enable, before.enable, "флаг должен вернуться как был");
    assert_eq!(after.server, before.server, "адрес должен вернуться как был");
    assert_eq!(after.bypass, before.bypass, "исключения должны вернуться как были");
}
