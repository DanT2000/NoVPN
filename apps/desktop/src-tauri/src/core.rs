//! Сборка конфига Mihomo и управление процессом движка.
//!
//! Порядок правил здесь — не косметика. Mihomo применяет первое совпавшее,
//! поэтому порядок и есть приоритет.
//!
//! Приоритет такой:
//!
//! 1. домены, заданные человеком — сначала из браузера, потом из окна;
//! 2. домены «напрямую» из списков;
//! 3. правила по приложениям;
//! 4. домены «через VPN» из списков.
//!
//! Пункт 1 выше всего, потому что решение человека не должен отменять никакой
//! подгруженный список. Пункт 2 стоит выше приложений не по прихоти: проверка
//! на живом трафике показала, что правило «Discord через VPN», стоящее выше
//! доменных, уводило за границу Госуслуги, открытые из Discord, — и те
//! переставали работать. Если такой домен всё же нужен через туннель, его
//! добавляют вручную, и он попадает в пункт 1.

use crate::sub::{Node, Parsed};
use serde_yaml::{Mapping, Value};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const GROUP: &str = "NoVPN";

/// Локальные и внутрисетевые доменные зоны. Всегда идут напрямую и всегда
/// разрешаются системным DNS: через туннель они не имеют смысла, а сломать
/// доступ к роутеру и домашним сервисам — верный способ разозлить человека.
pub const LOCAL_DOMAINS: &[&str] = &[
    "local",
    "lan",
    "home",
    "home.arpa",
    "internal",
    "intranet",
    "corp",
    "localdomain",
    "in-addr.arpa",
    "ip6.arpa",
];

/// Правила пользователя в том виде, в каком их видит движок.
/// Одно правило по домену вместе с маршрутом.
#[derive(Debug, Clone)]
pub struct DomainRule {
    pub domain: String,
    /// true — через VPN, false — напрямую.
    pub vpn: bool,
}

