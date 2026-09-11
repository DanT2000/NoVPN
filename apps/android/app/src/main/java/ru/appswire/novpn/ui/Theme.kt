package ru.appswire.novpn.ui

import android.app.Activity
import android.content.ContextWrapper
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

/**
 * Дизайн-токены — те же, что у десктопа (`apps/desktop/src/styles/theme.css`) и
 * веб-панели. Имена полей повторяют CSS-переменные, чтобы правку в одном продукте
 * можно было перенести в другой глазами, а не догадками. Значения не менять в
 * отрыве от десктопа: расхождение токенов = расхождение продуктов.
 *
 * Акцент в CSS задан как oklch(0.58 0.16 250) — здесь он уже переведён в sRGB.
 */
data class NoVpnColors(
    val dark: Boolean,
    // поверхности и структура
    val bgRoot: Color,
    val bgApp: Color,
    val surface: Color,
    val surfaceHover1: Color,
    val surfaceHover2: Color,
    val surfaceBtn2: Color,
    val surfaceDialog: Color,
    val overlay: Color,
    val border: Color,
    val borderInner: Color,
    val borderInput: Color,
    val borderControl: Color,
    val borderDanger: Color,
    // текст
    val textPrimary: Color,
    val textSecondary: Color,
    val textBody: Color,
    val textMuted: Color,
    val textMuted2: Color,
    val textFaint: Color,
    val textFainter: Color,
    val textOnAccent: Color,
    // бренд
    val accent: Color,
    val accentLight: Color,
    val link: Color,
    // статусы
    val greenFg: Color,
    val greenBg: Color,
    val greenDot: Color,
    val greenCardBorder: Color,
    val greenCardBg: Color,
    val amberFg: Color,
    val amberBg: Color,
    val amberNoticeBg: Color,
    val amberNoticeBorder: Color,
    val amberMuted: Color,
    val redFg: Color,
    val redBg: Color,
    val redBoxBg: Color,
    val redBtn: Color,
    val grayFg: Color,
    val grayBg: Color,
    val blueFg: Color,
    val blueBg: Color,
    val blueBgSoft: Color,
    val blueSel: Color,
)

private val Accent = Color(0xFF0D7DD4)
private val AccentLight = Color(0xFF4C9DEB)

val DarkTokens = NoVpnColors(
    dark = true,
    bgRoot = Color(0xFF0A0A0B),
    bgApp = Color(0xFF0B0C0E),
    surface = Color(0xFF0E0F11),
    surfaceHover1 = Color(0xFF101114),
    surfaceHover2 = Color(0xFF16171B),
    surfaceBtn2 = Color(0xFF1C1D22),
    surfaceDialog = Color(0xFF1A1B1F),
    overlay = Color(0xA6000000),
    border = Color(0xFF1E1F24),
    borderInner = Color(0xFF17181C),
    borderInput = Color(0xFF26272C),
    borderControl = Color(0xFF35363C),
    borderDanger = Color(0x4DF06E6E),
    textPrimary = Color(0xFFE9E9EB),
    textSecondary = Color(0xFFD5D6DA),
    textBody = Color(0xFF9A9CA3),
    textMuted = Color(0xFF77797F),
    textMuted2 = Color(0xFF55575E),
    textFaint = Color(0xFF494B52),
    textFainter = Color(0xFF35363C),
    textOnAccent = Color.White,
    accent = Accent,
    accentLight = AccentLight,
    link = Color(0xFF7EA6F0),
    greenFg = Color(0xFF7EE2A0),
    greenBg = Color(0x1F4ADE80),
    greenDot = Color(0xFF4ADE80),
    greenCardBorder = Color(0x404ADE80),
    greenCardBg = Color(0x0F4ADE80),
    amberFg = Color(0xFFF0C674),
    amberBg = Color(0x21F0C674),
    amberNoticeBg = Color(0x0FF0C674),
    amberNoticeBorder = Color(0x33F0C674),
    amberMuted = Color(0xFFCFA95E),
    redFg = Color(0xFFF0908C),
    redBg = Color(0x21F06E6E),
    redBoxBg = Color(0x1AF06E6E),
    redBtn = Color(0xFFC94F4F),
    grayFg = Color(0xFF9A9CA3),
    grayBg = Color(0x1F9A9CA3),
    blueFg = Color(0xFF8AB0F2),
    blueBg = Color(0x245A82F0),
    blueBgSoft = Color(0x0F5A82F0),
    blueSel = Color(0x1F5A82F0),
)

