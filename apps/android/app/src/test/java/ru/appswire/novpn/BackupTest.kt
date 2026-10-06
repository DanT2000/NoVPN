package ru.appswire.novpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.yaml.snakeyaml.Yaml
import ru.appswire.novpn.core.Config
import ru.appswire.novpn.core.Meta
import ru.appswire.novpn.core.Rules
import ru.appswire.novpn.core.Sub
import ru.appswire.novpn.store.DiagEntry
import ru.appswire.novpn.ui.Flags
import ru.appswire.novpn.vpn.Diag
import ru.appswire.novpn.vpn.NetDiagnosis

/**
 * Резервная маршрутизация на клиенте: разбор поля backup из meta.json, попадание
 * резервных прокси в конфиг движка (чтобы уход на резерв был одним selectProxy) и
 * классификация диагностики сети по совокупности признаков.
 */
class BackupTest {

    private val vlessMain =
        "vless://11111111-2222-3333-4444-555555555555@nl.main.example:443?type=tcp&security=reality&sni=cdn.example#Main"
    private val vlessReserve1 =
        "vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@r1.reserve.example:443?type=tcp&security=reality&sni=cdn.example#Reserve-1"
    private val vlessReserve2 =
        "vless://aaaaaaaa-bbbb-cccc-dddd-ffffffffffff@r2.reserve.example:8443?type=tcp&security=reality&sni=cdn.example#Reserve-2"

    private fun parse(vararg links: String): Sub.Parsed = Sub.parse(links.joinToString("\n"))

    @Suppress("UNCHECKED_CAST")
    private fun proxiesOf(root: Map<String, Any?>): List<Map<String, Any?>> =
        (root["proxies"] as? List<Map<String, Any?>>).orEmpty()

    @Suppress("UNCHECKED_CAST")
    private fun groupProxies(root: Map<String, Any?>): List<String> {
        val groups = root["proxy-groups"] as? List<Map<String, Any?>> ?: emptyList()
        val novpn = groups.firstOrNull { it["name"] == Config.GROUP } ?: return emptyList()
        return (novpn["proxies"] as? List<String>).orEmpty()
    }

    @Test
    fun `meta разбирает поле backup, а его отсутствие не ломает разбор`() {
        val withBackup = Meta.parse(
            """{"schemaVersion":1,"profiles":[{"profileId":"p1","host":"nl.main.example"}],
               "backup":{"available":true,"count":5,"priority":true,"sub":"https://vpn.example/sub/T/backup"}}""",
        )
        assertEquals(true, withBackup.backup?.available)
        assertEquals(5L, withBackup.backup?.count)
        assertTrue(withBackup.backup?.priority == true)

        val noBackup = Meta.parse("""{"schemaVersion":1,"profiles":[{"profileId":"p1","host":"h"}]}""")
        assertEquals(null, noBackup.backup)
    }

    @Test
    fun `резервные прокси попадают в конфиг и в группу NoVPN`() {
        val main = parse(vlessMain) as Sub.Parsed.Nodes
        val reserve = parse(vlessReserve1, vlessReserve2) as Sub.Parsed.Nodes
        val yaml = Config.build(
            parsed = main,
            rules = Rules(),
            selected = "Main",
            tunFd = 3,
            secret = "s",
            reserveProxies = reserve.nodes.map { it.map },
            reserveHosts = reserve.nodes.mapNotNull { it.map["server"]?.toString() },
        )
        val root = Yaml().load<Map<String, Any?>>(yaml)
        val names = proxiesOf(root).mapNotNull { it["name"]?.toString() }
        assertTrue("основной сервер в конфиге", names.contains("Main"))
        assertTrue("резерв 1 в конфиге", names.contains("Reserve-1"))
        assertTrue("резерв 2 в конфиге", names.contains("Reserve-2"))
        // Резерв должен быть выбираемым в группе — иначе selectProxy на него не сработает.
        val group = groupProxies(root)
        assertTrue(group.contains("Reserve-1"))
        assertTrue(group.contains("Reserve-2"))
    }

