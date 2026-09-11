package ru.appswire.novpn.store

import kotlinx.serialization.Serializable
import ru.appswire.novpn.core.ServerEntry

/** Правило по сайту, добавленное человеком (готовых списков здесь нет — они отдельно). */
@Serializable
data class SiteRule(
    val id: String,
    val title: String,
    val domain: String,
    /** `vpn` | `direct`. */
    val route: String,
    val enabled: Boolean = true,
)

/**
 * Правило по приложению. На Android «через VPN» означает «участвует в туннеле и
 * подчиняется умным правилам», «напрямую» — приложение исключается из VPN целиком
 * средствами системы. Правил по процессам движка тут нет и быть не может.
 */
@Serializable
data class AppRule(
    val pkg: String,
    /** `vpn` | `direct`. */
    val route: String,
)

@Serializable
data class Settings(
    /** Подключаться автоматически при запуске и после перезагрузки телефона. */
    val autoconnect: Boolean = true,
    val autoUpdateLists: Boolean = true,
    /** Локальная сеть напрямую: роутер, NAS, внутренние сайты мимо VPN.
     *  Выключено по умолчанию — так же, как на десктопе. */
    val bypassLocal: Boolean = false,
    val customLocalDomains: List<String> = emptyList(),
    /** cloudflare | google | quad9 | custom. */
    val dnsProvider: String = "cloudflare",
    val customDns: String = "",
    /** system | dark | light. */
    val theme: String = "system",
    /** Показывать скорость и трафик в уведомлении. */
    val notifySpeed: Boolean = true,
    /** Автоматическое восстановление: сам подбирает рабочий сервер (обычный, затем
     *  резервный) и возвращается на обычный, когда сеть нормализуется. Выключено —
     *  диагностика работает, но переход на резерв только по кнопке. */
    val autoFailover: Boolean = true,
    /** Отправлять на панель накопленную диагностику подключения (после восстановления
     *  интернета). Помогает понять реальную причину сбоев. */
    val sendDiagnostics: Boolean = true,
)

@Serializable
data class State(
    val onboarded: Boolean = false,
    val introSeen: Boolean = false,
    val subUrl: String = "",
    /** Точки подключения из подписки, уже сопоставленные с meta.json. */
    val servers: List<ServerEntry> = emptyList(),
    /** Ключ выбранного сервера (ServerEntry.key), не имя профиля. */
    val serverKey: String? = null,
    /** Включена умная маршрутизация. Выключение = профиль «Полный VPN». */
    val smartRouting: Boolean = true,
    /** Когда включили полный VPN (мс). Нужно для таймера возврата на умный. */
    val fullSince: Long = 0,
    val sites: List<SiteRule> = emptyList(),
    val apps: List<AppRule> = emptyList(),
    val settings: Settings = Settings(),
    /** Последняя удачная синхронизация списков — для строки статуса. */
    val listsSyncedAt: Long = 0,
    /** Человеку показали просьбу снять ограничения батареи (чтобы не спрашивать вечно). */
    val batteryHintSeen: Boolean = false,
    /** Показывали ли подсказку про автозапуск на оболочке производителя. */
    val oemHintSeen: Boolean = false,
)
