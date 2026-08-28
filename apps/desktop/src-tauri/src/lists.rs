//! Списки маршрутизации, приходящие с панели NoVPN.
//!
//! Это второй слой правил. При обновлении он заменяется целиком — в отличие от
//! правил человека, которые лежат отдельно и не трогаются никогда.
//!
//! По контракту (docs/NOVPN-CLIENT-CONTRACT.md, раздел 7) с панели приходят два
//! файла: `upstream.json` — база AutoRoute («что не работает в России», всё в
//! нём → через VPN) и `apps.json` — каталог приложений. `sites.json` убран:
//! список сайтов человек ведёт локально.
//!
//! Грамматика `upstream.items[]` (домены и IP вперемешку):
//!   `example.com`      → DOMAIN-SUFFIX   (домен и поддомены)
//!   `full:x.y`         → DOMAIN          (только точное совпадение)
//!   `keyword:слово`    → DOMAIN-KEYWORD
//!   `regexp:^ad\..*`   → DOMAIN-REGEX    (невалидные пропускаем — они из чужих источников)
//!   `1.2.3.4`, `10.0.0.0/8`, IPv6 → IP-CIDR (голый адрес → /32 или /128)
//!
//! Обновление — через `manifest.json` (sha256 по файлам) и условный GET с
//! `If-None-Match`: неизменившийся список не перекачивается, `304` оставляет
//! локальную копию. Любая ошибка — last-known-good: рабочие файлы не стираем.

use crate::store;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const FILES: [&str; 2] = ["upstream", "apps"];

/// Похоже ли на настоящий список маршрутизации: непустой массив или объект с
/// непустым `items`. Отсекает `[]`, `{}` и ответы-заглушки вроде `{"detail":…}`.
fn looks_like_list(text: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    match &v {
        Value::Array(a) => !a.is_empty(),
        Value::Object(_) => v
            .get("items")
            .and_then(|x| x.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false),
        _ => false,
    }
}

#[derive(Debug, Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Lists {
    /// Домены с поддоменами → через VPN.
    pub vpn_domains: Vec<String>,
    /// Точные домены → через VPN.
    pub vpn_full: Vec<String>,
    /// Подстроки хоста → через VPN.
    pub vpn_keywords: Vec<String>,
    /// Регулярные выражения → через VPN (уже проверенные на компилируемость).
    pub vpn_regex: Vec<String>,
    /// Подсети/адреса → через VPN (то, что достижимо по IP без SNI: DC Telegram, CDN).
    pub vpn_ips: Vec<String>,
    /// Домены «напрямую» (из объектных записей с `route: direct` и локальных пресетов).
    pub direct_domains: Vec<String>,
    pub apps: Vec<AppEntry>,
    /// Сколько элементов пришло в каждом файле — показываем в разделе «Списки».
    pub counts: Vec<(String, usize)>,
    /// Версия/дата базы по манифесту панели (для статуса «Правила vN»).
    pub version: Option<u64>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub route: String,
    pub processes: Vec<String>,
}

/// Сведения о скачанном файле — рядом с ним, чтобы условный GET и манифест
/// работали и после перезапуска.
#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
    sha256: String,
    #[serde(default)]
    etag: String,
    #[serde(default)]
    version: Option<u64>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ManifestFile {
    name: String,
    #[serde(default)]
    version: u64,
    #[serde(default)]
    sha256: String,
    #[serde(default, rename = "updatedAt")]
    updated_at: String,
    #[serde(default)]
    url: String,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    #[serde(default)]
    files: Vec<ManifestFile>,
}

