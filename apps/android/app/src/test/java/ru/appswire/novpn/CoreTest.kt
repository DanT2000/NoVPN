package ru.appswire.novpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.yaml.snakeyaml.Yaml
import ru.appswire.novpn.core.Config
import ru.appswire.novpn.core.DomainRule
import ru.appswire.novpn.core.ListsParser
import ru.appswire.novpn.core.Meta
import ru.appswire.novpn.core.Rules
import ru.appswire.novpn.core.Sub
import ru.appswire.novpn.core.deniedHuman

/**
 * Контрактные тесты клиента. Повторяют тесты десктопа (`core.rs`, `sub.rs`,
 * `meta.rs`): оба клиента обязаны понимать подписку и собирать правила одинаково,
 * иначе один и тот же сайт на телефоне и на компьютере пойдёт разными путями.
 */
class CoreTest {

    // ── meta.json ──

    @Test
    fun `адрес meta выводится из любой формы подписки`() {
        assertEquals("https://vpn.example/sub/TOKEN/meta.json", Meta.metaUrl("https://vpn.example/sub/TOKEN"))
        assertEquals("https://vpn.example/sub/TOKEN/meta.json", Meta.metaUrl("https://vpn.example/sub/TOKEN/full"))
        assertEquals(
            "https://vpn.example/sub/TOKEN/meta.json",
            Meta.metaUrl("https://vpn.example/sub/TOKEN/server/s_1/full?profile=full"),
        )
        assertNull(Meta.metaUrl("https://other.example/api/v1/client/subscribe?token=x"))
        assertNull(Meta.metaUrl("not a url"))
    }

    @Test
    fun `профиль без routing считается умным`() {
        val m = Meta.parse("""{"schemaVersion":1,"profiles":[{"profileId":"s1","host":"h"}]}""")
        assertEquals("smart", m.profiles[0].mode)
        assertFalse(m.unsupported)
        assertTrue(Meta.parse("""{"schemaVersion":99,"profiles":[]}""").unsupported)
    }

    // ── подписка ──

    @Test
    fun `ссылка vless разбирается в точку для движка`() {
        val link = "vless://11111111-2222-3333-4444-555555555555@1.vpn.example:443" +
            "?type=tcp&security=reality&pbk=PUBKEY&sid=ab12&fp=chrome&sni=cdn.example&flow=xtls-rprx-vision#Франция"
        val parsed = Sub.parse(link)
        val nodes = (parsed as Sub.Parsed.Nodes).nodes
        assertEquals(1, nodes.size)
        val m = nodes[0].map
        assertEquals("vless", m["type"])
        assertEquals("1.vpn.example", m["server"])
        assertEquals(443, m["port"])
        assertEquals("xtls-rprx-vision", m["flow"])
        assertEquals(true, m["tls"])
        assertEquals("cdn.example", m["servername"])
        @Suppress("UNCHECKED_CAST")
        val reality = m["reality-opts"] as Map<String, Any?>
        assertEquals("PUBKEY", reality["public-key"])
        assertEquals("ab12", reality["short-id"])
        assertEquals("Франция", nodes[0].name)
    }

    @Test
    fun `xray-json панели даёт профиль и имя без приписки режима`() {
        val json = """
        [{"remarks":"🇫🇷 Франция · Умная маршрутизация",
          "meta":{"novpn":{"profileId":"p1","serverId":"s1","host":"1.vpn.example","mode":"smart"}},
          "outbounds":[{"protocol":"vless","settings":{"vnext":[{"address":"1.vpn.example","port":443,
            "users":[{"id":"uuid-1","flow":"xtls-rprx-vision"}]}]},
            "streamSettings":{"network":"tcp","realitySettings":{"serverName":"cdn.example","publicKey":"PK","shortId":"s1"}}}]}]
        """.trimIndent()
        val nodes = (Sub.parse(json) as Sub.Parsed.Nodes).nodes
        assertEquals(1, nodes.size)
        assertEquals("Франция", nodes[0].name)
        assertEquals("p1", nodes[0].profile?.profileId)
        assertEquals("smart", nodes[0].profile?.mode)
    }

