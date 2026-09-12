package ru.appswire.novpn.ui

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import ru.appswire.novpn.data.Repo
import ru.appswire.novpn.system.Oem
import ru.appswire.novpn.vpn.VpnBus

/*
 * Экраны «Подключение», «Настройки», «Работа в фоне», «Журнал» — порты
 * `Connection.tsx` и `Settings.tsx` десктопа в той же вёрстке.
 */

/** Общая обёртка экрана: прокрутка и поля 18dp, как `.viewport`. */
@Composable
fun Viewport(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(start = 18.dp, end = 18.dp, top = 20.dp, bottom = 24.dp),
        content = content,
    )
}

/** Кнопка «Назад» вложенного экрана. */
@Composable
fun BackRow(onBack: () -> Unit) {
    val c = NoVpnTheme.colors
    Row(
        modifier = Modifier
            .clip(ShapeCtrl)
            .clickable { onBack() }
            .padding(end = 8.dp, top = 4.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(NoVpnIcons.Back, contentDescription = null, tint = c.link, modifier = Modifier.size(16.dp))
        Text("Назад", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = c.link)
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
    val c = NoVpnTheme.colors
    val state by repo.state.collectAsState()
    val denied by repo.deniedFlow.collectAsState()
    val stats by VpnBus.stats.collectAsState()
    val conn by VpnBus.state.collectAsState()
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }
    // Диалог смены ссылки открывается сам, когда ссылку принесли снаружи.
    var changing by remember(deepLink) { mutableStateOf(deepLink != null) }
    val scope = rememberCoroutineScope()
    val servers = repo.representatives(state)
    val fullAvailable = repo.fullAvailable(state)
    val selectedNode = repo.nodeFor(state)

    fun refresh(url: String) {
        busy = true
        message = null
        scope.launch {
            val r = repo.checkSubscription(url)
            busy = false
            onDeepLinkUsed()
            r.onSuccess {
                isError = false
                message = "Готово: ${count(it, "сервер", "сервера", "серверов")}"
                repo.syncLists()
                // Ручное обновление освежает всё, что относится к пользователю (§10),
                // включая резервный пул.
                repo.syncReserve()
                onRulesChanged()
            }.onFailure {
                isError = true
                message = it.message ?: "Не удалось обновить подписку"
            }
        }
    }

    Viewport {
        ScreenTitle("Подключение")
        ScreenSub("Подписка и выбор сервера.")

        SectionLabel("Подписка", first = true)
        Card(padding = PaddingValues(14.dp)) {
            val valid = state.subUrl.isNotBlank() && denied == null && state.servers.isNotEmpty()
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                StatusDot(if (valid) c.greenDot else c.redFg)
                Text(
                    when {
                        valid -> "Активна"
                        denied != null -> denied!!.message
                        state.subUrl.isBlank() -> "Не подключена"
                        else -> "Недействительна"
                    },
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (valid) c.greenFg else c.redFg,
                )
            }
            if (repo.meta?.unsupported == true) {
                Notice("Панель новее этого приложения: работаем в умном режиме, обновите NoVPN.", tone = Tone.WARN, modifier = Modifier.padding(top = 8.dp))
            }
            if (state.subUrl.isNotBlank()) {
                Text(
                    state.subUrl,
                    modifier = Modifier.padding(top = 10.dp),
                    fontFamily = Mono,
                    fontSize = 13.sp,
                    color = c.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            message?.let {
                Notice(it, tone = if (isError) Tone.DANGER else Tone.OK, modifier = Modifier.padding(top = 10.dp))
            }
            Row(modifier = Modifier.padding(top = 13.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Btn(
                    if (busy) "Проверяем…" else "Обновить",
                    onClick = { refresh(state.subUrl) },
                    kind = BtnKind.SECONDARY,
                    size = BtnSize.SM,
                    enabled = !busy && state.subUrl.isNotBlank(),
                    icon = NoVpnIcons.Refresh,
                    modifier = Modifier.weight(1f),
                )
                Btn(
                    if (state.subUrl.isBlank()) "Добавить" else "Изменить",
                    onClick = { changing = true },
                    kind = if (state.subUrl.isBlank()) BtnKind.PRIMARY else BtnKind.OUTLINE,
                    size = BtnSize.SM,
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        SectionLabel("Сервер")
        if (servers.isEmpty()) {
            Empty("Серверов пока нет", "Добавьте ссылку-подписку и нажмите «Обновить».")
        }
        // Один сервер — одна строка, даже если панель выдала два профиля (умный и
        // полный): какой из них использовать, решает тумблер на главном экране.
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            for (server in servers) {
                val selected = state.serverKey == server.key
                val offersFull = state.servers.any { it.key == server.key && it.mode == "full" }
                val parts = Flags.split(server.name)
                val shape = ShapeCtrl
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(shape)
                        .background(if (selected) c.blueBgSoft else Color.Transparent)
                        .border(1.dp, if (selected) c.accent else c.borderInput, shape)
                        .clickable {
                            repo.update { it.copy(serverKey = server.key) }
                            onRulesChanged()
                        }
                        .padding(horizontal = 14.dp, vertical = 13.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(11.dp),
                ) {
                    Radio(selected)
                    if (parts.flag.isNotEmpty()) {
                        Text(parts.flag, fontSize = 19.sp, maxLines = 1, softWrap = false, modifier = Modifier.widthIn(min = 26.dp))
                    }
                    Column(modifier = Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TName(parts.name.substringBefore(" · "), modifier = Modifier.weight(1f, fill = false))
                            if (server.recommended) Badge("рекомендуем")
                        }
                        TNote(
                            buildString {
                                append(server.host.ifEmpty { "—" })
                                if (offersFull) append(" · умная + полный VPN")
                            },
                            modifier = Modifier.padding(top = 3.dp),
                            mono = true,
                        )
                    }
                    // Задержка известна только после замера — до него честнее промолчать.
                    val ping = if (selected && conn == ru.appswire.novpn.vpn.ConnState.ON) stats.pingMs else null
                    if (ping != null) {
                        Text(
                            "$ping ms",
                            fontFamily = Mono,
                            fontSize = 13.sp,
                            color = when {
                                ping < 60 -> c.greenFg
                                ping < 110 -> c.amberFg
                                else -> c.redFg
                            },
                        )
                    }
                }
            }
        }
        if (selectedNode != null) {
            TNote(
                if (fullAvailable) {
                    "Умная маршрутизация · Полный VPN${if (selectedNode.mode == "full") " (выбран)" else ""}"
                } else {
                    "Умная маршрутизация"
                },
                modifier = Modifier.padding(top = 12.dp),
            )
        }
        TNote("Список серверов приходит из подписки и обновляется вместе с ней.", modifier = Modifier.padding(top = 6.dp))
    }

    if (changing) {
        var url by remember { mutableStateOf(deepLink ?: "") }
        NoVpnDialog(
            title = if (state.subUrl.isBlank()) "Добавить подписку" else "Изменить подписку",
            onClose = {
                changing = false
                onDeepLinkUsed()
            },
        ) {
            FieldLabel("Ссылка")
            Input(
                value = url,
                onChange = { url = it },
                placeholder = "https://…/sub/…",
                mono = true,
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Go,
                onDone = {
                    if (url.isNotBlank()) {
                        changing = false
                        refresh(url.trim())
                    }
                },
            )
            Btn(
                "Применить",
                onClick = {
                    changing = false
                    refresh(url.trim())
                },
                enabled = url.isNotBlank(),
                icon = NoVpnIcons.Check,
                modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
            )
        }
    }
}

// ── Настройки ─────────────────────────────────────────────────────────────

private val THEMES = listOf("system" to "Системная", "dark" to "Тёмная", "light" to "Светлая")
private val DNS = listOf("cloudflare" to "Cloudflare", "google" to "Google", "quad9" to "Quad9", "custom" to "Свой")

@Composable
fun SettingsScreen(
    repo: Repo,
    onRulesChanged: () -> Unit,
    onOpenBackground: () -> Unit,
    onOpenLog: () -> Unit,
    onOpenConnection: () -> Unit,
) {
    val c = NoVpnTheme.colors
    val state by repo.state.collectAsState()
    var advanced by remember { mutableStateOf(false) }
    val fullAvailable = repo.fullAvailable(state)

    Viewport {
        ScreenTitle("Настройки")
        ScreenSub("Поведение приложения и внешний вид.")

        SectionLabel("Запуск", first = true)
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ToggleItem(
                title = "Подключаться автоматически",
                meta = "При запуске приложения и после перезагрузки",
                checked = state.settings.autoconnect,
                onChange = { v -> repo.update { it.copy(settings = it.settings.copy(autoconnect = v)) } },
            )
            ChevronItem(title = "Работа в фоне", meta = "Батарея, автозапуск, постоянный VPN", onClick = onOpenBackground)
        }

        SectionLabel("Маршрутизация")
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (fullAvailable) {
                ToggleItem(
                    title = "Умная маршрутизация",
                    meta = if (state.smartRouting) "Через VPN идёт только нужное" else "Выключена: весь трафик через VPN",
                    checked = state.smartRouting,
                    onChange = { on ->
                        repo.update { it.copy(smartRouting = on, fullSince = if (on) 0 else System.currentTimeMillis()) }
                        onRulesChanged()
                    },
                )
            } else {
                ToggleItem(
                    title = "Умная маршрутизация",
                    meta = "Всегда включена: полный VPN появится, если его выдаст провайдер",
                    checked = true,
                    enabled = false,
                    onChange = {},
                )
            }
            ToggleItem(
                title = "Обновлять списки автоматически",
                checked = state.settings.autoUpdateLists,
                onChange = { v -> repo.update { it.copy(settings = it.settings.copy(autoUpdateLists = v)) } },
            )
            ToggleItem(
                title = "Локальная сеть — напрямую",
                meta = "Роутер, NAS и внутренние сайты в обход VPN",
                checked = state.settings.bypassLocal,
                onChange = { v ->
                    repo.update { it.copy(settings = it.settings.copy(bypassLocal = v)) }
                    onRulesChanged()
                },
            )
        }

        SectionLabel("Резервное подключение")
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ToggleCard(
                title = "Автоматическое восстановление",
                note = "Сам подбирает рабочий сервер и уходит на резерв, если обычные " +
                    "недоступны. Выключено — приложение только предупредит и предложит резерв вручную.",
                checked = state.settings.autoFailover,
                onChange = { v -> repo.update { it.copy(settings = it.settings.copy(autoFailover = v)) } },
            )
            ToggleCard(
                title = "Отправлять диагностику",
                note = "Помогает понять причину сбоев подключения. Можно выключить.",
                checked = state.settings.sendDiagnostics,
                onChange = { v -> repo.update { it.copy(settings = it.settings.copy(sendDiagnostics = v)) } },
            )
        }
        ReserveSubscription(repo)

        SectionLabel("Подписка")
        ChevronItem(
            title = "Текущая подписка",
            meta = state.subUrl.ifBlank { "не подключена" },
            metaMono = true,
            onClick = onOpenConnection,
        )

        SectionLabel("Уведомление")
        ToggleItem(
            title = "Скорость в уведомлении",
            meta = "Трафик и скорость в шторке, пока VPN включён",
            checked = state.settings.notifySpeed,
            onChange = { v -> repo.update { it.copy(settings = it.settings.copy(notifySpeed = v)) } },
        )

        SectionLabel("Тема")
        Segmented(THEMES, state.settings.theme, onChange = { id -> repo.update { it.copy(settings = it.settings.copy(theme = id)) } })
        TNote("«Системная» следует за темой телефона и меняется вместе с ней.", modifier = Modifier.padding(top = 8.dp))

        SectionLabel("Дополнительно")
        Item(
            title = "Расширенные настройки",
            meta = "Для тех, кто знает, зачем сюда зашёл",
            trailing = {
                Icon(
                    NoVpnIcons.Chevron,
                    contentDescription = null,
                    tint = c.textMuted2,
                    modifier = Modifier.size(15.dp).rotate(if (advanced) 90f else 0f),
                )
            },
            onClick = { advanced = !advanced },
        )
        if (advanced) AdvancedSettings(repo, onRulesChanged, onOpenLog)

        Text(
            "NoVPN Android ${ru.appswire.novpn.BuildConfig.VERSION_NAME}",
            modifier = Modifier.fillMaxWidth().padding(top = 26.dp),
            fontFamily = Mono,
            fontSize = 12.sp,
            color = c.textFainter,
            textAlign = TextAlign.Center,
        )
    }
}

/**
 * Тумблер с многострочным пояснением. Обычный `ToggleItem` подрезает подпись до
 * одной строки, а здесь текст важен, поэтому берём ту же карточку с тумблером,
 * что и «Умная маршрутизация» на главной.
 */
@Composable
private fun ToggleCard(title: String, note: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Card(padding = PaddingValues(horizontal = 16.dp, vertical = 15.dp), onClick = { onChange(!checked) }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(modifier = Modifier.weight(1f)) {
                TName(title)
                TNote(note, modifier = Modifier.padding(top = 3.dp))
            }
            Toggle(on = checked, onChange = onChange)
        }
    }
}