/// Базовый адрес панели из адреса подписки: `https://…/sub/КЛЮЧ/full` → `https://…`
pub fn base_of(sub_url: &str) -> Option<String> {
    let rest = sub_url.split("://").nth(1)?;
    let host = rest.split('/').next()?;
    let scheme = sub_url.split("://").next()?;
    if host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

fn items(v: &Value) -> Vec<Value> {
    v.get("items")
        .and_then(|x| x.as_array())
        .cloned()
        .or_else(|| v.as_array().cloned())
        .unwrap_or_default()
}

fn is_ipv4(s: &str) -> bool {
    let (addr, mask) = match s.split_once('/') {
        Some((a, m)) => (a, Some(m)),
        None => (s, None),
    };
    let octets: Vec<&str> = addr.split('.').collect();
    if octets.len() != 4 || !octets.iter().all(|o| !o.is_empty() && o.len() <= 3 && o.chars().all(|c| c.is_ascii_digit()) && o.parse::<u16>().map(|n| n <= 255).unwrap_or(false)) {
        return false;
    }
    mask.map(|m| m.parse::<u8>().map(|n| n <= 32).unwrap_or(false)).unwrap_or(true)
}

fn is_ipv6(s: &str) -> bool {
    let (addr, mask) = match s.split_once('/') {
        Some((a, m)) => (a, Some(m)),
        None => (s, None),
    };
    addr.contains(':')
        && addr.chars().all(|c| c.is_ascii_hexdigit() || c == ':')
        && addr.parse::<std::net::Ipv6Addr>().is_ok()
        && mask.map(|m| m.parse::<u8>().map(|n| n <= 128).unwrap_or(false)).unwrap_or(true)
}

/// Одна строка `upstream.items[]` → в нужное ведро. Всё в upstream — «через VPN».
pub fn absorb_upstream_item(raw: &str, out: &mut Lists) {
    let s = raw.trim();
    if s.is_empty() {
        return;
    }
    if let Some(rest) = s.strip_prefix("full:") {
        let d = rest.trim().to_lowercase();
        if !d.is_empty() {
            out.vpn_full.push(d);
        }
        return;
    }
    if let Some(rest) = s.strip_prefix("keyword:") {
        let k = rest.trim().to_lowercase();
        if !k.is_empty() {
            out.vpn_keywords.push(k);
        }
        return;
    }
    if let Some(rest) = s.strip_prefix("regexp:") {
        let re = rest.trim();
        // Панель регэкспы не проверяет — источники чужие. Невалидный пропускаем:
        // одна кривая строка иначе сделала бы весь конфиг движка невалидным.
        if !re.is_empty() && regex::Regex::new(re).is_ok() {
            out.vpn_regex.push(re.to_string());
        }
        return;
    }
    if is_ipv4(s) {
        out.vpn_ips.push(if s.contains('/') { s.to_string() } else { format!("{s}/32") });
        return;
    }
    if is_ipv6(s) {
        out.vpn_ips.push(if s.contains('/') { s.to_lowercase() } else { format!("{}/128", s.to_lowercase()) });
        return;
    }
    let d = s.trim_start_matches("domain:").trim().to_lowercase();
    if !d.is_empty() {
        out.vpn_domains.push(d);
    }
}

/// Разбирает один файл. `upstream` — по грамматике контракта; объектные записи
/// (`{domain, route}` из старых/локальных списков и `{processes}` для приложений)
/// понимаем в любом файле.
fn absorb(name: &str, v: &Value, out: &mut Lists) {
    let list = items(v);
    out.counts.push((name.to_string(), list.len()));

    for it in list {
        match it {
            Value::String(text) => absorb_upstream_item(&text, out),
            Value::Object(_) => {
                let route = it.get("route").and_then(|x| x.as_str()).unwrap_or("vpn");
                if let Some(d) = it.get("domain").and_then(|x| x.as_str()) {
                    let d = d.trim().to_lowercase();
                    if d.is_empty() {
                        continue;
                    }
                    if route == "direct" {
                        out.direct_domains.push(d);
                    } else {
                        out.vpn_domains.push(d);
                    }
                } else if let Some(procs) = it.get("processes").and_then(|x| x.as_array()) {
                    let name = it.get("name").and_then(|x| x.as_str()).unwrap_or("Программа");
                    out.apps.push(AppEntry {
                        id: it.get("id").and_then(|x| x.as_str()).unwrap_or(name).to_string(),
                        name: name.to_string(),
                        route: route.to_string(),
                        processes: procs.iter().filter_map(|p| p.as_str().map(String::from)).collect(),
                    });
                }
            }
            _ => {}
        }
    }
}

/// Собирает сохранённые списки в вид, готовый для правил.
pub fn load() -> Lists {
    let mut out = Lists::default();
    for name in FILES {
        let path = store::lists_dir().join(format!("{name}.json"));
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        absorb(name, &v, &mut out);
        if name == "upstream" {
            if let Some(sc) = read_sidecar(name) {
                out.version = sc.version;
                out.updated_at = sc.updated_at;
            }
        }
    }
    dedupe(&mut out);
    out
}

/// Один домен мог прийти дважды. Дубли в конфиге безвредны, но раздувают
/// его на тысячи строк и мешают читать при разборе.
fn dedupe(l: &mut Lists) {
    let mut seen = std::collections::HashSet::new();
    l.direct_domains.retain(|d| seen.insert(d.clone()));
    // «Напрямую» уже занято — тот же домен во втором списке не нужен.
    l.vpn_domains.retain(|d| seen.insert(d.clone()));
    let mut seen_full = std::collections::HashSet::new();
    l.vpn_full.retain(|d| seen_full.insert(d.clone()));
    let mut seen_kw = std::collections::HashSet::new();
    l.vpn_keywords.retain(|d| seen_kw.insert(d.clone()));
    let mut seen_re = std::collections::HashSet::new();
    l.vpn_regex.retain(|d| seen_re.insert(d.clone()));
    let mut seen_ip = std::collections::HashSet::new();
    l.vpn_ips.retain(|d| seen_ip.insert(d.clone()));
}

fn sidecar_path(name: &str) -> std::path::PathBuf {
    store::lists_dir().join(format!("{name}.meta.json"))
}
fn read_sidecar(name: &str) -> Option<Sidecar> {
    let t = std::fs::read_to_string(sidecar_path(name)).ok()?;
    serde_json::from_str(&t).ok()
}
fn write_sidecar(name: &str, sc: &Sidecar) {
    if let Ok(t) = serde_json::to_string_pretty(sc) {
        let _ = std::fs::write(sidecar_path(name), t);
    }
}

fn sha256_hex(text: &str) -> String {
    let d = Sha256::digest(text.as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// Атомарная запись списка: temp → rename, чтобы обрыв не оставил усечённый файл.
fn write_list(name: &str, text: &str) -> Result<(), String> {
    let dir = store::lists_dir();
    let target = dir.join(format!("{name}.json"));
    let tmp = dir.join(format!("{name}.json.tmp"));
    std::fs::write(&tmp, text).map_err(|e| format!("{name}: не удалось записать: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("{name}: не удалось записать: {e}"))
}

pub async fn sync(base: &str) -> Result<Lists, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let dir = store::lists_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать папку списков: {e}"))?;

    // 1. Манифест: один запрос, чтобы понять, что изменилось. Нет манифеста
    //    (старая панель) — качаем файлы напрямую условным GET.
    let manifest: Option<Manifest> = match client.get(format!("{base}/routing/manifest.json")).send().await {
        Ok(r) if r.status().is_success() => r.json::<Manifest>().await.ok(),
        _ => None,
    };

    let mut fetched = 0usize;
    let mut unchanged = 0usize;
    let mut last_err = String::new();
    for name in FILES {
        let local = read_sidecar(name).unwrap_or_default();
        let have_file = dir.join(format!("{name}.json")).exists();
        let entry = manifest.as_ref().and_then(|m| m.files.iter().find(|f| f.name == name));

        // Манифест говорит «тот же sha256» и файл на месте — не качаем вовсе.
        if let Some(e) = entry {
            if have_file && !e.sha256.is_empty() && e.sha256.eq_ignore_ascii_case(&local.sha256) {
                unchanged += 1;
                write_sidecar(name, &Sidecar { version: Some(e.version), updated_at: Some(e.updated_at.clone()), ..local });
                continue;
            }
        }

        let url = entry
            .map(|e| e.url.clone())
            .filter(|u| u.starts_with("http"))
            .unwrap_or_else(|| format!("{base}/routing/{name}.json"));
        let mut req = client.get(&url);
        if have_file && !local.etag.is_empty() {
            req = req.header("If-None-Match", &local.etag);
        }
        match req.send().await {
            Ok(r) if r.status().as_u16() == 304 => {
                unchanged += 1;
            }
            Ok(r) if r.status().is_success() => {
                let etag = r.headers().get("etag").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                match r.text().await {
                    Ok(text) if looks_like_list(&text) => {
                        // Пишем только осмысленный список: `[]` или `{"detail":…}`
                        // тоже валидный JSON и затёр бы рабочий список пустотой.
                        match write_list(name, &text) {
                            Ok(()) => {
                                fetched += 1;
                                write_sidecar(
                                    name,
                                    &Sidecar {
                                        sha256: sha256_hex(&text),
                                        etag,
                                        version: entry.map(|e| e.version),
                                        updated_at: entry.map(|e| e.updated_at.clone()),
                                    },
                                );
                            }
                            Err(e) => last_err = e,
                        }
                    }
                    Ok(_) => last_err = format!("{name}: пустой или неожиданный ответ"),
                    Err(e) => last_err = format!("{name}: {e}"),
                }
            }
            Ok(r) => last_err = format!("{name}: сервер ответил {}", r.status().as_u16()),
            Err(e) => last_err = format!("{name}: {e}"),
        }
    }

    if fetched == 0 && unchanged == 0 {
        return Err(if last_err.is_empty() { "Списки не удалось получить".into() } else { last_err });
    }
    Ok(load())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_grammar_lands_in_the_right_buckets() {
        let mut l = Lists::default();
        for it in [
            "example.com",
            "domain:Sub.Example.COM",
            "full:exact.example",
            "keyword:Google",
            "regexp:^ad\\..*",
            "regexp:(unclosed",
            "1.2.3.4",
            "10.0.0.0/8",
            "2001:db8::/32",
            "2001:db8::1",
            "   ",
        ] {
            absorb_upstream_item(it, &mut l);
        }
        assert_eq!(l.vpn_domains, vec!["example.com", "sub.example.com"]);
        assert_eq!(l.vpn_full, vec!["exact.example"]);
        assert_eq!(l.vpn_keywords, vec!["google"]);
        assert_eq!(l.vpn_regex, vec!["^ad\\..*"], "невалидный регэксп пропущен");
        assert_eq!(l.vpn_ips, vec!["1.2.3.4/32", "10.0.0.0/8", "2001:db8::/32", "2001:db8::1/128"]);
    }

    #[test]
    fn base_of_subscription_url() {
        assert_eq!(base_of("https://vpn.example/sub/T/full").as_deref(), Some("https://vpn.example"));
        assert_eq!(base_of("garbage"), None);
    }
}
