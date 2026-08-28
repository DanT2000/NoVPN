//! Разбор подписки.
//!
//! Формат заранее неизвестен: приложение должно принимать ссылку любого
//! провайдера, а не только NoVPN. Встречаются четыре вида, и все четыре нужно
//! узнавать по содержимому, а не по расширению или заголовку — провайдеры
//! отдают что угодно с чем угодно.
//!
//! Точку подключения храним не своей структурой, а готовой картой параметров
//! для Mihomo. Сочетаний транспорта, шифрования и маскировки — десятки, и
//! заводить под каждое своё поле значит бесконечно догонять чужие релизы.
//! Достаточно, чтобы Mihomo это принял.

use base64::Engine;
use serde_yaml::{Mapping, Value};

/// Что удалось разобрать из подписки.
#[derive(Debug)]
pub enum Parsed {
    /// Провайдер отдал готовый Clash-конфиг. Берём целиком как основу: там уже
    /// настроены его группы и балансировка, ломать это не за чем.
    Clash(Value),
    /// Список точек, собранный из ссылок или из Xray-JSON.
    Nodes(Vec<Node>),
}

/// Служебные поля профиля NoVPN из `meta.novpn` каждого конфига подписки
/// (контракт, раздел 3). Есть только у подписок панели NoVPN; у ссылок и чужих
/// Clash-конфигов их нет — тогда профиль один, режим smart, Full не появляется.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeProfile {
    pub profile_id: String,
    pub server_id: String,
    pub host: String,
    /// `smart` | `full`.
    pub mode: String,
}

#[derive(Debug, Clone)]
pub struct Node {
    pub name: String,
    pub map: Mapping,
    pub profile: Option<NodeProfile>,
}

fn s(v: &str) -> Value {
    Value::String(v.to_string())
}

fn put(m: &mut Mapping, k: &str, v: Value) {
    m.insert(s(k), v);
}

fn put_str(m: &mut Mapping, k: &str, v: &str) {
    if !v.is_empty() {
        m.insert(s(k), s(v));
    }
}

/// Запросы к подписке ходят под видом привычного провайдерам клиента: часть
/// панелей отдаёт разный формат в зависимости от User-Agent, а некоторые вовсе
/// отказывают незнакомым.
pub const USER_AGENT: &str = "v2rayNG/1.9.5";

pub fn parse(raw: &str) -> Result<Parsed, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("Подписка пустая".into());
    }

    // 1. JSON — Xray-массив конфигов (так отдаёт NoVPN) или одиночный конфиг.
    if text.starts_with('[') || text.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
            let nodes = from_xray_json(&v);
            if !nodes.is_empty() {
                return Ok(Parsed::Nodes(nodes));
            }
        }
    }

    // 2. Готовый Clash/Mihomo YAML.
    if text.contains("proxies:") {
        if let Ok(v) = serde_yaml::from_str::<Value>(text) {
            if v.get("proxies").and_then(|p| p.as_sequence()).is_some() {
                return Ok(Parsed::Clash(v));
            }
        }
    }

    // 3. Список ссылок — как есть либо в base64.
    let plain = if text.contains("://") {
        text.to_string()
    } else {
        decode_base64(text).ok_or("Не удалось разобрать подписку: неизвестный формат")?
    };
    let nodes = from_links(&plain);
    if nodes.is_empty() {
        return Err("В подписке не нашлось ни одного сервера".into());
    }
    Ok(Parsed::Nodes(nodes))
}

/// Подписки приходят и в обычном base64, и в URL-безопасном, и без выравнивания.
fn decode_base64(t: &str) -> Option<String> {
    let cleaned: String = t.chars().filter(|c| !c.is_whitespace()).collect();
    let engines: [&dyn Fn(&str) -> Option<Vec<u8>>; 2] = [
        &|x: &str| base64::engine::general_purpose::STANDARD_NO_PAD.decode(x.trim_end_matches('=')).ok(),
        &|x: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(x.trim_end_matches('=')).ok(),
    ];
    for e in engines {
        if let Some(bytes) = e(&cleaned) {
            if let Ok(text) = String::from_utf8(bytes) {
                if text.contains("://") {
                    return Some(text);
                }
            }
        }
    }
    None
}