/**
 * Личная резервная подписка (§8). Показываем только действия: добавить и удалить.
 * Сам URL с доступом наружу не выводим — он хранится в приложении и не должен
 * попадать на экран. Признака «есть ли уже личная» у нас нет, поэтому даём обе
 * возможности сразу, без индикатора состояния.
 */
@Composable
private fun ReserveSubscription(repo: Repo) {
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }

    fun add() {
        val u = url.trim()
        if (u.isEmpty() || busy) return
        busy = true
        message = null
        scope.launch {
            val err = repo.setPersonalReserve(u)
            busy = false
            if (err != null) {
                isError = true
                message = err
            } else {
                isError = false
                message = "Добавлено"
                url = ""
            }
        }
    }

    fun remove() {
        if (busy) return
        busy = true
        message = null
        scope.launch {
            repo.removePersonalReserve()
            busy = false
            isError = false
            message = "Удалено"
        }
    }

    SectionLabel("Резервная подписка")
    TNote(
        "Используется, только когда обычное VPN-подключение недоступно. " +
            "Не смешивается с обычными серверами.",
        modifier = Modifier.padding(bottom = 10.dp),
    )
    Input(
        value = url,
        onChange = { url = it },
        placeholder = "https://…",
        mono = true,
        keyboardType = KeyboardType.Uri,
        imeAction = ImeAction.Go,
        onDone = { add() },
    )
    message?.let {
        Notice(it, tone = if (isError) Tone.DANGER else Tone.OK, modifier = Modifier.padding(top = 10.dp))
    }
    Btn(
        if (busy) "Секунду…" else "Добавить резервную подписку",
        onClick = { add() },
        kind = BtnKind.SECONDARY,
        size = BtnSize.SM,
        enabled = !busy && url.isNotBlank(),
        modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
    )
    Btn(
        "Удалить резервную подписку",
        onClick = { remove() },
        kind = BtnKind.OUTLINE,
        size = BtnSize.SM,
        enabled = !busy,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    )
    TNote(
        "Саму ссылку не показываем: в ней доступ к серверу, и она хранится только в приложении.",
        modifier = Modifier.padding(top = 10.dp),
    )
}

