package ru.appswire.novpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.appswire.novpn.core.LanRoutes
import ru.appswire.novpn.core.NetSwitch
import ru.appswire.novpn.core.NetSwitch.Action

/** Смена физической сети под туннелем и маршруты «локальная сеть напрямую». */
class NetTest {
    private val wifi = 1
    private val cell = 0

    @Test
    fun `первая сеть после подключения только запоминается`() {
        assertEquals(Action.BASELINE, NetSwitch.decide(prevNet = null, prevTransport = -1, net = 104, transport = wifi))
        // Тип прошлой сети неизвестен — тоже не повод рвать соединения.
        assertEquals(Action.BASELINE, NetSwitch.decide(prevNet = 100, prevTransport = -1, net = 104, transport = wifi))
    }

    @Test
    fun `та же сеть — ничего не делаем`() {
        // 25.10.2026: колбэк после подключения приходил с той же сетью, и каждый раз
        // сбрасывались все соединения и перезагружался конфиг движка.
        assertEquals(Action.NONE, NetSwitch.decide(prevNet = 104, prevTransport = wifi, net = 104, transport = wifi))
    }

    @Test
    fun `другая сеть того же типа — мягкий переезд`() {
        assertEquals(Action.MOVE, NetSwitch.decide(prevNet = 100, prevTransport = cell, net = 105, transport = cell))
        // Тип новой сети не распознан — не переустанавливаем туннель, только переезжаем.
        assertEquals(Action.MOVE, NetSwitch.decide(prevNet = 100, prevTransport = cell, net = 105, transport = -1))
    }

    @Test
    fun `смена типа сети — переустановка туннеля`() {
        assertEquals(Action.REESTABLISH, NetSwitch.decide(prevNet = 104, prevTransport = wifi, net = 100, transport = cell))
        assertEquals(Action.REESTABLISH, NetSwitch.decide(prevNet = 100, prevTransport = cell, net = 104, transport = wifi))
    }

    private fun covered(routes: List<Pair<String, Int>>, ip: String): Boolean {
        val a = LanRoutes.ipv4ToLong(ip)
        return routes.any { (base, len) ->
            val b = LanRoutes.ipv4ToLong(base)
            val size = 1L shl (32 - len)
            a >= b && a < b + size
        }
    }

    @Test
    fun `локальные адреса не заворачиваются в туннель`() {
        val r = LanRoutes.ipv4WithoutLan()
        for (ip in listOf(
            "10.0.0.1", "10.255.255.255", "192.168.2.5", "192.168.0.255", "172.16.0.1", "172.31.255.255",
            "169.254.10.10", "224.0.0.251", "239.255.255.250", "255.255.255.255", "240.0.0.1",
        )) assertFalse("$ip не должен идти в туннель", covered(r, ip))
    }

    @Test
    fun `весь остальной интернет идёт в туннель`() {
        val r = LanRoutes.ipv4WithoutLan()
        for (ip in listOf(
            "1.1.1.1", "8.8.8.8", "9.255.255.255", "11.0.0.0", "100.64.0.1", "172.15.255.255", "172.32.0.0",
            "192.167.255.255", "192.169.0.0", "198.18.0.1", "198.18.255.254", "223.255.255.255", "95.182.88.4",
        )) assertTrue("$ip должен идти в туннель", covered(r, ip))
    }

    @Test
    fun `маршруты не перекрываются и выровнены по маске`() {
        val r = LanRoutes.ipv4WithoutLan()
        val ranges = r.map { (base, len) ->
            val b = LanRoutes.ipv4ToLong(base)
            assertEquals("невыровненный префикс $base/$len", 0L, b % (1L shl (32 - len)))
            b to b + (1L shl (32 - len))
        }.sortedBy { it.first }
        for (i in 1 until ranges.size) assertTrue(ranges[i - 1].second <= ranges[i].first)
        // Немного маршрутов: система ставит их в таблицу VPN, сотни незачем.
        assertTrue("маршрутов ${r.size}", r.size in 10..40)
    }
}
