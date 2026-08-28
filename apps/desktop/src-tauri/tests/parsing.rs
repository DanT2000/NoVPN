//! Проверка разбора подписки и сборки конфига.
//!
//! Данные здесь выдуманные. Настоящая подписка содержит ключи и uuid, а
//! репозиторий публичный — реальные значения в тестах означали бы раздачу
//! доступа всем желающим.

use novpn_desktop::core::{build_config, DomainRule, Ports, Rules};
use novpn_desktop::sub::{parse, Parsed};

const UUID: &str = "11111111-2222-3333-4444-555555555555";

fn names(p: &Parsed) -> Vec<String> {
    match p {
        Parsed::Nodes(n) => n.iter().map(|x| x.name.clone()).collect(),
        Parsed::Clash(v) => v
            .get("proxies")
            .and_then(|x| x.as_sequence())
            .map(|s| {
                s.iter()
                    .filter_map(|p| p.get("name").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

#[test]
fn vless_reality_link() {
    let link = format!(
        "vless://{UUID}@example.com:443?type=tcp&security=reality&pbk=PUBKEY&sid=abcd&fp=edge\
         &sni=cdn.example.net&flow=xtls-rprx-vision#Финляндия"
    );
    let p = parse(&link).expect("ссылка должна разобраться");
    let Parsed::Nodes(nodes) = &p else { panic!("ожидались точки") };
    assert_eq!(nodes.len(), 1);
    let m = &nodes[0].map;
    assert_eq!(nodes[0].name, "Финляндия");
    assert_eq!(m["type"].as_str(), Some("vless"));
    assert_eq!(m["server"].as_str(), Some("example.com"));
    assert_eq!(m["port"].as_u64(), Some(443));
    assert_eq!(m["flow"].as_str(), Some("xtls-rprx-vision"));
    assert_eq!(m["servername"].as_str(), Some("cdn.example.net"));
    assert_eq!(m["client-fingerprint"].as_str(), Some("edge"));
    assert_eq!(m["reality-opts"]["public-key"].as_str(), Some("PUBKEY"));
    assert_eq!(m["reality-opts"]["short-id"].as_str(), Some("abcd"));
}

#[test]
fn vless_websocket_link() {
    let link = format!("vless://{UUID}@a.example:8443?type=ws&security=tls&path=%2Fws&host=cdn.example#WS");
    let p = parse(&link).unwrap();
    let Parsed::Nodes(nodes) = &p else { panic!() };
    let m = &nodes[0].map;
    assert_eq!(m["network"].as_str(), Some("ws"));
    assert_eq!(m["ws-opts"]["path"].as_str(), Some("/ws"));
    assert_eq!(m["ws-opts"]["headers"]["Host"].as_str(), Some("cdn.example"));
    assert_eq!(m["tls"].as_bool(), Some(true));
}

#[test]
fn base64_list_of_links() {
    use base64::Engine;
    let raw = format!(
        "vless://{UUID}@one.example:443?security=reality&pbk=K1#Первый\n\
         trojan://secret@two.example:443?sni=two.example#Второй"
    );
    let encoded = base64::engine::general_purpose::STANDARD.encode(raw);
    let p = parse(&encoded).expect("base64-подписка должна разобраться");
    assert_eq!(names(&p), vec!["Первый", "Второй"]);
}

#[test]
fn vmess_link() {
    use base64::Engine;
    let json = r#"{"v":"2","ps":"Точка","add":"vm.example","port":"12345",
                   "id":"11111111-2222-3333-4444-555555555555","aid":"0","net":"ws",
                   "path":"/p","host":"h.example","tls":"tls"}"#;
    let link = format!(
        "vmess://{}",
        base64::engine::general_purpose::STANDARD.encode(json)
    );
    let p = parse(&link).expect("vmess должен разобраться");
    let Parsed::Nodes(nodes) = &p else { panic!() };
    let m = &nodes[0].map;
    assert_eq!(nodes[0].name, "Точка");
    assert_eq!(m["type"].as_str(), Some("vmess"));
    assert_eq!(m["port"].as_u64(), Some(12345));
    assert_eq!(m["network"].as_str(), Some("ws"));
    assert_eq!(m["ws-opts"]["path"].as_str(), Some("/p"));
}

#[test]
fn xray_json_like_novpn() {
    let json = format!(
        r#"[{{"remarks":"🇫🇮 Finland 1 | Обход белых списков",
             "outbounds":[{{"protocol":"vless","tag":"proxy",
               "settings":{{"vnext":[{{"address":"a.example","port":443,
                 "users":[{{"id":"{UUID}","flow":"xtls-rprx-vision"}}]}}]}},
               "streamSettings":{{"network":"tcp","security":"reality",
                 "realitySettings":{{"serverName":"cdn.example","fingerprint":"edge",
                   "publicKey":"PK","shortId":"ff00"}}}}}}]}}]"#
    );
    let p = parse(&json).expect("Xray-JSON должен разобраться");
    let Parsed::Nodes(nodes) = &p else { panic!() };
    assert_eq!(nodes.len(), 1);
    // Эмодзи и хвост после «|» из имени убираются — оно идёт в конфиг и в UI.
    assert_eq!(nodes[0].name, "Finland 1");
    assert_eq!(nodes[0].map["reality-opts"]["public-key"].as_str(), Some("PK"));
}

#[test]
fn clash_yaml_passthrough() {
    let yaml = "proxies:\n  - name: Чужой\n    type: ss\n    server: s.example\n    port: 8388\n";
    let p = parse(yaml).expect("Clash-YAML должен разобраться");
    assert!(matches!(p, Parsed::Clash(_)));
    assert_eq!(names(&p), vec!["Чужой"]);
}

#[test]
fn duplicate_names_get_unique() {
    let raw = format!(
        "vless://{UUID}@a.example:443?security=reality&pbk=K#Сервер\n\
         vless://{UUID}@b.example:443?security=reality&pbk=K#Сервер"
    );
    let p = parse(&raw).unwrap();
    // Mihomo требует уникальных имён, иначе конфиг не примет.
    assert_eq!(names(&p), vec!["Сервер", "Сервер #2"]);
}

#[test]
fn rules_put_direct_domains_first() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();
    let rules = Rules {
        vpn_processes: vec!["Discord.exe".into()],
        list_vpn_domains: vec!["openai.com".into()],
        list_direct_domains: vec!["gosuslugi.ru".into()],
        direct_processes: vec!["qbittorrent.exe".into()],
        ..Default::default()
    };
    let cfg = build_config(&p, &rules, Some("Точка"), Ports::default());

    let direct_site = cfg.find("DOMAIN-SUFFIX,gosuslugi.ru,DIRECT").expect("нет правила");
    let vpn_app = cfg.find("PROCESS-NAME,Discord.exe,NoVPN").expect("нет правила");
    let vpn_site = cfg.find("DOMAIN-SUFFIX,openai.com,NoVPN").expect("нет правила");
    let fallback = cfg.find("MATCH,DIRECT").expect("нет умолчания");

    // Ровно тот порядок, отсутствие которого ломало Госуслуги, открытые
    // из приложения с правилом «через VPN».
    assert!(direct_site < vpn_app, "домены «напрямую» должны быть выше приложений");
    assert!(vpn_app < vpn_site, "приложения должны быть выше доменов VPN");
    assert!(vpn_site < fallback, "умолчание должно быть последним");
}