    @Test
    fun `адрес резервного сервера идёт напрямую (анти-петля)`() {
        val main = parse(vlessMain) as Sub.Parsed.Nodes
        val reserve = parse(vlessReserve1) as Sub.Parsed.Nodes
        val yaml = Config.build(
            parsed = main,
            rules = Rules(),
            selected = "Main",
            tunFd = 3,
            reserveProxies = reserve.nodes.map { it.map },
            reserveHosts = reserve.nodes.mapNotNull { it.map["server"]?.toString() },
        )
        val root = Yaml().load<Map<String, Any?>>(yaml)
        @Suppress("UNCHECKED_CAST")
        val rules = (root["rules"] as? List<String>).orEmpty()
        assertTrue(
            "адрес резерва должен идти DIRECT, иначе соединение к нему завернётся в туннель",
            rules.any { it.contains("r1.reserve.example") && it.endsWith("DIRECT") },
        )
    }

    @Test
    fun `без резерва конфиг не меняется`() {
        val main = parse(vlessMain) as Sub.Parsed.Nodes
        val yaml = Config.build(parsed = main, rules = Rules(), selected = "Main", tunFd = 3)
        val root = Yaml().load<Map<String, Any?>>(yaml)
        assertEquals(listOf("Main"), proxiesOf(root).mapNotNull { it["name"]?.toString() })
    }

    @Test
    fun `диагностика различает основные ситуации сети`() {
        // Ничего не доступно — интернета нет.
        assertEquals(NetDiagnosis.NO_INTERNET, Diag.classify(russiaUp = false, externalUp = false, novpnUp = false))
        // Всё доступно — сеть в порядке.
        assertEquals(NetDiagnosis.OK, Diag.classify(russiaUp = true, externalUp = true, novpnUp = true))
        // Внешние есть, наши серверы нет — наши недоступны.
        assertEquals(NetDiagnosis.SERVER_DOWN, Diag.classify(russiaUp = true, externalUp = true, novpnUp = false))
        // Российские есть, внешних нет — похоже на ограниченный режим (белые списки).
        assertEquals(NetDiagnosis.RESTRICTED, Diag.classify(russiaUp = true, externalUp = false, novpnUp = false))
        // Белые списки МТС (30.09.2026): соединение с нашим сервером ПРОХОДИТ, а зарубежное
        // закрыто. Это тоже белые списки, а не «всё в порядке».
        assertEquals(NetDiagnosis.RESTRICTED, Diag.classify(russiaUp = true, externalUp = false, novpnUp = true))
    }

    @Test
    fun `в журнале сегодняшнее со временем, прошлые дни с датой`() {
        val today = "2026-10-06"
        assertEquals("05:53:04", DiagEntry("2026-10-06T05:53:04", "diagnosis", "x").stamp(today))
        // Вчерашнее больше не выглядит как «сегодня в 15:43».
        assertEquals("05.10 15:43", DiagEntry("2026-10-05T15:43:18", "diagnosis", "x").stamp(today))
        // Записи без даты (старый формат) показываем как есть.
        assertEquals("12:00:00", DiagEntry("12:00:00", "info", "x").stamp(today))
    }

    @Test
    fun `одинаковые записи журнала не повторяются чаще раза в 5 минут`() {
        val diag = "Обычные серверы не пропускают трафик. Диагностика: ru=+ ext=+ novpn=+ → OK"
        val recent = listOf(
            DiagEntry("2026-10-06T01:29:05", "diagnosis", diag),
            DiagEntry("2026-10-06T01:29:05", "info", "Резервных серверов нет — восстановить нечем."),
        )
        // Через 30 с — тот же текст: повтор, не пишем (оба вида чередуются, ловим оба).
        assertTrue(DiagEntry.isRepeat(recent, "diagnosis", diag, "2026-10-06T01:29:35"))
        assertTrue(DiagEntry.isRepeat(recent, "info", "Резервных серверов нет — восстановить нечем.", "2026-10-06T01:29:35"))
        // Через 6 минут — снова пишем: видно, что состояние держится.
        assertFalse(DiagEntry.isRepeat(recent, "diagnosis", diag, "2026-10-06T01:35:10"))
        // Другой текст или вид — всегда пишем.
        assertFalse(DiagEntry.isRepeat(recent, "diagnosis", "Диагностика: ru=- ext=- novpn=- → NO_INTERNET", "2026-10-06T01:29:35"))
        assertFalse(DiagEntry.isRepeat(recent, "error", diag, "2026-10-06T01:29:35"))
    }

