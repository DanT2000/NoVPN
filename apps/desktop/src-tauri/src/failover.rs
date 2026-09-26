//! Координатор авто-переключения серверов на десктопе — порт логики Android
//! `NoVpnService.evaluate()`.
//!
//! Фаза 1: следит за текущим сервером; если тот перестал пропускать трафик —
//! параллельно-последовательно подбирает рабочий ОБЫЧНЫЙ сервер из подписки и
//! переключается; когда предпочтительный (выбранный человеком) снова оживает —
//! возвращается на него. Задел под Фазу 2 (резерв/белые списки) — в конце цикла.
//!
//! Работает через управляющий канал движка (тот же контроллер, что у reload/
//! select_proxy), поэтому одинаково годится и для режима адаптера (движок в
//! привилегированном хосте), и для прокси-режима.

use crate::core::{self, Ports};
use crate::diag::{self, NetDiagnosis};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Проверка реального доступа — к настоящим сайтам, не 204-only-пинг.
const HEALTH_URLS: &[&str] = &[
    "http://cp.cloudflare.com/generate_204",
    "http://www.google.com/generate_204",
];
const HEALTH_TIMEOUT_MS: u32 = 3000;
/// Как часто сторож проверяет доступ выбранного сервера.
const TICK: Duration = Duration::from_secs(12);

/// Проверка реального ОБХОДА для резерва: внешние сайты, недоступные в белых
/// списках напрямую (в т.ч. YouTube). Требуем ≥2 быстрых ответа — так отсеиваются
/// и российские, и мёртвые серверы (через них YouTube/Google не загрузятся).
const BYPASS_URLS: &[&str] = &[
    "https://www.youtube.com/generate_204",
    "https://www.google.com/generate_204",
    "https://cp.cloudflare.com/generate_204",
];
const BYPASS_TIMEOUT_MS: u32 = 3500;
const BYPASS_MIN_OK: usize = 2;

/// Реально ли резервный сервер ПРОБИВАЕТ ограничение (строже, чем works_through).
fn bypasses_well(port: u16, name: &str) -> bool {
    BYPASS_URLS
        .iter()
        .filter(|u| core::proxy_delay(port, name, u, BYPASS_TIMEOUT_MS).is_ok())
        .count()
        >= BYPASS_MIN_OK
}

/// Один активный координатор на приложение (переподключение гасит прежний).
static ACTIVE: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();

fn active() -> &'static Mutex<Option<Arc<AtomicBool>>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/// Реально ли сервер пропускает трафик: delay-тест ЧЕРЕЗ него к настоящему сайту
/// (не порт, не ICMP — те проходят и в ограниченной сети).
fn works_through(port: u16, name: &str) -> bool {
    HEALTH_URLS
        .iter()
        .any(|u| core::proxy_delay(port, name, u, HEALTH_TIMEOUT_MS).is_ok())
}

/// Решение сторожа. Вынесено из цикла ЧИСТОЙ функцией — чтобы покрыть логику
/// (падение сервера → подбор → возврат → резерв) тестами без движка и сети.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// Остаёмся на текущем сервере.
    Stay,
    /// Переключиться на этот сервер (select_proxy).
    Switch(String),
}

/// `works`/`bypasses` — проверки доступа/обхода; `diagnose` — диагностика сети,
/// вызывается ЛЕНИВО (только когда ни один обычный сервер не работает).
pub fn decide<W, B, D>(
    current: &str,
    preferred: &str,
    normal: &[String],
    reserve: &[String],
    works: W,
    bypasses: B,
    diagnose: D,
) -> Action
where
    W: Fn(&str) -> bool,
    B: Fn(&str) -> bool,
    D: FnOnce() -> NetDiagnosis,
{
    // Текущий пропускает трафик — всё хорошо. Если мы на запасном, а
    // предпочтительный ожил — возвращаемся на него.
    if works(current) {
        if current != preferred && works(preferred) {
            return Action::Switch(preferred.to_string());
        }
        return Action::Stay;
    }
    // Текущий не пропускает — ищем рабочий ОБЫЧНЫЙ сервер.
    if let Some(n) = normal.iter().find(|n| n.as_str() != current && works(n)) {
        return Action::Switch(n.clone());
    }
    // Ни один обычный не работает — диагностируем и, при белых списках/падении
    // наших серверов, уходим на аварийный пул (российские уже исключены в reserve),
    // с проверкой РЕАЛЬНОГО обхода.
    if matches!(diagnose(), NetDiagnosis::Restricted | NetDiagnosis::ServerDown) {
        if let Some(r) = reserve.iter().find(|r| bypasses(r)) {
            return Action::Switch(r.clone());
        }
    }
    Action::Stay
}