#[test]
fn smart_off_sends_everything_through_tunnel() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();
    let rules = Rules {
        smart: false,
        list_vpn_domains: vec!["openai.com".into()],
        list_direct_domains: vec!["gosuslugi.ru".into()],
        ..Default::default()
    };
    let cfg = build_config(&p, &rules, Some("Точка"), Ports::default());

    // Выключенная умная маршрутизация означает «всё в туннель»: перечисленные
    // правила при этом не нужны и только вводили бы в заблуждение.
    assert!(cfg.contains("MATCH,NoVPN"), "всё должно уходить в туннель");
    assert!(!cfg.contains("gosuslugi.ru"), "частные правила тут лишние");
    assert!(cfg.contains("IP-CIDR,192.168.0.0/16,DIRECT"), "домашняя сеть должна остаться доступной");
}

#[test]
fn selected_server_goes_first_in_group() {
    let raw = format!(
        "vless://{UUID}@a.example:443?security=reality&pbk=K#Первый\n\
         vless://{UUID}@b.example:443?security=reality&pbk=K#Второй"
    );
    let p = parse(&raw).unwrap();
    let cfg = build_config(&p, &Rules::default(), Some("Второй"), Ports::default());
    let group = cfg.split("proxy-groups:").nth(1).expect("нет групп");
    let first = group.find("Второй").unwrap();
    let second = group.find("Первый").unwrap();
    assert!(first < second, "выбранный сервер должен стоять первым в группе");
}

