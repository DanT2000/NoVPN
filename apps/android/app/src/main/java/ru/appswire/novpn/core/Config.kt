package ru.appswire.novpn.core

import org.yaml.snakeyaml.DumperOptions
import org.yaml.snakeyaml.Yaml
import java.net.Inet6Address
import java.net.InetAddress

/**
 * Сборка конфига mihomo — порт `apps/desktop/src-tauri/src/core.rs`.
 *
 * Порядок правил здесь — не косметика. Mihomo применяет первое совпавшее,
 * поэтому порядок и есть приоритет:
 *
 *   1. домены, заданные человеком (из браузера, затем из окна);
 *   2. домены «напрямую» из списков;
 *   3. домены «через VPN» из списков.
 *
 * Пункт 1 выше всего, потому что решение человека не должен отменять никакой
 * подгруженный список.
 */
object Config {

    const val GROUP = "NoVPN"

    /** Дескриптор, на котором движок получает туннель (см. spawn.c). */
    const val TUN_FD = 3

    /** MTU туннеля. Должен совпадать с тем, что задан VpnService.Builder.setMtu. */
    const val MTU = 9000

    const val MIXED_PORT = 7893
    const val CONTROLLER_PORT = 9893

    /**
     * Локальные и внутрисетевые доменные зоны. Всегда напрямую и всегда через
     * системный DNS: через туннель они не имеют смысла, а сломать доступ к
     * роутеру и домашним сервисам — верный способ разозлить человека.
     */
    val LOCAL_DOMAINS = listOf(
        "local", "lan", "home", "home.arpa", "internal",
        "intranet", "corp", "localdomain", "in-addr.arpa", "ip6.arpa",
    )

    /**
     * Собирает готовый конфиг. Если провайдер отдал свой Clash-YAML, он берётся
     * основой: его точки и группы сохраняются, подменяются только порты, DNS,
     * туннель и правила — то, чем распоряжается приложение.
     *
     * @param tunFd дескриптор туннеля от VpnService; null — движок поднимается
     *   только как локальный прокси (используется в самопроверке).
     */
    fun build(
        parsed: Sub.Parsed,
        rules: Rules,
        selected: String?,
        tunFd: Int? = TUN_FD,
        /** Токен управляющего канала. На Android к 127.0.0.1 может подключиться
         *  любое приложение устройства, поэтому канал без токена оставлять нельзя. */
        secret: String = "",
        mixedPort: Int = MIXED_PORT,
        controllerPort: Int = CONTROLLER_PORT,
    ): String {
        val root: MutableMap<String, Any?> = when (parsed) {
            is Sub.Parsed.Clash -> parsed.root
            is Sub.Parsed.Nodes -> linkedMapOf()
        }
        val names = Sub.namesOf(parsed)

        if (parsed is Sub.Parsed.Nodes) {
            root["proxies"] = parsed.nodes.map { it.map }
        }

        root["mixed-port"] = mixedPort
        root["external-controller"] = "127.0.0.1:$controllerPort"
        if (secret.isNotEmpty()) root["secret"] = secret
        root["allow-lan"] = false
        root["mode"] = "rule"
        root["log-level"] = "info"
        root["ipv6"] = false
        root["unified-delay"] = true
        // Android без root не даёт менять таблицы маршрутизации и не имеет
        // /etc/resolv.conf — движок не должен даже пытаться.
        root["find-process-mode"] = "off"

        root["dns"] = buildDns(rules)
        if (tunFd != null) root["tun"] = buildTun(tunFd)

        // Своя группа поверх чужих: приложение переключает сервер именно ею.
        val ordered = names.toMutableList()
        if (selected != null) {
            val pos = ordered.indexOf(selected)
            if (pos > 0) {
                ordered.removeAt(pos)
                ordered.add(0, selected)
            }
        }
        val group = linkedMapOf<String, Any?>(
            "name" to GROUP,
            "type" to "select",
            "proxies" to ordered,
        )
        val groups = mutableListOf<Any?>(group)
        (root["proxy-groups"] as? List<*>)?.forEach { g ->
            if ((g as? Map<*, *>)?.get("name")?.toString() != GROUP) groups += g
        }
        root["proxy-groups"] = groups

        root["rules"] = buildRules(rules, Sub.hostsOf(parsed))

        val options = DumperOptions().apply {
            defaultFlowStyle = DumperOptions.FlowStyle.BLOCK
            isPrettyFlow = true
            indent = 2
            width = 4096
            // Якоря делают конфиг нечитаемым при разборе проблем, а выигрыша нет.
            isAllowReadOnlyProperties = true
        }
        val body = Yaml(options).dump(root)
        return "# Конфиг собран приложением NoVPN и пересобирается при каждом подключении.\n" +
            "# Править вручную бессмысленно — изменения будут потеряны.\n" + body
    }

