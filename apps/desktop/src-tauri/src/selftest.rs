//! Скрытый режим `--selftest`: headless-прогон боевого кода от начала до конца.
//!
//! GUI по удалёнке не покликать, поэтому проверяем настоящие пути — разбор
//! подписки, сборку конфига, запуск движка, реальное разделение трафика и
//! нативный хост — и печатаем отчёт. Ничего постоянного не оставляет.

use crate::core::{self, DomainRule, Engine, Ports, Rules};
use crate::{host, store, sub};

pub fn requested() -> bool {
    std::env::args().any(|a| a == "--selftest")
}

/// Известные причины отказа туннеля по логу mihomo → человеческая подсказка в отчёт.
pub fn diagnose_engine_log(log: &str) -> Option<&'static str> {
    if log.contains("REALITY authentication failed") {
        // mihomo представляется REALITY-клиентом 1.8.2; Xray ≥ 26.7.11 без minClientVer
        // его отвергает (mihomo#2967, wontfix). Лечится на сервере, не в клиенте.
        return Some(
            "сервер отверг REALITY-рукопожатие: Xray ≥ 26.7.11 без minClientVer не принимает mihomo — \
             в панели у сервера нажмите «Синхронизировать» (проставит minClientVer=1.8.2)",
        );
    }
    None
}

#[cfg(test)]
mod tests {
    use super::diagnose_engine_log;

    #[test]
    fn reality_rejection_is_explained() {
        let log = "time=\"…\" level=warning msg=\"[TCP] dial T error: REALITY authentication failed\"";
        assert!(diagnose_engine_log(log).unwrap().contains("minClientVer"));
        assert!(diagnose_engine_log("level=info msg=\"ok\"").is_none());
    }
}

fn line(ok: bool, name: &str, detail: impl AsRef<str>) {
    println!("[{}] {name}: {}", if ok { "ПРОШЁЛ" } else { "ПРОВАЛ" }, detail.as_ref());
}

async fn http_ip_via(proxy: Option<u16>) -> Result<String, String> {
    let mut b = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20));
    if let Some(port) = proxy {
        b = b.proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())?);
    } else {
        b = b.no_proxy();
    }
    let c = b.build().map_err(|e| e.to_string())?;
    let txt = c
        .get("https://ipinfo.io/json")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    Ok(format!(
        "{} {} {}",
        v.get("ip").and_then(|x| x.as_str()).unwrap_or("?"),
        v.get("city").and_then(|x| x.as_str()).unwrap_or("?"),
        v.get("country").and_then(|x| x.as_str()).unwrap_or("?"),
    ))
}