fn from_links(text: &str) -> Vec<Node> {
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        let node = if l.starts_with("vless://") {
            parse_vless(l)
        } else if l.starts_with("vmess://") {
            parse_vmess(l)
        } else if l.starts_with("trojan://") {
            parse_trojan(l)
        } else if l.starts_with("ss://") {
            parse_ss(l)
        } else {
            None
        };
        if let Some(n) = node {
            out.push(n);
        }
    }
    dedupe_names(out)
}

/// Имена точек у провайдеров часто повторяются, а Mihomo требует уникальных.
fn dedupe_names(mut nodes: Vec<Node>) -> Vec<Node> {
    let mut seen: Vec<String> = Vec::new();
    for n in nodes.iter_mut() {
        if n.name.trim().is_empty() {
            n.name = "Сервер".into();
        }
        let base = n.name.clone();
        let mut i = 2;
        while seen.contains(&n.name) {
            n.name = format!("{base} #{i}");
            i += 1;
        }
        seen.push(n.name.clone());
        n.map.insert(s("name"), s(&n.name));
    }
    nodes
}

struct Uri {
    user: String,
    host: String,
    port: u16,
    query: Vec<(String, String)>,
    frag: String,
}

fn split_uri(link: &str, scheme: &str) -> Option<Uri> {
    let rest = link.strip_prefix(scheme)?;
    let (rest, frag) = match rest.split_once('#') {
        Some((a, b)) => (a, urlencoding::decode(b).map(|x| x.to_string()).unwrap_or_default()),
        None => (rest, String::new()),
    };
    let (rest, query_raw) = match rest.split_once('?') {
        Some((a, b)) => (a, b),
        None => (rest, ""),
    };
    let (user, hostport) = match rest.rsplit_once('@') {
        Some((a, b)) => (a.to_string(), b),
        None => (String::new(), rest),
    };
    // IPv6 в квадратных скобках: [::1]:443
    let (host, port) = if let Some(end) = hostport.rfind(']') {
        let h = &hostport[..=end];
        let p = hostport[end + 1..].trim_start_matches(':');
        (h.trim_matches(|c| c == '[' || c == ']').to_string(), p)
    } else {
        match hostport.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p),
            None => (hostport.to_string(), "443"),
        }
    };
    let query = query_raw
        .split('&')
        .filter(|x| !x.is_empty())
        .filter_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            Some((
                k.to_string(),
                urlencoding::decode(v).map(|x| x.to_string()).unwrap_or_else(|_| v.to_string()),
            ))
        })
        .collect();
    Some(Uri {
        user,
        host,
        port: port.parse().unwrap_or(443),
        query,
        frag,
    })
}

impl Uri {
    fn q(&self, key: &str) -> String {
        self.query
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    }
}

