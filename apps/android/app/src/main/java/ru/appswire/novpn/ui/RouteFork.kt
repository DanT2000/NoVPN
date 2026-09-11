package ru.appswire.novpn.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ru.appswire.novpn.vpn.ConnState

/**
 * Развилка маршрутов — главный визуальный элемент приложения, порт
 * `apps/desktop/src/components/RouteFork.tsx` + `fork.css`. Показывает
 * единственное, что человеку нужно понять про NoVPN: трафик расходится на два
 * пути. Оба пути названы карточками, по живому пути бегут точки — видно не
 * только «куда», но и «идёт ли». Когда умная маршрутизация выключена, прямого
 * пути нет вовсе, и его карточка гаснет.
 */

enum class ForkTone { ON, WAIT, BAD, OFF }

fun forkTone(conn: ConnState): ForkTone = when (conn) {
    ConnState.ON -> ForkTone.ON
    ConnState.CONNECTING, ConnState.RECONNECTING -> ForkTone.WAIT
    ConnState.ERROR -> ForkTone.BAD
    ConnState.OFF -> ForkTone.OFF
}

/** Точка на кубической кривой Безье при параметре t. */
private fun bezier(p0: Offset, p1: Offset, p2: Offset, p3: Offset, t: Float): Offset {
    val u = 1 - t
    val x = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x
    val y = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
    return Offset(x, y)
}

@Composable
fun RouteFork(conn: ConnState, smart: Boolean, vpnLabel: String, directLabel: String) {
    val c = NoVpnTheme.colors
    val tone = forkTone(conn)
    val directOff = !smart
    val flowing = tone == ForkTone.ON || tone == ForkTone.WAIT

    // Единственная анимация в приложении — точки по живому пути. Три точки с
    // равным сдвигом фазы, период 1.65 с — как у SVG-анимации на десктопе.
    val transition = rememberInfiniteTransition(label = "fork")
    val progress by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1650, easing = LinearEasing), RepeatMode.Restart),
        label = "dots",
    )

    val vpnStroke = when (tone) {
        ForkTone.ON -> c.greenCardBorder
        ForkTone.WAIT -> c.amberNoticeBorder
        ForkTone.BAD -> c.borderDanger
        ForkTone.OFF -> c.textFainter
    }
    val dotColor = if (tone == ForkTone.WAIT) c.amberFg else c.greenDot
    val directStroke = if (directOff) c.borderInner else c.borderControl

    Column(modifier = Modifier.fillMaxWidth()) {
        Eyebrow(
            "Ваш трафик",
            modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp),
            letterSpacing = 1.2f,
        )

        Canvas(modifier = Modifier.fillMaxWidth().height(36.dp)) {
            val w = size.width
            val h = size.height
            // Концы кривых — центры карточек: две равные колонки с зазором 10dp.
            val gap = 10.dp.toPx()
            val cardW = (w - gap) / 2
            val leftX = cardW / 2
            val rightX = w - cardW / 2
            val top = Offset(w / 2, 2.dp.toPx())
            val bottomY = h - 2.dp.toPx()
            val ctrlY = 22.dp.toPx()
            val midY = 14.dp.toPx()

            val stroke = 1.6.dp.toPx()
            fun dashed(a: Float, b: Float) = PathEffect.dashPathEffect(floatArrayOf(a.dp.toPx(), b.dp.toPx()), 0f)

            val leftEnd = Offset(leftX, bottomY)
            val leftPath = Path().apply {
                moveTo(top.x, top.y)
                cubicTo(top.x, ctrlY, leftX, midY, leftEnd.x, leftEnd.y)
            }
            drawPath(
                leftPath,
                color = directStroke,
                style = Stroke(width = stroke, cap = StrokeCap.Round, pathEffect = if (directOff) dashed(3f, 5f) else null),
            )

            val rightEnd = Offset(rightX, bottomY)
            val rightPath = Path().apply {
                moveTo(top.x, top.y)
                cubicTo(top.x, ctrlY, rightX, midY, rightEnd.x, rightEnd.y)
            }
            val vpnDash = when (tone) {
                ForkTone.BAD -> dashed(4f, 5f)
                ForkTone.OFF -> dashed(3f, 5f)
                else -> null
            }
            drawPath(rightPath, color = vpnStroke, style = Stroke(width = stroke, cap = StrokeCap.Round, pathEffect = vpnDash))

            if (flowing) {
                val p1 = Offset(top.x, ctrlY)
                val p2 = Offset(rightX, midY)
                val r = 2.6.dp.toPx()
                for (i in 0 until 3) {
                    val t = (progress + i / 3f) % 1f
                    drawCircle(dotColor, radius = r, center = bezier(top, p1, p2, rightEnd, t))
                }
            }
        }

        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            RouteCard(
                modifier = Modifier.weight(1f),
                icon = NoVpnIcons.Straight,
                title = "Напрямую",
                note = if (directOff) "выключено" else directLabel,
                tone = null,
                dimmed = directOff,
            )
            RouteCard(
                modifier = Modifier.weight(1f),
                icon = NoVpnIcons.Shield,
                title = "Через VPN",
                note = vpnLabel,
                tone = tone,
                dimmed = false,
            )
        }
    }
}

