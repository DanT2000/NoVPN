package ru.appswire.novpn.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Списки маршрутизации с панели — порт `apps/desktop/src-tauri/src/lists.rs`.
 *
 * Это второй слой правил: при обновлении он заменяется целиком, в отличие от
 * правил человека, которые лежат отдельно и не трогаются никогда.
 *
 * Грамматика `upstream.items[]` (контракт, раздел 7):
 *   `example.com`   → DOMAIN-SUFFIX (домен и поддомены)
 *   `full:x.y`      → DOMAIN (точное совпадение)
 *   `keyword:слово` → DOMAIN-KEYWORD
 *   `regexp:^ad\..*`→ DOMAIN-REGEX (невалидные пропускаем — источники чужие)
 *   `1.2.3.4`, `10.0.0.0/8`, IPv6 → IP-CIDR
 *
 * Файл `apps.json` здесь не нужен: на Android правила по процессам не работают,
 * приложения разводятся средствами системы (см. Rules).
 */
@Serializable
data class RoutingLists(
    val vpnDomains: List<String> = emptyList(),
    val vpnFull: List<String> = emptyList(),
    val vpnKeywords: List<String> = emptyList(),
    val vpnRegex: List<String> = emptyList(),
    val vpnIps: List<String> = emptyList(),
    val directDomains: List<String> = emptyList(),
    val version: Long? = null,
    val updatedAt: String? = null,
    val etag: String? = null,
) {
    val total: Int
        get() = vpnDomains.size + vpnFull.size + vpnKeywords.size + vpnRegex.size + vpnIps.size + directDomains.size
}

object ListsParser {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    class Builder {
        val vpnDomains = mutableListOf<String>()
        val vpnFull = mutableListOf<String>()
        val vpnKeywords = mutableListOf<String>()
        val vpnRegex = mutableListOf<String>()
        val vpnIps = mutableListOf<String>()
        val directDomains = mutableListOf<String>()

        fun build(version: Long?, updatedAt: String?, etag: String?) = RoutingLists(
            vpnDomains = vpnDomains.distinct(),
            vpnFull = vpnFull.distinct(),
            vpnKeywords = vpnKeywords.distinct(),
            vpnRegex = vpnRegex.distinct(),
            vpnIps = vpnIps.distinct(),
            directDomains = directDomains.distinct(),
            version = version,
            updatedAt = updatedAt,
            etag = etag,
        )
    }

    /** Маска в допустимом диапазоне. Пусто — маски нет, это тоже нормально.
     *  Проверять надо и снизу: «/-1» Java разберёт как число, и в конфиг уехало бы
     *  правило, от которого движок откажется целиком вместе с конфигом. */
    private fun maskOk(mask: String?, max: Int): Boolean {
        if (mask == null) return true
        if (mask.isEmpty() || mask.any { it !in '0'..'9' }) return false
        val n = mask.toIntOrNull() ?: return false
        return n in 0..max
    }

    private fun isIpv4(s: String): Boolean {
        val (addr, mask) = s.split("/", limit = 2).let { it[0] to it.getOrNull(1) }
        return Config.isIpv4Literal(addr) && maskOk(mask, 32)
    }

    private fun isIpv6(s: String): Boolean {
        val (addr, mask) = s.split("/", limit = 2).let { it[0] to it.getOrNull(1) }
        return Config.isIpv6Literal(addr) && maskOk(mask, 128)
    }

    /** Одна строка `upstream.items[]` → в нужное ведро. Всё в upstream — «через VPN». */
    fun absorbUpstreamItem(raw: String, out: Builder) {
        val s = raw.trim()
        if (s.isEmpty()) return
        when {
            s.startsWith("full:") -> s.removePrefix("full:").trim().lowercase()
                .takeIf { it.isNotEmpty() }?.let { out.vpnFull += it }

            s.startsWith("keyword:") -> s.removePrefix("keyword:").trim().lowercase()
                .takeIf { it.isNotEmpty() }?.let { out.vpnKeywords += it }

            s.startsWith("regexp:") -> {
                val re = s.removePrefix("regexp:").trim()
                // Панель регэкспы не проверяет — источники чужие. Одна кривая строка
                // иначе сделала бы весь конфиг движка невалидным. Проверяем по меркам
                // движка (RE2), а не по возможностям Java: см. Config.safeRegex.
                if (Config.safeRegex(re)) out.vpnRegex += re
            }

            isIpv4(s) -> out.vpnIps += if (s.contains('/')) s else "$s/32"
            isIpv6(s) -> out.vpnIps += (if (s.contains('/')) s else "$s/128").lowercase()

            else -> s.removePrefix("domain:").trim().lowercase()
                .takeIf { it.isNotEmpty() }?.let { out.vpnDomains += it }
        }
    }

    /**
     * Разбирает файл списка. Понимает и массив строк, и `{items: [...]}`, и
     * объектные записи `{domain, route}` — так отдают старые и локальные списки.
     */
    fun parse(text: String, etag: String? = null): RoutingLists {
        val root = json.parseToJsonElement(text)
        val arr: List<kotlinx.serialization.json.JsonElement> = when (root) {
            is JsonArray -> root.toList()
            is JsonObject -> (root["items"] as? JsonArray)?.toList().orEmpty()
            else -> emptyList()
        }
        val b = Builder()
        for (el in arr) {
            when (el) {
                is JsonPrimitive -> el.contentOrNull?.let { absorbUpstreamItem(it, b) }
                is JsonObject -> {
                    val domain = (el["domain"] as? JsonPrimitive)?.contentOrNull
                        ?: (el["value"] as? JsonPrimitive)?.contentOrNull
                    val route = (el["route"] as? JsonPrimitive)?.contentOrNull ?: "vpn"
                    if (!domain.isNullOrBlank()) {
                        if (route == "direct") b.directDomains += domain.trim().lowercase()
                        else absorbUpstreamItem(domain, b)
                    }
                }
                else -> {}
            }
        }
        val obj = root as? JsonObject
        val version = (obj?.get("version") as? JsonPrimitive)?.contentOrNull?.toLongOrNull()
        val updatedAt = (obj?.get("updatedAt") as? JsonPrimitive)?.contentOrNull
        return b.build(version, updatedAt, etag)
    }

    /** Похоже ли на настоящий список: отсекает `[]`, `{}` и ответы-заглушки. */
    fun looksLikeList(text: String): Boolean = runCatching {
        when (val v = json.parseToJsonElement(text)) {
            is JsonArray -> v.isNotEmpty()
            is JsonObject -> (v["items"] as? JsonArray)?.isNotEmpty() == true
            else -> false
        }
    }.getOrDefault(false)
}
