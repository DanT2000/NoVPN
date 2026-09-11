package ru.appswire.novpn.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ru.appswire.novpn.core.Preset
import ru.appswire.novpn.data.Repo
import ru.appswire.novpn.vpn.ConnState
import ru.appswire.novpn.vpn.NetDiagnosis
import ru.appswire.novpn.vpn.NoVpnService
import ru.appswire.novpn.vpn.VpnBus

/*
 * Главный экран — порт `apps/desktop/src/screens/Home.tsx`. Один смысловой
 * центр: развилка и кнопка под ней. Всё остальное намеренно тише и мельче.
 */

/** «полчаса» / «час» / «2 часа» — понятная человеку длительность таймера возврата. */
private fun fmtTimeout(hours: Double): String {
    if (hours < 1) {
        val m = Math.round(hours * 60).toInt()
        return if (m == 30) "полчаса" else count(m, "минуту", "минуты", "минут")
    }
    val whole = hours.toInt()
    return if (hours == whole.toDouble()) count(whole, "час", "часа", "часов") else "$hours ч"
}

@Composable
fun HomeScreen(
    repo: Repo,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onRulesChanged: () -> Unit,
    onOpenRoutingApps: () -> Unit,
    onOpenConnection: () -> Unit,
) {
    val c = NoVpnTheme.colors
    val state by repo.state.collectAsState()
    val conn by VpnBus.state.collectAsState()
    val error by VpnBus.error.collectAsState()
    val stats by VpnBus.stats.collectAsState()
    // Резервная система: не null у reserve — работаем через аварийный сервер;
    // offerReserve — предложить перейти вручную; diagnosis — чем объяснить сбой.
    val reserve by VpnBus.reserve.collectAsState()
    val offerReserve by VpnBus.offerReserve.collectAsState()
    val diagnosis by VpnBus.diagnosis.collectAsState()
    val denied by repo.deniedFlow.collectAsState()
    val context = LocalContext.current
    val node = repo.nodeFor(state)
    val fullAvailable = repo.fullAvailable(state)
    val smart = repo.effectiveSmart(state)
    val live = conn == ConnState.ON || conn == ConnState.CONNECTING || conn == ConnState.RECONNECTING

    // Число сайтов «через VPN»: правила списков панели плюс только РУЧНЫЕ сайты —
    // одни и те же не считаются дважды. Пока списки не скачались, работает
    // встроенный запас, его и показываем: цифра должна совпадать с тем, что
    // реально уйдёт в движок.
    val lists = repo.lists
    val listRules = remember(lists) {
        if (lists != null && lists.vpnDomains.isNotEmpty()) {
            lists.vpnDomains.size + lists.vpnFull.size + lists.vpnKeywords.size + lists.vpnRegex.size + lists.vpnIps.size
        } else {
            Preset.fallbackVpnDomains(context).size
        }
    }
    val manualVpnSites = state.sites.count { it.enabled && it.route == "vpn" }
    val totalSites = listRules + manualVpnSites
    val vpnApps = state.apps.count { it.route == "vpn" }

    // В резервном режиме статус явно другой — янтарный «Резервное подключение»
    // вместо зелёного «Подключено»: человек должен видеть, что это подстраховка,
    // а не обычный сервер. Захватываем в локальную val, чтобы работал smart-cast.
    val res = reserve
    val label = if (res != null) "Резервное подключение" else when (conn) {
        ConnState.OFF -> "Не подключено"
        ConnState.CONNECTING -> "Подключаемся…"
        ConnState.ON -> "Подключено"
        ConnState.RECONNECTING -> "Восстанавливаем связь…"
        ConnState.ERROR -> "Не удалось подключиться"
    }
    val labelColor = if (res != null) c.amberFg else c.textPrimary
    val dot = if (res != null) c.amberFg else when (conn) {
        ConnState.ON -> c.greenDot
        ConnState.CONNECTING, ConnState.RECONNECTING -> c.amberFg
        ConnState.ERROR -> c.redFg
        ConnState.OFF -> c.textMuted2
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(start = 18.dp, end = 18.dp, top = 20.dp),
        ) {
            // Полоса уведомления — только когда есть что сказать. Отказ панели
            // важнее ошибки движка: пока доступ отозван, подключаться бессмысленно.
            denied?.let { Notice("${it.message}. Подключение заблокировано панелью.", tone = Tone.DANGER, modifier = Modifier.padding(bottom = 14.dp)) }
            if (denied == null && conn == ConnState.ERROR && error != null) {
                Notice(error!!, tone = Tone.DANGER, modifier = Modifier.padding(bottom = 14.dp))
            }

            RouteFork(
                conn = conn,
                smart = smart,
                vpnLabel = if (smart) count(totalSites, "правило", "правила", "правил") else "весь трафик",
                directLabel = "всё остальное",
            )

            // Статус: точка и крупный текст, под ним моно-строка про сервер.
            Column(
                modifier = Modifier.fillMaxWidth().padding(top = 18.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    StatusDot(dot)
                    Text(label, fontSize = 21.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.3).sp, color = labelColor)
                }
                val sub = when {
                    res != null -> Flags.label(res.server)
                    node == null -> "Сервер не выбран"
                    live -> buildString {
                        append(Flags.label(node.name))
                        stats.pingMs?.let { append(" · $it ms") }
                    }
                    conn == ConnState.ERROR -> "Сервер не отвечает"
                    else -> "Трафик идёт как обычно"
                }
                Text(sub, modifier = Modifier.padding(top = 7.dp), fontFamily = Mono, fontSize = 13.sp, color = c.textMuted, textAlign = TextAlign.Center)
                if (conn == ConnState.ON) {
                    Text(
                        "↓ ${humanBytes(stats.downTotal)} · ↑ ${humanBytes(stats.upTotal)} · ${count(stats.connections, "соединение", "соединения", "соединений")}",
                        modifier = Modifier.padding(top = 4.dp),
                        fontFamily = Mono,
                        fontSize = 11.sp,
                        color = c.textMuted2,
                        textAlign = TextAlign.Center,
                    )
                }
                // Тихая подпись диагностики — не тревожная плашка, а объяснение
                // вполголоса. В резервном режиме объяснять уже нечего.
                if (res == null) {
                    val hint = when {
                        diagnosis == NetDiagnosis.NO_INTERNET && live -> "Похоже, интернета сейчас нет"
                        diagnosis == NetDiagnosis.RESTRICTED && !repo.reserveAvailable() -> "Возможно, сеть работает в ограниченном режиме"
                        else -> null
                    }
                    if (hint != null) {
                        Text(hint, modifier = Modifier.padding(top = 7.dp), fontSize = 13.sp, color = c.textMuted, textAlign = TextAlign.Center)
                    }
                }
            }

            // Резервный режим: даём сменить аварийный сервер вручную и коротко
            // объясняем, почему трафик идёт не как обычно.
            if (res != null) {
                Card(
                    modifier = Modifier.padding(top = 18.dp),
                    padding = PaddingValues(horizontal = 16.dp, vertical = 15.dp),
                    background = c.amberNoticeBg,
                    borderColor = c.amberNoticeBorder,
                ) {
                    TName("Резервное подключение", color = c.amberFg)
                    TNote(
                        "Обычные серверы NoVPN сейчас недоступны. Приложение временно " +
                            "работает через резервный сервер и само вернётся на обычный, " +
                            "когда сеть восстановится.",
                        modifier = Modifier.padding(top = 6.dp),
                    )
                    Btn(
                        "Сменить резервный сервер",
                        onClick = { NoVpnService.changeReserve(context) },
                        kind = BtnKind.OUTLINE,
                        size = BtnSize.SM,
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    )
                }
            }

            // Автовосстановление выключено, обычные серверы недоступны, но резерв
            // есть — предлагаем перейти вручную, а не делаем это молча за человека.
            if (res == null && offerReserve) {
                Card(
                    modifier = Modifier.padding(top = 18.dp),
                    padding = PaddingValues(horizontal = 16.dp, vertical = 15.dp),
                    background = c.amberNoticeBg,
                    borderColor = c.amberNoticeBorder,
                ) {
                    TName("Обычные серверы недоступны", color = c.amberFg)
                    TNote("Похоже, сеть работает в ограниченном режиме.", modifier = Modifier.padding(top = 6.dp))
                    Btn(
                        "Перейти на резерв",
                        onClick = { NoVpnService.useReserve(context) },
                        kind = BtnKind.SECONDARY,
                        size = BtnSize.SM,
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    )
                }
            }

            // Один тумблер: ВКЛ — умная маршрутизация, ВЫКЛ — полный VPN. Выключить
            // можно только если сервер выдал полный профиль. Если не выдал — тумблера
            // просто нет, и объяснять человеку нечего.
            val fullTimeoutHours = node?.fullTimeoutHours ?: 0.0
            Card(modifier = Modifier.padding(top = 20.dp), padding = PaddingValues(horizontal = 16.dp, vertical = 15.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(modifier = Modifier.weight(1f)) {
                        TName("Умная маршрутизация")
                        TNote(
                            when {
                                !fullAvailable || state.smartRouting -> "Через VPN идёт только нужное"
                                fullTimeoutHours > 0 -> "Полный VPN. Вернётся на умную маршрутизацию через ${fmtTimeout(fullTimeoutHours)}"
                                else -> "Полный VPN: весь трафик идёт через туннель"
                            },
                            modifier = Modifier.padding(top = 3.dp),
                        )
                    }
                    if (fullAvailable) {
                        Toggle(on = state.smartRouting, onChange = { on ->
                            repo.update { it.copy(smartRouting = on, fullSince = if (on) 0 else System.currentTimeMillis()) }
                            onRulesChanged()
                        })
                    }
                }
                if (fullAvailable && !state.smartRouting) {
                    TNote(
                        "Российские сайты тоже пойдут через VPN, а трафик расходуется быстрее." +
                            if (fullTimeoutHours > 0) " Ничего делать не нужно — через ${fmtTimeout(fullTimeoutHours)} умная маршрутизация включится автоматически." else "",
                        modifier = Modifier.padding(top = 10.dp),
                        color = c.amberFg,
                    )
                }
            }

            // «Через VPN» — не перечень, а количество: перечень живёт в «Маршрутах».
            if (smart) {
                Card(
                    modifier = Modifier.padding(top = 9.dp),
                    padding = PaddingValues(horizontal = 16.dp, vertical = 15.dp),
                    onClick = onOpenRoutingApps,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TName("Через VPN", modifier = Modifier.weight(1f))
                        Chevron(size = 17)
                    }
                    TBody(
                        "${count(totalSites, "сайт", "сайта", "сайтов")} · ${count(vpnApps, "приложение", "приложения", "приложений")}",
                        modifier = Modifier.padding(top = 9.dp),
                    )
                }
            }

            if (node == null) {
                Card(modifier = Modifier.padding(top = 9.dp), padding = PaddingValues(horizontal = 16.dp, vertical = 15.dp), onClick = onOpenConnection) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(modifier = Modifier.weight(1f)) {
                            TName("Подключить подписку")
                            TNote("Ссылку выдаёт ваш провайдер NoVPN", modifier = Modifier.padding(top = 3.dp))
                        }
                        Chevron(size = 17)
                    }
                }
            }

            // Карточки «Работа в фоне» на главной больше нет: она отвлекала от
            // главного действия. Настройка фона осталась в разделе «Настройки».
            Spacer(Modifier.height(16.dp))
        }

        // Кнопка прижата к низу и не уезжает при прокрутке — до неё одно движение
        // из любого места экрана. Отключение красное: оно обрывает защиту.
        Box(modifier = Modifier.fillMaxWidth().background(c.bgRoot).padding(horizontal = 18.dp, vertical = 14.dp)) {
            when {
                live -> Btn("Отключить", onClick = onDisconnect, kind = BtnKind.DANGER, size = BtnSize.LG, modifier = Modifier.fillMaxWidth())
                conn == ConnState.ERROR -> Btn("Повторить", onClick = onConnect, size = BtnSize.LG, enabled = node != null && denied == null, modifier = Modifier.fillMaxWidth())
                else -> Btn("Запустить", onClick = onConnect, size = BtnSize.LG, enabled = node != null && denied == null, modifier = Modifier.fillMaxWidth())
            }
        }
    }
}