    @Test
    fun `одинаковые имена в подписке разводятся`() {
        val links = """
            vless://u1@a.example:443#Сервер
            vless://u2@b.example:443#Сервер
        """.trimIndent()
        val nodes = (Sub.parse(links) as Sub.Parsed.Nodes).nodes
        assertEquals(listOf("Сервер", "Сервер #2"), nodes.map { it.name })
    }

    // ── правила ──

    private fun rulesOf(r: Rules, hosts: List<String> = listOf("1.vpn.example")) = Config.buildRules(r, hosts)

    @Test
    fun `адрес сервера идёт напрямую первым — иначе петля`() {
        val out = rulesOf(Rules())
        assertEquals("DOMAIN,1.vpn.example,DIRECT", out.first())
    }

    @Test
    fun `quic режется в обоих режимах`() {
        assertTrue(rulesOf(Rules()).any { it.contains("REJECT") })
        assertTrue(rulesOf(Rules(smart = false)).any { it.contains("REJECT") })
    }

    @Test
    fun `правило человека сильнее обхода локальной сети`() {
        val out = rulesOf(
            Rules(
                bypassLocal = true,
                userDomains = listOf(DomainRule("myhost.corp", vpn = true)),
            ),
        )
        val user = out.indexOfFirst { it == "DOMAIN-SUFFIX,myhost.corp,${Config.GROUP}" }
        val bypass = out.indexOfFirst { it == "DOMAIN-SUFFIX,corp,DIRECT" }
        assertTrue("правило человека должно стоять раньше обхода", user in 0 until bypass)
    }

    @Test
    fun `полный VPN не содержит исключений из списков и заканчивается группой`() {
        val out = rulesOf(
            Rules(
                smart = false,
                listVpnDomains = listOf("youtube.com"),
                listDirectDomains = listOf("gosuslugi.ru"),
            ),
        )
        assertEquals("MATCH,${Config.GROUP}", out.last())
        assertFalse(out.any { it.contains("youtube.com") })
        assertFalse(out.any { it.contains("gosuslugi.ru") })
        // Локальные подсети всё равно напрямую: домашняя сеть рваться не должна.
        assertTrue(out.any { it == "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve" })
    }

    @Test
    fun `умный режим заканчивается прямым маршрутом`() {
        assertEquals("MATCH,DIRECT", rulesOf(Rules()).last())
    }

    @Test
    fun `lanAccess убирает прямые правила для локальных подсетей`() {
        assertFalse(rulesOf(Rules(lanAccess = true)).any { it.contains("192.168.0.0/16") })
        assertTrue(rulesOf(Rules(lanAccess = false)).any { it.contains("192.168.0.0/16") })
    }

    @Test
    fun `кривые записи не попадают в правила`() {
        assertNull(Config.cleanDomain("не домен"))
        assertNull(Config.cleanDomain("a,b.com"))
        assertNull(Config.cleanDomain("localhost"))
        assertEquals("example.com", Config.cleanDomain("HTTPS://WWW.Example.com/path?x=1"))
        val out = rulesOf(Rules(listVpnRegex = listOf("[невалидный", "^ok\\..*")))
        assertTrue(out.any { it.contains("^ok\\..*") })
        assertFalse(out.any { it.contains("[невалидный") })
    }

    // ── конфиг целиком ──

    @Test
    fun `конфиг разбирается обратно и описывает туннель на дескрипторе`() {
        val parsed = Sub.parse("vless://u1@1.vpn.example:443#Франция")
        val yaml = Config.build(parsed, Rules(), selected = "Франция", tunFd = 3, secret = "deadbeef")
        // Проверяем не подстроки, а результат разбора: движок читает YAML, а не текст.
        @Suppress("UNCHECKED_CAST")
        val root = Yaml().load<Map<String, Any?>>(yaml)

        val tun = root["tun"] as Map<*, *>
        assertEquals(3, tun["file-descriptor"])
        assertEquals(true, tun["enable"])
        assertEquals(false, tun["auto-route"])
        assertEquals(false, tun["auto-detect-interface"])
        assertEquals(Config.MTU, tun["mtu"])
        assertEquals("deadbeef", root["secret"])
        // Правила по процессам на Android не работают — движок не должен их искать.
        assertEquals("off", root["find-process-mode"])

        val groups = root["proxy-groups"] as List<*>
        val own = groups[0] as Map<*, *>
        assertEquals(Config.GROUP, own["name"])
        assertEquals("Франция", (own["proxies"] as List<*>)[0])
    }

