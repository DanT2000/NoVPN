package ru.appswire.novpn.ui

import android.app.Activity
import android.content.ContextWrapper
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

private val Accent = Color(0xFF4C8DFF)
private val AccentDark = Color(0xFF0D7DD4)
private val Ok = Color(0xFF2FBF71)
private val Danger = Color(0xFFE05A4E)

val StatusOk = Ok
val StatusDanger = Danger

private val DarkColors = darkColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    secondary = Ok,
    background = Color(0xFF0F1115),
    onBackground = Color(0xFFE8EAED),
    surface = Color(0xFF171A21),
    onSurface = Color(0xFFE8EAED),
    surfaceVariant = Color(0xFF1E222B),
    onSurfaceVariant = Color(0xFF9AA1AD),
    outline = Color(0xFF2C323D),
    error = Danger,
)

private val LightColors = lightColorScheme(
    primary = AccentDark,
    onPrimary = Color.White,
    secondary = Ok,
    background = Color(0xFFF4F5F7),
    onBackground = Color(0xFF14161A),
    surface = Color.White,
    onSurface = Color(0xFF14161A),
    surfaceVariant = Color(0xFFEDEFF3),
    onSurfaceVariant = Color(0xFF5B6470),
    outline = Color(0xFFDDE1E7),
    error = Danger,
)

private val AppTypography = Typography(
    titleLarge = TextStyle(fontSize = 22.sp, lineHeight = 28.sp),
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

@Composable
fun NoVpnTheme(theme: String, content: @Composable () -> Unit) {
    val dark = when (theme) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }
    val colors = if (dark) DarkColors else LightColors
    val view = LocalView.current
    val activity = currentActivity()
    if (!view.isInEditMode && activity != null) {
        SideEffect {
            val window = activity.window
            window.statusBarColor = colors.background.toArgb()
            window.navigationBarColor = colors.background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !dark
        }
    }
    MaterialTheme(colorScheme = colors, typography = AppTypography, content = content)
}
