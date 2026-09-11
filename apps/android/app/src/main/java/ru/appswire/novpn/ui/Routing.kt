package ru.appswire.novpn.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.appswire.novpn.data.Repo
import ru.appswire.novpn.store.AppRule
import ru.appswire.novpn.system.InstalledApps
import ru.appswire.novpn.vpn.ConnState
import ru.appswire.novpn.vpn.NoVpnService
import ru.appswire.novpn.vpn.VpnBus

@Composable
fun RoutingScreen(repo: Repo, onRulesChanged: () -> Unit) {
    var tab by remember { mutableStateOf(0) }
    val titles = listOf("Приложения", "Сайты", "Списки")

    Column(modifier = Modifier.fillMaxSize()) {
        Text(
            "Маршрутизация",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 8.dp),
        )
        TabRow(selectedTabIndex = tab) {
            titles.forEachIndexed { i, title ->
                Tab(selected = tab == i, onClick = { tab = i }, text = { Text(title) })
            }
        }
        when (tab) {
            0 -> AppsTab(repo)
            1 -> SitesTab(repo, onRulesChanged)
            else -> ListsTab(repo, onRulesChanged)
        }
    }
}

/**
 * Приложения. На Android правил по процессам нет: движок не может узнать, чьё
 * это соединение. Зато система умеет исключать приложение из VPN целиком — это и
 * есть «напрямую». Всё остальное идёт в туннель и подчиняется умным правилам.
 */
@Composable
private fun AppsTab(repo: Repo) {
    val context = LocalContext.current
    val state by repo.state.collectAsState()
    val conn by VpnBus.state.collectAsState()
    var query by remember { mutableStateOf("") }
    var showSystem by remember { mutableStateOf(false) }
    var dirty by remember { mutableStateOf(false) }
    val all = remember { InstalledApps.list(context) }

    val direct = state.apps.filter { it.route == "direct" }.map { it.pkg }.toSet()
    val shown = all
        .filter { showSystem || !it.system }
        .filter { query.isBlank() || it.label.contains(query, true) || it.pkg.contains(query, true) }

    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            placeholder = { Text("Поиск приложения") },
            singleLine = true,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp),
        )
        Row(
            modifier = Modifier.padding(vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FilterChip(
                selected = showSystem,
                onClick = { showSystem = !showSystem },
                label = { Text("Системные") },
            )
            Text(
                "Напрямую: ${direct.size}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (dirty && conn == ConnState.ON) {
            Notice("Изменения применятся после переподключения.", Tone.WARN)
            OutlinedButton(
                onClick = {
                    NoVpnService.reconnect(context)
                    dirty = false
                },
                modifier = Modifier.padding(top = 8.dp),
            ) {
                Text("Переподключить")
            }
        }
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(shown, key = { it.pkg }) { entry ->
                val isDirect = entry.pkg in direct
                ToggleItem(
                    title = entry.label,
                    subtitle = if (isDirect) "Напрямую, мимо VPN" else "В туннеле, по умным правилам",
                    checked = isDirect,
                    onChange = { wantDirect ->
                        repo.update { st ->
                            val rest = st.apps.filterNot { it.pkg == entry.pkg }
                            st.copy(apps = if (wantDirect) rest + AppRule(entry.pkg, "direct") else rest)
                        }
                        dirty = true
                    },
                )
            }
        }
    }
}

@Composable
private fun SitesTab(repo: Repo, onRulesChanged: () -> Unit) {
    val state by repo.state.collectAsState()
    var adding by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Только ваши правила",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = { adding = true }) { Text("Добавить") }
        }

        if (state.sites.isEmpty()) {
            Notice("Пока пусто. Добавьте сайт, которому нужен свой маршрут — он будет сильнее любых списков.")
        }

        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(state.sites, key = { it.id }) { site ->
                Card {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(site.domain, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                if (site.route == "vpn") "Через VPN" else "Напрямую",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        TextButton(onClick = {
                            repo.setSiteRoute(site.id, if (site.route == "vpn") "direct" else "vpn")
                            onRulesChanged()
                        }) {
                            Text("Сменить")
                        }
                        TextButton(onClick = {
                            repo.removeSite(site.id)
                            onRulesChanged()
                        }) {
                            Text("Убрать")
                        }
                    }
                }
            }
        }
    }

    if (adding) {
        var domain by remember { mutableStateOf("") }
        var route by remember { mutableStateOf("vpn") }
        AlertDialog(
            onDismissRequest = { adding = false },
            title = { Text("Новый сайт") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = domain,
                        onValueChange = { domain = it },
                        placeholder = { Text("example.com") },
                        singleLine = true,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(
                            selected = route == "vpn",
                            onClick = { route = "vpn" },
                            label = { Text("Через VPN") },
                        )
                        FilterChip(
                            selected = route == "direct",
                            onClick = { route = "direct" },
                            label = { Text("Напрямую") },
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    repo.addSite(domain, route)
                    adding = false
                    onRulesChanged()
                }) {
                    Text("Добавить")
                }
            },
            dismissButton = { TextButton(onClick = { adding = false }) { Text("Отмена") } },
        )
    }
}

@Composable
private fun ListsTab(repo: Repo, onRulesChanged: () -> Unit) {
    val state by repo.state.collectAsState()
    val lists = repo.lists
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Card {
            Text("Недоступные ресурсы", style = MaterialTheme.typography.bodyMedium)
            Text(
                "Сайты, которым нужен VPN. Список приходит с панели и обновляется сам.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                buildString {
                    append("Правил: ${lists?.total ?: 0}")
                    if (state.listsSyncedAt > 0) {
                        append(" · обновлено ")
                        append(android.text.format.DateUtils.getRelativeTimeSpanString(state.listsSyncedAt))
                    }
                },
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
        if (lists != null) {
            Card {
                Text("Из чего состоит", style = MaterialTheme.typography.bodyMedium)
                listOf(
                    "Домены с поддоменами" to lists.vpnDomains.size,
                    "Точные домены" to lists.vpnFull.size,
                    "По части имени" to lists.vpnKeywords.size,
                    "Регулярные выражения" to lists.vpnRegex.size,
                    "Подсети и адреса" to lists.vpnIps.size,
                    "Напрямую" to lists.directDomains.size,
                ).forEach { (label, count) ->
                    RowItem(title = label, trailing = { Text("$count") })
                }
            }
        }
        message?.let { Notice(it) }
        Button(
            onClick = {
                busy = true
                scope.launch {
                    val r = repo.syncLists()
                    busy = false
                    message = r.fold(
                        onSuccess = { "Обновлено: правил — $it" },
                        onFailure = { it.message ?: "Не удалось обновить" },
                    )
                    onRulesChanged()
                }
            },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (busy) "Обновляем…" else "Обновить списки")
        }
    }
}
