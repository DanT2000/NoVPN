package ru.appswire.novpn.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import org.yaml.snakeyaml.Yaml
import java.net.URLDecoder
import java.util.Base64

/**
 * Разбор подписки — порт `apps/desktop/src-tauri/src/sub.rs`, строка в строку по
 * смыслу. Оба клиента обязаны понимать одну и ту же подписку одинаково, поэтому
 * расхождений тут быть не должно: если правится здесь — правится и там.
 *
 * Формат заранее неизвестен: приложение принимает ссылку любого провайдера.
 * Точку подключения храним не своей структурой, а готовой картой параметров для
 * mihomo: сочетаний транспорта и маскировки десятки, заводить под каждое поле
 * значит бесконечно догонять чужие релизы.
 */
object Sub {

    /** Запросы ходят под видом привычного провайдерам клиента: часть панелей
     *  отдаёт разный формат в зависимости от User-Agent, а некоторые отказывают
     *  незнакомым. */
    const val USER_AGENT = "v2rayNG/1.9.5"

    /** Служебные поля профиля NoVPN из `meta.novpn` конфига (контракт, раздел 3). */
    data class NodeProfile(
        val profileId: String,
        val serverId: String,
        val host: String,
        /** `smart` | `full`. */
        val mode: String,
    )

    data class Node(
        val name: String,
        val map: MutableMap<String, Any?>,
        val profile: NodeProfile? = null,
    )

    sealed class Parsed {
        /** Провайдер отдал готовый Clash-конфиг — берём целиком как основу. */
        data class Clash(val root: MutableMap<String, Any?>) : Parsed()
        data class Nodes(val nodes: List<Node>) : Parsed()
    }

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun parse(raw: String): Parsed {
        val text = raw.trim()
        require(text.isNotEmpty()) { "Подписка пустая" }

        // 1. JSON — Xray-массив конфигов (так отдаёт NoVPN) или одиночный конфиг.
        if (text.startsWith("[") || text.startsWith("{")) {
            val nodes = runCatching { fromXrayJson(json.parseToJsonElement(text)) }.getOrDefault(emptyList())
            if (nodes.isNotEmpty()) return Parsed.Nodes(nodes)
        }

        // 2. Готовый Clash/Mihomo YAML.
        if (text.contains("proxies:")) {
            val root = runCatching {
                // SafeConstructor: текст приходит из сети, а обычный конструктор
                // YAML умеет создавать произвольные классы по тегам.
                @Suppress("UNCHECKED_CAST")
                Yaml(org.yaml.snakeyaml.constructor.SafeConstructor(org.yaml.snakeyaml.LoaderOptions()))
                    .load<Any?>(text) as? MutableMap<String, Any?>
            }.getOrNull()
            if (root != null && (root["proxies"] as? List<*>)?.isNotEmpty() == true) {
                // Из чужого конфига берём ТОЛЬКО точки подключения. Всё остальное
                // (listeners, socks-port, bind-address, rule-providers, geox-url, hosts) —
                // это команды движку, который крутится на телефоне человека: подписка не
                // должна открывать порты в локальную сеть и заставлять его качать файлы с
                // чужих адресов. proxy-groups провайдера тоже НЕ переносим, как и десктоп
                // (sub.rs): группа через `use:`/`include-all`/`filter` без своего списка
                // proxies (или устаревший relay) роняла ВЕСЬ конфиг — «`use` or `proxies`
                // missing», движок не стартовал. Наши правила ссылаются только на NoVPN.
                val safe = linkedMapOf<String, Any?>()
                root["proxies"]?.let { safe["proxies"] = it }
                return Parsed.Clash(safe)
            }
        }

        // 3. Список ссылок — как есть либо в base64.
        val plain = if (text.contains("://")) text
        else decodeBase64(text) ?: throw IllegalArgumentException("Не удалось разобрать подписку: неизвестный формат")
        val nodes = fromLinks(plain)
        require(nodes.isNotEmpty()) { "В подписке не нашлось ни одного сервера" }
        return Parsed.Nodes(nodes)
    }

