//! Аварийный пул серверов (резервная маршрутизация) на десктопе — порт логики
//! Android reserve. Тянем `/sub/<token>/backup` (base64-список ссылок), кэшируем в
//! `reserve.txt`. Резерв — подстраховка, поэтому ошибки глотаем.

use crate::sub::{self, Node, Parsed};
use crate::store;

/// URL аварийного пула из адреса подписки: `<base>/sub/<token>/backup`.
pub fn backup_url(sub_url: &str) -> Option<String> {
    let idx = sub_url.find("/sub/")?;
    let after = &sub_url[idx + 5..];
    let token = after.split('/').next()?;
    if token.is_empty() {
        return None;
    }
    Some(format!("{}/sub/{}/backup", &sub_url[..idx], token))
}

/// Тянет аварийный пул и кэширует. Кэшируем ТОЛЬКО валидный непустой список.
pub async fn sync(sub_url: &str) {
    let Some(url) = backup_url(sub_url) else {
        return;
    };
    let Ok(client) = reqwest::Client::builder()
        .user_agent(sub::USER_AGENT)
        .timeout(std::time::Duration::from_secs(20))
        .build()
    else {
        return;
    };
    let Ok(resp) = client.get(&url).send().await else {
        return;
    };
    if !resp.status().is_success() {
        return;
    }
    let Ok(text) = resp.text().await else {
        return;
    };
    if text.trim().is_empty() {
        return;
    }
    let ok = matches!(sub::parse(&text), Ok(Parsed::Nodes(ref n)) if !n.is_empty());
    if ok {
        let _ = store::write_raw("reserve.txt", &text);
    }
}

/// Разобранные резервные серверы из кэша (скрыты из обычного списка).
pub fn cached_nodes() -> Vec<Node> {
    match store::read_raw("reserve.txt").and_then(|t| sub::parse(&t).ok()) {
        Some(Parsed::Nodes(n)) => n,
        _ => Vec::new(),
    }
}

/// Имена резервных серверов, ГОДНЫХ для обхода белых списков: российские
/// исключаем (из РФ российское ограничение не обойти).
pub fn bypass_candidate_names() -> Vec<String> {
    cached_nodes()
        .into_iter()
        .filter(|n| !crate::flags::is_russian(&n.name))
        .map(|n| n.name)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_url_derived_from_subscription() {
        assert_eq!(
            backup_url("https://vpn.example/sub/TOKEN/full").as_deref(),
            Some("https://vpn.example/sub/TOKEN/backup")
        );
        assert_eq!(
            backup_url("https://vpn.example/sub/TOKEN").as_deref(),
            Some("https://vpn.example/sub/TOKEN/backup")
        );
        assert_eq!(backup_url("https://vpn.example/other"), None);
    }
}