    @Test
    fun `системные dns подставляются вместо system`() {
        val parsed = Sub.parse("vless://u1@1.vpn.example:443#Ф")
        val yaml = Config.build(
            parsed,
            Rules(systemDns = listOf("192.168.1.1"), listDirectDomains = listOf("gosuslugi.ru")),
            selected = null,
            tunFd = 3,
        )
        @Suppress("UNCHECKED_CAST")
        val root = Yaml().load<Map<String, Any?>>(yaml)
        val dns = root["dns"] as Map<*, *>
        val policy = dns["nameserver-policy"] as Map<*, *>
        assertEquals(listOf("192.168.1.1"), policy["+.gosuslugi.ru"])
        assertEquals(listOf("192.168.1.1"), dns["default-nameserver"])
        // Значение system на Android не работает: движку там читать нечего.
        assertFalse(policy.values.any { it == "system" })
    }

    // ── списки ──

    @Test
    fun `грамматика upstream разносит записи по видам`() {
        val b = ListsParser.Builder()
        listOf(
            "example.com",
            "full:exact.example",
            "keyword:tracker",
            "regexp:^ads\\..*",
            "regexp:[кривой",
            "1.2.3.4",
            "10.0.0.0/8",
            "2001:db8::1",
        ).forEach { ListsParser.absorbUpstreamItem(it, b) }
        val l = b.build(null, null, null)
        assertEquals(listOf("example.com"), l.vpnDomains)
        assertEquals(listOf("exact.example"), l.vpnFull)
        assertEquals(listOf("tracker"), l.vpnKeywords)
        assertEquals(listOf("^ads\\..*"), l.vpnRegex)
        assertEquals(listOf("1.2.3.4/32", "10.0.0.0/8", "2001:db8::1/128"), l.vpnIps)
    }

    @Test
    fun `объектные записи с маршрутом direct попадают в прямые`() {
        val l = ListsParser.parse("""{"items":[{"domain":"gosuslugi.ru","route":"direct"},{"domain":"youtube.com","route":"vpn"}]}""")
        assertEquals(listOf("gosuslugi.ru"), l.directDomains)
        assertEquals(listOf("youtube.com"), l.vpnDomains)
    }

    @Test
    fun `пустой ответ за список не принимается`() {
        assertFalse(ListsParser.looksLikeList("[]"))
        assertFalse(ListsParser.looksLikeList("""{"detail":"not found"}"""))
        assertTrue(ListsParser.looksLikeList("""{"items":["a.com"]}"""))
    }

    // ── проверки под находки сверки с десктопом ──

    @Test
    fun `литерал адреса не путается с доменом и не уходит в резолвер`() {
        assertTrue(Config.isIpv4Literal("203.0.113.7"))
        assertFalse(Config.isIpv4Literal("1.2.3"))
        assertFalse(Config.isIpv4Literal("1.2.3.4.5"))
        assertFalse(Config.isIpv4Literal("1.2.3.256"))
        assertTrue(Config.isIpv6Literal("2001:db8::1"))
        assertTrue(Config.isIpv6Literal("::1"))
        assertFalse(Config.isIpv6Literal("1:2:3:4:5:6:7:8:9:10"))
        assertFalse(Config.isIpv6Literal("example.com"))
    }

    @Test
    fun `анти-петля для адресов сервера даёт корректную маску`() {
        assertEquals(
            "IP-CIDR,203.0.113.7/32,DIRECT,no-resolve",
            Config.buildRules(Rules(), listOf("203.0.113.7")).first(),
        )
        assertEquals(
            "IP-CIDR,2001:db8::1/128,DIRECT,no-resolve",
            Config.buildRules(Rules(), listOf("2001:db8::1")).first(),
        )
        assertEquals("DOMAIN,1.2.3.4.5,DIRECT", Config.buildRules(Rules(), listOf("1.2.3.4.5")).first())
    }

