package ru.appswire.novpn.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.appswire.novpn.data.Repo

enum class Tab { HOME, ROUTING, CONNECTION, SETTINGS }

@Composable
fun AppRoot(
    repo: Repo,
    deepLink: String?,
    onDeepLinkUsed: () -> Unit,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onRulesChanged: () -> Unit,
) {
    val state by repo.state.collectAsState()
    var tab by rememberSaveable { mutableStateOf(Tab.HOME) }
    var screen by rememberSaveable { mutableStateOf<String?>(null) }

    // Ссылка из панели: если приложение ещё не настроено — ведём через первый
    // запуск, иначе сразу открываем экран подписки с подставленным адресом.
    LaunchedEffect(deepLink) {
        if (deepLink != null && state.onboarded) tab = Tab.CONNECTION
    }

    if (!state.onboarded) {
        Onboarding(repo = repo, deepLink = deepLink, onDeepLinkUsed = onDeepLinkUsed)
        return
    }

    when (screen) {
        "background" -> {
            BackgroundScreen(repo = repo, onBack = { screen = null })
            return
        }
        "log" -> {
            LogScreen(repo = repo, onBack = { screen = null })
            return
        }
    }

    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = tab == Tab.HOME,
                    onClick = { tab = Tab.HOME },
                    icon = { Icon(Icons.Filled.Home, contentDescription = null) },
                    label = { Text("Главная") },
                )
                NavigationBarItem(
                    selected = tab == Tab.ROUTING,
                    onClick = { tab = Tab.ROUTING },
                    icon = { Icon(Icons.Filled.Shield, contentDescription = null) },
                    label = { Text("Маршруты") },
                )
                NavigationBarItem(
                    selected = tab == Tab.CONNECTION,
                    onClick = { tab = Tab.CONNECTION },
                    icon = { Icon(Icons.Filled.Language, contentDescription = null) },
                    label = { Text("Подключение") },
                )
                NavigationBarItem(
                    selected = tab == Tab.SETTINGS,
                    onClick = { tab = Tab.SETTINGS },
                    icon = { Icon(Icons.Filled.Settings, contentDescription = null) },
                    label = { Text("Настройки") },
                )
            }
        },
    ) { inner ->
        Column(modifier = Modifier.padding(inner)) {
            when (tab) {
                Tab.HOME -> HomeScreen(
                    repo = repo,
                    onConnect = onConnect,
                    onDisconnect = onDisconnect,
                    onRulesChanged = onRulesChanged,
                    onOpenRouting = { tab = Tab.ROUTING },
                    onOpenConnection = { tab = Tab.CONNECTION },
                    onOpenBackground = { screen = "background" },
                )

                Tab.ROUTING -> RoutingScreen(repo = repo, onRulesChanged = onRulesChanged)

                Tab.CONNECTION -> ConnectionScreen(
                    repo = repo,
                    deepLink = deepLink,
                    onDeepLinkUsed = onDeepLinkUsed,
                    onRulesChanged = onRulesChanged,
                )

                Tab.SETTINGS -> SettingsScreen(
                    repo = repo,
                    onRulesChanged = onRulesChanged,
                    onOpenBackground = { screen = "background" },
                    onOpenLog = { screen = "log" },
                )
            }
        }
    }
}

/**
 * Первый запуск: одна ссылка — и всё. Остальное приложение настроит само,
 * а поменять можно позже в настройках.
 */
@Composable
private fun Onboarding(repo: Repo, deepLink: String?, onDeepLinkUsed: () -> Unit) {
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

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("NoVPN", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text(
            "Через VPN пойдёт только то, что нужно: сайты и приложения, которые иначе не работают. " +
                "Всё остальное — напрямую, на полной скорости.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        SectionLabel("Ссылка-подписка")
        OutlinedTextField(
            value = url,
            onValueChange = { url = it; error = null },
            placeholder = { Text("https://…/sub/…") },
            singleLine = true,
            isError = error != null,
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { Notice(it, Tone.DANGER) }
        Button(
            onClick = {
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
            },
            enabled = !busy && url.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (busy) "Проверяем…" else "Продолжить")
        }
        TextButton(
            onClick = { repo.update { st -> st.copy(onboarded = true) } },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Пропустить, добавлю позже")
        }
    }
}
