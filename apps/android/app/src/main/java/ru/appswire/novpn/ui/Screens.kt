package ru.appswire.novpn.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.appswire.novpn.data.Repo
import ru.appswire.novpn.system.Oem
import ru.appswire.novpn.vpn.ConnState
import ru.appswire.novpn.vpn.VpnBus

// ── Главная ───────────────────────────────────────────────────────────────

@Composable
fun HomeScreen(
    repo: Repo,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onRulesChanged: () -> Unit,
    onOpenRouting: () -> Unit,
    onOpenConnection: () -> Unit,
    onOpenBackground: () -> Unit,
) {
    val state by repo.state.collectAsState()
    val conn by VpnBus.state.collectAsState()
    val error by VpnBus.error.collectAsState()
    val stats by VpnBus.stats.collectAsState()
    val denied by repo.deniedFlow.collectAsState()
    val context = LocalContext.current
    val node = repo.nodeFor(state)
    val fullAvailable = repo.fullAvailable(state)

    val title = when (conn) {
        ConnState.OFF -> "Не подключено"
        ConnState.CONNECTING -> "Подключаемся…"
        ConnState.ON -> "Подключено"
        ConnState.RECONNECTING -> "Восстанавливаем связь…"
        ConnState.ERROR -> "Не удалось подключиться"
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("NoVPN", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)

        denied?.let { Notice("${it.message}. Подключение заблокировано панелью.", Tone.DANGER) }
        error?.let { Notice(it, Tone.DANGER) }

        Card {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Dot(
                    when (conn) {
                        ConnState.ON -> StatusOk
                        ConnState.ERROR -> StatusDanger
                        ConnState.OFF -> MaterialTheme.colorScheme.onSurfaceVariant
                        else -> MaterialTheme.colorScheme.primary
                    },
                )
                Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            }
            Text(
                node?.name ?: "Сервер не выбран",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp, start = 16.dp),
            )
            Spacer(Modifier.height(12.dp))
            if (conn == ConnState.ON || conn == ConnState.CONNECTING || conn == ConnState.RECONNECTING) {
                Button(
                    onClick = onDisconnect,
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                ) {
                    Text("Отключить", color = MaterialTheme.colorScheme.onSurface)
                }
            } else {
                Button(
                    onClick = onConnect,
                    enabled = node != null && denied == null,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Запустить")
                }
            }
            if (node == null) {
                Spacer(Modifier.height(8.dp))
                TextButton(onClick = onOpenConnection, modifier = Modifier.fillMaxWidth()) {
                    Text("Подключить подписку")
                }
            }
        }

        if (conn == ConnState.ON) {
            Card {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column {
                        Text("Скачано", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(humanBytes(stats.downTotal), style = MaterialTheme.typography.bodyMedium)
                        Text(humanSpeed(stats.downSpeed), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column {
                        Text("Отдано", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(humanBytes(stats.upTotal), style = MaterialTheme.typography.bodyMedium)
                        Text(humanSpeed(stats.upSpeed), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column {
                        Text("Соединений", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("${stats.connections}", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }

        SectionLabel("Маршрутизация")
        Card {
            ToggleItem(
                title = "Умная маршрутизация",
                subtitle = if (repo.effectiveSmart(state)) {
                    "Через VPN идёт только нужное"
                } else {
                    "Выключена: весь трафик через VPN"
                },
                checked = repo.effectiveSmart(state),
                enabled = fullAvailable,
                onChange = { on ->
                    repo.update {
                        it.copy(smartRouting = on, fullSince = if (on) 0 else System.currentTimeMillis())
                    }
                    onRulesChanged()
                },
            )
            if (!fullAvailable) {
                Text(
                    "Полный VPN появится, если его выдаст провайдер подписки.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else if (!state.smartRouting) {
                val hours = node?.fullTimeoutHours ?: 0.0
                if (hours > 0) {
                    Text(
                        "Полный VPN сам вернётся на умную маршрутизацию через ${formatHours(hours)}.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            RowItem(
                title = "Что идёт через VPN",
                subtitle = "Приложения, сайты и готовые списки",
                onClick = onOpenRouting,
            )
        }

        // Ограничения фона — главная причина «сам выключился».
        val batteryOk = Oem.ignoresBatteryOptimizations(context)
        if (!batteryOk || Oem.needsAutostart) {
            SectionLabel("Работа в фоне")
            Card(onClick = onOpenBackground) {
                Text(
                    if (!batteryOk) {
                        "Система может усыпить приложение, и связь оборвётся. Проверьте настройки."
                    } else {
                        "На вашей оболочке нужен автозапуск, иначе VPN не поднимется после перезагрузки."
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    "Открыть проверку",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}

private fun formatHours(h: Double): String {
    val total = (h * 60).toInt()
    val hours = total / 60
    val minutes = total % 60
    return when {
        hours > 0 && minutes > 0 -> "$hours ч $minutes мин"
        hours > 0 -> "$hours ч"
        else -> "$minutes мин"
    }
}

// ── Подключение ───────────────────────────────────────────────────────────

@Composable
fun ConnectionScreen(
    repo: Repo,
    deepLink: String?,
    onDeepLinkUsed: () -> Unit,
    onRulesChanged: () -> Unit,
) {
    val state by repo.state.collectAsState()
    var url by remember(state.subUrl, deepLink) { mutableStateOf(deepLink ?: state.subUrl) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val servers = repo.representatives(state)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("Подключение", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)

        SectionLabel("Ссылка-подписка")
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            placeholder = { Text("https://…/sub/…") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        message?.let { Notice(it, if (isError) Tone.DANGER else Tone.INFO) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    busy = true
                    message = null
                    scope.launch {
                        val r = repo.checkSubscription(url)
                        busy = false
                        onDeepLinkUsed()
                        r.onSuccess {
                            isError = false
                            message = "Готово: серверов — $it"
                            repo.syncLists()
                            onRulesChanged()
                        }.onFailure {
                            isError = true
                            message = it.message ?: "Не удалось обновить подписку"
                        }
                    }
                },
                enabled = !busy && url.isNotBlank(),
            ) {
                Text(if (busy) "Проверяем…" else "Обновить")
            }
            OutlinedButton(
                onClick = {
                    busy = true
                    scope.launch {
                        val r = repo.syncLists()
                        busy = false
                        isError = r.isFailure
                        message = r.fold(
                            onSuccess = { "Списки обновлены: правил — $it" },
                            onFailure = { it.message ?: "Не удалось обновить списки" },
                        )
                        onRulesChanged()
                    }
                },
                enabled = !busy && state.subUrl.isNotBlank(),
            ) {
                Text("Списки")
            }
        }

        SectionLabel("Сервер")
        if (servers.isEmpty()) {
            Notice("Серверов пока нет — вставьте ссылку-подписку и нажмите «Обновить».")
        }
        servers.forEach { server ->
            val selected = state.serverKey == server.key
            Card(onClick = {
                repo.update { it.copy(serverKey = server.key) }
                onRulesChanged()
            }) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(server.name, style = MaterialTheme.typography.bodyMedium)
                        Text(
                            buildString {
                                append(server.host)
                                if (server.recommended) append(" · рекомендуем")
                                if (repo.groupOf(state.copy(serverKey = server.key)).any { it.mode == "full" }) {
                                    append(" · есть полный VPN")
                                }
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (selected) Dot(StatusOk, 10)
                }
            }
        }
    }
}

// ── Настройки ─────────────────────────────────────────────────────────────

@Composable
fun SettingsScreen(
    repo: Repo,
    onRulesChanged: () -> Unit,
    onOpenBackground: () -> Unit,
    onOpenLog: () -> Unit,
) {
    val state by repo.state.collectAsState()
    var advanced by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("Настройки", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)

        SectionLabel("Запуск")
        Card {
            ToggleItem(
                title = "Подключаться автоматически",
                subtitle = "При запуске приложения и после перезагрузки телефона",
                checked = state.settings.autoconnect,
                onChange = { v -> repo.update { it.copy(settings = it.settings.copy(autoconnect = v)) } },
            )
            RowItem(
                title = "Работа в фоне",
                subtitle = "Батарея, автозапуск, постоянный VPN",
                onClick = onOpenBackground,
            )
        }

        SectionLabel("Маршрутизация")
        Card {
            ToggleItem(
                title = "Обновлять списки автоматически",
                checked = state.settings.autoUpdateLists,
                onChange = { v -> repo.update { it.copy(settings = it.settings.copy(autoUpdateLists = v)) } },
            )
            ToggleItem(
                title = "Локальная сеть — напрямую",
                subtitle = "Роутер, сетевое хранилище и внутренние сайты мимо VPN",
                checked = state.settings.bypassLocal,
                onChange = { v ->
                    repo.update { it.copy(settings = it.settings.copy(bypassLocal = v)) }
                    onRulesChanged()
                },
            )
        }

        SectionLabel("Внешний вид")
        Card {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("system" to "Системная", "dark" to "Тёмная", "light" to "Светлая").forEach { (id, label) ->
                    FilterChip(
                        selected = state.settings.theme == id,
                        onClick = { repo.update { it.copy(settings = it.settings.copy(theme = id)) } },
                        label = { Text(label) },
                    )
                }
            }
            ToggleItem(
                title = "Скорость в уведомлении",
                checked = state.settings.notifySpeed,
                onChange = { v -> repo.update { it.copy(settings = it.settings.copy(notifySpeed = v)) } },
            )
        }

        SectionLabel("Дополнительно")
        Card(onClick = { advanced = !advanced }) {
            Text(if (advanced) "Свернуть" else "Расширенные настройки", style = MaterialTheme.typography.bodyMedium)
        }
        if (advanced) {
            Card {
                Text("DNS-сервер", style = MaterialTheme.typography.bodyMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                    listOf(
                        "cloudflare" to "Cloudflare",
                        "google" to "Google",
                        "quad9" to "Quad9",
                        "custom" to "Свой",
                    ).forEach { (id, label) ->
                        FilterChip(
                            selected = state.settings.dnsProvider == id,
                            onClick = {
                                repo.update { it.copy(settings = it.settings.copy(dnsProvider = id)) }
                                onRulesChanged()
                            },
                            label = { Text(label) },
                        )
                    }
                }
                if (state.settings.dnsProvider == "custom") {
                    OutlinedTextField(
                        value = state.settings.customDns,
                        onValueChange = { v -> repo.update { it.copy(settings = it.settings.copy(customDns = v)) } },
                        placeholder = { Text("https://dns.example/dns-query") },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 8.dp),
                    )
                    TextButton(onClick = onRulesChanged) { Text("Применить") }
                }
            }
            Card {
                RowItem(title = "Журнал движка", subtitle = "Что происходило при подключении", onClick = onOpenLog)
            }
        }

        Spacer(Modifier.height(12.dp))
        Text(
            "Версия ${ru.appswire.novpn.BuildConfig.VERSION_NAME}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ── Работа в фоне ─────────────────────────────────────────────────────────

@Composable
fun BackgroundScreen(repo: Repo, onBack: () -> Unit) {
    val context = LocalContext.current
    // Список пересобираем на каждый заход: человек мог только что что-то разрешить.
    val hints = remember { Oem.hints(context) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        TextButton(onClick = onBack) { Text("‹ Назад") }
        Text("Работа в фоне", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text(
            "VPN должен работать и с закрытым приложением. Голый Android так и делает, но оболочки " +
                "производителей закрывают приложения «ради батареи». Ниже — то, что стоит разрешить.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        hints.forEach { hint ->
            Card {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    when (hint.done) {
                        true -> Dot(StatusOk)
                        false -> Dot(StatusDanger)
                        null -> Dot(MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(hint.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                }
                Text(
                    hint.text,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp),
                )
                if (hint.done == true) {
                    Text(
                        "Уже разрешено",
                        style = MaterialTheme.typography.bodySmall,
                        color = StatusOk,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                } else if (hint.action != null) {
                    val action: Intent = hint.action
                    OutlinedButton(
                        onClick = { runCatching { context.startActivity(action) } },
                        modifier = Modifier.padding(top = 8.dp),
                    ) {
                        Text("Открыть настройки")
                    }
                }
            }
        }

        Notice(
            "Если включить системный «Постоянный VPN» вместе с «Блокировать соединения без VPN», " +
                "приложения, которым вы выбрали «напрямую», потеряют интернет: система запретит им " +
                "ходить мимо туннеля. Само приложение NoVPN при этом продолжит работать.",
            Tone.WARN,
        )
    }
}

// ── Журнал ────────────────────────────────────────────────────────────────

@Composable
fun LogScreen(repo: Repo, onBack: () -> Unit) {
    var text by remember { mutableStateOf(repo.store.logTail()) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = onBack) { Text("‹ Назад") }
            TextButton(onClick = { text = repo.store.logTail() }) { Text("Обновить") }
        }
        Text("Журнал движка", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
