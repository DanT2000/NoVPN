package ru.appswire.novpn

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.appswire.novpn.vpn.Diag
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

class DiagTest {

    /**
     * Посредник оператора: принимает TCP к любому адресу, но дальше ничего не отвечает.
     * 31.10.2026 так выглядели заблокированные «Нидерланды» с мобильной сети: TCP-проба
     * говорила «сервер жив», телефон три раза перезапускал туннель вместо ухода на резерв.
     */
    @Test
    fun `молчащий после TCP адрес — не живой сервер`() {
        val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        val held = mutableListOf<Socket>()
        val acceptor = thread(isDaemon = true) {
            runCatching { while (true) held += server.accept() }
        }
        try {
            assertTrue("TCP-проба обманывается", Diag.tcpReachable("127.0.0.1", server.localPort))
            assertFalse(
                "рукопожатие не пришло — сервер недостижим",
                Diag.tlsReachable("127.0.0.1", server.localPort, "cdn.dodostatic.net", timeoutMs = 1500),
            )
        } finally {
            server.close()
            held.forEach { runCatching { it.close() } }
            acceptor.join(2000)
        }
    }

    @Test
    fun `закрытый порт — недостижим обеими пробами`() {
        val port = ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { it.localPort }
        assertFalse(Diag.tcpReachable("127.0.0.1", port, timeoutMs = 1500))
        assertFalse(Diag.tlsReachable("127.0.0.1", port, "cdn.dodostatic.net", timeoutMs = 1500))
    }
}
