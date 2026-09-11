package ru.appswire.novpn.ui

import android.text.format.DateUtils
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ru.appswire.novpn.data.Repo
import ru.appswire.novpn.store.AppRule
import ru.appswire.novpn.store.SiteRule
import ru.appswire.novpn.system.AppIcons
import ru.appswire.novpn.system.InstalledApps
import ru.appswire.novpn.vpn.ConnState
import ru.appswire.novpn.vpn.NoVpnService
import ru.appswire.novpn.vpn.VpnBus

/*
 * «Маршруты» — порт `apps/desktop/src/screens/Routing.tsx`. Расширенного режима
 * здесь нет: на Android правил по процессам не бывает, показывать нечего.
 */

private val ROUTING_TABS = listOf("apps" to "Приложения", "sites" to "Сайты", "lists" to "Списки")

@Composable
fun RoutingScreen(repo: Repo, tab: String, onTab: (String) -> Unit, onRulesChanged: () -> Unit) {
    Column(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.padding(start = 18.dp, end = 18.dp, top = 20.dp)) {
            ScreenTitle("Умная маршрутизация")
            ScreenSub("Что идёт через VPN, а что — напрямую.")
            Segmented(ROUTING_TABS, tab, onChange = onTab, modifier = Modifier.padding(bottom = 16.dp))
        }
        when (tab) {
            "apps" -> AppsTab(repo)
            "sites" -> SitesTab(repo, onRulesChanged)
            else -> ListsTab(repo, onRulesChanged)
        }
    }
}

// ── Приложения ────────────────────────────────────────────────────────────

/**
 * Иконка приложения из PackageManager. Грузится в фоне и кэшируется в памяти
 * ([AppIcons]); пока не готова — на её месте буква-аватар, чтобы список не
 * прыгал.
 */
@Composable
private fun rememberAppIcon(pkg: String): ImageBitmap? {
    val context = LocalContext.current
    val sizePx = with(LocalDensity.current) { 48.dp.roundToPx() }
    // Начальное значение — из кэша, чтобы при прокрутке назад иконка не мигала
    // аватаром; в фон уходим только за тем, чего в кэше ещё нет.
    var icon by remember(pkg) { mutableStateOf(AppIcons.cached(pkg)?.asImageBitmap()) }
    LaunchedEffect(pkg) {
        if (icon == null) {
            icon = withContext(Dispatchers.IO) { AppIcons.load(context, pkg, sizePx) }?.asImageBitmap()
        }
    }
    return icon
}

@Composable
private fun AppIcon(pkg: String, label: String) {
    val bitmap = rememberAppIcon(pkg)
    if (bitmap != null) {
        Image(
            bitmap = bitmap,
            contentDescription = null,
            modifier = Modifier.size(36.dp).clip(RoundedCornerShape(9.dp)),
        )
    } else {
        Avatar(label)
    }
}

/**
 * Три состояния одним касанием: «Напрямую» — приложение исключается из туннеля
 * средствами системы; «Авто» — правила нет, приложение в туннеле по умным
 * правилам; «Через VPN» — то же, что «Авто», но человек это выбрал явно и
 * приложение считается в «Через VPN» на главной. В хранилище: `direct` /
 * отсутствие правила / `vpn` — служба смотрит только на `direct`, так что
 * старые сохранённые правила читаются как прежде.
 */
@Composable
private fun RouteTri(value: String?, onChange: (String?) -> Unit) {
    val c = NoVpnTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(ShapeCtrl)
            .background(c.surface)
            .border(1.dp, c.border, ShapeCtrl)
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        @Composable
        fun seg(id: String?, label: String, fg: Color, bg: Color) {
            val active = id == value
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(5.dp))
                    .background(if (active) bg else Color.Transparent)
                    .clickable { if (!active) onChange(id) }
                    .padding(vertical = 8.dp, horizontal = 4.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (active) fg else c.textMuted,
                    maxLines = 1,
                    softWrap = false,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        seg("direct", "Напрямую", c.redFg, c.redBg)
        seg(null, "Авто", c.textPrimary, c.surfaceBtn2)
        seg("vpn", "Через VPN", c.greenFg, c.greenBg)
    }
}

