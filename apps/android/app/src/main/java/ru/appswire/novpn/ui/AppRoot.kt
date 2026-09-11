package ru.appswire.novpn.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import ru.appswire.novpn.data.Repo

enum class Tab { HOME, ROUTING, CONNECTION, SETTINGS }

/** Хост ссылки для сообщения человеку: сравнивать он будет именно адрес панели. */
private fun hostOf(url: String): String = runCatching {
    java.net.URI(url).host ?: url
}.getOrDefault(url).ifEmpty { url }

@Composable
fun AppRoot(
    repo: Repo,
    deepLink: String?,
    onDeepLinkUsed: () -> Unit,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onRulesChanged: () -> Unit,
) {
    val c = NoVpnTheme.colors
    val state by repo.state.collectAsState()
    var tab by rememberSaveable { mutableStateOf(Tab.HOME) }
    var screen by rememberSaveable { mutableStateOf<String?>(null) }
    // Подвкладка «Маршрутов» живёт здесь, чтобы главная могла открыть сразу «Приложения».
    var routingTab by rememberSaveable { mutableStateOf("apps") }
    // Ссылку, пришедшую снаружи, подставляем в поле только после явного согласия.
    var accepted by remember { mutableStateOf<String?>(null) }
    var ask by remember { mutableStateOf<String?>(null) }

    // Системная «Назад»: с вложенного экрана — на уровень выше, с любой вкладки —
    // на главную, а с главной — как обычно (свернуть приложение).
    BackHandler(enabled = screen != null || tab != Tab.HOME) {
        if (screen != null) screen = null else tab = Tab.HOME
    }

    // Ссылка из панели. Прислать её может любое приложение и любая веб-страница,
    // поэтому молча подменять подписку нельзя: спрашиваем, и только потом
    // открываем экран подписки с подставленным адресом.
    LaunchedEffect(deepLink) {
        when {
            deepLink == null -> Unit
            !state.onboarded -> accepted = deepLink
            state.subUrl.isBlank() || state.subUrl == deepLink -> {
                accepted = deepLink
                tab = Tab.CONNECTION
            }
            else -> ask = deepLink
        }
    }

    ask?.let { incoming ->
        NoVpnDialog(
            title = "Заменить подписку?",
            onClose = {
                ask = null
                onDeepLinkUsed()
            },
        ) {
            TBody(
                "Другое приложение или сайт предлагает подписку на ${hostOf(incoming)}. " +
                    "Сейчас подключена ${hostOf(state.subUrl)}. Меняйте только если сами открыли " +
                    "эту ссылку у своего провайдера.",
            )
            Row(modifier = Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                Btn("Отмена", kind = BtnKind.OUTLINE, size = BtnSize.SM, onClick = {
                    ask = null
                    onDeepLinkUsed()
                })
                Btn("Подставить", size = BtnSize.SM, modifier = Modifier.weight(1f), onClick = {
                    accepted = incoming
                    ask = null
                    tab = Tab.CONNECTION
                })
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(c.bgRoot)) {
        if (!state.onboarded) {
            Onboarding(repo = repo, deepLink = accepted, onDeepLinkUsed = onDeepLinkUsed)
            return@Box
        }

        when (screen) {
            "background" -> {
                BackgroundScreen(repo = repo, onBack = { screen = null })
                return@Box
            }
            "log" -> {
                LogScreen(repo = repo, onBack = { screen = null })
                return@Box
            }
        }

        Column(modifier = Modifier.fillMaxSize()) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                when (tab) {
                    Tab.HOME -> HomeScreen(
                        repo = repo,
                        onConnect = onConnect,
                        onDisconnect = onDisconnect,
                        onRulesChanged = onRulesChanged,
                        onOpenRoutingApps = {
                            routingTab = "apps"
                            tab = Tab.ROUTING
                        },
                        onOpenConnection = { tab = Tab.CONNECTION },
                        onOpenBackground = { screen = "background" },
                    )

                    Tab.ROUTING -> RoutingScreen(
                        repo = repo,
                        tab = routingTab,
                        onTab = { routingTab = it },
                        onRulesChanged = onRulesChanged,
                    )

                    Tab.CONNECTION -> ConnectionScreen(
                        repo = repo,
                        deepLink = accepted,
                        onDeepLinkUsed = {
                            accepted = null
                            onDeepLinkUsed()
                        },
                        onRulesChanged = onRulesChanged,
                    )

                    Tab.SETTINGS -> SettingsScreen(
                        repo = repo,
                        onRulesChanged = onRulesChanged,
                        onOpenBackground = { screen = "background" },
                        onOpenLog = { screen = "log" },
                        onOpenConnection = { tab = Tab.CONNECTION },
                    )
                }
            }
            TabBar(tab = tab, onGo = { tab = it })
        }
    }
}

// ── Нижняя панель ─────────────────────────────────────────────────────────

private class TabSpec(val id: Tab, val label: String, val icon: ImageVector)

private val TABS = listOf(
    TabSpec(Tab.HOME, "Главная", NoVpnIcons.Home),
    TabSpec(Tab.ROUTING, "Маршруты", NoVpnIcons.Routing),
    TabSpec(Tab.CONNECTION, "Подключение", NoVpnIcons.Connection),
    TabSpec(Tab.SETTINGS, "Настройки", NoVpnIcons.Settings),
)