    @Test
    fun `российские серверы отсеиваются из аварийного пула`() {
        // В аварийных подписках попадаются чисто российские точки («YouTube без
        // рекламы», узнаются по флагу 🇷🇺). Для обхода белых списков они бесполезны:
        // из России российское ограничение не обойти — их надо выкинуть из перебора.
        val ruYoutube =
            "vless://aaaaaaaa-bbbb-cccc-dddd-000000000001@ru1.reserve.example:443?type=tcp&security=reality&sni=cdn.example#🇷🇺 YouTube без рекламы"
        val ruMoscow =
            "vless://aaaaaaaa-bbbb-cccc-dddd-000000000002@ru2.reserve.example:443?type=tcp&security=reality&sni=cdn.example#Москва-2"
        val reserve = parse(vlessReserve1, ruYoutube, vlessReserve2, ruMoscow) as Sub.Parsed.Nodes

        // Ровно то же условие, что в NoVpnService.reserveCandidates().
        val eligible = reserve.nodes.filterNot { Flags.isRussian(it.name) }.map { it.name }

        assertEquals(listOf("Reserve-1", "Reserve-2"), eligible)
        assertFalse("российский резерв не должен попасть в обход", eligible.any { it.contains("YouTube") || it.contains("Москва") })
    }

    @Test
    fun `адреса серверов резолвятся системным DNS, а не заблокированным DoH`() {
        // В сети с белыми списками DoH к 1.1.1.1:443 закрыт. Если имя сервера
        // (обычного или резервного) резолвить через DoH — движок не подключится
        // ни к одному и обход не стартует. Поэтому их адреса должны идти в
        // nameserver-policy на системный (провайдерский) DNS.
        val main = parse(vlessMain) as Sub.Parsed.Nodes // host nl.main.example
        val reserve = parse(vlessReserve1) as Sub.Parsed.Nodes // host r1.reserve.example
        val yaml = Config.build(
            parsed = main,
            rules = Rules(systemDns = listOf("10.0.0.1")),
            selected = "Main",
            tunFd = 3,
            reserveProxies = reserve.nodes.map { it.map },
            reserveHosts = reserve.nodes.mapNotNull { it.map["server"]?.toString() },
        )
        val root = Yaml().load<Map<String, Any?>>(yaml)
        val dns = root["dns"] as Map<*, *>
        val policy = dns["nameserver-policy"] as Map<*, *>
        // Первым — системный DNS; за ним допустим только обычный (не DoH) российский
        // фоллбэк 77.88.8.8 (0.2.3: вялый провайдерский DNS не должен ронять подключение).
        for ((what, host) in listOf("обычный" to "+.nl.main.example", "резервный" to "+.r1.reserve.example")) {
            val servers = policy[host] as List<*>
            assertEquals("$what сервер — сначала системный DNS", "10.0.0.1", servers.first())
            assertTrue("$what сервер — без DoH: $servers", servers.none { it.toString().contains("://") })
        }
        // И они не должны получать фейковый IP — движок дозванивается к ним по-настоящему.
        val fakeFilter = dns["fake-ip-filter"] as List<*>
        assertTrue(fakeFilter.contains("+.nl.main.example"))
        assertTrue(fakeFilter.contains("+.r1.reserve.example"))
    }
}