/** Расширенные: DNS, свои локальные домены, диагностика. Реально работающие, а не заглушка. */
@Composable
private fun AdvancedSettings(repo: Repo, onRulesChanged: () -> Unit, onOpenLog: () -> Unit) {
    val c = NoVpnTheme.colors
    val state by repo.state.collectAsState()
    var domain by remember { mutableStateOf("") }
    var customDns by remember(state.settings.customDns) { mutableStateOf(state.settings.customDns) }

    fun addDomain() {
        val d = domain.trim().lowercase().trimStart('.')
        if (d.isEmpty() || d in state.settings.customLocalDomains) return
        repo.update { it.copy(settings = it.settings.copy(customLocalDomains = it.settings.customLocalDomains + d)) }
        domain = ""
        onRulesChanged()
    }

    Column(modifier = Modifier.padding(top = 8.dp)) {
        SectionLabel("DNS-сервер", first = true)
        Segmented(DNS, state.settings.dnsProvider, onChange = { id ->
            repo.update { it.copy(settings = it.settings.copy(dnsProvider = id)) }
            onRulesChanged()
        })
        if (state.settings.dnsProvider == "custom") {
            Row(modifier = Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Input(
                    value = customDns,
                    onChange = { customDns = it },
                    placeholder = "https://dns.example/dns-query или 192.168.1.1",
                    mono = true,
                    keyboardType = KeyboardType.Uri,
                    modifier = Modifier.weight(1f),
                    onDone = {
                        repo.update { it.copy(settings = it.settings.copy(customDns = customDns)) }
                        onRulesChanged()
                    },
                )
                Btn("Применить", kind = BtnKind.SECONDARY, size = BtnSize.SM, enabled = customDns != state.settings.customDns, onClick = {
                    repo.update { it.copy(settings = it.settings.copy(customDns = customDns)) }
                    onRulesChanged()
                })
            }
        }
        TNote(
            if (state.settings.dnsProvider == "custom") {
                "Свой DNS-сервер: адрес роутера/домашнего DNS или ссылка DoH. Несколько — через запятую."
            } else {
                "Запросы имён идут через DNS-over-HTTPS, чтобы провайдер не подменял ответы."
            },
            modifier = Modifier.padding(top = 8.dp),
        )

        SectionLabel("Свои локальные домены")
        TNote("Корпоративные суффиксы, которые всегда идут напрямую (например corp.example).", modifier = Modifier.padding(bottom = 8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Input(
                value = domain,
                onChange = { domain = it },
                placeholder = "ad.company.net",
                mono = true,
                keyboardType = KeyboardType.Uri,
                modifier = Modifier.weight(1f),
                onDone = { addDomain() },
            )
            Btn("Добавить", kind = BtnKind.SECONDARY, size = BtnSize.SM, enabled = domain.isNotBlank(), onClick = { addDomain() })
        }
        if (state.settings.customLocalDomains.isNotEmpty()) {
            Row(
                modifier = Modifier.padding(top = 10.dp).horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                for (d in state.settings.customLocalDomains) {
                    Text(
                        "$d ✕",
                        modifier = Modifier
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(999.dp))
                            .background(c.grayBg)
                            .clickable {
                                repo.update { it.copy(settings = it.settings.copy(customLocalDomains = it.settings.customLocalDomains - d)) }
                                onRulesChanged()
                            }
                            .padding(horizontal = 11.dp, vertical = 5.dp),
                        fontFamily = Mono,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        color = c.grayFg,
                    )
                }
            }
        }

        SectionLabel("Диагностика")
        Btn("Открыть журнал движка", onClick = onOpenLog, kind = BtnKind.OUTLINE, size = BtnSize.SM, modifier = Modifier.fillMaxWidth())
    }
}

