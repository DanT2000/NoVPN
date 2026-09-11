package ru.appswire.novpn.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * Иконки — те же контуры, что в `apps/desktop/src/components/icons.tsx`:
 * штрих 1.6, viewBox 24, скруглённые концы. Цвет задаётся tint'ом при
 * отрисовке, поэтому здесь он условный.
 */
object NoVpnIcons {

    private fun stroked(name: String, width: Float = 1.6f, vararg paths: String): ImageVector {
        val b = ImageVector.Builder(
            name = name,
            defaultWidth = 20.dp,
            defaultHeight = 20.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        )
        for (d in paths) {
            b.addPath(
                pathData = addPathNodes(d),
                stroke = SolidColor(Color.Black),
                strokeLineWidth = width,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
        return b.build()
    }

    val Home: ImageVector by lazy {
        stroked("Home", 1.6f, "M4 10.5 12 4l8 6.5", "M6 9.8V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.8")
    }

    /** Развилка — тот же образ, что и на главном экране. */
    val Routing: ImageVector by lazy {
        stroked(
            "Routing", 1.6f,
            "M12 20v-6",
            "M12 14c0-3 -5-3 -5-6V5",
            "M12 14c0-3 5-3 5-6V5",
            "M5.6 4a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0",
            "M15.6 4a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0",
        )
    }

    val Connection: ImageVector by lazy {
        stroked(
            "Connection", 1.6f,
            "M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0",
            "M4 12h16",
            "M12 4c2.2 2.4 3.3 5.1 3.3 8s-1.1 5.6-3.3 8c-2.2-2.4-3.3-5.1-3.3-8S9.8 6.4 12 4Z",
        )
    }

    val Settings: ImageVector by lazy {
        stroked(
            "Settings", 1.6f,
            "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
            "M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z",
        )
    }

    /** Прямой путь — стрелка вниз без преград. */
    val Straight: ImageVector by lazy {
        stroked("Straight", 1.6f, "M12 4v14", "M7.5 13.5 12 18l4.5-4.5")
    }

    /** Путь через VPN — щит. */
    val Shield: ImageVector by lazy {
        stroked("Shield", 1.6f, "M12 3.5 5 6.4v5c0 4.2 2.8 7.4 7 9.1 4.2-1.7 7-4.9 7-9.1v-5L12 3.5Z")
    }

    val Check: ImageVector by lazy { stroked("Check", 2.4f, "M4 12.5 9.5 18 20 6.5") }

    val Chevron: ImageVector by lazy { stroked("Chevron", 1.6f, "M9 5l7 7-7 7") }

    val Back: ImageVector by lazy { stroked("Back", 1.6f, "M15 5l-7 7 7 7") }

    val Plus: ImageVector by lazy { stroked("Plus", 1.6f, "M12 5v14M5 12h14") }

    val Refresh: ImageVector by lazy { stroked("Refresh", 1.6f, "M20 11a8 8 0 1 0-.7 4.3", "M20 5v6h-6") }

    val Trash: ImageVector by lazy {
        stroked("Trash", 1.6f, "M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2", "M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12")
    }

    val Close: ImageVector by lazy { stroked("Close", 1.7f, "M5 5l14 14M19 5L5 19") }

    val Search: ImageVector by lazy { stroked("Search", 1.6f, "M4 10.5a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0", "M20 20l-4.4-4.4") }

    /**
     * Логотип: щит с буквой N — тот же контур, что в `res/drawable/ic_stat_novpn.xml`
     * и в иконке приложения. Заливка, не штрих: рисуется белым на синем.
     */
    val Brand: ImageVector by lazy {
        val b = ImageVector.Builder(
            name = "Brand",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        )
        b.addPath(pathData = addPathNodes(BRAND_SHIELD), fill = SolidColor(Color.White))
        b.addPath(pathData = addPathNodes(BRAND_LETTER), fill = SolidColor(Color.White))
        b.build()
    }

    /** Контуры логотипа — один источник для Compose и для XML-ресурсов. */
    const val BRAND_SHIELD =
        "M12,2L4,5.5v6.2c0,4.6 3.4,8.9 8,10.3c4.6,-1.4 8,-5.7 8,-10.3V5.5L12,2zM12,4.2l6,2.6v4.9c0,3.5 -2.5,6.9 -6,8.1c-3.5,-1.2 -6,-4.6 -6,-8.1V6.8L12,4.2z"
    const val BRAND_LETTER = "M8.7,8h1.9l3,4.6V8h1.7v8h-1.9l-3,-4.6V16H8.7z"
}