    /** Имена точек подключения в подписке (в порядке следования). */
    fun namesOf(parsed: Parsed): List<String> = when (parsed) {
        is Parsed.Nodes -> parsed.nodes.map { it.name }
        is Parsed.Clash -> (parsed.root["proxies"] as? List<*>).orEmpty()
            .mapNotNull { (it as? Map<*, *>)?.get("name")?.toString() }
    }

    /** Адреса серверов — нужны для анти-петли в правилах. */
    fun hostsOf(parsed: Parsed): List<String> = when (parsed) {
        is Parsed.Nodes -> parsed.nodes.mapNotNull { it.map["server"]?.toString() }
        is Parsed.Clash -> (parsed.root["proxies"] as? List<*>).orEmpty()
            .mapNotNull { (it as? Map<*, *>)?.get("server")?.toString() }
    }

    /** Типы, которые ходят по UDP: TCP-проба до их порта ничего не говорит о сервере. */
    private val UDP_TYPES = setOf("wireguard", "hysteria", "hysteria2", "tuic")

    /**
     * Адрес и ПОРТ серверов — для диагностики «наш сервер достижим». Порт берём из
     * точки: панель ставит Xray и на нестандартный порт (443 бывает занят), у чужих
     * провайдеров 8443/2053 — обычное дело. Стук на жёсткий 443 давал ложный novpn=-
     * (SERVER_DOWN), и самовосстановление залипшего туннеля не срабатывало никогда.
     */
    fun endpointsOf(parsed: Parsed): List<Pair<String, Int>> {
        val maps: List<Map<*, *>> = when (parsed) {
            is Parsed.Nodes -> parsed.nodes.map { it.map }
            is Parsed.Clash -> (parsed.root["proxies"] as? List<*>).orEmpty().mapNotNull { it as? Map<*, *> }
        }
        return maps.mapNotNull { m ->
            if (m["type"]?.toString()?.lowercase() in UDP_TYPES) return@mapNotNull null
            val host = m["server"]?.toString()?.trim().orEmpty()
            if (host.isEmpty()) return@mapNotNull null
            // В чужом YAML порт бывает и числом, и строкой.
            val p = m["port"]?.toString()?.trim()?.toIntOrNull()
            host to (if (p != null && p in 1..65535) p else 443)
        }.distinct() // у умного и полного профиля один и тот же сервер
    }

    /** Подписки приходят и в обычном base64, и в URL-безопасном, и без выравнивания. */
    fun decodeBase64(t: String): String? {
        val cleaned = t.filterNot { it.isWhitespace() }.trimEnd('=')
        for (decoder in listOf(Base64.getDecoder(), Base64.getUrlDecoder())) {
            val text = runCatching { String(decoder.decode(cleaned), Charsets.UTF_8) }.getOrNull()
            if (text != null && text.contains("://")) return text
        }
        return null
    }

    private fun fromLinks(text: String): List<Node> {
        val out = mutableListOf<Node>()
        for (line in text.lines()) {
            val l = line.trim()
            if (l.isEmpty() || l.startsWith("#")) continue
            val node = when {
                l.startsWith("vless://") -> parseVless(l)
                l.startsWith("vmess://") -> parseVmess(l)
                l.startsWith("trojan://") -> parseTrojan(l)
                l.startsWith("ss://") -> parseSs(l)
                else -> null
            }
            if (node != null) out += node
        }
        return dedupeNames(out)
    }

    /**
     * Резервные точки, чьё имя совпало с обычным сервером (или со служебным именем
     * движка), получают приписку «(резерв)». Иначе в движке было два прокси с одним
     * именем: конфиг молча пропускал резервный, а проверка обхода и selectProxy по этому
     * имени били в ОБЫЧНЫЙ сервер — такой резерв был недоступен, а под «Резервным
     * подключением» мог оказаться обычный. Флаг в начале имени сохраняется: по нему
     * отсеиваются российские серверы.
     */
    fun renameClashing(nodes: List<Node>, taken: Set<String>): List<Node> {
        if (nodes.none { it.name in taken }) return nodes
        val used = HashSet(taken).apply { nodes.forEach { add(it.name) } }
        return nodes.map { n ->
            if (n.name !in taken) return@map n
            var name = "${n.name} (резерв)"
            var i = 2
            while (name in used) name = "${n.name} (резерв ${i++})"
            used += name
            n.copy(name = name, map = LinkedHashMap(n.map).apply { this["name"] = name })
        }
    }