    @Test
    fun `анти-петля работает и в полном режиме, и выше правил человека`() {
        val full = Config.buildRules(Rules(smart = false), listOf("1.vpn.example"))
        assertEquals("DOMAIN,1.vpn.example,DIRECT", full.first())
        val smart = Config.buildRules(
            Rules(userDomains = listOf(DomainRule("1.vpn.example", vpn = true))),
            listOf("1.vpn.example"),
        )
        assertEquals("DOMAIN,1.vpn.example,DIRECT", smart.first())
    }

    @Test
    fun `регэкспы не по силам движку отбрасываются`() {
        assertFalse(Config.safeRegex("^(?=.*ad).*"))
        assertFalse(Config.safeRegex("(a)\\1"))
        assertFalse(Config.safeRegex("a,b"))
        assertTrue(Config.safeRegex("^ads\\..*"))
        val b = ListsParser.Builder()
        ListsParser.absorbUpstreamItem("regexp:^(?=.*ad).*", b)
        ListsParser.absorbUpstreamItem("regexp:^ok\\..*", b)
        assertEquals(listOf("^ok\\..*"), b.build(null, null, null).vpnRegex)
    }

    @Test
    fun `битые адреса и маски не попадают в список`() {
        val b = ListsParser.Builder()
        listOf("1:2:3:4:5:6:7:8:9:10", "1.2.3.4/-1", "1.2.3.4/33", "10.0.0.0/8").forEach {
            ListsParser.absorbUpstreamItem(it, b)
        }
        val l = b.build(null, null, null)
        assertEquals(listOf("10.0.0.0/8"), l.vpnIps)
        assertFalse(Config.buildRules(Rules(listVpnIps = l.vpnIps), emptyList()).any { it.contains("-1") })
    }

    @Test
    fun `плюс в имени сервера остаётся плюсом`() {
        val nodes = (Sub.parse("vless://u1@a.example:443#RU+Moscow") as Sub.Parsed.Nodes).nodes
        assertEquals("RU+Moscow", nodes[0].name)
    }

    @Test
    fun `негодный порт откатывается на 443`() {
        val nodes = (Sub.parse("vless://u1@a.example:99999#Х") as Sub.Parsed.Nodes).nodes
        assertEquals(443, nodes[0].map["port"])
    }

    @Test
    fun `пустые значения в точку подключения не пишутся`() {
        val nodes = (Sub.parse("vless://u1@a.example:443?type=grpc&security=reality#Х") as Sub.Parsed.Nodes).nodes
        @Suppress("UNCHECKED_CAST")
        val grpc = nodes[0].map["grpc-opts"] as Map<String, Any?>
        assertTrue(grpc.isEmpty())
        @Suppress("UNCHECKED_CAST")
        val reality = nodes[0].map["reality-opts"] as Map<String, Any?>
        assertFalse(reality.containsKey("public-key"))
    }

    @Test
    fun `из чужого clash-конфига берём только точки и группы`() {
        val yaml = """
            mixed-port: 7890
            listeners:
              - name: open
                type: socks
                listen: 0.0.0.0
                port: 1080
            proxies:
              - { name: A, type: ss, server: a.example, port: 443, cipher: aes-128-gcm, password: p }
        """.trimIndent()
        val parsed = Sub.parse(yaml) as Sub.Parsed.Clash
        assertEquals(setOf("proxies"), parsed.root.keys)
        val out = Config.build(parsed, Rules(), selected = "A", tunFd = 3)
        assertFalse("чужие слушатели в конфиг не попадают", out.contains("listeners"))
    }

    @Test
    fun `в туннельном режиме локальный прокси выключен`() {
        val parsed = Sub.parse("vless://u1@a.example:443#Х")
        val withTun = Yaml().load<Map<String, Any?>>(Config.build(parsed, Rules(), selected = null, tunFd = 3))
        assertEquals(0, withTun["mixed-port"])
        val noTun = Yaml().load<Map<String, Any?>>(Config.build(parsed, Rules(), selected = null, tunFd = null))
        assertEquals(Config.MIXED_PORT, noTun["mixed-port"])
    }