#[derive(Debug, Clone)]
pub struct Rules {
    /// Выключенная умная маршрутизация означает профиль «Полный VPN»: весь трафик в
    /// туннель, никаких доменных исключений, fail-close. Перечисленные ниже правила
    /// тогда не нужны вовсе. Выключить можно только если сервер выдал полный профиль —
    /// это решает интерфейс по meta.json (контракт, раздел 4).
    pub smart: bool,
    /// Серверная политика приватных подсетей (meta.routing.lanAccess). false (по
    /// умолчанию) — LAN напрямую; true — LAN В туннель (самохостер добирается до
    /// локалки своего сервера). Действует в обоих режимах. Легко перепутать.
    pub lan_access: bool,
    /// Режим сетевого адаптера. Без него правила по приложениям не работают:
    /// Discord и Telegram системный прокси попросту игнорируют.
    pub tunnel: bool,
    /// Обходить ли локальные ДОМЕНЫ (.local, .lan, corp…) напрямую и разрешать
    /// их системным DNS. Переключатель: у кого-то интранет-имена должны идти
    /// через VPN, у кого-то — мимо. Локальные ПОДСЕТИ это не трогает, они
    /// напрямую всегда — иначе домашняя сеть отвалится.
    pub bypass_local: bool,
    /// Свои локальные суффиксы (корпоративные домены), которые всегда идут
    /// напрямую и резолвятся системным DNS. Явный выбор человека.
    pub custom_local: Vec<String>,
    /// Провайдер DNS-over-HTTPS: cloudflare | google | quad9.
    pub dns_provider: String,
    /// Домены, заданные человеком, уже в порядке важности: сначала из
    /// браузера, затем добавленные в окне. Отменять их список не вправе.
    pub user_domains: Vec<DomainRule>,
    /// Домены из подгруженных списков, обязанные идти напрямую.
    pub list_direct_domains: Vec<String>,
    /// Домены из подгруженных списков, которым нужен VPN (домен + поддомены).
    pub list_vpn_domains: Vec<String>,
    /// Остальные виды из грамматики upstream (контракт, раздел 7): точные домены,
    /// подстроки, регэкспы, подсети. Всё — через VPN.
    pub list_vpn_full: Vec<String>,
    pub list_vpn_keywords: Vec<String>,
    pub list_vpn_regex: Vec<String>,
    pub list_vpn_ips: Vec<String>,
    /// Имена процессов, которым нужен VPN.
    pub vpn_processes: Vec<String>,
    /// Имена процессов, явно оставленных напрямую (торренты, российские игры).
    pub direct_processes: Vec<String>,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            smart: true,
            lan_access: false,
            tunnel: false,
            bypass_local: false,
            custom_local: Vec::new(),
            dns_provider: "cloudflare".into(),
            user_domains: Vec::new(),
            list_direct_domains: Vec::new(),
            list_vpn_domains: Vec::new(),
            list_vpn_full: Vec::new(),
            list_vpn_keywords: Vec::new(),
            list_vpn_regex: Vec::new(),
            list_vpn_ips: Vec::new(),
            vpn_processes: Vec::new(),
            direct_processes: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Ports {
    pub mixed: u16,
    pub controller: u16,
}

impl Default for Ports {
    fn default() -> Self {
        // Порты нестандартные намеренно: 7890 занят почти каждым вторым
        // клиентом, и совпадение выглядело бы как поломка нашего приложения.
        Self { mixed: 7893, controller: 9893 }
    }
}

fn s(v: &str) -> Value {
    Value::String(v.to_string())
}

/// Собирает готовый конфиг. Если провайдер отдал свой Clash-YAML, он берётся
/// основой: его точки и группы сохраняются, подменяются только порты, DNS и
/// правила — то, чем распоряжается наше приложение.
pub fn build_config(parsed: &Parsed, rules: &Rules, selected: Option<&str>, ports: Ports) -> String {
    let mut root = match parsed {
        Parsed::Clash(v) => v.as_mapping().cloned().unwrap_or_default(),
        Parsed::Nodes(_) => Mapping::new(),
    };

    let names: Vec<String> = match parsed {
        Parsed::Nodes(nodes) => nodes.iter().map(|n| n.name.clone()).collect(),
        Parsed::Clash(v) => v
            .get("proxies")
            .and_then(|p| p.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|p| p.get("name").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    };

    if let Parsed::Nodes(nodes) = parsed {
        root.insert(
            s("proxies"),
            Value::Sequence(nodes.iter().map(|n: &Node| Value::Mapping(n.map.clone())).collect()),
        );
    }

    root.insert(s("mixed-port"), Value::Number(ports.mixed.into()));
    root.insert(s("external-controller"), s(&format!("127.0.0.1:{}", ports.controller)));
    root.insert(s("allow-lan"), Value::Bool(false));
    root.insert(s("mode"), s("rule"));
    root.insert(s("log-level"), s("info"));
    root.insert(s("ipv6"), Value::Bool(false));
    root.insert(s("unified-delay"), Value::Bool(true));

    // DNS поверх HTTPS: обычный DNS провайдера подменяет ответы для части
    // доменов, и тогда правило «через VPN» приведёт не туда, куда нужно.
    let mut dns = Mapping::new();
    dns.insert(s("enable"), Value::Bool(true));
    dns.insert(s("ipv6"), Value::Bool(false));
    dns.insert(s("enhanced-mode"), s("fake-ip"));
    dns.insert(s("fake-ip-range"), s("198.18.0.1/16"));
    // Фейковый IP не выдаём тому, что и так резолвится локально — иначе
    // ломается loopback и сервисы, которые сами обращаются по IP.
    let mut fake_filter = vec![s("localhost"), s("+.localhost")];
    if rules.bypass_local {
        // При включённом обходе локальные зоны разрешает системный DNS: он
        // знает домен домашней/офисной сети, а публичный DoH — нет.
        for d in LOCAL_DOMAINS {
            fake_filter.push(s(&format!("+.{}", d.trim_start_matches('.'))));
        }
    }
    // Свои корпоративные суффиксы — всегда, это явный выбор человека.
    for d in &rules.custom_local {
        let d = d.trim().trim_start_matches('.');
        if !d.is_empty() {
            fake_filter.push(s(&format!("+.{d}")));
        }
    }
    // Домены «напрямую» (российские сервисы из списка и ручной выбор DIRECT)
    // резолвим локальным DNS, а не зарубежным DoH: с иностранной точки многие из
    // них отдают не тот IP, показывают заглушку или вовсе закрываются. DoH
    // оставляем только для VPN-доменов — там он и нужен от подмены.
    //
    // Только при включённой умной маршрутизации: без неё всё идёт в туннель и
    // «прямых» доменов нет. Санитайзер тот же, что и в правилах — мусор (запятые,
    // URL) не должен попасть и в DNS.
    let direct_domains: Vec<String> = if rules.smart {
        rules
            .list_direct_domains
            .iter()
            .chain(rules.user_domains.iter().filter(|d| !d.vpn).map(|d| &d.domain))
            .filter_map(|d| clean_domain(d))
            .collect()
    } else {
        Vec::new()
    };
    for d in &direct_domains {
        fake_filter.push(s(&format!("+.{d}")));
    }
    dns.insert(s("fake-ip-filter"), Value::Sequence(fake_filter));
    let cloudflare = || {
        vec![
            "https://1.1.1.1/dns-query".to_string(),
            "https://cloudflare-dns.com/dns-query".to_string(),
        ]
    };
    let ns: Vec<String> = match rules.dns_provider.as_str() {
        "google" => vec!["https://dns.google/dns-query".into(), "https://8.8.8.8/dns-query".into()],
        "quad9" => vec!["https://dns.quad9.net/dns-query".into(), "https://9.9.9.9/dns-query".into()],
        "cloudflare" | "" => cloudflare(),
        custom => {
            // Свой DNS: DoH-URL (https://…), tls://, или адрес (192.168.1.1).
            // Несколько — через запятую. Мусор/пустое откатываем на Cloudflare.
            let parts: Vec<String> = custom
                .split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty() && !p.contains(char::is_whitespace))
                .collect();
            if parts.is_empty() {
                cloudflare()
            } else {
                parts
            }
        }
    };
    dns.insert(s("nameserver"), Value::Sequence(ns.into_iter().map(|x| s(&x)).collect()));
    let mut policy = Mapping::new();
    if rules.bypass_local {
        for d in LOCAL_DOMAINS {
            policy.insert(s(&format!("+.{}", d.trim_start_matches('.'))), s("system"));
        }
    }
    for d in &rules.custom_local {
        let d = d.trim().trim_start_matches('.');
        if !d.is_empty() {
            policy.insert(s(&format!("+.{d}")), s("system"));
        }
    }
    for d in &direct_domains {
        policy.insert(s(&format!("+.{d}")), s("system"));
    }
    if !policy.is_empty() {
        dns.insert(s("nameserver-policy"), Value::Mapping(policy));
    }
    root.insert(s("dns"), Value::Mapping(dns));

    if rules.tunnel {
        // Свой сетевой адаптер вместо системного прокси. Только так видно
        // трафик программ, которые про настройки Windows не спрашивают.
        let mut tun = Mapping::new();
        tun.insert(s("enable"), Value::Bool(true));
        tun.insert(s("stack"), s("mixed"));
        tun.insert(s("auto-route"), Value::Bool(true));
        tun.insert(s("auto-detect-interface"), Value::Bool(true));
        tun.insert(s("mtu"), Value::Number(9000.into()));
        // Перехват DNS обязателен: без него имя домена до правил не доходит,
        // и вся маршрутизация по доменам перестаёт работать.
        tun.insert(
            s("dns-hijack"),
            Value::Sequence(vec![s("any:53"), s("tcp://any:53")]),
        );
        root.insert(s("tun"), Value::Mapping(tun));
    }

    // Своя группа поверх чужих: приложение переключает сервер именно ею.
    let mut ordered = names.clone();
    if let Some(sel) = selected {
        if let Some(pos) = ordered.iter().position(|n| n == sel) {
            let picked = ordered.remove(pos);
            ordered.insert(0, picked);
        }
    }
    let mut group = Mapping::new();
    group.insert(s("name"), s(GROUP));
    group.insert(s("type"), s("select"));
    group.insert(
        s("proxies"),
        Value::Sequence(ordered.iter().map(|n| s(n)).collect()),
    );

    let mut groups: Vec<Value> = vec![Value::Mapping(group)];
    if let Some(existing) = root.get(s("proxy-groups")).and_then(|g| g.as_sequence()) {
        for g in existing {
            let name = g.get("name").and_then(|n| n.as_str()).unwrap_or("");
            if name != GROUP {
                groups.push(g.clone());
            }
        }
    }
    root.insert(s("proxy-groups"), Value::Sequence(groups));

    // Адреса самих VPN-серверов — для анти-петли: трафик к серверу никогда не
    // должен заворачиваться в туннель к нему же.
    let hosts: Vec<String> = match parsed {
        Parsed::Nodes(nodes) => nodes
            .iter()
            .filter_map(|n| n.map.get(s("server")).and_then(|v| v.as_str()).map(String::from))
            .collect(),
        Parsed::Clash(v) => v
            .get("proxies")
            .and_then(|p| p.as_sequence())
            .map(|seq| seq.iter().filter_map(|p| p.get("server").and_then(|x| x.as_str()).map(String::from)).collect())
            .unwrap_or_default(),
    };
    root.insert(s("rules"), Value::Sequence(build_rules(rules, &hosts)));

    let body = serde_yaml::to_string(&Value::Mapping(root))
        .unwrap_or_else(|e| format!("# не удалось собрать конфиг: {e}\n"));
    format!(
        "# Конфиг собран приложением NoVPN и пересобирается при каждом подключении.\n\
         # Править вручную бессмысленно — изменения будут потеряны.\n{body}"
    )
}

/// Приводит домен к безопасному для правила виду: только хост, без схемы, пути,
/// пробелов и запятых. Всё, что не годится, отбрасывается — иначе одна кривая
/// запись (запятая, вставленный список, полный URL) сделает весь конфиг
/// невалидным, и подключиться станет нельзя вообще.
fn clean_domain(raw: &str) -> Option<String> {
    let mut d = raw.trim().to_lowercase();
    if let Some(pos) = d.find("://") {
        d = d[pos + 3..].to_string();
    }
    // Отрезаем путь, порт, пользователя.
    d = d.split(['/', '?', '#', ':', '@']).next().unwrap_or("").to_string();
    d = d.trim().trim_start_matches("www.").trim_matches('.').to_string();
    // Запятая, пробел, пустота или отсутствие точки — не домен.
    if d.is_empty() || d.contains([',', ' ', '\t']) || !d.contains('.') {
        return None;
    }
    Some(d)
}

/// Имя процесса, годное для правила: без запятых и пробелов, оканчивается на .exe
/// либо хотя бы без спецсимволов. Кривые записи пропускаем.
fn clean_process(raw: &str) -> Option<String> {
    let p = raw.trim();
    if p.is_empty() || p.contains([',', '\t']) || p.contains('/') {
        return None;
    }
    Some(p.to_string())
}

fn push_subnets(out: &mut Vec<Value>) {
    // Локальные подсети — напрямую ВСЕГДА и ПЕРВЫМИ. Иначе соединение
    // туннелируемого приложения к 192.168.x/NAS/принтеру совпало бы с правилом
    // по процессу раньше, чем с этой строкой, и ушло бы в туннель.
    for net in [
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "224.0.0.0/4",
        "255.255.255.255/32",
    ] {
        out.push(s(&format!("IP-CIDR,{net},DIRECT,no-resolve")));
    }
}

/// Широкие DIRECT-суффиксы обхода локальной сети: переключатель «локальная сеть
/// напрямую» и свои корпоративные суффиксы.
fn push_local_bypass(out: &mut Vec<Value>, r: &Rules) {
    if r.bypass_local {
        for d in LOCAL_DOMAINS {
            out.push(s(&format!("DOMAIN-SUFFIX,{d},DIRECT")));
        }
    }
    for d in &r.custom_local {
        if let Some(d) = clean_domain(d) {
            out.push(s(&format!("DOMAIN-SUFFIX,{d},DIRECT")));
        }
    }
}

/// Хост сервера — адрес или домен? Для адреса нужен IP-CIDR, для домена — DOMAIN.
fn is_ip_literal(h: &str) -> bool {
    h.parse::<std::net::IpAddr>().is_ok()
}

fn build_rules(r: &Rules, server_hosts: &[String]) -> Vec<Value> {
    let mut out = Vec::new();

    // Анти-петля (контракт, раздел 4): адрес самого VPN-сервера всегда напрямую —
    // в режиме адаптера иначе соединение к серверу могло бы завернуться в туннель
    // к нему же. Стоит первым, выше любых правил человека.
    for h in server_hosts {
        let h = h.trim();
        if h.is_empty() {
            continue;
        }
        if is_ip_literal(h) {
            let mask = if h.contains(':') { 128 } else { 32 };
            out.push(s(&format!("IP-CIDR,{h}/{mask},DIRECT,no-resolve")));
        } else if let Some(d) = clean_domain(h) {
            out.push(s(&format!("DOMAIN,{d},DIRECT")));
        }
    }

    // QUIC (udp/443) — REJECT в ОБОИХ режимах: браузер открывает QUIC, UDP по
    // туннелю теряется, отката на TCP нет — YouTube «зависает». Отрезаем сразу,
    // и браузер падает на надёжный HTTP/2.
    out.push(s("AND,((NETWORK,udp),(DST-PORT,443)),REJECT"));

    // Локальные подсети — до всего остального. По серверной политике lanAccess:
    // false (обычно) — напрямую; true — правил нет, LAN идёт в туннель.
    if !r.lan_access {
        push_subnets(&mut out);
    }

    if !r.smart {
        // Профиль «Полный VPN»: весь трафик в туннель, никаких доменных ИСКЛЮЧЕНИЙ
        // из списков. Но локальную сеть не рвём: приватные подсети уже ушли DIRECT
        // выше, а тут применяем и обход локальных ДОМЕНОВ (.local и свои) — доступ к
        // NAS/принтеру по имени должен работать и в полном режиме. Это не утечка в
        // интернет, только LAN, поэтому fail-close не нарушает: в группе нет DIRECT,
        // мёртвый прокси = обрыв, а не утечка реального IP.
        push_local_bypass(&mut out, r);
        out.push(s(&format!("MATCH,{GROUP}")));
        return out;
    }

    // 1. Решение человека. Ни один список и ни один общий переключатель его не
    //    отменяет — поэтому идёт ПЕРЕД широкими суффиксами обхода локальной сети
    //    (иначе «через VPN» для домена вроде myhost.corp перебивался бы обходом).
    for d in &r.user_domains {
        if let Some(dom) = clean_domain(&d.domain) {
            let target = if d.vpn { GROUP } else { "DIRECT" };
            out.push(s(&format!("DOMAIN-SUFFIX,{dom},{target}")));
        }
    }

    // 2. Обход локальной сети (широкие DIRECT-суффиксы) — после явного выбора.
    push_local_bypass(&mut out, r);

    // 3. Списки «напрямую»: российские сервисы, которые с зарубежного адреса
    //    просто не открываются.
    for d in &r.list_direct_domains {
        if let Some(d) = clean_domain(d) {
            out.push(s(&format!("DOMAIN-SUFFIX,{d},DIRECT")));
        }
    }

    // 4. Приложения.
    for p in &r.direct_processes {
        if let Some(p) = clean_process(p) {
            out.push(s(&format!("PROCESS-NAME,{p},DIRECT")));
        }
    }
    for p in &r.vpn_processes {
        if let Some(p) = clean_process(p) {
            out.push(s(&format!("PROCESS-NAME,{p},{GROUP}")));
        }
    }

    // 5. Списки «через VPN» — по грамматике upstream (контракт, раздел 7).
    for d in &r.list_vpn_domains {
        if let Some(d) = clean_domain(d) {
            out.push(s(&format!("DOMAIN-SUFFIX,{d},{GROUP}")));
        }
    }
    for d in &r.list_vpn_full {
        if let Some(d) = clean_domain(d) {
            out.push(s(&format!("DOMAIN,{d},{GROUP}")));
        }
    }
    for k in &r.list_vpn_keywords {
        let k = k.trim().to_lowercase();
        if !k.is_empty() && !k.contains([',', ' ', '\t']) {
            out.push(s(&format!("DOMAIN-KEYWORD,{k},{GROUP}")));
        }
    }
    for re in &r.list_vpn_regex {
        // Запятая внутри регэкспа сломала бы разбор строки правила движком.
        let re = re.trim();
        if !re.is_empty() && !re.contains(',') && regex::Regex::new(re).is_ok() {
            out.push(s(&format!("DOMAIN-REGEX,{re},{GROUP}")));
        }
    }
    for ip in &r.list_vpn_ips {
        let ip = ip.trim();
        if !ip.is_empty() && !ip.contains([',', ' ']) {
            // Реальный dst-IP под fake-ip: срабатывает на прямых соединениях по
            // адресу (DC Telegram, CDN без SNI) — ровно для этого IP-виды и нужны.
            out.push(s(&format!("IP-CIDR,{ip},{GROUP}")));
        }
    }

    // 6. Всё неназванное идёт напрямую. Это и есть модель NoVPN.
    out.push(s("MATCH,DIRECT"));
    out
}

/// Ждём, пока НАШ движок начнёт отвечать на управляющем порту.
///
/// Проверяем не сам факт «порт слушает», а что отвечает именно Mihomo: иначе
/// чужой процесс на том же порту приняли бы за свой, объявили «Подключено» и
/// увели трафик через постороннее приложение. Управляющий эндпоинт `/version`
/// Mihomo возвращает JSON с полем `meta` — по нему и опознаём.
/// Чем закончился запуск движка, по его собственному журналу.
enum StartOutcome {
    /// Движок сам занял порты и слушает — это точно наш экземпляр.
    Listening,
    /// Порт занят кем-то другим: mihomo при этом не падает, а продолжает жить
    /// без прослушивания. Выдать это за подключение нельзя.
    PortBusy,
    /// За отведённое время ничего определённого не написал.
    Timeout,
}

/// Ждём исхода по ЖУРНАЛУ движка, а не по TCP-пробе. Проба к порту не отличает
/// наш mihomo от чужого clash на том же порту, а журнал пишем только мы — в нём
/// либо строка про успешное прослушивание, либо ошибка bind.
fn wait_started(log_path: &Path, timeout: Duration) -> StartOutcome {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(log_path) {
            let low = text.to_lowercase();
            if low.contains("only one usage")
                || low.contains("address already in use")
                || low.contains("bind:")
            {
                return StartOutcome::PortBusy;
            }
            if low.contains("proxy listening at") || low.contains("tun listening at") {
                return StartOutcome::Listening;
            }
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    StartOutcome::Timeout
}

/// Ждём освобождения порта прежним экземпляром: иначе новый займётся тем же
/// самым конфликтом.
pub fn wait_port_free(port: u16, timeout: Duration) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_err() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

pub const LOG_NAME: &str = "engine.log";

/// Просит движок перечитать конфиг без перезапуска.
///
/// Перезапуск процесса рвёт все открытые соединения: скачивание оборвётся,
/// звонок отвалится, страница перестанет грузиться. А правило добавляют как
/// раз посреди работы, поэтому цена перезапуска здесь неприемлема.
///
/// Запрос собран вручную поверх TCP намеренно: обращение идёт к себе же на
/// localhost, и тащить ради двух строк асинхронный HTTP-клиент со всей его
/// машинерией — избыточно.
pub fn reload(controller_port: u16, config_path: &Path) -> Result<(), String> {
    use std::io::{Read, Write};

    let body = serde_json::json!({ "path": config_path.to_string_lossy() }).to_string();
    let req = format!(
        "PUT /configs?force=true HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
        port = controller_port,
        len = body.len(),
        body = body
    );

    let addr: SocketAddr = ([127, 0, 0, 1], controller_port).into();
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|e| format!("Движок не отвечает: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("Не удалось отправить правила движку: {e}"))?;

    let mut resp = String::new();
    let _ = stream.read_to_string(&mut resp);
    let status = resp.lines().next().unwrap_or("");
    // 204 — принято молча, 200 — принято с телом. Всё остальное отказ.
    if status.contains(" 204") || status.contains(" 200") {
        Ok(())
    } else {
        Err(format!("Движок отклонил правила: {}", status.trim()))
    }
}

/// Явно переключить селектор группы на конкретный сервер. mihomo при перезагрузке
/// конфига СОХРАНЯЕТ ранее выбранный прокси группы `select`, поэтому смена сервера
/// одним лишь reload не срабатывала — движок оставался на старом, и человеку
/// приходилось жать «Отключить». Этот вызов заставляет группу указать на новый.
/// `group`/`name` — фиксированный ASCII-тег и имя сервера из подписки; имя может
/// содержать пробелы/не-ASCII, поэтому уходит в JSON-тело, а не в URL.
pub fn select_proxy(controller_port: u16, group: &str, name: &str) -> Result<(), String> {
    use std::io::{Read, Write};

    let body = serde_json::json!({ "name": name }).to_string();
    let req = format!(
        "PUT /proxies/{group} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
        group = group,
        port = controller_port,
        len = body.len(),
        body = body
    );

    let addr: SocketAddr = ([127, 0, 0, 1], controller_port).into();
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|e| format!("Движок не отвечает: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("Не удалось переключить сервер: {e}"))?;
    let mut resp = String::new();
    let _ = stream.read_to_string(&mut resp);
    let status = resp.lines().next().unwrap_or("");
    if status.contains(" 204") || status.contains(" 200") {
        Ok(())
    } else {
        Err(format!("Движок отклонил переключение сервера: {}", status.trim()))
    }
}

/// Запущенный движок.
pub const PID_NAME: &str = "engine.pid";

pub struct Engine {
    child: Child,
    pid_path: PathBuf,
}

impl Engine {
    /// Пишет конфиг, поднимает движок и **убеждается, что он слушает порт**.
    /// Возвращает ошибку с концом журнала, если этого не произошло: молчаливое
    /// «запустился» здесь опаснее любой ошибки.
    pub fn start(exe: &Path, dir: &Path, config: &str, port: u16, controller_port: u16) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("Не удалось создать папку движка: {e}"))?;
        std::fs::write(dir.join("config.yaml"), config)
            .map_err(|e| format!("Не удалось записать конфиг: {e}"))?;

        // Журнал движка в файл: в собранном приложении консоли нет, и без
        // этого причина отказа была бы невидима.
        let log_path = dir.join(LOG_NAME);
        let log = std::fs::File::create(&log_path)
            .map_err(|e| format!("Не удалось открыть журнал движка: {e}"))?;
        let log_err = log.try_clone().map_err(|e| e.to_string())?;

        let mut cmd = Command::new(exe);
        cmd.arg("-d").arg(dir);
        cmd.stdout(Stdio::from(log)).stderr(Stdio::from(log_err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Без этого при каждом подключении мигало бы окно консоли.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = cmd.spawn().map_err(|e| format!("Движок не запустился: {e}"))?;
        // PID на диск: если приложение упадёт, при следующем старте мы точно
        // опознаем и завершим именно свой осиротевший движок, не задев чужой.
        let pid_path = dir.join(PID_NAME);
        let _ = std::fs::write(&pid_path, child.id().to_string());
        let mut engine = Self { child, pid_path };

        let _ = controller_port;
        match wait_started(&log_path, Duration::from_secs(12)) {
            StartOutcome::Listening => Ok(engine),
            StartOutcome::PortBusy => {
                engine.stop();
                Err(format!(
                    "Порт {port} занят другим приложением — освободите его или закройте \
                     конфликтующий VPN-клиент.\n{}",
                    tail(&log_path, 4)
                ))
            }
            StartOutcome::Timeout => {
                engine.stop();
                Err(format!("Движок не поднялся за отведённое время.\n{}", tail(&log_path, 6)))
            }
        }
    }

    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.pid_path);
    }

    /// Жив ли процесс. Движок может упасть сам — например, если сервер в
    /// подписке описан так, что Mihomo отказывается принимать конфиг.
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Конец журнала — то, что показываем человеку вместо голого «не получилось».
pub fn tail(path: &Path, lines: usize) -> String {
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let all: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    all.iter()
        .rev()
        .take(lines)
        .rev()
        .map(|l| {
            // Отрезаем метку времени: человеку она ничего не говорит.
            l.split_once("msg=").map(|(_, m)| m.trim_matches('"')).unwrap_or(l)
        })
        .collect::<Vec<_>>()
        .join("
")
}

/// Путь к движку рядом с приложением. Tauri кладёт sidecar в тот же каталог,
/// что и исполняемый файл, дописывая к имени целевую тройку.
pub fn engine_path(app_dir: &Path) -> PathBuf {
    let name = if cfg!(windows) { "mihomo.exe" } else { "mihomo" };
    let direct = app_dir.join(name);
    if direct.exists() {
        return direct;
    }
    app_dir.join(if cfg!(windows) {
        "mihomo-x86_64-pc-windows-msvc.exe"
    } else {
        "mihomo-x86_64-unknown-linux-gnu"
    })
}
