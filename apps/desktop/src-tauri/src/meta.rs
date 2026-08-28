//! Метаданные подписки — `GET /sub/<токен>/meta.json` (контракт панель↔клиент:
//! `docs/NOVPN-CLIENT-CONTRACT.md` в корне репозитория).
//!
//! Отсюда клиент узнаёт ПРОФИЛИ: у одного сервера их может быть два — умный
//! (список AutoRoute → в VPN, остальное напрямую) и «Полный VPN» (всё в туннель).
//! Сопоставление с конфигами подписки — по `profileId` из `meta.novpn` в каждом
//! конфиге; `host` — запасной ключ для старых панелей и чужих провайдеров.
//!
//! Два правила из контракта, которые здесь и реализованы:
//! - «панель не ответила» (таймаут, сеть, 5xx) — НЕ сигнал: живём по последней
//!   удачной копии, кэш не трогаем;
//! - любой 4xx — авторитетный ответ панели: подписка недействительна / доступ
//!   отключён / срок истёк / трафик исчерпан. Подключение блокируется, причина
//!   показывается человеку.

use crate::store;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Мажорная версия контракта, которую понимает этот клиент. Выше — деградация в
/// smart и просьба обновиться (незнакомые поля при равной версии игнорируем).
pub const SUPPORTED_SCHEMA: u64 = 1;

const CACHE: &str = "meta.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Routing {
    /// `smart` | `full`. Пусто/неизвестно = smart.
    #[serde(default)]
    pub mode: String,
    /// false (по умолчанию) — приватные подсети НАПРЯМУЮ; true — В туннель
    /// (самохостер добирается до локалки своего сервера). Легко перепутать.
    #[serde(default)]
    pub lan_access: bool,
    /// Аварийные прокси-каналы, если Xray заблокируют. Это транспорт, НЕ
    /// исключения маршрутизации.
    #[serde(default)]
    pub fallback_types: Option<Vec<String>>,
    #[serde(default)]
    pub own_exceptions: u64,
    /// Зарезервировано контрактом, панель пока не заполняет.
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub fallback_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub profile_id: String,
    #[serde(default)]
    pub server_id: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub remark: String,
    #[serde(default)]
    pub recommended: bool,
    #[serde(default)]
    pub protocols: Vec<String>,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub sub_link: String,
    #[serde(default)]
    pub routing: Routing,
}

impl Profile {
    /// Режим профиля. Отсутствие блока `routing` (старая панель) — smart.
    pub fn mode(&self) -> &'static str {
        if self.routing.mode == "full" { "full" } else { "smart" }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    #[serde(default)]
    pub schema_version: u64,
    #[serde(default)]
    pub panel: Value,
    #[serde(default)]
    pub routing_resources: BTreeMap<String, String>,
    #[serde(default)]
    pub profiles: Vec<Profile>,
}

impl Meta {
    pub fn parse(text: &str) -> Result<Meta, String> {
        let m: Meta = serde_json::from_str(text).map_err(|e| format!("meta.json не разобран: {e}"))?;
        if m.profiles.iter().any(|p| p.profile_id.trim().is_empty()) {
            return Err("meta.json: у профиля нет profileId".into());
        }
        Ok(m)
    }

    /// Мажор контракта выше нашего — данные могут значить не то, что мы думаем.
    pub fn unsupported(&self) -> bool {
        self.schema_version > SUPPORTED_SCHEMA
    }

    pub fn by_id(&self, profile_id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.profile_id == profile_id)
    }

    /// Умный профиль того же сервера — цель отката, если полный отозвали.
    pub fn smart_of_server(&self, server_id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.server_id == server_id && p.mode() == "smart")
    }
}

/// Отказ панели (4xx). `kind` — машинный код из тела ответа: `not_found`,
/// `disabled`, `expired`, `traffic`; текст — уже по-человечески.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Denied {
    pub status: u16,
    pub kind: String,
    pub message: String,
}

