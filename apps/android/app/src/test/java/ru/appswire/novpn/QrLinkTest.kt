package ru.appswire.novpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import ru.appswire.novpn.ui.QrLink

/**
 * Что сканер принимает за ссылку-подписку. Панель кладёт в QR прямую https-ссылку,
 * кабинет может дать ссылку приложения novpn://; конфиги чужих клиентов — нет.
 */
class QrLinkTest {

    @Test
    fun `прямая https-ссылка и личная k-ссылка принимаются как есть`() {
        assertEquals("https://vpn.appswire.ru/sub/abc", QrLink.extract("https://vpn.appswire.ru/sub/abc"))
        assertEquals("https://vpn.appswire.ru/k/tok123", QrLink.extract("  https://vpn.appswire.ru/k/tok123\n"))
    }

    @Test
    fun `ссылка приложения novpn раскрывается во вложенную подписку`() {
        assertEquals(
            "https://vpn.appswire.ru/sub/abc?x=1",
            QrLink.extract("novpn://subscribe?url=https%3A%2F%2Fvpn.appswire.ru%2Fsub%2Fabc%3Fx%3D1"),
        )
    }

    @Test
    fun `не подписка — отклоняется`() {
        assertNull(QrLink.extract("vless://uuid@host:443?security=reality#name"))
        assertNull(QrLink.extract("[Interface]\nPrivateKey = x"))
        assertNull(QrLink.extract("http://vpn.appswire.ru/sub/abc"))
        assertNull(QrLink.extract("novpn://subscribe?url=http%3A%2F%2Fevil"))
        assertNull(QrLink.extract("просто текст"))
    }
}
