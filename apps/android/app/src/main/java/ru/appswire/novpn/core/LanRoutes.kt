package ru.appswire.novpn.core

/**
 * Маршруты туннеля при «Локальная сеть — напрямую». Правила движка уже отправляли
 * локальные адреса напрямую, но только то, что движок умеет проксировать: широковещание
 * и мультикаст (поиск устройств в сети — микшер X32 в Mixing Station, Chromecast, DLNA)
 * в туннеле просто терялись. Поэтому локальные подсети не заводим в туннель вовсе:
 * маршрут 0.0.0.0/0 заменяем набором префиксов «весь IPv4, кроме локального».
 * Так работает на любом Android, без excludeRoute (он есть только с Android 13).
 */
object LanRoutes {
    /** Что идёт мимо туннеля: частные сети, link-local, мультикаст и 240/4 вместе с
     *  широковещанием 255.255.255.255 (в интернете 240/4 не используется). */
    val LAN_V4 = listOf(
        "10.0.0.0" to 8,
        "172.16.0.0" to 12,
        "192.168.0.0" to 16,
        "169.254.0.0" to 16,
        "224.0.0.0" to 3,
    )

    /** То же для IPv6 (excludeRoute, Android 13+): ULA, link-local, мультикаст. */
    val LAN_V6 = listOf("fc00::" to 7, "fe80::" to 10, "ff00::" to 8)

    fun ipv4ToLong(ip: String): Long =
        ip.split('.').fold(0L) { acc, part -> (acc shl 8) or part.toLong() }

    private fun longToIpv4(v: Long): String =
        listOf(24, 16, 8, 0).joinToString(".") { ((v shr it) and 0xFF).toString() }

    /** Весь IPv4 без [LAN_V4] — минимальным набором выровненных префиксов. */
    fun ipv4WithoutLan(): List<Pair<String, Int>> {
        val lan = LAN_V4.map { (base, len) -> ipv4ToLong(base) to (1L shl (32 - len)) }
        val out = mutableListOf<Pair<String, Int>>()
        fun walk(start: Long, len: Int) {
            val size = 1L shl (32 - len)
            val end = start + size
            if (lan.any { (b, s) -> start >= b && end <= b + s }) return // целиком локальный
            if (lan.none { (b, s) -> start < b + s && b < end }) { // с локальным не пересекается
                out += longToIpv4(start) to len
                return
            }
            walk(start, len + 1)
            walk(start + size / 2, len + 1)
        }
        walk(0L, 0)
        return out
    }
}
