package ru.appswire.novpn

import org.junit.Assert.assertEquals
import org.junit.Test
import ru.appswire.novpn.ui.Flags

/**
 * Флаг в строке сервера. Панель кладёт его в имя профиля сама; для чужих
 * подписок угадываем по названию. Ошибка тут не ломает подключение, но портит
 * главный экран — поэтому проверяем формы, которые реально приходят.
 */
class FlagsTest {

    @Test
    fun `флаг из имени панели вынимается вместе со значком сервера`() {
        val s = Flags.split("🇫🇷 Франция · Умная маршрутизация")
        assertEquals("🇫🇷", s.flag)
        assertEquals("Франция · Умная маршрутизация", s.name)
        assertEquals("🇫🇷 Франция", Flags.label("🇫🇷 Франция · Умная маршрутизация"))

        val home = Flags.split("🏠🇫🇮 HomeVPN")
        assertEquals("🏠🇫🇮", home.flag)
        assertEquals("HomeVPN", home.name)
    }

    @Test
    fun `страна угадывается по русскому и английскому названию`() {
        assertEquals("🇳🇱", Flags.split("Нидерланды 1").flag)
        assertEquals("🇩🇪", Flags.split("Frankfurt-2").flag)
        assertEquals("🇰🇿", Flags.split("kazakhstan").flag)
        assertEquals("", Flags.split("Сервер №3").flag)
        assertEquals("Сервер №3", Flags.split("Сервер №3").name)
    }

    @Test
    fun `iso-код превращается в пару региональных индикаторов`() {
        assertEquals("🇺🇸", Flags.emoji("us"))
        assertEquals("", Flags.emoji("usa"))
        assertEquals("", Flags.emoji("1A"))
    }
}