pub fn human(kind: &str) -> &'static str {
    match kind {
        "not_found" => "Подписка недействительна — проверьте ссылку",
        "disabled" => "Доступ отключён",
        "expired" => "Срок доступа истёк",
        "traffic" => "Лимит трафика исчерпан",
        _ => "Панель отказала в доступе",
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetaResult {
    pub meta: Option<Meta>,
    /// `network` — свежий ответ; `cache` — панель не ответила, взяли last-known-good;
    /// `none` — нет ни того, ни другого (старая панель / чужой провайдер).
    pub source: String,
    pub denied: Option<Denied>,
    /// Контракт новее нашего: работаем как smart и просим обновиться.
    pub unsupported: bool,
    /// Почему не удалось спросить панель (для диагностики; не сигнал об отзыве).
    pub network_error: Option<String>,
}

/// `https://panel/sub/<токен>[/full|/server/<id>/full]` → `https://panel/sub/<токен>/meta.json`.
/// Чужая ссылка без `/sub/<токен>/` — `None`: у неё meta.json нет по определению.
pub fn meta_url(sub_url: &str) -> Option<String> {
    let (scheme, rest) = sub_url.split_once("://")?;
    let (host, path) = match rest.split_once('/') {
        Some((h, p)) => (h, p),
        None => (rest, ""),
    };
    if host.is_empty() {
        return None;
    }
    let path = path.split(['?', '#']).next().unwrap_or("");
    let mut segs = path.split('/').filter(|s| !s.is_empty());
    while let Some(seg) = segs.next() {
        if seg == "sub" {
            let token = segs.next()?;
            if token.is_empty() {
                return None;
            }
            return Some(format!("{scheme}://{host}/sub/{token}/meta.json"));
        }
    }
    None
}

pub fn load_cached() -> Option<Meta> {
    store::read_raw(CACHE).and_then(|t| Meta::parse(&t).ok())
}

fn save_cache(text: &str) {
    let _ = store::write_raw(CACHE, text);
}

/// Спросить панель. Никогда не бросает: любой исход — это `MetaResult`, по
/// которому интерфейс решает, что показать и можно ли подключаться.
pub async fn fetch(sub_url: &str) -> MetaResult {
    let cached = load_cached();
    let Some(url) = meta_url(sub_url) else {
        return MetaResult { meta: cached, source: "none".into(), ..Default::default() };
    };
    let client = match reqwest::Client::builder()
        .user_agent(crate::sub::USER_AGENT)
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => return from_cache(cached, Some(e.to_string())),
    };
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => return from_cache(cached, Some(e.to_string())),
    };
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    if status.is_success() {
        return match Meta::parse(&body) {
            Ok(m) => {
                let unsupported = m.unsupported();
                // Кэшируем только то, что поняли: непонятную версию не пишем, иначе
                // после отката панели мы бы подняли её из кэша как «рабочую».
                if !unsupported {
                    save_cache(&body);
                }
                MetaResult { meta: Some(m), source: "network".into(), unsupported, ..Default::default() }
            }
            Err(e) => from_cache(cached, Some(e)),
        };
    }

    if status.is_client_error() {
        // 4xx — авторитетный отказ. Кэш НЕ стираем (доступ могут вернуть), но
        // интерфейс обязан заблокировать подключение до валидного 200.
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let kind = v
            .pointer("/error/type")
            .and_then(|x| x.as_str())
            .unwrap_or(if status.as_u16() == 404 { "not_found" } else { "denied" })
            .to_string();
        let message = human(&kind).to_string();
        return MetaResult {
            meta: cached,
            source: "network".into(),
            denied: Some(Denied { status: status.as_u16(), kind, message }),
            ..Default::default()
        };
    }

    // 5xx и прочее — панель нездорова, не сигнал.
    from_cache(cached, Some(format!("панель ответила {}", status.as_u16())))
}

fn from_cache(cached: Option<Meta>, err: Option<String>) -> MetaResult {
    let source = if cached.is_some() { "cache" } else { "none" };
    MetaResult { meta: cached, source: source.into(), network_error: err, ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_url_is_derived_from_any_subscription_form() {
        assert_eq!(
            meta_url("https://vpn.example/sub/TOKEN").as_deref(),
            Some("https://vpn.example/sub/TOKEN/meta.json")
        );
        assert_eq!(
            meta_url("https://vpn.example/sub/TOKEN/full").as_deref(),
            Some("https://vpn.example/sub/TOKEN/meta.json")
        );
        assert_eq!(
            meta_url("https://vpn.example/sub/TOKEN/server/s_1/full?profile=full").as_deref(),
            Some("https://vpn.example/sub/TOKEN/meta.json")
        );
        assert_eq!(meta_url("https://other.example/api/v1/client/subscribe?token=x"), None);
        assert_eq!(meta_url("not a url"), None);
    }

    #[test]
    fn profile_without_routing_is_smart() {
        let m = Meta::parse(r#"{"schemaVersion":1,"profiles":[{"profileId":"s1","host":"h"}]}"#).unwrap();
        assert_eq!(m.profiles[0].mode(), "smart");
        assert!(!m.unsupported());
        let n = Meta::parse(r#"{"schemaVersion":99,"profiles":[]}"#).unwrap();
        assert!(n.unsupported());
    }

    #[test]
    fn human_reasons_match_contract() {
        assert!(human("disabled").contains("отключён"));
        assert!(human("expired").contains("истёк"));
        assert!(human("traffic").contains("трафика"));
        assert!(human("not_found").contains("недействительна"));
    }
}