/// Транспорт и маскировка — общая часть для vless и trojan.
fn apply_transport(m: &mut Mapping, u: &Uri) {
    let net = match u.q("type").as_str() {
        "" => "tcp".to_string(),
        other => other.to_string(),
    };
    put_str(m, "network", &net);

    match net.as_str() {
        "ws" => {
            let mut ws = Mapping::new();
            let path = u.q("path");
            put_str(&mut ws, "path", if path.is_empty() { "/" } else { &path });
            let host = u.q("host");
            if !host.is_empty() {
                let mut h = Mapping::new();
                put_str(&mut h, "Host", &host);
                put(&mut ws, "headers", Value::Mapping(h));
            }
            put(m, "ws-opts", Value::Mapping(ws));
        }
        "grpc" => {
            let mut g = Mapping::new();
            put_str(&mut g, "grpc-service-name", &u.q("serviceName"));
            put(m, "grpc-opts", Value::Mapping(g));
        }
        "http" => {
            let mut h = Mapping::new();
            let path = u.q("path");
            put(
                &mut h,
                "path",
                Value::Sequence(vec![s(if path.is_empty() { "/" } else { &path })]),
            );
            put(m, "http-opts", Value::Mapping(h));
        }
        _ => {}
    }

    let security = u.q("security");
    let sni = {
        let a = u.q("sni");
        if a.is_empty() { u.q("host") } else { a }
    };
    match security.as_str() {
        "reality" => {
            put(m, "tls", Value::Bool(true));
            put_str(m, "servername", &sni);
            let fp = u.q("fp");
            put_str(m, "client-fingerprint", if fp.is_empty() { "chrome" } else { &fp });
            let mut r = Mapping::new();
            put_str(&mut r, "public-key", &u.q("pbk"));
            let sid = u.q("sid");
            if !sid.is_empty() {
                put_str(&mut r, "short-id", &sid);
            }
            put(m, "reality-opts", Value::Mapping(r));
        }
        "tls" | "xtls" => {
            put(m, "tls", Value::Bool(true));
            put_str(m, "servername", &sni);
            let fp = u.q("fp");
            if !fp.is_empty() {
                put_str(m, "client-fingerprint", &fp);
            }
            if u.q("allowInsecure") == "1" {
                put(m, "skip-cert-verify", Value::Bool(true));
            }
        }
        _ => {}
    }
}

fn parse_vless(link: &str) -> Option<Node> {
    let u = split_uri(link, "vless://")?;
    if u.user.is_empty() || u.host.is_empty() {
        return None;
    }
    let name = if u.frag.is_empty() { u.host.clone() } else { u.frag.clone() };
    let mut m = Mapping::new();
    put_str(&mut m, "name", &name);
    put_str(&mut m, "type", "vless");
    put_str(&mut m, "server", &u.host);
    put(&mut m, "port", Value::Number(u.port.into()));
    put_str(&mut m, "uuid", &u.user);
    put(&mut m, "udp", Value::Bool(true));
    let flow = u.q("flow");
    if !flow.is_empty() {
        put_str(&mut m, "flow", &flow);
    }
    apply_transport(&mut m, &u);
    Some(Node { name, map: m, profile: None })
}

fn parse_trojan(link: &str) -> Option<Node> {
    let u = split_uri(link, "trojan://")?;
    if u.user.is_empty() || u.host.is_empty() {
        return None;
    }
    let name = if u.frag.is_empty() { u.host.clone() } else { u.frag.clone() };
    let mut m = Mapping::new();
    put_str(&mut m, "name", &name);
    put_str(&mut m, "type", "trojan");
    put_str(&mut m, "server", &u.host);
    put(&mut m, "port", Value::Number(u.port.into()));
    put_str(&mut m, "password", &u.user);
    put(&mut m, "udp", Value::Bool(true));
    // У trojan шифрование обязательно, даже если в ссылке про него не сказано.
    put(&mut m, "tls", Value::Bool(true));
    apply_transport(&mut m, &u);
    Some(Node { name, map: m, profile: None })
}

