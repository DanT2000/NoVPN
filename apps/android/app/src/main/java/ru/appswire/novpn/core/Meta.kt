package ru.appswire.novpn.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Метаданные подписки — `GET /sub/<токен>/meta.json` (docs/NOVPN-CLIENT-CONTRACT.md).
 * Порт `apps/desktop/src-tauri/src/meta.rs`.
 *
 * Отсюда клиент узнаёт ПРОФИЛИ: у одного сервера их может быть два — умный и
 * «Полный VPN». Сопоставление с конфигами подписки — по `profileId`, `host` —
 * запасной ключ.
 *
 * Два правила контракта, которые здесь и реализованы:
 * - «панель не ответила» (таймаут, сеть, 5xx) — НЕ сигнал: живём по последней
 *   удачной копии;
 * - любой 4xx — авторитетный ответ: подписка недействительна / отключена /
 *   истекла / трафик исчерпан. Подключение блокируется.
 */
@Serializable
data class Routing(
    /** `smart` | `full`. Пусто/неизвестно = smart. */
    val mode: String = "",
    /** false — приватные подсети НАПРЯМУЮ; true — В туннель. Легко перепутать. */
    val lanAccess: Boolean = false,
    val fallbackTypes: List<String>? = null,
    val ownExceptions: Long = 0,
    /** Через сколько ЧАСОВ полный VPN сам вернётся на умный. 0 — не возвращать. */
    val fullTimeoutHours: Double = 0.0,
    val expiresAt: String? = null,
    val fallbackProfileId: String? = null,
)

@Serializable
data class Profile(
    val profileId: String,
    val serverId: String = "",
    val host: String = "",
    val remark: String = "",
    val recommended: Boolean = false,
    val protocols: List<String> = emptyList(),
    val online: Boolean = false,
    val subLink: String = "",
    val routing: Routing = Routing(),
) {
    /** Режим профиля. Отсутствие блока routing (старая панель) — smart. */
    val mode: String get() = if (routing.mode == "full") "full" else "smart"
}

@Serializable
data class Meta(
    val schemaVersion: Long = 0,
    val routingResources: Map<String, String> = emptyMap(),
    val profiles: List<Profile> = emptyList(),
) {
    /** Мажор контракта выше нашего — данные могут значить не то, что мы думаем. */
    val unsupported: Boolean get() = schemaVersion > SUPPORTED_SCHEMA

    fun byId(profileId: String): Profile? = profiles.firstOrNull { it.profileId == profileId }

    /** Умный профиль того же сервера — цель отката, если полный отозвали. */
    fun smartOfServer(serverId: String): Profile? =
        profiles.firstOrNull { it.serverId == serverId && it.mode == "smart" }

    companion object {
        /** Мажорная версия контракта, которую понимает этот клиент. */
        const val SUPPORTED_SCHEMA = 1L

        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        fun parse(text: String): Meta {
            val m = json.decodeFromString<Meta>(text)
            require(m.profiles.none { it.profileId.isBlank() }) { "meta.json: у профиля нет profileId" }
            return m
        }

        /**
         * `https://panel/sub/<токен>[/full|…]` → `https://panel/sub/<токен>/meta.json`.
         * Чужая ссылка без `/sub/<токен>/` — null: у неё meta.json нет по определению.
         */
        fun metaUrl(subUrl: String): String? {
            val i = subUrl.indexOf("://")
            if (i < 0) return null
            val scheme = subUrl.substring(0, i)
            val rest = subUrl.substring(i + 3)
            val slash = rest.indexOf('/')
            val host = if (slash < 0) rest else rest.substring(0, slash)
            if (host.isEmpty()) return null
            val path = if (slash < 0) "" else rest.substring(slash + 1).substringBefore('?').substringBefore('#')
            val segs = path.split('/').filter { it.isNotEmpty() }
            val at = segs.indexOf("sub")
            if (at < 0 || at + 1 >= segs.size) return null
            val token = segs[at + 1]
            if (token.isEmpty()) return null
            return "$scheme://$host/sub/$token/meta.json"
        }

        /** Базовый адрес панели из адреса подписки — для списков маршрутизации. */
        fun baseOf(subUrl: String): String? {
            val i = subUrl.indexOf("://")
            if (i < 0) return null
            val scheme = subUrl.substring(0, i)
            val rest = subUrl.substring(i + 3)
            val host = rest.substringBefore('/')
            if (host.isEmpty()) return null
            return "$scheme://$host"
        }
    }
}

/** Отказ панели (4xx): машинный код и текст для человека. */
@Serializable
data class Denied(val status: Int, val kind: String, val message: String)

fun deniedHuman(kind: String): String = when (kind) {
    "not_found" -> "Подписка недействительна — проверьте ссылку"
    "disabled" -> "Доступ отключён"
    "expired" -> "Срок доступа истёк"
    "traffic" -> "Лимит трафика исчерпан"
    else -> "Панель отказала в доступе"
}

@Serializable
data class MetaResult(
    val meta: Meta? = null,
    /** `network` — свежий ответ; `cache` — панель не ответила; `none` — нет meta. */
    val source: String = "none",
    val denied: Denied? = null,
    val unsupported: Boolean = false,
    val networkError: String? = null,
)

/** Профиль подписки, сопоставленный с meta.json. */
@Serializable
data class ServerEntry(
    /** Имя точки в конфиге движка (оно же в группе NoVPN). */
    val name: String,
    val profileId: String? = null,
    val serverId: String? = null,
    val host: String = "",
    /** `smart` | `full`. */
    val mode: String = "smart",
    val recommended: Boolean = false,
    val lanAccess: Boolean = false,
    val fullTimeoutHours: Double = 0.0,
) {
    /** Ключ группировки: профили панели — по serverId, чужие — по имени. */
    val key: String get() = serverId ?: name
}