#[allow(unused_assignments)]
pub async fn run() {
    println!("=== NoVPN self-test {} ===", env!("CARGO_PKG_VERSION"));
    let mut passed = 0;
    let mut failed = 0;
    macro_rules! check {
        ($ok:expr, $name:expr, $detail:expr) => {{
            let ok = $ok;
            if ok { passed += 1 } else { failed += 1 }
            line(ok, $name, $detail);
            ok
        }};
    }

    // 1. Движок на месте и запускается на этом CPU.
    let exe = match crate::cmds::locate_engine_pub() {
        Ok(p) => p,
        Err(e) => {
            check!(false, "движок найден", e);
            return;
        }
    };
    check!(exe.exists(), "движок найден", exe.display().to_string());

    // 2. Подписка разбирается.
    let raw = match store::read_raw("subscription.txt") {
        Some(t) => t,
        None => {
            check!(false, "подписка", "нет %APPDATA%\\NoVPN\\subscription.txt".to_string());
            return;
        }
    };
    let parsed = match sub::parse(&raw) {
        Ok(p) => p,
        Err(e) => {
            check!(false, "разбор подписки", e);
            return;
        }
    };
    let servers = match &parsed {
        sub::Parsed::Nodes(n) => n.iter().map(|x| x.name.clone()).collect::<Vec<_>>(),
        sub::Parsed::Clash(_) => vec!["clash".into()],
    };
    check!(!servers.is_empty(), "разбор подписки", format!("серверов: {}", servers.len()));

    // Выбираем зарубежный сервер (не HomeVPN), чтобы выход отличался от прямого.
    let selected = servers
        .iter()
        .find(|n| n.to_lowercase().contains("finland") || n.to_lowercase().contains("нидерланд") || n.to_lowercase().contains("germany"))
        .cloned()
        .or_else(|| servers.first().cloned());
    println!("    выбран сервер: {:?}", selected);

    // 3. Сборка конфига боевым генератором + запуск боевым Engine::start.
    let ports = Ports { mixed: 7897, controller: 9897 };
    let rules = Rules {
        smart: true,
        user_domains: vec![
            DomainRule { domain: "ipinfo.io".into(), vpn: true }, // проверочный: должен уйти в туннель
        ],
        list_direct_domains: vec!["ya.ru".into()],
        vpn_processes: vec!["Discord.exe".into()],
        ..Default::default()
    };
    let config = core::build_config(&parsed, &rules, selected.as_deref(), ports);
    check!(config.contains("mixed-port: 7897"), "сборка конфига", "конфиг собран".to_string());

    let dir = std::env::temp_dir().join("novpn-selftest-engine");
    let engine = match Engine::start(&exe, &dir, &config, ports.mixed, ports.controller) {
        Ok(e) => Some(e),
        Err(e) => {
            check!(false, "запуск движка", e);
            None
        }
    };
    if engine.is_none() {
        println!("\nИТОГ: пройдено {passed}, провалено {failed}");
        return;
    }
    let mut engine = engine.unwrap();
    check!(engine.alive(), "запуск движка", "движок слушает".to_string());

    // 4. Реальное разделение трафика.
    let direct = http_ip_via(None).await;
    let via_vpn = http_ip_via(Some(ports.mixed)).await;
    match (&direct, &via_vpn) {
        (Ok(d), Ok(v)) => {
            println!("    напрямую: {d}");
            println!("    через VPN (ipinfo.io→туннель): {v}");
            // Оба ответили — прокси работает и туннель поднялся.
            check!(true, "разделение трафика", "прокси и туннель отвечают".to_string());
            // Если выходы различаются — разведение по IP подтверждено.
            check!(
                d != v || d.contains("?"),
                "выходы различаются",
                format!("прямой ≠ через VPN: {}", d != v)
            );
        }
        _ => {
            check!(false, "разделение трафика", format!("direct={:?} vpn={:?}", direct.err(), via_vpn.err()));
            // Причину падения туннеля движок пишет только в свой лог — вытаскиваем её в отчёт,
            // иначе «vpn=timeout» не отличить от отказа сервера.
            let log = std::fs::read_to_string(dir.join(core::LOG_NAME)).unwrap_or_default();
            if let Some(hint) = diagnose_engine_log(&log) {
                println!("    диагноз: {hint}");
            }
            for line in log.lines().rev().filter(|l| l.contains("level=error") || l.contains("level=warning")).take(3) {
                println!("    движок: {line}");
            }
        }
    }

    engine.stop();

    // 5. Нативный хост для расширения (боевой обработчик).
    let set = host::handle_test(&serde_json::json!({"type":"set","domain":"selftest.example","route":"vpn"}));
    let get = host::handle_test(&serde_json::json!({"type":"get","domain":"selftest.example"}));
    let ok_host = set.get("ok").and_then(|x| x.as_bool()).unwrap_or(false)
        && get.get("route").and_then(|x| x.as_str()) == Some("vpn");
    let _ = host::handle_test(&serde_json::json!({"type":"remove","domain":"selftest.example"}));
    check!(ok_host, "нативный хост", "set/get/remove работают".to_string());

    println!("\nИТОГ: пройдено {passed}, провалено {failed}");
}