@Composable
private fun AppsTab(repo: Repo) {
    val c = NoVpnTheme.colors
    val context = LocalContext.current
    val state by repo.state.collectAsState()
    val conn by VpnBus.state.collectAsState()
    var query by remember { mutableStateOf("") }
    var showSystem by remember { mutableStateOf(false) }
    // «Напрямую» меняет состав туннеля — это применяется только переподключением.
    var dirty by remember { mutableStateOf(false) }
    // Перечисление пакетов — не мгновенное, поэтому не на главном потоке.
    var all by remember { mutableStateOf<List<InstalledApps.Entry>?>(InstalledApps.cached()) }
    LaunchedEffect(Unit) {
        if (all == null) all = withContext(Dispatchers.IO) { InstalledApps.list(context) }
    }

    val rules = state.apps.associate { it.pkg to it.route }
    val needle = query.trim()
    // Сначала выбранные приложения, потом остальные: через VPN → напрямую → авто.
    // Внутри группы — по алфавиту. Так видно, что человек уже настроил.
    fun rank(route: String?): Int = when (route) {
        "vpn" -> 0
        "direct" -> 1
        else -> 2
    }
    val shown = (all ?: emptyList())
        .filter { showSystem || !it.system }
        .filter { needle.isEmpty() || it.label.contains(needle, true) || it.pkg.contains(needle, true) }
        .sortedWith(compareBy({ rank(rules[it.pkg]) }, { it.label.lowercase() }))

    fun setRoute(pkg: String, route: String?) {
        val was = rules[pkg]
        repo.update { st ->
            val rest = st.apps.filterNot { it.pkg == pkg }
            st.copy(apps = if (route == null) rest else rest + AppRule(pkg, route))
        }
        if (was == "direct" || route == "direct") dirty = true
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item(key = "toolbar") {
            Column {
                Input(
                    value = query,
                    onChange = { query = it },
                    placeholder = "Поиск приложения",
                    imeAction = ImeAction.Search,
                    leading = { Icon(NoVpnIcons.Search, contentDescription = null, tint = c.textFaint, modifier = Modifier.size(16.dp)) },
                )
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        if (all == null) "смотрим, что установлено…" else "показано ${shown.size} из ${all!!.size}",
                        fontFamily = Mono,
                        fontSize = 11.sp,
                        color = c.textMuted2,
                    )
                    Row(
                        modifier = Modifier.clip(ShapeCtrl).clickable { showSystem = !showSystem }.padding(horizontal = 4.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("Системные", fontSize = 13.sp, color = c.textMuted)
                        Toggle(on = showSystem, onChange = { showSystem = it })
                    }
                }
                if (dirty && conn == ConnState.ON) {
                    Notice(
                        "Изменения применятся после переподключения.",
                        tone = Tone.WARN,
                        modifier = Modifier.padding(top = 10.dp),
                        trailing = {
                            LinkBtn("Переподключить", onClick = {
                                NoVpnService.reconnect(context)
                                dirty = false
                            })
                        },
                    )
                }
                Spacer(Modifier.height(4.dp))
            }
        }

        if (all != null && shown.isEmpty()) {
            item(key = "empty") { Empty("Ничего не найдено", "Попробуйте другое слово.") }
        }

        items(shown, key = { it.pkg }) { entry ->
            val route = rules[entry.pkg]
            Card(padding = PaddingValues(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    AppIcon(entry.pkg, entry.label)
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            entry.label,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = c.textPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        TMeta(entry.pkg, modifier = Modifier.padding(top = 2.dp))
                    }
                }
                Box(modifier = Modifier.padding(top = 10.dp)) {
                    RouteTri(value = route, onChange = { setRoute(entry.pkg, it) })
                }
            }
        }

        item(key = "hint") {
            Hint(
                "Напрямую — приложение идёт мимо VPN. Через VPN — приложение всегда в туннеле; " +
                    "какие его сайты пойдут через сервер при умной маршрутизации, решают правила и списки.",
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

// ── Сайты ─────────────────────────────────────────────────────────────────

@Composable
private fun SitesTab(repo: Repo, onRulesChanged: () -> Unit) {
    val c = NoVpnTheme.colors
    val state by repo.state.collectAsState()
    var edit by remember { mutableStateOf<SiteRule?>(null) }
    var adding by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }

    val needle = query.trim().lowercase()
    val shown = if (needle.isEmpty()) state.sites else state.sites.filter {
        it.title.lowercase().contains(needle) || it.domain.contains(needle)
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item(key = "toolbar") {
            Column {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Input(
                        value = query,
                        onChange = { query = it },
                        placeholder = "Поиск сайта",
                        imeAction = ImeAction.Search,
                        modifier = Modifier.weight(1f),
                        leading = { Icon(NoVpnIcons.Search, contentDescription = null, tint = c.textFaint, modifier = Modifier.size(16.dp)) },
                    )
                    Btn("Добавить", onClick = { adding = true }, size = BtnSize.SM, icon = NoVpnIcons.Plus)
                }
                if (needle.isNotEmpty()) {
                    Text(
                        "показано ${shown.size} из ${state.sites.size}",
                        modifier = Modifier.padding(top = 8.dp),
                        fontFamily = Mono,
                        fontSize = 11.sp,
                        color = c.textMuted2,
                    )
                }
                Spacer(Modifier.height(4.dp))
            }
        }
        if (state.sites.isEmpty()) {
            item(key = "empty") { Empty("Пока пусто", "Добавьте сайт, которому нужен свой маршрут — он сильнее любых списков.") }
        } else if (shown.isEmpty()) {
            item(key = "none") { Empty("Ничего не найдено", "Попробуйте другое слово.") }
        }
        items(shown, key = { it.id }) { site ->
            Item(
                title = site.title,
                meta = site.domain + if (!site.enabled) " · выключено" else "",
                metaMono = true,
                leading = { Avatar(site.title) },
                trailing = { RouteTag(site.route) },
                onClick = { edit = site },
                enabledLook = site.enabled,
            )
        }
    }

    edit?.let { site ->
        // Берём свежую копию: диалог живёт дольше одного изменения.
        val cur = state.sites.firstOrNull { it.id == site.id } ?: site
        NoVpnDialog(title = cur.title, onClose = { edit = null }) {
            TNote(cur.domain, mono = true, modifier = Modifier.padding(bottom = 16.dp))
            SectionLabel("Маршрут", first = true)
            RouteSwitch(cur.route) { r ->
                repo.setSiteRoute(cur.id, r)
                onRulesChanged()
            }
            // Выключить, а не удалять: удобно проверить «а если без него», ничего не теряя.
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                TNote(if (cur.enabled) "Правило действует" else "Правило выключено")
                Toggle(on = cur.enabled, onChange = {
                    repo.toggleSite(cur.id)
                    onRulesChanged()
                })
            }
            Row(modifier = Modifier.padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                Btn("Убрать", kind = BtnKind.DANGER_OUTLINE, size = BtnSize.SM, icon = NoVpnIcons.Trash, onClick = {
                    repo.removeSite(cur.id)
                    onRulesChanged()
                    edit = null
                })
                Btn("Готово", size = BtnSize.SM, modifier = Modifier.weight(1f), onClick = { edit = null })
            }
        }
    }

    if (adding) {
        var domain by remember { mutableStateOf("") }
        var route by remember { mutableStateOf("vpn") }
        fun submit() {
            if (domain.isBlank()) return
            repo.addSite(domain, route)
            adding = false
            onRulesChanged()
        }
        NoVpnDialog(title = "Добавить сайт", onClose = { adding = false }) {
            FieldLabel("Сайт")
            Input(
                value = domain,
                onChange = { domain = it },
                placeholder = "example.com",
                mono = true,
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Done,
                onDone = { submit() },
            )
            TNote("Можно вставить целиком, со схемой и путём — лишнее уберём сами.", modifier = Modifier.padding(top = 8.dp))
            SectionLabel("Маршрут")
            RouteSwitch(route) { route = it }
            Btn("Добавить", enabled = domain.isNotBlank(), modifier = Modifier.fillMaxWidth().padding(top = 18.dp), onClick = { submit() })
        }
    }
}