    @Test
    fun `свой DNS разбирается, мусор откатывается на cloudflare`() {
        val parsed = Sub.parse("vless://u1@a.example:443#Х")
        fun ns(provider: String): List<*> {
            val root = Yaml().load<Map<String, Any?>>(
                Config.build(parsed, Rules(dnsProvider = provider), selected = null, tunFd = 3),
            )
            return (root["dns"] as Map<*, *>)["nameserver"] as List<*>
        }
        assertEquals(listOf("https://dns.google/dns-query", "https://8.8.8.8/dns-query"), ns("google"))
        assertEquals(listOf("https://a.example/dns-query", "1.1.1.1"), ns("https://a.example/dns-query, 1.1.1.1"))
        assertTrue(ns("   ").first().toString().contains("1.1.1.1"))
    }

    @Test
    fun `строгий private dns не понижается до открытого резолвера`() {
        val parsed = Sub.parse("vless://u1@a.example:443#Х")
        val root = Yaml().load<Map<String, Any?>>(
            Config.build(
                parsed,
                Rules(systemDns = listOf("tls://dns.adguard.com"), listDirectDomains = listOf("gosuslugi.ru")),
                selected = null,
                tunFd = 3,
            ),
        )
        val dns = root["dns"] as Map<*, *>
        assertEquals(listOf("tls://dns.adguard.com"), (dns["nameserver-policy"] as Map<*, *>)["+.gosuslugi.ru"])
        assertFalse(dns.containsKey("default-nameserver"))
    }

    @Test
    fun `причины отказа панели человеческие`() {
        assertTrue(deniedHuman("disabled").contains("отключён"))
        assertTrue(deniedHuman("expired").contains("истёк"))
        assertTrue(deniedHuman("traffic").contains("трафика"))
        assertTrue(deniedHuman("not_found").contains("недействительна"))
    }

    @Test
    fun `адрес панели выводится из ссылки-подписки`() {
        assertEquals("https://vpn.example", Meta.baseOf("https://vpn.example/sub/T/full"))
        assertEquals("https://vpn.example", Meta.baseOf("https://vpn.example"))
        assertNull(Meta.baseOf("не ссылка"))
    }

    @Test
    fun `vmess и base64-список разбираются`() {
        val payload = "{" +
            "\"add\":\"a.example\",\"port\":\"443\",\"id\":\"uuid-1\"," +
            "\"ps\":\"Точка\",\"net\":\"ws\",\"tls\":\"tls\",\"path\":\"/ws\"}"
        val vmess = "vmess://" + java.util.Base64.getEncoder().encodeToString(payload.toByteArray())
        val nodes = (Sub.parse(vmess) as Sub.Parsed.Nodes).nodes
        assertEquals("vmess", nodes[0].map["type"])
        assertEquals("Точка", nodes[0].name)
        @Suppress("UNCHECKED_CAST")
        val ws = nodes[0].map["ws-opts"] as Map<String, Any?>
        assertEquals("/ws", ws["path"])

        val links = "vless://u1@a.example:443#A" + "\n" + "vless://u2@b.example:443#B"
        val list = java.util.Base64.getEncoder().encodeToString(links.toByteArray())
        assertEquals(2, (Sub.parse(list) as Sub.Parsed.Nodes).nodes.size)
    }

    @Test
    fun `мусор вместо подписки даёт понятную ошибку`() {
        val e = runCatching { Sub.parse("это не подписка") }.exceptionOrNull()
        assertTrue(e is IllegalArgumentException)
        assertTrue(e!!.message!!.contains("разобрать"))
    }

    @Test
    fun `в каждом правиле ровно три поля — запятая не просочилась`() {
        val out = Config.buildRules(
            Rules(
                userDomains = listOf(DomainRule("a,b.example", vpn = true), DomainRule("ok.example", vpn = true)),
                listVpnKeywords = listOf("хорошее", "пло хое", "с,запятой"),
                listDirectDomains = listOf("gosuslugi.ru"),
            ),
            listOf("1.vpn.example"),
        )
        for (rule in out) {
            // MATCH,<цель> и составное AND-правило устроены иначе — они не про шаблон.
            if (rule.startsWith("AND,") || rule.startsWith("MATCH,")) continue
            val parts = rule.split(",")
            assertTrue("кривое правило: " + rule, parts.size in 3..4)
            assertTrue("пустой шаблон: " + rule, parts[1].isNotBlank())
        }
        assertFalse(out.any { it.contains("a,b.example") })
        assertFalse(out.any { it.contains("пло хое") })
    }
}