#[test]
fn garbage_is_rejected_with_a_message() {
    let err = parse("это не подписка").unwrap_err();
    assert!(!err.is_empty());
}

#[test]
fn browser_domain_is_normalized() {
    use novpn_desktop::host::normalize_domain;
    // Регистр приводится раньше, чем отрезается «www.»: обратный порядок
    // оставлял префикс в имени, и правило переставало находиться.
    assert_eq!(normalize_domain("WWW.Example.COM"), "example.com");
    assert_eq!(normalize_domain("  YouTube.com "), "youtube.com");
    assert_eq!(normalize_domain("api.github.com"), "api.github.com");
    assert_eq!(normalize_domain(""), "");
}

#[test]
fn user_rule_beats_any_list() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();

    // Домен есть и в списке «напрямую», и в решении человека — с обратным
    // маршрутом. Побеждать обязано решение человека.
    let rules = Rules {
        user_domains: vec![DomainRule { domain: "gosuslugi.ru".into(), vpn: true }],
        list_direct_domains: vec!["gosuslugi.ru".into()],
        list_vpn_domains: vec!["youtube.com".into()],
        vpn_processes: vec!["Discord.exe".into()],
        ..Default::default()
    };
    let cfg = build_config(&p, &rules, Some("Точка"), Ports::default());

    let mine = cfg.find("DOMAIN-SUFFIX,gosuslugi.ru,NoVPN").expect("нет правила человека");
    let list = cfg.find("DOMAIN-SUFFIX,gosuslugi.ru,DIRECT").expect("нет правила списка");
    assert!(mine < list, "решение человека должно стоять выше списка");
}

#[test]
fn user_rule_can_send_listed_site_direct() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();

    // Обратный случай: сайт в списке «через VPN», человек хочет напрямую.
    let rules = Rules {
        user_domains: vec![DomainRule { domain: "youtube.com".into(), vpn: false }],
        list_vpn_domains: vec!["youtube.com".into()],
        ..Default::default()
    };
    let cfg = build_config(&p, &rules, Some("Точка"), Ports::default());

    let mine = cfg.find("DOMAIN-SUFFIX,youtube.com,DIRECT").expect("нет правила человека");
    let list = cfg.find("DOMAIN-SUFFIX,youtube.com,NoVPN").expect("нет правила списка");
    assert!(mine < list, "«напрямую» от человека должно перебивать список");
}

#[test]
fn russian_sites_still_beat_app_rules() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();
    let rules = Rules {
        list_direct_domains: vec!["gosuslugi.ru".into()],
        vpn_processes: vec!["Discord.exe".into()],
        ..Default::default()
    };
    let cfg = build_config(&p, &rules, Some("Точка"), Ports::default());

    let site = cfg.find("DOMAIN-SUFFIX,gosuslugi.ru,DIRECT").expect("нет правила");
    let app = cfg.find("PROCESS-NAME,Discord.exe,NoVPN").expect("нет правила");
    // Иначе Госуслуги, открытые из Discord, уедут за границу и перестанут
    // работать. Кому нужно наоборот — добавит домен вручную, он будет выше.
    assert!(site < app, "российские сайты должны быть выше правил по приложениям");
}

#[test]
fn tunnel_mode_adds_adapter_and_dns_hijack() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();

    let off = build_config(&p, &Rules::default(), Some("Точка"), Ports::default());
    assert!(!off.contains("tun:"), "без режима адаптера его в конфиге быть не должно");

    let on = build_config(
        &p,
        &Rules { tunnel: true, ..Default::default() },
        Some("Точка"),
        Ports::default(),
    );
    assert!(on.contains("tun:"), "режим адаптера должен попасть в конфиг");
    // Без перехвата DNS имя домена до правил не доходит, и вся маршрутизация
    // по доменам перестаёт работать — проверяем, что он на месте.
    assert!(on.contains("dns-hijack"), "перехват DNS обязателен");
    assert!(on.contains("auto-route"), "без auto-route трафик мимо адаптера");
}