    private fun buildTun(fd: Int): Map<String, Any?> = linkedMapOf(
        "enable" to true,
        // Туннель уже создан системой: движок только берёт готовый дескриптор.
        "file-descriptor" to fd,
        // gvisor — пользовательский стек, не требует ни root, ни прав на сеть.
        "stack" to "gvisor",
        // Маршруты и «угадывание интерфейса» на Android недоступны без root:
        // маршрутизацию задаёт VpnService, исходящий интерфейс выбирает система.
        "auto-route" to false,
        "auto-detect-interface" to false,
        "auto-redirect" to false,
        "mtu" to MTU,
        // Перехват DNS обязателен: без него имя домена до правил не доходит,
        // и вся маршрутизация по доменам перестаёт работать.
        "dns-hijack" to listOf("any:53", "tcp://any:53"),
    )

    private fun buildDns(rules: Rules): Map<String, Any?> {
        val dns = linkedMapOf<String, Any?>(
            "enable" to true,
            "ipv6" to false,
            "enhanced-mode" to "fake-ip",
            "fake-ip-range" to "198.18.0.1/16",
        )
        // Фейковый IP не выдаём тому, что и так резолвится локально.
        val fakeFilter = mutableListOf("localhost", "+.localhost")
        if (rules.bypassLocal) {
            LOCAL_DOMAINS.forEach { fakeFilter += "+.${it.trimStart('.')}" }
        }
        rules.customLocal.forEach { raw ->
            val d = raw.trim().trimStart('.')
            if (d.isNotEmpty()) fakeFilter += "+.$d"
        }
        // Домены «напрямую» резолвим локальным DNS, а не зарубежным DoH: с
        // иностранной точки многие из них отдают не тот IP или закрываются.
        // Только при умной маршрутизации: в полном режиме «прямых» доменов нет.
        val directDomains: List<String> = if (rules.smart) {
            (rules.listDirectDomains + rules.userDomains.filter { !it.vpn }.map { it.domain })
                .mapNotNull(::cleanDomain)
                .distinct()
        } else emptyList()
        directDomains.forEach { fakeFilter += "+.$it" }
        dns["fake-ip-filter"] = fakeFilter

        dns["nameserver"] = nameservers(rules.dnsProvider)

        // «system» тут не годится: на Android нет /etc/resolv.conf, движок просто
        // не найдёт резолвер. Подставляем реальные адреса, полученные у системы.
        val local = rules.systemDns.filter { it.isNotBlank() }
        if (local.isNotEmpty()) {
            val policy = linkedMapOf<String, Any?>()
            if (rules.bypassLocal) LOCAL_DOMAINS.forEach { policy["+.${it.trimStart('.')}"] = local }
            rules.customLocal.forEach { raw ->
                val d = raw.trim().trimStart('.')
                if (d.isNotEmpty()) policy["+.$d"] = local
            }
            directDomains.forEach { policy["+.$it"] = local }
            if (policy.isNotEmpty()) dns["nameserver-policy"] = policy
            // Резолвер для самих DoH-серверов: без него движок не узнает их адреса.
            dns["default-nameserver"] = local
        }
        return dns
    }

    private fun nameservers(provider: String): List<String> {
        val cloudflare = listOf("https://1.1.1.1/dns-query", "https://cloudflare-dns.com/dns-query")
        return when (provider) {
            "google" -> listOf("https://dns.google/dns-query", "https://8.8.8.8/dns-query")
            "quad9" -> listOf("https://dns.quad9.net/dns-query", "https://9.9.9.9/dns-query")
            "cloudflare", "" -> cloudflare
            else -> {
                // Свой DNS: DoH-URL, tls:// или адрес. Несколько — через запятую.
                val parts = provider.split(",").map { it.trim() }
                    .filter { it.isNotEmpty() && !it.any(Char::isWhitespace) }
                parts.ifEmpty { cloudflare }
            }
        }
    }

    /**
     * Приводит домен к безопасному для правила виду: только хост, без схемы,
     * пути, пробелов и запятых. Всё, что не годится, отбрасывается — иначе одна
     * кривая запись сделает весь конфиг невалидным, и подключиться станет нельзя.
     */
    fun cleanDomain(raw: String): String? {
        var d = raw.trim().lowercase()
        val scheme = d.indexOf("://")
        if (scheme >= 0) d = d.substring(scheme + 3)
        d = d.split('/', '?', '#', ':', '@')[0]
        d = d.trim().removePrefix("www.").trim('.')
        if (d.isEmpty() || d.any { it == ',' || it == ' ' || it == '\t' } || !d.contains('.')) return null
        return d
    }

