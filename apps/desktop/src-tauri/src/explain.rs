//! «Почему этот сайт пошёл не туда».
//!
//! Владелец просил лог решений: когда сайт ведёт себя не так, как ожидалось, надо
//! понимать причину, а не гадать. Полный лог тут не помощник — он огромный и не
//! отвечает на вопрос «какое правило сработало». Поэтому объясняем по запросу:
//! человек вводит домен, мы прогоняем его по ТОМ ЖЕ порядку правил, в котором их
//! получает движок (см. `core::build_rules`), и называем сработавшее.
//!
//! Порядок обязан совпадать с генератором конфига. Если он разойдётся, объяснение
//! начнёт врать — а это хуже, чем его отсутствие: человек будет искать поломку не там.

use crate::core::Rules;
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct Verdict {
    /// `vpn` | `direct`.
    pub route: String,
    /// Человеческая причина: какое правило сработало.
    pub reason: String,
    /// Что именно совпало (домен, подстрока, регэксп) — пусто для маршрута по умолчанию.
    pub matched: String,
}

fn host_matches_suffix(host: &str, rule: &str) -> bool {
    host == rule || host.ends_with(&format!(".{rule}"))
}

/// Прогнать домен по правилам в порядке их применения движком.
pub fn explain(host_raw: &str, r: &Rules) -> Verdict {
    let host = host_raw.trim().trim_end_matches('.').to_lowercase();
    let v = |route: &str, reason: &str, matched: &str| Verdict {
        route: route.into(),
        reason: reason.into(),
        matched: matched.into(),
    };

    if host.is_empty() {
        return v("direct", "Пустой адрес", "");
    }

    // 1. Полный VPN: доменных исключений нет вовсе.
    if !r.smart {
        return v("vpn", "Умная маршрутизация выключена: весь трафик идёт через VPN", "");
    }

    // 2. Локальные имена — раньше всего, если человек оставил их напрямую.
    if r.bypass_local {
        for suffix in ["local", "lan", "home", "internal", "intranet"] {
            if host_matches_suffix(&host, suffix) {
                return v("direct", "Локальное имя сети идёт напрямую", suffix);
            }
        }
        for d in &r.custom_local {
            if host_matches_suffix(&host, &d.to_lowercase()) {
                return v("direct", "Ваш локальный домен идёт напрямую", d);
            }
        }
    }

    // 3. Правила человека — важнее любых списков.
    for d in &r.user_domains {
        if host_matches_suffix(&host, &d.domain.to_lowercase()) {
            let route = if d.vpn { "vpn" } else { "direct" };
            return v(route, "Ваше правило для этого сайта", &d.domain);
        }
    }

    // 4. Исключения из базы: «напрямую» проверяется ПЕРЕД «в VPN» — иначе широкое
    //    правило перекрыло бы точечное (так и было с GitHub).
    for d in &r.list_direct_domains {
        if host_matches_suffix(&host, &d.to_lowercase()) {
            return v("direct", "База маршрутизации: этот сайт работает без VPN", d);
        }
    }

    // 5. База «в VPN» — по видам из грамматики upstream.
    for d in &r.list_vpn_domains {
        if host_matches_suffix(&host, &d.to_lowercase()) {
            return v("vpn", "База маршрутизации: не работает в России", d);
        }
    }
    for d in &r.list_vpn_full {
        if host == d.to_lowercase() {
            return v("vpn", "База маршрутизации: точное совпадение", d);
        }
    }
    for k in &r.list_vpn_keywords {
        if host.contains(&k.to_lowercase()) {
            return v("vpn", "База маршрутизации: совпадение по части имени", k);
        }
    }
    for re in &r.list_vpn_regex {
        if regex::Regex::new(re).map(|c| c.is_match(&host)).unwrap_or(false) {
            return v("vpn", "База маршрутизации: совпадение по шаблону", re);
        }
    }

    v("direct", "Ни одно правило не подошло — идёт напрямую", "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::DomainRule;

    fn base() -> Rules {
        Rules {
            smart: true,
            list_direct_domains: vec!["github.com".into()],
            list_vpn_domains: vec!["openai.com".into(), "githubcopilot.com".into()],
            list_vpn_full: vec!["exact.example".into()],
            list_vpn_keywords: vec!["torrent".into()],
            list_vpn_regex: vec![r"^ads?\..*".into()],
            ..Default::default()
        }
    }

    #[test]
    fn user_rule_beats_the_base() {
        let mut r = base();
        r.user_domains = vec![DomainRule { domain: "openai.com".into(), vpn: false }];
        let v = explain("chat.openai.com", &r);
        assert_eq!(v.route, "direct");
        assert!(v.reason.contains("Ваше правило"), "{}", v.reason);
    }

    #[test]
    fn direct_exception_beats_vpn_rule() {
        // Ровно случай GitHub: широкое «в VPN» не должно перекрывать точечное «напрямую».
        let mut r = base();
        r.list_vpn_domains.push("github.com".into());
        let v = explain("api.github.com", &r);
        assert_eq!(v.route, "direct");
        assert_eq!(v.matched, "github.com");
    }

    #[test]
    fn subdomains_follow_the_parent() {
        assert_eq!(explain("api.openai.com", &base()).route, "vpn");
        assert_eq!(explain("openai.com", &base()).route, "vpn");
        // Похожее, но чужое имя не должно совпадать.
        assert_eq!(explain("notopenai.com", &base()).route, "direct");
    }

    #[test]
    fn other_grammar_kinds_work() {
        assert_eq!(explain("exact.example", &base()).route, "vpn");
        assert_eq!(explain("sub.exact.example", &base()).route, "direct", "full — только точное совпадение");
        assert_eq!(explain("mytorrentsite.org", &base()).route, "vpn");
        assert_eq!(explain("ads.example.net", &base()).route, "vpn");
    }

    #[test]
    fn full_mode_says_so_plainly() {
        let mut r = base();
        r.smart = false;
        let v = explain("github.com", &r);
        assert_eq!(v.route, "vpn");
        assert!(v.reason.contains("выключена"), "{}", v.reason);
    }

    #[test]
    fn unknown_domain_goes_direct() {
        let v = explain("nothing-matches-here.example", &base());
        assert_eq!(v.route, "direct");
        assert!(v.reason.contains("Ни одно правило"));
    }

    #[test]
    fn input_is_normalised() {
        assert_eq!(explain("  API.OpenAI.com.  ", &base()).route, "vpn");
        assert_eq!(explain("", &base()).route, "direct");
    }
}