#[test]
fn local_subnets_always_direct_domains_only_on_switch() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();

    // Подсети LAN — напрямую ВСЕГДА, независимо от переключателя: иначе в
    // режиме адаптера отвалится роутер.
    let off = build_config(&p, &Rules::default(), Some("Точка"), Ports::default());
    assert!(off.contains("IP-CIDR,192.168.0.0/16,DIRECT"), "домашняя подсеть всегда direct");
    // Локальные ДОМЕНЫ — только когда переключатель включён.
    assert!(!off.contains("DOMAIN-SUFFIX,local,DIRECT"), "без флага зоны .local не форсируем");

    let on = build_config(
        &p,
        &Rules { bypass_local: true, ..Default::default() },
        Some("Точка"),
        Ports::default(),
    );
    assert!(on.contains("DOMAIN-SUFFIX,local,DIRECT"), "с флагом зона .local direct");
    assert!(on.contains("DOMAIN-SUFFIX,lan,DIRECT"), "с флагом зона .lan direct");

    // Критично в обоих случаях: ни одного правила с пустым паттерном.
    for cfg in [&off, &on] {
        for bad in ["DOMAIN-KEYWORD,,", "DOMAIN-SUFFIX,,", "DOMAIN,,"] {
            assert!(!cfg.contains(bad), "правило с пустым паттерном: {bad}");
        }
    }
}

#[test]
fn commas_and_urls_in_domains_are_dropped_not_broken() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();
    let rules = Rules {
        user_domains: vec![
            DomainRule { domain: "vk.com, ok.ru".into(), vpn: false },
            DomainRule { domain: "https://youtube.com/watch".into(), vpn: true },
            DomainRule { domain: "ok.ru".into(), vpn: false },
        ],
        ..Default::default()
    };
    let cfg = build_config(&p, &rules, Some("Точка"), Ports::default());
    assert!(!cfg.contains("vk.com, ok.ru"), "запись с запятой должна быть отброшена");
    assert!(cfg.contains("DOMAIN-SUFFIX,youtube.com,NoVPN"), "URL должен нормализоваться до хоста");
    assert!(cfg.contains("DOMAIN-SUFFIX,ok.ru,DIRECT"));
    for line in cfg.lines() {
        if line.trim_start().starts_with("- DOMAIN-SUFFIX,") {
            let parts: Vec<&str> = line.trim_start().trim_start_matches("- ").split(',').collect();
            assert_eq!(parts.len(), 3, "правило должно иметь ровно 3 поля: {line}");
        }
    }
}

#[test]
fn local_subnets_come_before_app_rules() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();
    let rules = Rules { vpn_processes: vec!["Discord.exe".into()], ..Default::default() };
    let cfg = build_config(&p, &rules, Some("Точка"), Ports::default());
    let subnet = cfg.find("IP-CIDR,192.168.0.0/16,DIRECT").expect("нет подсети");
    let app = cfg.find("PROCESS-NAME,Discord.exe,NoVPN").expect("нет правила приложения");
    assert!(subnet < app, "локальные подсети должны стоять выше правил по приложениям");
}

#[test]
fn user_vpn_choice_beats_local_bypass_suffix() {
    // Регрессия: широкий обход локальной сети не должен перебивать явный выбор
    // человека «через VPN» для домена с локальным суффиксом.
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();
    let rules = Rules {
        smart: true,
        bypass_local: true,
        user_domains: vec![DomainRule { domain: "myhost.corp".into(), vpn: true }],
        ..Default::default()
    };
    let cfg = build_config(&p, &rules, Some("Точка"), Ports::default());
    let user = cfg.find("DOMAIN-SUFFIX,myhost.corp,NoVPN").expect("нет правила человека");
    let bypass = cfg.find("DOMAIN-SUFFIX,corp,DIRECT").expect("нет обхода .corp");
    assert!(user < bypass, "выбор человека должен стоять выше обхода локальной сети");
}

#[test]
fn direct_domains_resolve_via_system_dns_when_smart() {
    // «Прямые» домены должны резолвиться локальным DNS (nameserver-policy: system),
    // а не зарубежным DoH — иначе российские сервисы получают не тот IP.
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();
    let rules = Rules {
        smart: true,
        list_direct_domains: vec!["gosuslugi.ru".into()],
        ..Default::default()
    };
    let cfg = build_config(&p, &rules, Some("Точка"), Ports::default());
    assert!(cfg.contains("+.gosuslugi.ru: system"), "прямой домен должен идти через системный DNS");
    // А при выключенной умной маршрутизации DNS-политики для него быть не должно.
    let off = build_config(&p, &Rules { smart: false, ..rules.clone() }, Some("Точка"), Ports::default());
    assert!(!off.contains("gosuslugi.ru"), "без умной маршрутизации прямых доменов нет");
}