/**
 * `.tabbar` — четыре раздела, как на десктопе. Активная вкладка отмечена
 * акцентной чертой сверху. Подписи в одну строку: если «Подключение» не
 * помещается, вкладка подписывается «Сервер».
 */
@Composable
private fun TabBar(tab: Tab, onGo: (Tab) -> Unit) {
    val c = NoVpnTheme.colors
    Column(modifier = Modifier.fillMaxWidth().background(c.bgRoot)) {
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(c.border))
        Row(modifier = Modifier.fillMaxWidth()) {
            for (spec in TABS) {
                val active = spec.id == tab
                val color = if (active) c.textPrimary else c.textMuted2
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onGo(spec.id) },
                    contentAlignment = Alignment.TopCenter,
                ) {
                    if (active) {
                        Box(
                            modifier = Modifier
                                .width(28.dp)
                                .height(2.dp)
                                .clip(RoundedCornerShape(bottomStart = 2.dp, bottomEnd = 2.dp))
                                .background(c.accentLight),
                        )
                    }
                    Column(
                        modifier = Modifier.padding(top = 10.dp, bottom = 9.dp, start = 2.dp, end = 2.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Icon(spec.icon, contentDescription = null, tint = color, modifier = Modifier.size(19.dp))
                        TabLabel(spec.label, color)
                    }
                }
            }
        }
    }
}

/** Подпись вкладки без переноса; длинная заменяется короткой, а не режется. */
@Composable
private fun TabLabel(label: String, color: Color) {
    var text by remember(label) { mutableStateOf(label) }
    Text(
        text,
        fontSize = 11.sp,
        lineHeight = 12.sp,
        fontWeight = FontWeight.SemiBold,
        color = color,
        maxLines = 1,
        softWrap = false,
        textAlign = TextAlign.Center,
        onTextLayout = { result ->
            if (result.hasVisualOverflow && text == "Подключение") text = "Сервер"
        },
    )
}

// ── Первый запуск ─────────────────────────────────────────────────────────

/** Логотип: щит с буквой N на синем градиенте — тот же образ, что у иконки приложения. */
@Composable
fun BrandMark(size: Int = 56) {
    Box(
        modifier = Modifier
            .size(size.dp)
            .clip(RoundedCornerShape((size * 0.22f).dp))
            .background(Brush.linearGradient(listOf(Color(0xFF3B82F6), Color(0xFF1D4ED8)))),
        contentAlignment = Alignment.Center,
    ) {
        Icon(NoVpnIcons.Brand, contentDescription = null, tint = Color.White, modifier = Modifier.size((size * 0.62f).dp))
    }
}

/**
 * Первый запуск: одна ссылка — и всё. Остальное приложение настроит само,
 * а поменять можно позже в «Подключении».
 */
@Composable
private fun Onboarding(repo: Repo, deepLink: String?, onDeepLinkUsed: () -> Unit) {
    val c = NoVpnTheme.colors
    var url by remember { mutableStateOf(deepLink.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(deepLink) {
        if (!deepLink.isNullOrBlank()) {
            url = deepLink
            onDeepLinkUsed()
        }
    }

    fun submit() {
        if (busy || url.isBlank()) return
        busy = true
        error = null
        scope.launch {
            val result = repo.checkSubscription(url)
            busy = false
            result.onSuccess {
                repo.update { st -> st.copy(onboarded = true) }
                repo.syncLists()
            }.onFailure { error = it.message ?: "Не удалось проверить подписку" }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(start = 24.dp, end = 24.dp, top = 30.dp, bottom = 26.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(24.dp))
        BrandMark(64)
        // Начертание — как на сайте и в десктопе: моноширинный, «vpn» акцентом.
        Row(modifier = Modifier.padding(top = 16.dp)) {
            Text("no", fontFamily = Mono, fontSize = 34.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
            Text("vpn", fontFamily = Mono, fontSize = 34.sp, fontWeight = FontWeight.SemiBold, color = c.accentLight)
        }
        Eyebrow("доступ без лишних вопросов", modifier = Modifier.padding(top = 5.dp))

        Spacer(Modifier.height(30.dp))
        TBody(
            "Через VPN пойдёт только то, что нужно: сайты и приложения, которые иначе не работают. " +
                "Всё остальное — напрямую, на полной скорости.",
            modifier = Modifier.fillMaxWidth(),
        )

        Column(modifier = Modifier.fillMaxWidth().padding(top = 26.dp)) {
            FieldLabel("Ссылка-подписка")
            Input(
                value = url,
                onChange = {
                    url = it
                    error = null
                },
                placeholder = "https://…/sub/…",
                mono = true,
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Go,
                onDone = { submit() },
            )
            TNote("Ссылку выдаёт ваш провайдер NoVPN — в панели или письмом.", modifier = Modifier.padding(top = 8.dp))
        }
        error?.let { Notice(it, tone = Tone.DANGER, modifier = Modifier.padding(top = 12.dp)) }

        Btn(
            if (busy) "Проверяем…" else "Продолжить",
            onClick = { submit() },
            size = BtnSize.LG,
            enabled = !busy && url.isNotBlank(),
            modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
        )
        LinkBtn(
            "Пропустить, добавлю позже",
            onClick = { repo.update { st -> st.copy(onboarded = true) } },
            modifier = Modifier.padding(top = 12.dp),
        )
    }
}
