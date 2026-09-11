package ru.appswire.novpn.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import java.util.Locale

/*
 * Переиспользуемые элементы. Разметка и размеры повторяют
 * `apps/desktop/src/styles/components.css` и `app.css`: кнопки, карточки,
 * тумблер, сегменты, подписи разделов — десктоп и телефон должны читаться как
 * одно приложение.
 */

val Mono = FontFamily.Monospace

/** Радиусы из токенов: --r-ctrl 6, --r-card 8, --r-card-lg 10, --r-dialog 20. */
val ShapeCtrl = RoundedCornerShape(6.dp)
val ShapeCard = RoundedCornerShape(8.dp)
val ShapeCardLg = RoundedCornerShape(10.dp)
val ShapeDialog = RoundedCornerShape(20.dp)

// ── Заголовки ─────────────────────────────────────────────────────────────

/** `.screen-title` — 23px, жирный, плотная разрядка. */
@Composable
fun ScreenTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier,
        fontSize = 23.sp,
        lineHeight = 28.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-0.4).sp,
        color = NoVpnTheme.colors.textPrimary,
    )
}

/** `.screen-sub` — подзаголовок экрана приглушённым. */
@Composable
fun ScreenSub(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier.padding(top = 4.dp, bottom = 18.dp),
        fontSize = 14.sp,
        lineHeight = 21.sp,
        color = NoVpnTheme.colors.textMuted,
    )
}

/** `.section-label` — моно, капс, разрядка. `first` убирает верхний отступ. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, first: Boolean = false) {
    Text(
        text.uppercase(Locale.getDefault()),
        modifier = modifier.padding(top = if (first) 0.dp else 22.dp, bottom = 10.dp),
        fontFamily = Mono,
        fontSize = 12.sp,
        letterSpacing = 1.sp,
        color = NoVpnTheme.colors.textMuted2,
    )
}

/** `.eyebrow` — микро-подпись: моно, капс, шире разрядка. */
@Composable
fun Eyebrow(text: String, modifier: Modifier = Modifier, letterSpacing: Float = 1.1f) {
    Text(
        text.uppercase(Locale.getDefault()),
        modifier = modifier,
        fontFamily = Mono,
        fontSize = 11.sp,
        letterSpacing = letterSpacing.sp,
        color = NoVpnTheme.colors.textMuted2,
        textAlign = TextAlign.Center,
    )
}

// ── Текстовые роли (t-name / t-note / t-body / t-meta) ────────────────────

@Composable
fun TName(text: String, modifier: Modifier = Modifier, color: Color = NoVpnTheme.colors.textPrimary) {
    Text(text, modifier = modifier, fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, color = color)
}

@Composable
fun TNote(text: String, modifier: Modifier = Modifier, color: Color = NoVpnTheme.colors.textMuted, mono: Boolean = false) {
    Text(
        text,
        modifier = modifier,
        fontSize = 13.sp,
        lineHeight = 19.sp,
        color = color,
        fontFamily = if (mono) Mono else null,
    )
}

@Composable
fun TBody(text: String, modifier: Modifier = Modifier, color: Color = NoVpnTheme.colors.textBody) {
    Text(text, modifier = modifier, fontSize = 14.sp, lineHeight = 21.sp, color = color)
}

