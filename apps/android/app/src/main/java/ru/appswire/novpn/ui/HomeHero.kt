package ru.appswire.novpn.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import ru.appswire.novpn.R
import ru.appswire.novpn.vpn.ConnState
import ru.appswire.novpn.vpn.NetDiagnosis
import ru.appswire.novpn.vpn.ReserveInfo

/**
 * Главный герой домашнего экрана: глобус-фон и большая круглая кнопка с логотипом.
 * Кнопка — основной переключатель: нажатие подключает или отключает VPN. Цвет
 * говорит о состоянии: серый — выключено, синий — умный режим, зелёный — полный
 * VPN, янтарный — подключаемся/резерв, красный — ошибка или нет интернета. Глобус
 * приходит двумя картинками (светлая/тёмная тема) и растворяется по краям в фон.
 */
private enum class HeroTone(val a: Color, val b: Color) {
    GREY(Color(0xFF8B93A1), Color(0xFF5B6472)),
    BLUE(Color(0xFF4F93FF), Color(0xFF1D4ED8)),
    GREEN(Color(0xFF34D27F), Color(0xFF15803D)),
    AMBER(Color(0xFFF7B23B), Color(0xFFD97706)),
    RED(Color(0xFFF6664F), Color(0xFFB91C1C)),
}

@Composable
fun HomeHero(
    conn: ConnState,
    smart: Boolean,
    diagnosis: NetDiagnosis,
    reserve: ReserveInfo?,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
) {
    val c = NoVpnTheme.colors
    val connecting = conn == ConnState.CONNECTING || conn == ConnState.RECONNECTING
    val on = conn == ConnState.ON
    val noInternet = on && reserve == null && diagnosis == NetDiagnosis.NO_INTERNET
    val live = on || connecting

    val tone = when {
        noInternet || conn == ConnState.ERROR -> HeroTone.RED
        connecting || reserve != null -> HeroTone.AMBER
        on -> if (smart) HeroTone.BLUE else HeroTone.GREEN
        else -> HeroTone.GREY
    }

    Box(
        modifier = Modifier.fillMaxWidth().height(300.dp),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = painterResource(if (c.dark) R.drawable.globe_dark else R.drawable.globe_light),
            contentDescription = null,
            modifier = Modifier.fillMaxWidth().height(360.dp),
        )
        // Мягкий ореол под кнопкой в цвет состояния — без зависимости от blur-API.
        Box(
            modifier = Modifier
                .size(230.dp)
                .background(
                    Brush.radialGradient(
                        colors = listOf(tone.a.copy(alpha = if (c.dark) 0.38f else 0.22f), Color.Transparent),
                    ),
                    CircleShape,
                ),
        )
        Box(
            modifier = Modifier
                .size(138.dp)
                .clip(CircleShape)
                .background(Brush.radialGradient(0f to tone.a, 0.82f to tone.b))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = ripple(color = Color.White),
                ) { if (live) onDisconnect() else onConnect() },
            contentAlignment = Alignment.Center,
        ) {
            Image(
                imageVector = NoVpnIcons.Brand,
                contentDescription = if (live) "Отключить" else "Подключить",
                modifier = Modifier.size(72.dp),
            )
        }
    }
}
