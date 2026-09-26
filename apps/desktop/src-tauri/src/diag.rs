//! Диагностика сети — порт `apps/android/.../vpn/Diag.kt`.
//!
//! Различаем по СОВОКУПНОСТИ признаков (а не по одному сайту): интернета нет /
//! ограниченный режим («белые списки») / наши серверы недоступны / всё в порядке.
//! Как отличаем белые списки: российские ресурсы доступны, а обычные внешние
//! (Google/Cloudflare) и наши серверы — нет.

use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetDiagnosis {
    NoInternet,
    Restricted, // похоже на белые списки
    ServerDown, // наши серверы недоступны, внешние есть
    Ok,
}

/// Российские ресурсы: доступны даже в ограниченной сети.
const RUSSIA: &[&str] = &["https://ya.ru/", "https://www.ozon.ru/", "https://vk.com/"];
/// Обычные внешние ресурсы: в ограниченной сети недоступны.
const EXTERNAL: &[&str] = &[
    "https://www.google.com/generate_204",
    "https://cp.cloudflare.com/generate_204",
    "https://www.gstatic.com/generate_204",
];

/// Классификация по совокупности признаков (вынесено для тестируемости).
/// Таблица совпадает с Android `Diag.classify`.
pub fn classify(russia_up: bool, external_up: bool, novpn_up: bool) -> NetDiagnosis {
    match (russia_up, external_up, novpn_up) {
        (false, false, false) => NetDiagnosis::NoInternet,
        (_, true, true) => NetDiagnosis::Ok,
        (_, true, false) => NetDiagnosis::ServerDown,
        (true, false, _) => NetDiagnosis::Restricted,
        // Осталось лишь (false,false,true) — интернет через наши серверы есть.
        _ => NetDiagnosis::Ok,
    }
}

fn probe_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(6))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Доступен ли хоть один URL из списка (любой ответ 200..499 = «сеть дошла»).
async fn any_reachable(client: &reqwest::Client, urls: &[&str]) -> bool {
    let mut handles = Vec::new();
    for u in urls {
        let c = client.clone();
        let url = (*u).to_string();
        handles.push(tokio::spawn(async move {
            matches!(
                c.head(&url).header("User-Agent", "NoVPN-Diag").send().await,
                Ok(r) if (200..500).contains(&r.status().as_u16())
            )
        }));
    }
    for h in handles {
        if let Ok(true) = h.await {
            return true;
        }
    }
    false
}

/// TCP-достижимость хотя бы одного нашего сервера (host, port).
async fn any_server_up(servers: &[(String, u16)]) -> bool {
    if servers.is_empty() {
        return false;
    }
    let mut handles = Vec::new();
    for (host, port) in servers.iter().take(4) {
        let addr = format!("{host}:{port}");
        handles.push(tokio::spawn(async move {
            matches!(timeout(Duration::from_secs(4), TcpStream::connect(&addr)).await, Ok(Ok(_)))
        }));
    }
    for h in handles {
        if let Ok(true) = h.await {
            return true;
        }
    }
    false
}

/// Полная диагностика. `servers` — адреса обычных серверов (host, port), чтобы
/// отличить «наши серверы легли» от «интернета нет вовсе».
pub async fn diagnose(servers: &[(String, u16)]) -> NetDiagnosis {
    let c = probe_client();
    let russia = any_reachable(&c, RUSSIA).await;
    let external = any_reachable(&c, EXTERNAL).await;
    let novpn = any_server_up(servers).await;
    classify(russia, external, novpn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_matches_android_table() {
        assert_eq!(classify(false, false, false), NetDiagnosis::NoInternet);
        assert_eq!(classify(true, true, true), NetDiagnosis::Ok);
        assert_eq!(classify(true, true, false), NetDiagnosis::ServerDown);
        assert_eq!(classify(true, false, false), NetDiagnosis::Restricted);
        assert_eq!(classify(false, false, true), NetDiagnosis::Ok);
    }
}