// ── Списки ────────────────────────────────────────────────────────────────

@Composable
private fun ListsTab(repo: Repo, onRulesChanged: () -> Unit) {
    val c = NoVpnTheme.colors
    val state by repo.state.collectAsState()
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    // Списки читаются лениво с диска — после синхронизации перечитываем.
    val lists = remember(state.listsSyncedAt) { repo.lists }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(start = 18.dp, end = 18.dp, bottom = 24.dp),
    ) {
        Hint(
            "Готовые списки приходят с сервера NoVPN и обновляются сами. Список целиком либо " +
                "включён, либо выключен — а ваши собственные правила всегда сильнее списка.",
            modifier = Modifier.padding(bottom = 14.dp),
        )

        Card(padding = PaddingValues(horizontal = 16.dp, vertical = 15.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(modifier = Modifier.weight(1f)) {
                    TName(
                        when {
                            busy -> "Обновляем…"
                            lists == null -> "Списки ещё не скачаны"
                            else -> "Списки актуальны"
                        },
                        color = when {
                            busy -> c.amberFg
                            lists == null -> c.amberFg
                            else -> c.greenFg
                        },
                    )
                    TNote(
                        if (state.listsSyncedAt > 0) {
                            "Последняя синхронизация: ${DateUtils.getRelativeTimeSpanString(state.listsSyncedAt)}"
                        } else {
                            "Пока работает встроенный запас правил"
                        },
                        modifier = Modifier.padding(top = 3.dp),
                    )
                }
                Btn(
                    "Обновить",
                    kind = BtnKind.SECONDARY,
                    size = BtnSize.SM,
                    enabled = !busy && state.subUrl.isNotBlank(),
                    icon = NoVpnIcons.Refresh,
                    onClick = {
                        busy = true
                        message = null
                        scope.launch {
                            val r = repo.syncLists()
                            busy = false
                            isError = r.isFailure
                            message = r.fold(
                                onSuccess = { "Обновлено: ${count(it, "правило", "правила", "правил")}" },
                                onFailure = { it.message ?: "Не удалось обновить" },
                            )
                            onRulesChanged()
                        }
                    },
                )
            }
            message?.let { Notice(it, tone = if (isError) Tone.DANGER else Tone.OK, modifier = Modifier.padding(top = 12.dp)) }
        }

        Spacer(Modifier.height(14.dp))
        Item(
            title = "Недоступные ресурсы",
            meta = if (lists != null) {
                count(lists.total, "правило", "правила", "правил") + (lists.updatedAt?.let { " · обновлено $it" } ?: "")
            } else {
                "придёт с панели при первой синхронизации"
            },
            trailing = { Toggle(on = state.settings.autoUpdateLists, onChange = { v -> repo.update { it.copy(settings = it.settings.copy(autoUpdateLists = v)) } }) },
        )

        if (lists != null) {
            SectionLabel("Из чего состоит")
            Card(padding = PaddingValues(horizontal = 14.dp, vertical = 4.dp)) {
                listOf(
                    "Домены с поддоменами" to lists.vpnDomains.size,
                    "Точные домены" to lists.vpnFull.size,
                    "По части имени" to lists.vpnKeywords.size,
                    "Регулярные выражения" to lists.vpnRegex.size,
                    "Подсети и адреса" to lists.vpnIps.size,
                    "Напрямую" to lists.directDomains.size,
                ).forEachIndexed { i, (label, n) ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        TBody(label)
                        Text(n.toString(), fontFamily = Mono, fontSize = 13.sp, color = c.textSecondary)
                    }
                    if (i < 5) {
                        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(c.borderInner))
                    }
                }
            }
        }
    }
}