@Composable
fun TMeta(text: String, modifier: Modifier = Modifier, mono: Boolean = true) {
    Text(
        text,
        modifier = modifier,
        fontSize = 12.sp,
        lineHeight = 17.sp,
        color = NoVpnTheme.colors.textMuted2,
        fontFamily = if (mono) Mono else null,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

// ── Карточки и строки ─────────────────────────────────────────────────────

/** `.card` — поверхность с бордером, радиус 8. */
@Composable
fun Card(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    padding: PaddingValues = PaddingValues(16.dp),
    shape: RoundedCornerShape = ShapeCard,
    background: Color = NoVpnTheme.colors.surface,
    borderColor: Color = NoVpnTheme.colors.border,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(background)
            .border(1.dp, borderColor, shape)
            .then(if (onClick != null) Modifier.clickable { onClick() } else Modifier)
            .padding(padding),
        content = content,
    )
}

/**
 * `.item` — строка списка: значок слева, название и подпись, хвост справа.
 * Между строками 8dp — задаётся снаружи через Arrangement.spacedBy.
 */
@Composable
fun Item(
    title: String,
    meta: String? = null,
    modifier: Modifier = Modifier,
    metaColor: Color = NoVpnTheme.colors.textMuted2,
    metaMono: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    enabledLook: Boolean = true,
) {
    val c = NoVpnTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(ShapeCard)
            .background(c.surface)
            .border(1.dp, c.border, ShapeCard)
            .then(if (onClick != null) Modifier.clickable { onClick() } else Modifier)
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        leading?.invoke()
        Column(modifier = Modifier.weight(1f).alpha(if (enabledLook) 1f else 0.5f)) {
            Text(
                title,
                fontSize = 15.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight.SemiBold,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (meta != null) {
                Text(
                    meta,
                    modifier = Modifier.padding(top = 3.dp),
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                    color = metaColor,
                    fontFamily = if (metaMono) Mono else null,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        trailing?.invoke(this)
    }
}

/** Строка с тумблером справа — как `Row` в Settings.tsx. */
@Composable
fun ToggleItem(
    title: String,
    meta: String? = null,
    checked: Boolean,
    enabled: Boolean = true,
    onChange: (Boolean) -> Unit,
) {
    Item(
        title = title,
        meta = meta,
        trailing = { Toggle(on = checked, enabled = enabled, onChange = onChange) },
        onClick = if (enabled) ({ onChange(!checked) }) else null,
    )
}

/** Строка-ссылка с шевроном справа. */
@Composable
fun ChevronItem(title: String, meta: String? = null, metaMono: Boolean = false, onClick: () -> Unit) {
    Item(
        title = title,
        meta = meta,
        metaMono = metaMono,
        trailing = { Chevron() },
        onClick = onClick,
    )
}

@Composable
fun Chevron(icon: ImageVector = NoVpnIcons.Chevron, size: Int = 16) {
    Icon(icon, contentDescription = null, tint = NoVpnTheme.colors.textMuted2, modifier = Modifier.size(size.dp))
}

/**
 * `.avatar` — буква фирменным цветом на его же приглушённой подложке. Цвет
 * выводится из названия, чтобы одно и то же имя всегда красилось одинаково.
 */
@Composable
fun Avatar(name: String, size: Int = 36) {
    val color = colorFor(name)
    Box(
        modifier = Modifier
            .size(size.dp)
            .clip(RoundedCornerShape(9.dp))
            .background(color.copy(alpha = 0.16f)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?",
            fontSize = 15.sp,
            fontWeight = FontWeight.ExtraBold,
            color = color,
        )
    }
}

private val AVATAR_PALETTE = listOf(
    Color(0xFF5A82F0), Color(0xFF7EE2A0), Color(0xFFF0C674), Color(0xFFF0908C),
    Color(0xFFB08CF0), Color(0xFF5CC8D6), Color(0xFFE79A5C), Color(0xFF8AB0F2),
)

fun colorFor(name: String): Color {
    var h = 0
    for (ch in name) h = (h * 31 + ch.code) and 0x7fffffff
    return AVATAR_PALETTE[h % AVATAR_PALETTE.size]
}

// ── Кнопки ────────────────────────────────────────────────────────────────

enum class BtnKind { PRIMARY, SECONDARY, OUTLINE, DANGER, DANGER_OUTLINE }
enum class BtnSize { SM, MD, LG }

/** `.btn` и его варианты. Высоты 36 / 44 / 52, как в CSS. */
@Composable
fun Btn(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: BtnKind = BtnKind.PRIMARY,
    size: BtnSize = BtnSize.MD,
    enabled: Boolean = true,
    icon: ImageVector? = null,
) {
    val c = NoVpnTheme.colors
    val height = when (size) {
        BtnSize.SM -> 36.dp
        BtnSize.MD -> 44.dp
        BtnSize.LG -> 52.dp
    }
    val fontSize = when (size) {
        BtnSize.SM -> 13.sp
        BtnSize.MD -> 14.sp
        BtnSize.LG -> 15.sp
    }
    val bg = when (kind) {
        BtnKind.PRIMARY -> c.accent
        BtnKind.SECONDARY -> c.surfaceBtn2
        BtnKind.DANGER -> c.redBtn
        BtnKind.OUTLINE, BtnKind.DANGER_OUTLINE -> Color.Transparent
    }
    val fg = when (kind) {
        BtnKind.PRIMARY, BtnKind.DANGER -> Color.White
        BtnKind.SECONDARY, BtnKind.OUTLINE -> c.textSecondary
        BtnKind.DANGER_OUTLINE -> c.redFg
    }
    val borderColor = when (kind) {
        BtnKind.OUTLINE -> c.borderInput
        BtnKind.DANGER_OUTLINE -> c.borderDanger
        else -> Color.Transparent
    }
    Row(
        modifier = modifier
            .height(height)
            .alpha(if (enabled) 1f else 0.45f)
            .clip(ShapeCtrl)
            .background(bg)
            .border(1.dp, borderColor, ShapeCtrl)
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = if (size == BtnSize.SM) 12.dp else 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, fontSize = fontSize, fontWeight = FontWeight.Bold, color = fg, maxLines = 1, softWrap = false)
    }
}

/** `.link-btn` — текстовая кнопка цветом ссылки. */
@Composable
fun LinkBtn(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Text(
        text,
        modifier = modifier
            .alpha(if (enabled) 1f else 0.45f)
            .clip(ShapeCtrl)
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 4.dp, vertical = 6.dp),
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
        color = NoVpnTheme.colors.link,
    )
}

// ── Тумблер ───────────────────────────────────────────────────────────────

/** `.toggle` — 40×23, белый бегунок, акцент во включённом состоянии. */
@Composable
fun Toggle(on: Boolean, onChange: (Boolean) -> Unit, enabled: Boolean = true) {
    val c = NoVpnTheme.colors
    val track by animateColorAsState(if (on) c.accent else c.borderControl, label = "track")
    val x by animateDpAsState(if (on) 20.dp else 3.dp, label = "thumb")
    Box(
        modifier = Modifier
            .size(width = 40.dp, height = 23.dp)
            .alpha(if (enabled) 1f else 0.45f)
            .clip(RoundedCornerShape(12.dp))
            .background(track)
            .clickable(enabled = enabled) { onChange(!on) },
    ) {
        Box(
            modifier = Modifier
                .offset { IntOffset(x.roundToPx(), 3.dp.roundToPx()) }
                .size(17.dp)
                .clip(CircleShape)
                .background(Color.White),
        )
    }
}

// ── Сегменты ──────────────────────────────────────────────────────────────

/** `.segmented` — равные кнопки в рамке; активная поднята подложкой. */
@Composable
fun Segmented(
    options: List<Pair<String, String>>,
    value: String,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = NoVpnTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(ShapeCtrl)
            .background(c.surface)
            .border(1.dp, c.border, ShapeCtrl)
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        for ((id, label) in options) {
            val active = id == value
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(5.dp))
                    .background(if (active) c.surfaceBtn2 else Color.Transparent)
                    .clickable { onChange(id) }
                    .padding(vertical = 10.dp, horizontal = 4.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (active) c.textPrimary else c.textMuted,
                    maxLines = 1,
                    softWrap = false,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

// ── Поля ввода ────────────────────────────────────────────────────────────

/** `.input` — поле на поверхности с рамкой; в фокусе рамка акцентная. */
@Composable
fun Input(
    value: String,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    mono: Boolean = false,
    enabled: Boolean = true,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Done,
    onDone: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
) {
    val c = NoVpnTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    BasicTextField(
        value = value,
        onValueChange = onChange,
        modifier = modifier.fillMaxWidth(),
        enabled = enabled,
        singleLine = true,
        interactionSource = interaction,
        textStyle = TextStyle(
            fontSize = 15.sp,
            color = c.textPrimary,
            fontFamily = if (mono) Mono else null,
        ),
        cursorBrush = SolidColor(c.accentLight),
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
        keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }, onGo = { onDone?.invoke() }, onSearch = { onDone?.invoke() }),
        decorationBox = { inner ->
            Row(
                modifier = Modifier
                    .clip(ShapeCtrl)
                    .background(c.surface)
                    .border(1.dp, if (focused) c.accent else c.borderInput, ShapeCtrl)
                    .padding(horizontal = 13.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (leading != null) {
                    leading()
                    Spacer(Modifier.width(8.dp))
                }
                Box(modifier = Modifier.weight(1f)) {
                    if (value.isEmpty()) {
                        Text(placeholder, fontSize = 15.sp, color = c.textFaint, fontFamily = if (mono) Mono else null, maxLines = 1)
                    }
                    inner()
                }
            }
        },
    )
}

/** `.field-label` — подпись над полем. */
@Composable
fun FieldLabel(text: String) {
    Text(
        text.uppercase(Locale.getDefault()),
        modifier = Modifier.padding(bottom = 7.dp),
        fontFamily = Mono,
        fontSize = 11.sp,
        letterSpacing = 0.9.sp,
        color = NoVpnTheme.colors.textMuted2,
    )
}

// ── Уведомления и подсказки ───────────────────────────────────────────────

enum class Tone { INFO, WARN, DANGER, OK }

/** `.notice` — небольшая полоса уведомления. Крупных тревожных плашек нет. */
@Composable
fun Notice(text: String, modifier: Modifier = Modifier, tone: Tone = Tone.INFO, trailing: (@Composable () -> Unit)? = null) {
    val c = NoVpnTheme.colors
    val (bg, border, fg) = when (tone) {
        Tone.WARN -> Triple(c.amberNoticeBg, c.amberNoticeBorder, c.amberMuted)
        Tone.DANGER -> Triple(c.redBoxBg, Color.Transparent, c.redFg)
        Tone.OK -> Triple(c.greenCardBg, c.greenCardBorder, c.greenFg)
        Tone.INFO -> Triple(c.blueBgSoft, c.blueSel, c.blueFg)
    }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(ShapeCtrl)
            .background(bg)
            .border(1.dp, border, ShapeCtrl)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text,
            modifier = Modifier.weight(1f),
            fontSize = 13.sp,
            lineHeight = 19.sp,
            color = fg,
            fontWeight = if (tone == Tone.DANGER) FontWeight.SemiBold else FontWeight.Normal,
        )
        trailing?.invoke()
    }
}

/** `.hint` — пояснение в тихой рамке. */
@Composable
fun Hint(text: String, modifier: Modifier = Modifier) {
    val c = NoVpnTheme.colors
    Text(
        text,
        modifier = modifier
            .fillMaxWidth()
            .clip(ShapeCtrl)
            .background(c.surface)
            .border(1.dp, c.borderInner, ShapeCtrl)
            .padding(horizontal = 13.dp, vertical = 11.dp),
        fontSize = 13.sp,
        lineHeight = 19.sp,
        color = c.textMuted,
    )
}

/** Пустое состояние списка — пунктирная рамка и два слова. */
@Composable
fun Empty(title: String, note: String? = null) {
    val c = NoVpnTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .dashedBorder(c.borderInput, ShapeCard)
            .padding(horizontal = 16.dp, vertical = 22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        TName(title)
        if (note != null) TNote(note, modifier = Modifier.padding(top = 6.dp))
    }
}

/** `.badge` — моно-метка капсом на синей подложке. */
@Composable
fun Badge(text: String, fg: Color = NoVpnTheme.colors.blueFg, bg: Color = NoVpnTheme.colors.blueBg) {
    Text(
        text.uppercase(Locale.getDefault()),
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(bg)
            .padding(horizontal = 7.dp, vertical = 3.dp),
        fontFamily = Mono,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.4.sp,
        color = fg,
    )
}

/** `.route` — метка маршрута: «Через VPN» синим, «Напрямую» серым. */
@Composable
fun RouteTag(route: String) {
    val c = NoVpnTheme.colors
    val vpn = route == "vpn"
    Text(
        if (vpn) "Через VPN" else "Напрямую",
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (vpn) c.blueBg else c.grayBg)
            .padding(horizontal = 11.dp, vertical = 5.dp),
        fontSize = 12.sp,
        fontWeight = FontWeight.Bold,
        color = if (vpn) c.blueFg else c.grayFg,
        maxLines = 1,
        softWrap = false,
    )
}