/** Светлая тема: `[data-theme='light']`. Акцент общий, статусы затемнены под белый. */
val LightTokens = NoVpnColors(
    dark = false,
    bgRoot = Color(0xFFEEF0F3),
    bgApp = Color(0xFFF6F7F9),
    surface = Color(0xFFFFFFFF),
    surfaceHover1 = Color(0xFFF3F4F6),
    surfaceHover2 = Color(0xFFE9EBEF),
    surfaceBtn2 = Color(0xFFE6E8EC),
    surfaceDialog = Color(0xFFFFFFFF),
    overlay = Color(0x5214161C),
    border = Color(0xFFE2E4E9),
    borderInner = Color(0xFFEDEEF1),
    borderInput = Color(0xFFD3D6DD),
    borderControl = Color(0xFFBFC3CB),
    borderDanger = Color(0x59C94F4F),
    textPrimary = Color(0xFF16181D),
    textSecondary = Color(0xFF2B2D33),
    textBody = Color(0xFF53565E),
    textMuted = Color(0xFF71747C),
    textMuted2 = Color(0xFF8B8E96),
    textFaint = Color(0xFFA7AAB1),
    textFainter = Color(0xFFC2C5CB),
    textOnAccent = Color.White,
    accent = Accent,
    accentLight = AccentLight,
    link = Color(0xFF245EC2),
    greenFg = Color(0xFF157F42),
    greenBg = Color(0x2422C55E),
    greenDot = Color(0xFF22A24D),
    greenCardBorder = Color(0x6622A24D),
    greenCardBg = Color(0x1422A24D),
    amberFg = Color(0xFF9A6A00),
    amberBg = Color(0x2ED69E2E),
    amberNoticeBg = Color(0x1AD69E2E),
    amberNoticeBorder = Color(0x66BE8C28),
    amberMuted = Color(0xFF9A7420),
    redFg = Color(0xFFC0392B),
    redBg = Color(0x24C94F4F),
    redBoxBg = Color(0x1AC94F4F),
    redBtn = Color(0xFFCF453F),
    grayFg = Color(0xFF53565E),
    grayBg = Color(0x24787A82),
    blueFg = Color(0xFF245EC2),
    blueBg = Color(0x265A82F0),
    blueBgSoft = Color(0x145A82F0),
    blueSel = Color(0x295A82F0),
)

val LocalNoVpnColors = staticCompositionLocalOf { DarkTokens }

/** Доступ к токенам из любого composable: `NoVpnTheme.colors.accent`. */
object NoVpnTheme {
    val colors: NoVpnColors
        @Composable
        @ReadOnlyComposable
        get() = LocalNoVpnColors.current
}

private val AppTypography = Typography(
    titleLarge = TextStyle(fontSize = 23.sp, lineHeight = 28.sp),
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 21.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
)

/** Активность из текущего контекста — нужна для системных диалогов и окна. */
@Composable
fun currentActivity(): Activity? {
    var ctx = LocalContext.current
    while (ctx is ContextWrapper) {
        if (ctx is Activity) return ctx
        ctx = ctx.baseContext
    }
    return null
}

/**
 * Тема приложения. Свои токены — через [LocalNoVpnColors]; Material-схема
 * заполняется из них же, чтобы системные элементы (диалоги, клавиатурные поля,
 * выделение текста) не выбивались из общей палитры.
 */
@Composable
fun NoVpnTheme(theme: String, content: @Composable () -> Unit) {
    val dark = when (theme) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }
    val t = if (dark) DarkTokens else LightTokens
    val scheme = if (dark) {
        darkColorScheme(
            primary = t.accent,
            onPrimary = t.textOnAccent,
            secondary = t.greenFg,
            background = t.bgRoot,
            onBackground = t.textPrimary,
            surface = t.bgRoot,
            onSurface = t.textPrimary,
            surfaceVariant = t.surfaceBtn2,
            onSurfaceVariant = t.textMuted,
            surfaceContainerHigh = t.surfaceDialog,
            surfaceContainer = t.surface,
            outline = t.borderInput,
            outlineVariant = t.border,
            error = t.redFg,
        )
    } else {
        lightColorScheme(
            primary = t.accent,
            onPrimary = t.textOnAccent,
            secondary = t.greenFg,
            background = t.bgRoot,
            onBackground = t.textPrimary,
            surface = t.bgRoot,
            onSurface = t.textPrimary,
            surfaceVariant = t.surfaceBtn2,
            onSurfaceVariant = t.textMuted,
            surfaceContainerHigh = t.surfaceDialog,
            surfaceContainer = t.surface,
            outline = t.borderInput,
            outlineVariant = t.border,
            error = t.redFg,
        )
    }
    val view = LocalView.current
    val activity = currentActivity()
    if (!view.isInEditMode && activity != null) {
        SideEffect { paintSystemBars(activity, view, t.bgRoot.toArgb(), dark) }
    }
    CompositionLocalProvider(LocalNoVpnColors provides t) {
        MaterialTheme(colorScheme = scheme, typography = AppTypography, content = content)
    }
}

/**
 * Системные полосы — в цвет фона, значки по яркости темы. Прямая раскраска
 * объявлена устаревшей в API 35 (там полосы прозрачны сами), но на телефонах
 * с Android 8–14 без неё остаётся чёрная полоса под светлой темой.
 */
@Suppress("DEPRECATION")
private fun paintSystemBars(activity: Activity, view: android.view.View, color: Int, dark: Boolean) {
    val window = activity.window
    window.statusBarColor = color
    window.navigationBarColor = color
    val controller = WindowCompat.getInsetsController(window, view)
    controller.isAppearanceLightStatusBars = !dark
    controller.isAppearanceLightNavigationBars = !dark
}