fn parse_vmess(link: &str) -> Option<Node> {
    let body = link.strip_prefix("vmess://")?;
    // Тело vmess — это base64 от JSON (без "://"), поэтому общий decode_base64,
    // который ищет "://", здесь не годится: пробуем оба алфавита напрямую.
    let cleaned: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    let trimmed = cleaned.trim_end_matches('=');
    let json = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(trimmed))
        .ok()
        .and_then(|b| String::from_utf8(b).ok())?;
    let v: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let g = |k: &str| -> String {
        match v.get(k) {
            Some(serde_json::Value::String(x)) => x.clone(),
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => String::new(),
        }
    };
    let host = g("add");
    if host.is_empty() {
        return None;
    }
    let name = if g("ps").is_empty() { host.clone() } else { g("ps") };
    let mut m = Mapping::new();
    put_str(&mut m, "name", &name);
    put_str(&mut m, "type", "vmess");
    put_str(&mut m, "server", &host);
    put(
        &mut m,
        "port",
        Value::Number(g("port").parse::<u16>().unwrap_or(443).into()),
    );
    put_str(&mut m, "uuid", &g("id"));
    put(
        &mut m,
        "alterId",
        Value::Number(g("aid").parse::<u16>().unwrap_or(0).into()),
    );
    let cipher = g("scy");
    put_str(&mut m, "cipher", if cipher.is_empty() { "auto" } else { &cipher });
    put(&mut m, "udp", Value::Bool(true));

    let net = g("net");
    put_str(&mut m, "network", if net.is_empty() { "tcp" } else { &net });
    if g("tls") == "tls" {
        put(&mut m, "tls", Value::Bool(true));
        let sni = if g("sni").is_empty() { g("host") } else { g("sni") };
        put_str(&mut m, "servername", &sni);
    }
    if net == "ws" {
        let mut ws = Mapping::new();
        let path = g("path");
        put_str(&mut ws, "path", if path.is_empty() { "/" } else { &path });
        if !g("host").is_empty() {
            let mut h = Mapping::new();
            put_str(&mut h, "Host", &g("host"));
            put(&mut ws, "headers", Value::Mapping(h));
        }
        put(&mut m, "ws-opts", Value::Mapping(ws));
    }
    Some(Node { name, map: m, profile: None })
}

fn parse_ss(link: &str) -> Option<Node> {
    let rest = link.strip_prefix("ss://")?;
    let (body, frag) = match rest.split_once('#') {
        Some((a, b)) => (a, urlencoding::decode(b).map(|x| x.to_string()).unwrap_or_default()),
        None => (rest, String::new()),
    };
    let body = body.split('?').next().unwrap_or(body);

    // Две записи в ходу: base64(method:pass)@host:port и base64(всё целиком).
    let (method, password, host, port) = if let Some((cred, hostport)) = body.rsplit_once('@') {
        let dec = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(cred.trim_end_matches('='))
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_else(|| cred.to_string());
        let (m, p) = dec.split_once(':')?;
        let (h, pt) = hostport.rsplit_once(':')?;
        (m.to_string(), p.to_string(), h.to_string(), pt.to_string())
    } else {
        let dec = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(body.trim_end_matches('='))
            .ok()
            .and_then(|b| String::from_utf8(b).ok())?;
        let (cred, hostport) = dec.rsplit_once('@')?;
        let (m, p) = cred.split_once(':')?;
        let (h, pt) = hostport.rsplit_once(':')?;
        (m.to_string(), p.to_string(), h.to_string(), pt.to_string())
    };

    let name = if frag.is_empty() { host.clone() } else { frag };
    let mut m = Mapping::new();
    put_str(&mut m, "name", &name);
    put_str(&mut m, "type", "ss");
    put_str(&mut m, "server", &host);
    put(
        &mut m,
        "port",
        Value::Number(port.parse::<u16>().unwrap_or(443).into()),
    );
    put_str(&mut m, "cipher", &method);
    put_str(&mut m, "password", &password);
    put(&mut m, "udp", Value::Bool(true));
    Some(Node { name, map: m, profile: None })
}