#[test]
fn custom_dns_is_used_as_nameserver() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();
    // Свой DNS: домашний адрес + запасной, через запятую.
    let rules = Rules { dns_provider: "192.168.1.1, https://dns.example/dns-query".into(), ..Default::default() };
    let cfg = build_config(&p, &rules, Some("Точка"), Ports::default());
    assert!(cfg.contains("192.168.1.1"), "свой DNS должен попасть в nameserver");
    assert!(cfg.contains("https://dns.example/dns-query"), "второй свой DNS тоже");
    assert!(!cfg.contains("1.1.1.1"), "cloudflare по умолчанию не должен подставляться");
    // Пустой/мусорный свой DNS откатывается на Cloudflare.
    let empty = build_config(&p, &Rules { dns_provider: "  ".into(), ..Default::default() }, Some("Точка"), Ports::default());
    assert!(empty.contains("1.1.1.1"), "пустой свой DNS -> Cloudflare");
}

/* ── Контракт панель↔клиент (docs/NOVPN-CLIENT-CONTRACT.md) ──────────────── */

#[test]
fn xray_json_carries_novpn_profile() {
    // Панель кладёт в каждый конфиг meta.novpn: по profileId клиент сопоставляет
    // конфиг с meta.json. У умного и полного профиля одного сервера host общий.
    let json = format!(
        r#"[{{"remarks":"🇫🇷 Франция · Умная маршрутизация","meta":{{"serverDescription":"🇫🇷 Франция · Умная маршрутизация","novpn":{{"profileId":"s_1","serverId":"s_1","host":"a.example","mode":"smart"}}}},
             "outbounds":[{{"protocol":"vless","settings":{{"vnext":[{{"address":"a.example","port":443,"users":[{{"id":"{UUID}"}}]}}]}},
               "streamSettings":{{"network":"tcp","security":"reality","realitySettings":{{"serverName":"x","publicKey":"PK","shortId":"1"}}}}}}]}},
           {{"remarks":"🇫🇷 Франция","meta":{{"novpn":{{"profileId":"s_1:full","serverId":"s_1","host":"a.example","mode":"full"}}}},
             "outbounds":[{{"protocol":"vless","settings":{{"vnext":[{{"address":"a.example","port":443,"users":[{{"id":"{UUID}"}}]}}]}},
               "streamSettings":{{"network":"tcp","security":"reality","realitySettings":{{"serverName":"x","publicKey":"PK","shortId":"1"}}}}}}]}}]"#
    );
    let p = parse(&json).expect("подписка с двумя профилями должна разобраться");
    let Parsed::Nodes(nodes) = &p else { panic!() };
    assert_eq!(nodes.len(), 2, "один конфиг на профиль");
    let smart = nodes[0].profile.as_ref().expect("у конфига панели есть профиль");
    let full = nodes[1].profile.as_ref().expect("у второго тоже");
    assert_eq!(smart.profile_id, "s_1");
    assert_eq!(smart.mode, "smart");
    assert_eq!(full.profile_id, "s_1:full");
    assert_eq!(full.mode, "full");
    assert_eq!(smart.host, full.host, "host общий — поэтому ключ profileId, а не host");
    // В десктопе режим виден по тумблеру, поэтому подпись профиля из имени убирается:
    // в списке серверов остаётся просто «Франция», а второй профиль различается номером.
    assert_eq!(nodes[0].name, "Франция");
    assert_eq!(nodes[1].name, "Франция #2");
}

#[test]
fn foreign_subscription_has_no_profile_and_is_smart() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Чужой");
    let p = parse(&link).unwrap();
    let Parsed::Nodes(nodes) = &p else { panic!() };
    assert!(nodes[0].profile.is_none(), "у чужой ссылки meta.novpn нет → Full не появляется");
}