/** Точка статуса 9dp. */
@Composable
fun StatusDot(color: Color, size: Int = 9) {
    Box(
        modifier = Modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(color),
    )
}

/** `.radio` — кружок выбора, заполняется акцентом. */
@Composable
fun Radio(checked: Boolean) {
    val c = NoVpnTheme.colors
    Box(
        modifier = Modifier
            .size(18.dp)
            .clip(CircleShape)
            .border(1.5.dp, if (checked) c.accentLight else c.borderControl, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        if (checked) {
            Box(
                modifier = Modifier
                    .size(9.dp)
                    .clip(CircleShape)
                    .background(c.accentLight),
            )
        }
    }
}

/**
 * `RouteSwitch` — маршрут одним тумблером: выключен — напрямую, включён — через
 * VPN. Смысл подписан рядом, чтобы не гадать.
 */
@Composable
fun RouteSwitch(value: String, onChange: (String) -> Unit) {
    val c = NoVpnTheme.colors
    val vpn = value == "vpn"
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(ShapeCtrl)
            .background(if (vpn) c.blueBgSoft else Color.Transparent)
            .border(1.dp, c.borderInput, ShapeCtrl)
            .clickable { onChange(if (vpn) "direct" else "vpn") }
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            TName(if (vpn) "Через VPN" else "Напрямую")
            TNote(if (vpn) "Этот трафик пойдёт в туннель" else "Мимо VPN, как обычно", modifier = Modifier.padding(top = 2.dp))
        }
        Toggle(on = vpn, onChange = { onChange(if (it) "vpn" else "direct") })
    }
}

