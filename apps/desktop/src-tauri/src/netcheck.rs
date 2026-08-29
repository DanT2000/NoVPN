//! Обнаружение чужих VPN-туннелей.
//!
//! Зачем: если поднят ещё один туннель (Amnezia, OpenVPN, другой клиент), маршрут по
//! умолчанию забирают на себя оба, и интернет пропадает СОВСЕМ — у человека при этом
//! просто «ничего не грузится», без единой подсказки. Владелец поймал это на своей
//! машине: одновременно были подняты наш `Meta` и `AmneziaVPN`, локальная сеть жила,
//! наружу не уходило ничего.
//!
//! Как определяем: две таблицы `netsh` (он есть в любой Windows и не требует
//! PowerShell) — маршруты и интерфейсы. Из маршрутов берём ИНДЕКСЫ тех интерфейсов,
//! у которых есть `0.0.0.0/0`, из второй таблицы — их имена. По индексу, а не по
//! последней колонке маршрута: там лежит то шлюз (`192.168.2.1`), то имя интерфейса —
//! зависит от того, есть ли у маршрута шлюз. Сам префикс и числа от языка системы не
//! зависят, поэтому разбор работает и на русской Windows.

/// Наш собственный адаптер (его создаёт движок в режиме адаптера).
const OURS: &[&str] = &["meta", "novpn"];

/// Признаки чужих VPN-адаптеров. Список по именам, а не по драйверам: драйвер
/// (wintun) у многих клиентов общий, а имя адаптера видно пользователю.
const VPN_HINTS: &[&str] = &[
    "amnezia", "wireguard", "openvpn", "tap-windows", "nordlynx", "proton", "outline",
    "hiddify", "nekoray", "v2ray", "clash", "surfshark", "expressvpn", "mullvad",
    "windscribe", "warp", "tailscale", "zerotier", "vpn", "tun",
];

/// Индексы интерфейсов, у которых есть маршрут по умолчанию.
pub fn parse_default_route_indexes(routes: &str) -> Vec<u32> {
    let mut out = Vec::new();
    for line in routes.lines() {
        let Some(rest) = line.split("0.0.0.0/0").nth(1) else { continue };
        let Some(idx) = rest.split_whitespace().next().and_then(|s| s.parse::<u32>().ok()) else { continue };
        if !out.contains(&idx) {
            out.push(idx);
        }
    }
    out
}

/// Индекс → имя интерфейса. Строка вида « 32   25  1420  connected  Meta»:
/// четыре числовых/служебных поля, дальше имя (может содержать пробелы).
pub fn parse_interface_names(interfaces: &str) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    for line in interfaces.lines() {
        let mut parts = line.split_whitespace();
        let Some(idx) = parts.next().and_then(|s| s.parse::<u32>().ok()) else { continue };
        // метрика, MTU, состояние — пропускаем, дальше всё остальное это имя
        let rest: Vec<&str> = parts.collect();
        if rest.len() < 4 {
            continue;
        }
        let name = rest[3..].join(" ");
        if !name.is_empty() {
            out.push((idx, name));
        }
    }
    out
}

/// Похоже ли имя на чужой VPN-адаптер.
pub fn is_foreign_vpn(name: &str) -> bool {
    let low = name.to_lowercase();
    if OURS.iter().any(|o| low.contains(o)) {
        return false;
    }
    VPN_HINTS.iter().any(|h| low.contains(h))
}

/// Свести две таблицы в список чужих туннелей с маршрутом по умолчанию.
pub fn conflicts_from(routes: &str, interfaces: &str) -> Vec<String> {
    let names = parse_interface_names(interfaces);
    let mut out = Vec::new();
    for idx in parse_default_route_indexes(routes) {
        let Some((_, name)) = names.iter().find(|(i, _)| *i == idx) else { continue };
        if is_foreign_vpn(name) && !out.contains(name) {
            out.push(name.clone());
        }
    }
    out
}

#[cfg(windows)]
fn netsh(args: &[&str]) -> String {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("netsh")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// Чужие туннели, которые прямо сейчас держат маршрут по умолчанию.
#[cfg(windows)]
pub fn foreign_tunnels() -> Vec<String> {
    conflicts_from(
        &netsh(&["interface", "ipv4", "show", "route"]),
        &netsh(&["interface", "ipv4", "show", "interfaces"]),
    )
}

#[cfg(not(windows))]
pub fn foreign_tunnels() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Настоящий вывод с машины владельца: заголовки переведены, числа и префикс — нет.
    // В маршрутах последняя колонка это ШЛЮЗ, если он есть, и имя интерфейса, если нет.
    const ROUTES: &str = "\
Публикация  Тип       Метрика  Префикс                   Идх  Шлюз/Имя интерфейса
----------  --------  -------  ------------------------  ---  ------------------------
Нет         Вручную   0        0.0.0.0/0                   7  192.168.2.1
Нет         Вручную   0        0.0.0.0/0                  28  AmneziaVPN
Нет         Вручную   0        0.0.0.0/0                  32  198.18.0.2
Нет         Система   256      127.0.0.0/8                 1  Loopback Pseudo-Interface 1
";
    const IFACES: &str = "\
Идх     Мет         MTU          Состояние     Имя
---  ----------  ----------  ------------  ---------------
  1          75  4294967295  connected     Loopback Pseudo-Interface 1
  7          25        1500  connected     Ethernet
 28           5        1420  connected     AmneziaVPN
 32           5        9000  connected     Meta
";

    #[test]
    fn default_routes_are_found_by_index() {
        assert_eq!(parse_default_route_indexes(ROUTES), vec![7, 28, 32]);
    }

    #[test]
    fn interface_names_are_read_with_spaces() {
        let names = parse_interface_names(IFACES);
        assert_eq!(names.iter().find(|(i, _)| *i == 32).unwrap().1, "Meta");
        assert_eq!(names.iter().find(|(i, _)| *i == 7).unwrap().1, "Ethernet");
        assert_eq!(names.iter().find(|(i, _)| *i == 1).unwrap().1, "Loopback Pseudo-Interface 1");
    }

    #[test]
    fn only_the_foreign_tunnel_is_reported() {
        // Наш Meta и обычная сеть конфликтом не считаются — иначе предупреждение
        // висело бы всегда и его перестали бы читать.
        assert_eq!(conflicts_from(ROUTES, IFACES), vec!["AmneziaVPN"]);
    }

    #[test]
    fn no_conflict_when_we_are_alone() {
        let routes = "Нет  Вручную  0  0.0.0.0/0  7  192.168.2.1\nНет  Вручную  0  0.0.0.0/0  32  198.18.0.2\n";
        assert!(conflicts_from(routes, IFACES).is_empty());
    }

    #[test]
    fn tunnel_without_default_route_is_not_a_conflict() {
        // Поднятый, но не забирающий маршрут туннель мешать не может.
        let routes = "Нет  Вручную  0  0.0.0.0/0  7  192.168.2.1\n";
        assert!(conflicts_from(routes, IFACES).is_empty());
    }

    #[test]
    fn our_names_never_match() {
        assert!(!is_foreign_vpn("Meta"));
        assert!(!is_foreign_vpn("NoVPN Tunnel"));
        assert!(is_foreign_vpn("WireGuard Tunnel"));
        assert!(!is_foreign_vpn("Ethernet"));
    }
}