#[test]
fn upstream_grammar_becomes_mihomo_rules() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();
    let rules = Rules {
        list_vpn_domains: vec!["blocked.example".into()],
        list_vpn_full: vec!["exact.example".into()],
        list_vpn_keywords: vec!["google".into()],
        list_vpn_regex: vec![r"^ad\..*".into(), "bad,comma".into()],
        list_vpn_ips: vec!["10.10.0.0/16".into(), "2001:db8::/32".into()],
        ..Default::default()
    };
    let cfg = build_config(&p, &rules, Some("Точка"), Ports::default());
    assert!(cfg.contains("DOMAIN-SUFFIX,blocked.example,NoVPN"));
    assert!(cfg.contains("DOMAIN,exact.example,NoVPN"), "full: → DOMAIN (точное)");
    assert!(cfg.contains("DOMAIN-KEYWORD,google,NoVPN"));
    assert!(cfg.contains(r"DOMAIN-REGEX,^ad\..*,NoVPN"));
    assert!(!cfg.contains("bad,comma"), "регэксп с запятой сломал бы правило — пропускаем");
    assert!(cfg.contains("IP-CIDR,10.10.0.0/16,NoVPN"));
    assert!(cfg.contains("IP-CIDR,2001:db8::/32,NoVPN"));
    assert!(cfg.contains("MATCH,DIRECT"), "smart: всё остальное напрямую");
}

#[test]
fn full_profile_is_fail_close_without_domain_exceptions() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();
    let rules = Rules {
        smart: false,
        bypass_local: true,
        custom_local: vec!["corp.example".into()],
        user_domains: vec![DomainRule { domain: "gosuslugi.ru".into(), vpn: false }],
        list_direct_domains: vec!["ya.ru".into()],
        list_vpn_domains: vec!["openai.com".into()],
        ..Default::default()
    };
    let cfg = build_config(&p, &rules, Some("Точка"), Ports::default());
    assert!(cfg.contains("MATCH,NoVPN"), "всё в туннель");
    assert!(!cfg.contains("MATCH,DIRECT"), "fail-close: никакого DIRECT-умолчания");
    for leak in ["gosuslugi.ru", "ya.ru", "openai.com", "DOMAIN-SUFFIX,corp,DIRECT", "DOMAIN-SUFFIX,corp.example,DIRECT"] {
        assert!(!cfg.contains(leak), "в полном профиле нет доменных исключений: {leak}");
    }
    // Приватные подсети при lanAccess=false — напрямую и в полном профиле.
    assert!(cfg.contains("IP-CIDR,192.168.0.0/16,DIRECT"));
}

#[test]
fn quic_is_rejected_in_both_modes() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();
    for smart in [true, false] {
        let cfg = build_config(&p, &Rules { smart, ..Default::default() }, Some("Точка"), Ports::default());
        assert!(cfg.contains("AND,((NETWORK,udp),(DST-PORT,443)),REJECT"), "QUIC-блок обязателен (smart={smart})");
    }
}

#[test]
fn lan_access_true_sends_private_subnets_into_tunnel() {
    let link = format!("vless://{UUID}@a.example:443?security=reality&pbk=K#Точка");
    let p = parse(&link).unwrap();
    let off = build_config(&p, &Rules::default(), Some("Точка"), Ports::default());
    assert!(off.contains("IP-CIDR,192.168.0.0/16,DIRECT"), "lanAccess=false: LAN напрямую");
    let on = build_config(&p, &Rules { lan_access: true, ..Default::default() }, Some("Точка"), Ports::default());
    assert!(!on.contains("IP-CIDR,192.168.0.0/16,DIRECT"), "lanAccess=true: LAN в туннель (правила DIRECT нет)");
    assert!(!on.contains("IP-CIDR,10.0.0.0/8,DIRECT"));
}

#[test]
fn server_host_is_always_direct_anti_loop() {
    let raw = format!(
        "vless://{UUID}@a.example:443?security=reality&pbk=K#Домен\n\
         vless://{UUID}@203.0.113.7:443?security=reality&pbk=K#Адрес"
    );
    let p = parse(&raw).unwrap();
    let rules = Rules { user_domains: vec![DomainRule { domain: "a.example".into(), vpn: true }], ..Default::default() };
    let cfg = build_config(&p, &rules, Some("Домен"), Ports::default());
    let loop_dom = cfg.find("DOMAIN,a.example,DIRECT").expect("анти-петля для домена");
    let loop_ip = cfg.find("IP-CIDR,203.0.113.7/32,DIRECT,no-resolve").expect("анти-петля для адреса");
    let user = cfg.find("DOMAIN-SUFFIX,a.example,NoVPN").expect("правило человека");
    assert!(loop_dom < user && loop_ip < user, "анти-петля стоит выше любых правил человека");
    // и в полном профиле тоже
    let full = build_config(&p, &Rules { smart: false, ..Default::default() }, Some("Домен"), Ports::default());
    assert!(full.contains("DOMAIN,a.example,DIRECT"));
}