// ── Работа в фоне ─────────────────────────────────────────────────────────

@Composable
fun BackgroundScreen(repo: Repo, onBack: () -> Unit) {
    val c = NoVpnTheme.colors
    val context = LocalContext.current
    // Список пересобираем на каждый заход: человек мог только что что-то разрешить.
    val hints = remember { Oem.hints(context) }

    Viewport {
        BackRow(onBack)
        ScreenTitle("Работа в фоне")
        ScreenSub(
            "VPN должен работать и с закрытым приложением. Голый Android так и делает, но оболочки " +
                "производителей закрывают приложения «ради батареи». Ниже — то, что стоит разрешить.",
        )

        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            for (hint in hints) {
                Card(padding = PaddingValues(horizontal = 15.dp, vertical = 14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        StatusDot(
                            when (hint.done) {
                                true -> c.greenDot
                                false -> c.redFg
                                null -> c.textMuted2
                            },
                        )
                        TName(hint.title)
                    }
                    TNote(hint.text, modifier = Modifier.padding(top = 6.dp))
                    if (hint.done == true) {
                        TNote("Уже разрешено", modifier = Modifier.padding(top = 8.dp), color = c.greenFg)
                    } else if (hint.action != null) {
                        val action: Intent = hint.action
                        Btn(
                            "Открыть настройки",
                            onClick = { runCatching { context.startActivity(action) } },
                            kind = BtnKind.SECONDARY,
                            size = BtnSize.SM,
                            modifier = Modifier.padding(top = 10.dp),
                        )
                    }
                }
            }
        }

        Notice(
            "Если включить системный «Постоянный VPN» вместе с «Блокировать соединения без VPN», " +
                "приложения, которым вы выбрали «напрямую», потеряют интернет: система запретит им " +
                "ходить мимо туннеля. Само приложение NoVPN при этом продолжит работать.",
            tone = Tone.WARN,
            modifier = Modifier.padding(top = 14.dp),
        )
        Spacer(Modifier.height(8.dp))
    }
}