// ── Диалог ────────────────────────────────────────────────────────────────

/** `.dialog` — карточка 20dp со своим заголовком и крестиком. */
@Composable
fun NoVpnDialog(title: String, onClose: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val c = NoVpnTheme.colors
    Dialog(onDismissRequest = onClose) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(ShapeDialog)
                .background(c.surfaceDialog)
                .border(1.dp, c.borderInput, ShapeDialog)
                .padding(22.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(bottom = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(title, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, color = c.textPrimary, modifier = Modifier.weight(1f))
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(ShapeCtrl)
                        .clickable { onClose() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(NoVpnIcons.Close, contentDescription = "Закрыть", tint = c.textMuted, modifier = Modifier.size(13.dp))
                }
            }
            content()
        }
    }
}

// ── Пунктирная рамка ──────────────────────────────────────────────────────

/** `border-style: dashed` — у Compose своего пунктира нет, рисуем сами. */
fun Modifier.dashedBorder(color: Color, shape: RoundedCornerShape, width: Dp = 1.dp): Modifier = drawBehind {
    val stroke = Stroke(
        width = width.toPx(),
        pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 4.dp.toPx()), 0f),
    )
    val outline = shape.createOutline(size, layoutDirection, this)
    drawOutline(outline = outline, color = color, style = stroke)
}