/// Xray-JSON: так отдаёт подписка NoVPN — массив полных конфигов, из каждого
/// берём основной исходящий канал.
fn from_xray_json(v: &serde_json::Value) -> Vec<Node> {
    let configs: Vec<&serde_json::Value> = match v {
        serde_json::Value::Array(a) => a.iter().collect(),
        other => vec![other],
    };
    let mut out = Vec::new();
    for cfg in configs {
        let remark = cfg
            .get("remarks")
            .and_then(|x| x.as_str())
            .unwrap_or("Сервер")
            .to_string();
        let Some(obs) = cfg.get("outbounds").and_then(|x| x.as_array()) else {
            continue;
        };
        for ob in obs {
            if ob.get("protocol").and_then(|x| x.as_str()) != Some("vless") {
                continue;
            }
            let Some(vnext) = ob
                .pointer("/settings/vnext/0")
                .filter(|x| x.get("address").is_some())
            else {
                continue;
            };
            let st = ob.get("streamSettings");
            let user = vnext.pointer("/users/0");
            let address = vnext.get("address").and_then(|x| x.as_str()).unwrap_or("");
            let port = vnext.get("port").and_then(|x| x.as_u64()).unwrap_or(443) as u16;
            let uuid = user
                .and_then(|u| u.get("id"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if address.is_empty() || uuid.is_empty() {
                continue;
            }

            let name = clean_name(&remark);
            let mut m = Mapping::new();
            put_str(&mut m, "name", &name);
            put_str(&mut m, "type", "vless");
            put_str(&mut m, "server", address);
            put(&mut m, "port", Value::Number(port.into()));
            put_str(&mut m, "uuid", uuid);
            put(&mut m, "udp", Value::Bool(true));
            let net = st
                .and_then(|x| x.get("network"))
                .and_then(|x| x.as_str())
                .unwrap_or("tcp");
            put_str(&mut m, "network", net);
            if let Some(flow) = user.and_then(|u| u.get("flow")).and_then(|x| x.as_str()) {
                put_str(&mut m, "flow", flow);
            }
            if let Some(rs) = st.and_then(|x| x.get("realitySettings")) {
                put(&mut m, "tls", Value::Bool(true));
                put_str(
                    &mut m,
                    "servername",
                    rs.get("serverName").and_then(|x| x.as_str()).unwrap_or(""),
                );
                let fp = rs.get("fingerprint").and_then(|x| x.as_str()).unwrap_or("chrome");
                put_str(&mut m, "client-fingerprint", fp);
                let mut r = Mapping::new();
                put_str(
                    &mut r,
                    "public-key",
                    rs.get("publicKey").and_then(|x| x.as_str()).unwrap_or(""),
                );
                if let Some(sid) = rs.get("shortId").and_then(|x| x.as_str()) {
                    if !sid.is_empty() {
                        put_str(&mut r, "short-id", sid);
                    }
                }
                put(&mut m, "reality-opts", Value::Mapping(r));
            } else if st.and_then(|x| x.get("security")).and_then(|x| x.as_str()) == Some("tls") {
                put(&mut m, "tls", Value::Bool(true));
                if let Some(sni) = st
                    .and_then(|x| x.pointer("/tlsSettings/serverName"))
                    .and_then(|x| x.as_str())
                {
                    put_str(&mut m, "servername", sni);
                }
            }
            // Служебные поля панели NoVPN: по profileId клиент сопоставляет конфиг с
            // meta.json (у умного и полного профиля одного сервера host общий, так
            // что host — только запасной ключ). Xray-core незнакомые поля игнорирует.
            let profile = cfg.pointer("/meta/novpn").and_then(|nv| {
                let g = |k: &str| nv.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
                let profile_id = g("profileId");
                if profile_id.is_empty() {
                    return None;
                }
                let mode = if g("mode") == "full" { "full" } else { "smart" };
                Some(NodeProfile { profile_id, server_id: g("serverId"), host: g("host"), mode: mode.into() })
            });
            out.push(Node { name, map: m, profile });
            break; // из профиля берём только основной канал
        }
    }
    dedupe_names(out)
}

/// Имена в подписках украшены эмодзи и хвостами вроде «| Обход белых списков».
/// В конфиг и в список серверов должно попадать что-то читаемое.
fn clean_name(raw: &str) -> String {
    let head = raw.split('|').next().unwrap_or(raw);
    // «·» оставляем: панель так отделяет приписку второго профиля («Франция · Полный
    // VPN»), и без неё два профиля одного сервера читались бы одинаково.
    let cleaned: String = head
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '#' | '.' | '·'))
        .collect();
    let t = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        "Сервер".into()
    } else {
        t
    }
}
