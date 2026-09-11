package ru.appswire.novpn.core

/** Одно правило по домену вместе с маршрутом. */
data class DomainRule(val domain: String, val vpn: Boolean)

/**
 * Правила в том виде, в каком их видит движок. Поля повторяют десктопные
 * (`core.rs::Rules`) — это один и тот же контракт маршрутизации на двух клиентах.
 *
 * Чего здесь НЕТ по сравнению с десктопом: правил по именам процессов. На Android
 * узнать, какому приложению принадлежит соединение, без root нельзя (с Android 10
 * `/proc/net/tcp` показывает только свои сокеты). Поэтому «приложение напрямую»
 * делается не правилом движка, а средствами системы: такое приложение исключается
 * из VPN целиком (`VpnService.Builder.addDisallowedApplication`) — см. VpnRunner.
 */
data class Rules(
    /** Выключенная умная маршрутизация = профиль «Полный VPN»: весь трафик в туннель. */
    val smart: Boolean = true,
    /** Серверная политика приватных подсетей (meta.routing.lanAccess).
     *  false — LAN напрямую; true — LAN В туннель. Легко перепутать. */
    val lanAccess: Boolean = false,
    /** Обходить ли локальные ДОМЕНЫ (.local, .lan, corp…) напрямую. */
    val bypassLocal: Boolean = true,
    /** Свои локальные суффиксы, всегда напрямую и через системный DNS. */
    val customLocal: List<String> = emptyList(),
    /** cloudflare | google | quad9 | свой адрес/URL (через запятую). */
    val dnsProvider: String = "cloudflare",
    /** Системные DNS устройства — для доменов «напрямую». На Android нет
     *  /etc/resolv.conf, поэтому «system» движку не подходит: адреса берём у
     *  ConnectivityManager и подставляем явно. Пусто — политика не пишется. */
    val systemDns: List<String> = emptyList(),
    /** Домены человека в порядке важности: сначала из браузера, затем из окна. */
    val userDomains: List<DomainRule> = emptyList(),
    val listDirectDomains: List<String> = emptyList(),
    val listVpnDomains: List<String> = emptyList(),
    val listVpnFull: List<String> = emptyList(),
    val listVpnKeywords: List<String> = emptyList(),
    val listVpnRegex: List<String> = emptyList(),
    val listVpnIps: List<String> = emptyList(),
)