// ── Форматирование ────────────────────────────────────────────────────────

/** Согласование существительного с числом: «12 631 сайт», а не «сайтов». */
fun plural(n: Int, one: String, few: String, many: String): String {
    val a = kotlin.math.abs(n) % 100
    val b = a % 10
    return when {
        a in 11..19 -> many
        b in 2..4 -> few
        b == 1 -> one
        else -> many
    }
}

fun count(n: Int, one: String, few: String, many: String): String =
    "${String.format(Locale.forLanguageTag("ru"), "%,d", n)} ${plural(n, one, few, many)}"

fun humanBytes(bytes: Long): String = when {
    bytes >= 1_000_000_000 -> "%.2f ГБ".format(bytes / 1_000_000_000.0)
    bytes >= 1_000_000 -> "%.1f МБ".format(bytes / 1_000_000.0)
    bytes >= 1_000 -> "%d КБ".format(bytes / 1_000)
    else -> "$bytes Б"
}

fun humanSpeed(bytesPerSec: Long): String = when {
    bytesPerSec >= 1_000_000 -> "%.1f МБ/с".format(bytesPerSec / 1_000_000.0)
    bytesPerSec >= 1_000 -> "%d КБ/с".format(bytesPerSec / 1_000)
    else -> "$bytesPerSec Б/с"
}
