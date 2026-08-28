//! Списки маршрутизации, приходящие с сервера NoVPN.
//!
//! Это второй слой правил. При обновлении он заменяется целиком — в отличие от
//! правил человека, которые лежат отдельно и не трогаются никогда.
//!
//! Формат приходящих файлов заранее не задан жёстко: панель может отдавать
//! простой список строк, а может — записи с маршрутом. Разбираем оба, потому
//! что чинить приложение при каждом изменении формата на сервере нельзя.

use crate::store;
use serde::Serialize;
use serde_json::Value;

const FILES: [&str; 3] = ["upstream", "sites", "apps"];

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
    pub vpn_domains: Vec<String>,
    pub direct_domains: Vec<String>,
    pub apps: Vec<AppEntry>,
    /// Сколько элементов пришло в каждом файле — показываем в разделе «Списки».
    pub counts: Vec<(String, usize)>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub route: String,
    pub processes: Vec<String>,
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

/// Разбирает один файл. `default_vpn` задаёт смысл голых строк: в `upstream`
/// перечислено то, что не открывается без туннеля, то есть маршрут «через VPN».
fn absorb(name: &str, v: &Value, out: &mut Lists, default_vpn: bool) {
    let list = items(v);
    out.counts.push((name.to_string(), list.len()));

    for it in list {
        match it {
            Value::String(domain) => {
                let d = domain.trim().trim_start_matches("domain:").to_lowercase();
                if d.is_empty() {
                    continue;
                }
                if default_vpn {
                    out.vpn_domains.push(d);
                } else {
                    out.direct_domains.push(d);
                }
            }
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
                        id: it
                            .get("id")
                            .and_then(|x| x.as_str())
                            .unwrap_or(name)
                            .to_string(),
                        name: name.to_string(),
                        route: route.to_string(),
                        processes: procs
                            .iter()
                            .filter_map(|p| p.as_str().map(String::from))
                            .collect(),
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
        absorb(name, &v, &mut out, true);
    }
    dedupe(&mut out);
    out
}

/// Один домен мог прийти в двух файлах. Дубли в конфиге безвредны, но раздувают
/// его на тысячи строк и мешают читать при разборе.
fn dedupe(l: &mut Lists) {
    let mut seen = std::collections::HashSet::new();
    l.direct_domains.retain(|d| seen.insert(d.clone()));
    // «Напрямую» уже занято — тот же домен во втором списке не нужен.
    l.vpn_domains.retain(|d| seen.insert(d.clone()));
}

pub async fn sync(base: &str) -> Result<Lists, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let dir = store::lists_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать папку списков: {e}"))?;

    let mut fetched = 0usize;
    let mut last_err = String::new();
    for name in FILES {
        let url = format!("{base}/routing/{name}.json");
        match client.get(&url).send().await {
            Ok(r) if r.status().is_success() => match r.text().await {
                Ok(text) if looks_like_list(&text) => {
                    // Пишем только осмысленный список. Валидного JSON мало:
                    // ответ `[]` или `{"detail":"unauthorized"}` тоже валиден и
                    // затёр бы рабочий список пустотой. Через temp+rename —
                    // чтобы обрыв не оставил усечённый файл.
                    let target = dir.join(format!("{name}.json"));
                    let tmp = dir.join(format!("{name}.json.tmp"));
                    if std::fs::write(&tmp, &text).is_ok() && std::fs::rename(&tmp, &target).is_ok() {
                        fetched += 1;
                    } else {
                        last_err = format!("{name}: не удалось записать");
                    }
                }
                Ok(_) => last_err = format!("{name}: пустой или неожиданный ответ"),
                Err(e) => last_err = format!("{name}: {e}"),
            },
            Ok(r) => last_err = format!("{name}: сервер ответил {}", r.status().as_u16()),
            Err(e) => last_err = format!("{name}: {e}"),
        }
    }

    if fetched == 0 {
        return Err(if last_err.is_empty() {
            "Списки не удалось получить".into()
        } else {
            last_err
        });
    }
    Ok(load())
}