    private fun isIpLiteral(h: String): Boolean = runCatching {
        // Только литерал: InetAddress.getByName для имени полез бы в DNS, поэтому
        // сначала грубая проверка на «похоже на адрес».
        if (!h.any { it == ':' } && !h.all { it.isDigit() || it == '.' }) return false
        InetAddress.getByName(h) != null
    }.getOrDefault(false)

    private fun pushSubnets(out: MutableList<String>) {
        // Локальные подсети — напрямую ВСЕГДА и ПЕРВЫМИ.
        listOf(
            "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
            "169.254.0.0/16", "224.0.0.0/4", "255.255.255.255/32",
        ).forEach { out += "IP-CIDR,$it,DIRECT,no-resolve" }
    }

    /** Широкие DIRECT-суффиксы обхода локальной сети. */
    private fun pushLocalBypass(out: MutableList<String>, r: Rules) {
        if (r.bypassLocal) LOCAL_DOMAINS.forEach { out += "DOMAIN-SUFFIX,$it,DIRECT" }
        r.customLocal.forEach { raw -> cleanDomain(raw)?.let { out += "DOMAIN-SUFFIX,$it,DIRECT" } }
    }

    fun buildRules(r: Rules, serverHosts: List<String>): List<String> {
        val out = mutableListOf<String>()

        // Анти-петля (контракт, раздел 4): адрес самого VPN-сервера всегда
        // напрямую — иначе соединение к серверу завернулось бы в туннель к нему же.
        for (raw in serverHosts) {
            val h = raw.trim()
            if (h.isEmpty()) continue
            if (isIpLiteral(h)) {
                val mask = if (runCatching { InetAddress.getByName(h) is Inet6Address }.getOrDefault(false)) 128 else 32
                out += "IP-CIDR,$h/$mask,DIRECT,no-resolve"
            } else {
                cleanDomain(h)?.let { out += "DOMAIN,$it,DIRECT" }
            }
        }

        // QUIC (udp/443) — REJECT в обоих режимах: браузер открывает QUIC, UDP по
        // туннелю теряется, отката на TCP нет — видео «зависает».
        out += "AND,((NETWORK,udp),(DST-PORT,443)),REJECT"

        // Локальные подсети — до всего остального, по серверной политике lanAccess.
        if (!r.lanAccess) pushSubnets(out)

        if (!r.smart) {
            // «Полный VPN»: весь трафик в туннель, без доменных исключений. Но
            // локальную сеть не рвём: приватные подсети уже ушли DIRECT выше, а
            // здесь применяем обход локальных ДОМЕНОВ — доступ к NAS по имени
            // должен работать и в полном режиме.
            pushLocalBypass(out, r)
            out += "MATCH,$GROUP"
            return out
        }

        // 1. Решение человека — перед широкими суффиксами обхода локальной сети.
        for (d in r.userDomains) {
            val dom = cleanDomain(d.domain) ?: continue
            out += "DOMAIN-SUFFIX,$dom,${if (d.vpn) GROUP else "DIRECT"}"
        }

        // 2. Обход локальной сети — после явного выбора.
        pushLocalBypass(out, r)

        // 3. Списки «напрямую»: российские сервисы, которые с зарубежного адреса
        //    просто не открываются.
        for (d in r.listDirectDomains) cleanDomain(d)?.let { out += "DOMAIN-SUFFIX,$it,DIRECT" }

        // 4. Списки «через VPN» — по грамматике upstream (контракт, раздел 7).
        for (d in r.listVpnDomains) cleanDomain(d)?.let { out += "DOMAIN-SUFFIX,$it,$GROUP" }
        for (d in r.listVpnFull) cleanDomain(d)?.let { out += "DOMAIN,$it,$GROUP" }
        for (k in r.listVpnKeywords) {
            val key = k.trim().lowercase()
            if (key.isNotEmpty() && key.none { it == ',' || it == ' ' || it == '\t' }) {
                out += "DOMAIN-KEYWORD,$key,$GROUP"
            }
        }
        for (re in r.listVpnRegex) {
            // Запятая внутри регэкспа сломала бы разбор строки правила движком.
            val rx = re.trim()
            if (rx.isNotEmpty() && !rx.contains(',') && runCatching { Regex(rx) }.isSuccess) {
                out += "DOMAIN-REGEX,$rx,$GROUP"
            }
        }
        for (ip in r.listVpnIps) {
            val a = ip.trim()
            if (a.isNotEmpty() && a.none { it == ',' || it == ' ' }) out += "IP-CIDR,$a,$GROUP"
        }

        // 5. Всё неназванное идёт напрямую. Это и есть модель NoVPN.
        out += "MATCH,DIRECT"
        return out
    }
}