/** `.rcard` — карточка пути. `tone == null` — нейтральная (прямой путь). */
@Composable
private fun RouteCard(
    modifier: Modifier,
    icon: ImageVector,
    title: String,
    note: String,
    tone: ForkTone?,
    dimmed: Boolean,
) {
    val c = NoVpnTheme.colors
    val borderColor = when (tone) {
        ForkTone.ON -> c.greenCardBorder
        ForkTone.WAIT -> c.amberNoticeBorder
        ForkTone.BAD -> c.borderDanger
        else -> c.border
    }
    val bg = when (tone) {
        ForkTone.ON -> c.greenCardBg
        ForkTone.WAIT -> c.amberNoticeBg
        ForkTone.BAD -> c.redBoxBg
        else -> c.surface
    }
    val iconFg = when (tone) {
        ForkTone.ON -> c.greenFg
        ForkTone.WAIT -> c.amberFg
        ForkTone.BAD -> c.redFg
        else -> c.textMuted
    }
    val iconBg = when (tone) {
        ForkTone.ON -> c.greenBg
        ForkTone.WAIT -> c.amberBg
        ForkTone.BAD -> c.redBg
        else -> c.surfaceBtn2
    }
    val titleColor = when (tone) {
        ForkTone.ON -> c.greenFg
        ForkTone.WAIT -> c.amberFg
        ForkTone.BAD -> c.redFg
        else -> c.textSecondary
    }
    // Пунктирная рамка — у выключенного пути и у неподключённого VPN.
    val dashed = dimmed || tone == ForkTone.OFF
    Column(
        modifier = modifier
            .alpha(if (dimmed) 0.4f else 1f)
            .clip(ShapeCardLg)
            .background(bg)
            .then(if (dashed) Modifier.dashedBorder(borderColor, ShapeCardLg) else Modifier.border(1.dp, borderColor, ShapeCardLg))
            .padding(start = 12.dp, end = 12.dp, top = 13.dp, bottom = 14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Box(
            modifier = Modifier
                .padding(bottom = 4.dp)
                .size(34.dp)
                .clip(CircleShape)
                .background(iconBg),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = iconFg, modifier = Modifier.size(19.dp))
        }
        Text(title, fontSize = 14.sp, fontWeight = FontWeight.Bold, color = titleColor, maxLines = 1, softWrap = false)
        Text(
            note,
            fontFamily = Mono,
            fontSize = 11.sp,
            lineHeight = 15.sp,
            color = c.textMuted2,
            textAlign = TextAlign.Center,
            maxLines = 2,
        )
    }
}
