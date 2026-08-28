//! Канонические фикстуры контракта — из панели (`apps/manager/test/fixtures/contract`).
//! Их генерируют contract-тесты панели из настоящих HTTP-ответов, поэтому клиент,
//! читающий их здесь, сверяется ровно с тем, что панель отдаёт на проводе.

use novpn_desktop::meta::{human, meta_url, Meta};
use std::path::PathBuf;

fn fixture(name: &str) -> String {
    let p: PathBuf = [env!("CARGO_MANIFEST_DIR"), "..", "..", "manager", "test", "fixtures", "contract", &format!("{name}.json")]
        .iter()
        .collect();
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("нет фикстуры {}: {e}", p.display()))
}

#[test]
fn smart_and_full_share_host_but_differ_by_profile_id() {
    let m = Meta::parse(&fixture("smart-and-full")).expect("фикстура панели должна разбираться");
    assert_eq!(m.schema_version, 1);
    assert!(!m.unsupported());
    for k in ["manifest", "upstream", "apps", "geosite", "geoip"] {
        assert!(m.routing_resources.get(k).map(|u| u.starts_with("http")).unwrap_or(false), "нет ресурса {k}");
    }
    assert!(!m.routing_resources.contains_key("sites"), "sites убран из контракта");
    let smart = m.profiles.iter().find(|p| p.mode() == "smart" && p.recommended).expect("умный профиль с recommended");
    let full = m
        .profiles
        .iter()
        .find(|p| p.mode() == "full" && p.server_id == smart.server_id)
        .expect("полный профиль того же сервера");
    assert_eq!(smart.host, full.host, "host общий");
    assert_ne!(smart.profile_id, full.profile_id, "profileId различает");
    assert!(full.profile_id.ends_with(":full"));
    assert!(full.remark.ends_with("· Полный VPN"));
    assert_eq!(full.routing.own_exceptions, 0, "в full доменных исключений нет");
    assert_eq!(m.smart_of_server(&smart.server_id).map(|p| p.profile_id.as_str()), Some(smart.profile_id.as_str()));
}

#[test]
fn legacy_without_routing_reads_as_smart() {
    let m = Meta::parse(&fixture("legacy-no-routing")).unwrap();
    assert_eq!(m.profiles.len(), 1);
    assert_eq!(m.profiles[0].mode(), "smart", "нет routing → smart");
    assert!(!m.profiles[0].routing.lan_access);
}

#[test]
fn expired_full_fixture_carries_reserved_fields() {
    let m = Meta::parse(&fixture("expired-full")).unwrap();
    let p = &m.profiles[0];
    assert_eq!(p.mode(), "full");
    assert!(p.routing.expires_at.is_some(), "expiresAt читается, даже если панель его пока не заполняет");
}

#[test]
fn newer_schema_is_flagged_unsupported_not_rejected() {
    let m = Meta::parse(&fixture("invalid-routing-version")).unwrap();
    assert!(m.unsupported(), "мажор выше нашего → деградация в smart, а не падение");
}

#[test]
fn smart_only_and_full_only_fixtures() {
    let s = Meta::parse(&fixture("smart-only")).unwrap();
    assert!(s.profiles.iter().all(|p| p.mode() == "smart"));
    let f = Meta::parse(&fixture("full-only")).unwrap();
    assert!(f.profiles.iter().all(|p| p.mode() == "full"));
}

#[test]
fn meta_url_matches_sub_link_from_fixture() {
    let m = Meta::parse(&fixture("smart-and-full")).unwrap();
    let sub_link = &m.profiles[0].sub_link;
    let url = meta_url(sub_link).expect("subLink профиля → meta.json того же токена");
    assert!(url.ends_with("/meta.json"));
    assert!(url.contains("/sub/"));
}

#[test]
fn denial_reasons_are_human() {
    for kind in ["not_found", "disabled", "expired", "traffic"] {
        assert!(!human(kind).is_empty());
        assert!(!human(kind).contains(kind), "человеку показываем текст, а не код");
    }
}