    /** Имена точек у провайдеров часто повторяются, а mihomo требует уникальных. */
    private fun dedupeNames(nodes: List<Node>): List<Node> {
        val seen = mutableSetOf<String>()
        val out = mutableListOf<Node>()
        for (n in nodes) {
            var name = n.name.trim().ifEmpty { "Сервер" }
            val base = name
            var i = 2
            while (!seen.add(name)) {
                name = "$base #$i"
                i++
            }
            n.map["name"] = name
            out += n.copy(name = name)
        }
        return out
    }

    private class Uri(
        val user: String,
        val host: String,
        val port: Int,
        val query: Map<String, String>,
        val frag: String,
    ) {
        fun q(key: String): String = query[key].orEmpty()
    }

    private fun dec(s: String): String = runCatching {
        // Именно percent-decode, а не URLDecoder: тот по правилам форм превращает
        // «+» в пробел, и «RU+Moscow» стало бы «RU Moscow» — на десктопе имя другое.
        val out = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < s.length) {
            if (s[i] == '%' && i + 2 < s.length) {
                val hex = s.substring(i + 1, i + 3).toIntOrNull(16)
                if (hex != null) {
                    out.write(hex)
                    i += 3
                    continue
                }
            }
            // Обычный текст до следующего «%» пишем ЦЕЛИКОМ, а не по одному char:
            // иначе суррогатная пара эмодзи (флаг 🇷🇺 и др.) распадётся на два
            // непарных char и превратится в «????» — имя резерва искажалось, и
            // отсев российских серверов по флагу переставал работать. Как на
            // десктопе (urlencoding::decode сохраняет литеральный UTF-8).
            val start = i
            i++
            while (i < s.length && s[i] != '%') i++
            out.write(s.substring(start, i).toByteArray(Charsets.UTF_8))
        }
        String(out.toByteArray(), Charsets.UTF_8)
    }.getOrDefault(s)

    /** Порт из ссылки. Мусор и выход за границы — 443, как на десктопе (u16). */
    private fun port(raw: String?): Int {
        val n = raw?.trim()?.toIntOrNull() ?: return 443
        return if (n in 1..65535) n else 443
    }

    /** Кладём значение, только если оно непустое: движок отличает пустую строку от
     *  отсутствующего ключа, а десктопный put_str пустые отбрасывает. */
    private fun MutableMap<String, Any?>.putIfNotEmpty(key: String, value: String?) {
        if (!value.isNullOrEmpty()) this[key] = value
    }

    private fun splitUri(link: String, scheme: String): Uri? {
        val body = link.removePrefix(scheme)
        if (body == link) return null
        val (beforeFrag, frag) = body.split("#", limit = 2).let {
            it[0] to (it.getOrNull(1)?.let(::dec) ?: "")
        }
        val (beforeQuery, queryRaw) = beforeFrag.split("?", limit = 2).let { it[0] to it.getOrNull(1).orEmpty() }
        val at = beforeQuery.lastIndexOf('@')
        // userinfo в ссылке percent-кодирован: пароль trojan «a+b=» приходит как «a%2Bb%3D»
        // (так его собирает и сама панель из Xray-JSON провайдера). Без раскодирования в
        // движок уходил «a%2Bb%3D», и сервер отвергал пароль. UUID vless от этого не меняется.
        val user = if (at >= 0) dec(beforeQuery.substring(0, at)) else ""
        // Отсекаем путь `host:port/...` (напр. vless с завершающим «/» перед «?») — иначе
        // порт разбирался как «port/» → toIntOrNull()==null → откат на 443. Как в sub.rs.
        val hostPort = (if (at >= 0) beforeQuery.substring(at + 1) else beforeQuery).substringBefore('/')
        // IPv6 в квадратных скобках: [::1]:443
        val end = hostPort.lastIndexOf(']')
        val host: String
        val portText: String
        if (end >= 0) {
            host = hostPort.substring(0, end + 1).trim('[', ']')
            portText = hostPort.substring(end + 1).trimStart(':')
        } else {
            val colon = hostPort.lastIndexOf(':')
            if (colon >= 0) {
                host = hostPort.substring(0, colon)
                portText = hostPort.substring(colon + 1)
            } else {
                host = hostPort
                portText = "443"
            }
        }
        val query = queryRaw.split("&").filter { it.isNotEmpty() }.mapNotNull { kv ->
            val i = kv.indexOf('=')
            if (i <= 0) null else kv.substring(0, i) to dec(kv.substring(i + 1))
        }.toMap()
        return Uri(user, host, port(portText), query, frag)
    }

    /** Транспорт и маскировка — общая часть для vless и trojan. */
    private fun applyTransport(m: MutableMap<String, Any?>, u: Uri) {
        // splithttp — прежнее имя XHTTP в Xray; движок знает его только как xhttp.
        val net = u.q("type").ifEmpty { "tcp" }.let { if (it == "splithttp") "xhttp" else it }
        m["network"] = net
        when (net) {
            "ws" -> {
                val ws = linkedMapOf<String, Any?>("path" to u.q("path").ifEmpty { "/" })
                val host = u.q("host")
                if (host.isNotEmpty()) ws["headers"] = linkedMapOf<String, Any?>("Host" to host)
                m["ws-opts"] = ws
            }
            "grpc" -> m["grpc-opts"] = linkedMapOf<String, Any?>().apply {
                putIfNotEmpty("grpc-service-name", u.q("serviceName"))
            }
            "http" -> m["http-opts"] = linkedMapOf<String, Any?>("path" to listOf(u.q("path").ifEmpty { "/" }))
            "xhttp" -> {
                // Без пути, хоста и режима движок стучится в «/», а сервер ждёт свой путь:
                // 30.09.2026 все 23 XHTTP-сервера резервного пула поэтому не работали, с
                // этими параметрами — 22 из 23. XHTTP режет трафик на короткие запросы и
                // проходит там, где долгие соединения замирают (белые списки МТС).
                m["xhttp-opts"] = linkedMapOf<String, Any?>("path" to u.q("path").ifEmpty { "/" }).apply {
                    putIfNotEmpty("host", u.q("host"))
                    putIfNotEmpty("mode", u.q("mode"))
                }
                // Режим stream-one работает поверх HTTP/2 — alpn из ссылки передаём как есть.
                val alpn = u.q("alpn").split(",").map { it.trim() }.filter { it.isNotEmpty() }
                if (alpn.isNotEmpty()) m["alpn"] = alpn
            }
        }
        val sni = u.q("sni").ifEmpty { u.q("host") }
        when (u.q("security")) {
            "reality" -> {
                m["tls"] = true
                if (sni.isNotEmpty()) m["servername"] = sni
                m["client-fingerprint"] = u.q("fp").ifEmpty { "chrome" }
                val r = linkedMapOf<String, Any?>()
                r.putIfNotEmpty("public-key", u.q("pbk"))
                r.putIfNotEmpty("short-id", u.q("sid"))
                m["reality-opts"] = r
            }
            "tls", "xtls" -> {
                m["tls"] = true
                if (sni.isNotEmpty()) m["servername"] = sni
                if (u.q("fp").isNotEmpty()) m["client-fingerprint"] = u.q("fp")
                // allowInsecure из ссылки НЕ переносим в skip-cert-verify: отключать
                // проверку сертификата по данным из недоверенной подписки нельзя — это
                // открывает MITM внешнего TLS туннеля, и авто-ревью Google флагует
                // отключение проверки сертификата из внешнего входа. Для REALITY (свой
                // pbk-пиннинг) поле и не нужно, а для обычного TLS оно опасно.
            }
        }
    }

    private fun parseVless(link: String): Node? {
        val u = splitUri(link, "vless://") ?: return null
        if (u.user.isEmpty() || u.host.isEmpty()) return null
        val name = u.frag.ifEmpty { u.host }
        val m = linkedMapOf<String, Any?>(
            "name" to name, "type" to "vless", "server" to u.host, "port" to u.port,
            "uuid" to u.user, "udp" to true,
        )
        if (u.q("flow").isNotEmpty()) m["flow"] = u.q("flow")
        applyTransport(m, u)
        return Node(name, m)
    }

    private fun parseTrojan(link: String): Node? {
        val u = splitUri(link, "trojan://") ?: return null
        if (u.user.isEmpty() || u.host.isEmpty()) return null
        val name = u.frag.ifEmpty { u.host }
        val m = linkedMapOf<String, Any?>(
            "name" to name, "type" to "trojan", "server" to u.host, "port" to u.port,
            "password" to u.user, "udp" to true,
            // У trojan шифрование обязательно, даже если в ссылке про него не сказано.
            "tls" to true,
        )
        applyTransport(m, u)
        return Node(name, m)
    }

    private fun parseVmess(link: String): Node? {
        val body = link.removePrefix("vmess://")
        if (body == link) return null
        val cleaned = body.filterNot { it.isWhitespace() }.trimEnd('=')
        val text = listOf(Base64.getDecoder(), Base64.getUrlDecoder()).firstNotNullOfOrNull { d ->
            runCatching { String(d.decode(cleaned), Charsets.UTF_8) }.getOrNull()
        } ?: return null
        val v = runCatching { json.parseToJsonElement(text.trim()) as? JsonObject }.getOrNull() ?: return null
        fun g(k: String): String = when (val e = v[k]) {
            is JsonPrimitive -> e.contentOrNull.orEmpty()
            else -> ""
        }
        val host = g("add")
        if (host.isEmpty()) return null
        val name = g("ps").ifEmpty { host }
        val m = linkedMapOf<String, Any?>(
            "name" to name, "type" to "vmess", "server" to host,
            "port" to port(g("port")),
            "uuid" to g("id"),
            "alterId" to (g("aid").toIntOrNull() ?: 0),
            "cipher" to g("scy").ifEmpty { "auto" },
            "udp" to true,
        )
        val net = g("net")
        m["network"] = net.ifEmpty { "tcp" }
        if (g("tls") == "tls") {
            m["tls"] = true
            val sni = g("sni").ifEmpty { g("host") }
            if (sni.isNotEmpty()) m["servername"] = sni
        }
        if (net == "ws") {
            val ws = linkedMapOf<String, Any?>("path" to g("path").ifEmpty { "/" })
            if (g("host").isNotEmpty()) ws["headers"] = linkedMapOf<String, Any?>("Host" to g("host"))
            m["ws-opts"] = ws
        }
        return Node(name, m)
    }

    private fun parseSs(link: String): Node? {
        val rest = link.removePrefix("ss://")
        if (rest == link) return null
        val (bodyRaw, frag) = rest.split("#", limit = 2).let { it[0] to (it.getOrNull(1)?.let(::dec) ?: "") }
        val body = bodyRaw.substringBefore('?')

        // Две записи в ходу: base64(method:pass)@host:port и base64(всё целиком).
        val at = body.lastIndexOf('@')
        val method: String; val password: String; val host: String; val port: String
        if (at >= 0) {
            val cred = body.substring(0, at)
            // SIP002: ss://base64(method:pass)@host:port/?plugin=... — срезаем путь «/…»,
            // иначе порт разбирался как «port/» и падал в 443. Как в sub.rs.
            val hostPort = body.substring(at + 1).substringBefore('/')
            val decoded = ssUserInfo(cred) ?: return null
            val ci = decoded.indexOf(':'); if (ci < 0) return null
            val hi = hostPort.lastIndexOf(':'); if (hi < 0) return null
            method = decoded.substring(0, ci); password = decoded.substring(ci + 1)
            host = hostPort.substring(0, hi); port = hostPort.substring(hi + 1)
        } else {
            val decoded = decodeB64Any(dec(body)) ?: return null
            val ai = decoded.lastIndexOf('@'); if (ai < 0) return null
            val cred = decoded.substring(0, ai); val hostPort = decoded.substring(ai + 1)
            val ci = cred.indexOf(':'); if (ci < 0) return null
            val hi = hostPort.lastIndexOf(':'); if (hi < 0) return null
            method = cred.substring(0, ci); password = cred.substring(ci + 1)
            host = hostPort.substring(0, hi); port = hostPort.substring(hi + 1)
        }
        val name = frag.ifEmpty { host }
        val m = linkedMapOf<String, Any?>(
            "name" to name, "type" to "ss", "server" to host,
            "port" to port(port),
            "cipher" to method, "password" to password, "udp" to true,
        )
        return Node(name, m)
    }

    /**
     * userinfo ссылки ss://. По SIP002 это base64 от «method:pass» — и обычный, и
     * URL-безопасный («-», «_»: так экспортирует shadowsocks-android). Для шифров 2022
     * (SIP022) — открытый «method:pass» с percent-кодированием: ключ «KEY=» приходит как
     * «KEY%3D». Раньше URL-безопасный base64 не разбирался (узел выпадал), а %-коды
     * уходили в движок как есть — пароль не совпадал.
     */
    private fun ssUserInfo(cred: String): String? {
        val plain = dec(cred)
        // В base64 двоеточия не бывает: есть «:» — значит, userinfo открытый.
        if (plain.contains(':')) return plain
        return decodeB64Any(plain)
    }

    /** base64 в обоих алфавитах и без выравнивания — как у vmess. */
    private fun decodeB64Any(s: String): String? {
        val cleaned = s.filterNot { it.isWhitespace() }.trimEnd('=')
        return listOf(Base64.getDecoder(), Base64.getUrlDecoder()).firstNotNullOfOrNull { d ->
            runCatching { String(d.decode(cleaned), Charsets.UTF_8) }.getOrNull()
        }
    }

    /** Xray-JSON: так отдаёт подписка NoVPN — массив полных конфигов, из каждого
     *  берём основной исходящий канал. */
    private fun fromXrayJson(v: JsonElement): List<Node> {
        val configs: List<JsonElement> = when (v) {
            is JsonArray -> v.toList()
            else -> listOf(v)
        }
        val out = mutableListOf<Node>()
        for (cfgEl in configs) {
            val cfg = cfgEl as? JsonObject ?: continue
            val remark = (cfg["remarks"] as? JsonPrimitive)?.contentOrNull ?: "Сервер"
            val obs = (cfg["outbounds"] as? JsonArray) ?: continue
            for (obEl in obs) {
                val ob = obEl as? JsonObject ?: continue
                if ((ob["protocol"] as? JsonPrimitive)?.contentOrNull != "vless") continue
                val vnext = (ob["settings"] as? JsonObject)?.get("vnext")?.let { it as? JsonArray }
                    ?.firstOrNull() as? JsonObject ?: continue
                val address = (vnext["address"] as? JsonPrimitive)?.contentOrNull.orEmpty()
                // Клэмп 1..65535 (как desktop): 0/переполнение → 443, иначе линк вёл бы себя
                // по-разному на Android и десктопе.
                val port = ((vnext["port"] as? JsonPrimitive)?.intOrNull ?: 443).let { if (it in 1..65535) it else 443 }
                val user = (vnext["users"] as? JsonArray)?.firstOrNull() as? JsonObject
                val uuid = (user?.get("id") as? JsonPrimitive)?.contentOrNull.orEmpty()
                if (address.isEmpty() || uuid.isEmpty()) continue
                val st = ob["streamSettings"] as? JsonObject

                // Служебные поля панели: по profileId клиент сопоставляет конфиг с meta.json
                // (у умного и полного профиля одного сервера host общий).
                val profile = ((cfg["meta"] as? JsonObject)?.get("novpn") as? JsonObject)?.let { nv ->
                    fun g(k: String) = (nv[k] as? JsonPrimitive)?.contentOrNull.orEmpty()
                    val pid = g("profileId")
                    if (pid.isEmpty()) null
                    else NodeProfile(pid, g("serverId"), g("host"), if (g("mode") == "full") "full" else "smart")
                }
                // Панель подписывает профиль («Франция · Умная маршрутизация») для телефонных
                // приложений; здесь режим виден по тумблеру, поэтому хвост отбрасываем.
                val name = if (profile != null) stripProfileSuffix(cleanName(remark)) else cleanName(remark)

                val m = linkedMapOf<String, Any?>(
                    "name" to name, "type" to "vless", "server" to address, "port" to port,
                    "uuid" to uuid, "udp" to true,
                )
                val net = (st?.get("network") as? JsonPrimitive)?.contentOrNull ?: "tcp"
                m["network"] = net
                (user?.get("flow") as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }?.let { m["flow"] = it }

                val rs = st?.get("realitySettings") as? JsonObject
                if (rs != null) {
                    m["tls"] = true
                    (rs["serverName"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
                        ?.let { m["servername"] = it }
                    m.putIfNotEmpty(
                        "client-fingerprint",
                        (rs["fingerprint"] as? JsonPrimitive)?.contentOrNull?.ifEmpty { null } ?: "chrome",
                    )
                    val r = linkedMapOf<String, Any?>()
                    r.putIfNotEmpty("public-key", (rs["publicKey"] as? JsonPrimitive)?.contentOrNull)
                    r.putIfNotEmpty("short-id", (rs["shortId"] as? JsonPrimitive)?.contentOrNull)
                    m["reality-opts"] = r
                } else if ((st?.get("security") as? JsonPrimitive)?.contentOrNull == "tls") {
                    m["tls"] = true
                    ((st["tlsSettings"] as? JsonObject)?.get("serverName") as? JsonPrimitive)
                        ?.contentOrNull?.takeIf { it.isNotEmpty() }?.let { m["servername"] = it }
                }
                out += Node(name, m, profile)
                break // из профиля берём только основной канал
            }
        }
        return dedupeNames(out)
    }

    /** Приписка профиля панели («… · Умная маршрутизация») — не часть имени сервера. */
    private fun stripProfileSuffix(name: String): String = name.split(" · ")[0].trim()

    /** Имена в подписках украшены эмодзи и хвостами вроде «| Обход белых списков».
        Ведущие значки-эмодзи (флаг страны + значок сервера, панель ставит их
        осмысленно: «🇳🇱🚀 Нидерланды», «🏠 HomeVPN») СОХРАНЯЕМ — раньше фильтр срезал
        их все, значок сервера терялся, а флаг приходилось угадывать по названию.
        Чистим только текстовую часть после ведущих значков. */
    private fun cleanName(raw: String): String {
        val head = raw.substringBefore('|')
        val prefixEnd = run {
            var i = 0
            while (i < head.length) {
                val cp = head.codePointAt(i)
                if (cp >= 0x2600 || cp == 0xFE0F || cp == 0x200D || cp == 0x20E3) {
                    i += Character.charCount(cp)
                } else break
            }
            i
        }
        val prefix = head.substring(0, prefixEnd).trim()
        val restRaw = head.substring(prefixEnd).filter { it.isLetterOrDigit() || it in " -_#.·" }
        val rest = restRaw.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        val name = listOf(prefix, rest).filter { it.isNotEmpty() }.joinToString(" ")
        return name.ifEmpty { "Сервер" }
    }

    /** Профили из подписки: id → профиль (для сопоставления с meta.json). */
    fun profilesOf(parsed: Parsed): List<NodeProfile> = when (parsed) {
        is Parsed.Nodes -> parsed.nodes.mapNotNull { it.profile }
        is Parsed.Clash -> emptyList()
    }
}
