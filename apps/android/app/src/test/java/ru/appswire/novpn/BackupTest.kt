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
    }
}