// ── Журнал ────────────────────────────────────────────────────────────────

@Composable
fun LogScreen(repo: Repo, onBack: () -> Unit) {
    val c = NoVpnTheme.colors
    var text by remember { mutableStateOf(repo.store.logTail()) }
    var diag by remember { mutableStateOf(repo.recentDiag()) }
    Viewport {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            BackRow(onBack)
            Spacer(Modifier.weight(1f))
            Btn(
                "Обновить",
                onClick = { text = repo.store.logTail(); diag = repo.recentDiag() },
                kind = BtnKind.SECONDARY,
                size = BtnSize.SM,
                icon = NoVpnIcons.Refresh,
            )
        }
        ScreenTitle("Журнал")
        ScreenSub("Диагностика подключения и последние строки движка.")

        // Диагностика: что приложение проверяло и как решало (нет интернета, сервер
        // недоступен, ограниченный режим, уход на резерв). Понятным языком.
        if (diag.isNotEmpty()) {
            SectionLabel("Диагностика", first = true)
            androidx.compose.foundation.layout.Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(ShapeCtrl)
                    .background(c.surface)
                    .border(1.dp, c.borderInner, ShapeCtrl)
                    .padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                diag.forEach { e ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(e.at.substringAfter('T'), fontFamily = Mono, fontSize = 11.sp, color = c.textMuted2)
                        Text(
                            e.text,
                            fontSize = 12.sp,
                            lineHeight = 16.sp,
                            color = if (e.kind == "error") c.redFg else if (e.kind == "reserve") c.amberFg else c.textBody,
                        )
                    }
                }
            }
            SectionLabel("Журнал движка")
        } else {
            SectionLabel("Журнал движка", first = true)
        }
        Text(
            text,
            modifier = Modifier
                .fillMaxWidth()
                .clip(ShapeCtrl)
                .background(c.surface)
                .border(1.dp, c.borderInner, ShapeCtrl)
                .padding(12.dp),
            fontFamily = Mono,
            fontSize = 11.sp,
            lineHeight = 16.sp,
            color = c.textBody,
        )
    }
}