/// Запустить координатор. `preferred` — сервер, выбранный человеком (куда
/// возвращаемся). `servers` — (name, host, port) всех обычных серверов подписки.
/// Прежний координатор (если был) гасится.
pub fn start(preferred: String, servers: Vec<(String, String, u16)>) {
    // Гасим прежний и ставим новый флаг остановки.
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut g = active().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = g.replace(stop.clone()) {
            old.store(true, Ordering::SeqCst);
        }
    }
    let port = Ports::default().controller;

    std::thread::spawn(move || {
        // Отдельный однопоточный рантайм — только чтобы гонять async-диагностику
        // (reqwest/TCP) внутри обычного потока-сторожа.
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(r) => r,
            Err(_) => return,
        };
        let names: Vec<String> = servers.iter().map(|(n, _, _)| n.clone()).collect();
        let addrs: Vec<(String, u16)> = servers.iter().map(|(_, h, p)| (h.clone(), *p)).collect();
        let mut current = preferred.clone();

        'watch: loop {
            // Прерываемый сон: стоп-флаг проверяем каждые 500мс, а не спим все 12с — иначе
            // остановленный/переподключённый сторож живёт (и держит tokio-рантайм) до конца
            // TICK, и несколько таких «зомби» могли накопиться при повторных vpn_reload.
            let step = Duration::from_millis(500);
            let mut slept = Duration::ZERO;
            while slept < TICK {
                if stop.load(Ordering::SeqCst) {
                    break 'watch;
                }
                std::thread::sleep(step);
                slept += step;
            }
            if stop.load(Ordering::SeqCst) {
                break;
            }
            // Контроллер лёг — VPN отключён, сторожить нечего.
            if !core::controller_up(port) {
                break;
            }

            // Текущий сервер пропускает трафик — всё хорошо. Если мы на запасном, а
            // предпочтительный ожил — возвращаемся на него.
            let reserve = crate::reserve::bypass_candidate_names();
            let action = decide(
                &current,
                &preferred,
                &names,
                &reserve,
                |n| works_through(port, n),
                |n| bypasses_well(port, n),
                || rt.block_on(diag::diagnose(&addrs)),
            );
            if let Action::Switch(next) = action {
                // decide() и его delay-тесты идут секундами: за это время сессию могли
                // остановить/переподключить. Перепроверяем перед самим переключением и
                // фиксируем текущий сервер ТОЛЬКО если движок реально принял выбор —
                // иначе рассинхрон (мы думаем, что на next, а движок на прежнем).
                if stop.load(Ordering::SeqCst) || !core::controller_up(port) {
                    break;
                }
                if core::select_proxy(port, core::GROUP, &next).is_ok() {
                    current = next;
                }
            }
        }

        // Снимаем себя из активных, если это всё ещё мы.
        let mut g = active().lock().unwrap_or_else(|e| e.into_inner());
        if g.as_ref().map(|s| Arc::ptr_eq(s, &stop)).unwrap_or(false) {
            *g = None;
        }
    });
}

/// Остановить координатор (при отключении VPN).
pub fn stop() {
    let mut g = active().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = g.take() {
        old.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn stays_when_current_works() {
        let a = decide("A", "A", &v(&["A", "B"]), &v(&["R"]), |_| true, |_| true, || NetDiagnosis::Ok);
        assert_eq!(a, Action::Stay);
    }

    #[test]
    fn returns_to_preferred_when_it_recovers() {
        // На запасном B, оба сервера работают → вернуться на предпочтительный A.
        let a = decide("B", "A", &v(&["A", "B"]), &v(&["R"]), |_| true, |_| true, || NetDiagnosis::Ok);
        assert_eq!(a, Action::Switch("A".into()));
    }

    #[test]
    fn switches_to_working_normal_when_current_dead() {
        // A мёртв, B живой → уходим на B (не диагностируя).
        let a = decide("A", "A", &v(&["A", "B", "C"]), &v(&["R"]), |n| n != "A", |_| true, || {
            panic!("диагностику звать не должны, пока есть рабочий обычный")
        });
        assert_eq!(a, Action::Switch("B".into()));
    }

    #[test]
    fn goes_to_reserve_on_restricted() {
        // Все обычные мертвы, белые списки, резерв R2 реально пробивает.
        let a = decide("A", "A", &v(&["A", "B"]), &v(&["R1", "R2"]), |_| false, |n| n == "R2", || {
            NetDiagnosis::Restricted
        });
        assert_eq!(a, Action::Switch("R2".into()));
    }

    #[test]
    fn stays_when_no_internet() {
        // Всё мертво, интернета нет вовсе — переключаться некуда.
        let a = decide("A", "A", &v(&["A", "B"]), &v(&["R"]), |_| false, |_| true, || NetDiagnosis::NoInternet);
        assert_eq!(a, Action::Stay);
    }
}
