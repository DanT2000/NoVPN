package ru.appswire.novpn.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import ru.appswire.novpn.MainActivity
import ru.appswire.novpn.R
import ru.appswire.novpn.core.Config
import ru.appswire.novpn.core.Sub
import ru.appswire.novpn.data.Repo

/**
 * Служба VPN: поднимает туннель системы, запускает движок и следит, чтобы он жил.
 *
 * Про «закрыл приложение — VPN выключился». Этого быть не должно, и поэтому:
 *  - служба работает как foreground с постоянным уведомлением;
 *  - в манифесте `android:stopWithTask="false"` — смахивание из недавних задач
 *    убивает окно, но не службу;
 *  - `START_STICKY` — если систему припёрло по памяти и она нас убила, служба
 *    поднимется сама и переподключится по сохранённому состоянию;
 *  - сторож раз в несколько секунд проверяет, жив ли процесс движка, и
 *    перезапускает его, не трогая туннель.
 *
 * Все действия над туннелем и движком идут под одним мьютексом. Без него две
 * команды подряд (двойное нажатие, sticky-рестарт поверх ручного запуска,
 * автозапуск при загрузке) запускали два движка на один порт и теряли
 * дескриптор туннеля — человек получал «Подключено» при мёртвом туннеле.
 *
 * Чего это НЕ лечит: агрессивные «оптимизаторы» на оболочках производителей
 * (MIUI/HyperOS, EMUI, ColorOS). Там нужно разрешение на автозапуск и снятие
 * ограничений батареи — этим занимается экран «Работа в фоне» (Oem.kt).
 */
class NoVpnService : VpnService() {

    private lateinit var repo: Repo

    @Volatile
    private var engine: Engine? = null

    @Volatile
    private var tun: ParcelFileDescriptor? = null

    @Volatile
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    @Volatile
    private var watchdog: Job? = null

    /** Идёт остановка: длинные шаги подключения должны это заметить и не мешать. */
    @Volatile
    private var stopping = false

    /**
      * Необработанное исключение в корутине убивает весь процесс. Для службы с
      * START_STICKY это худший исход: система поднимает её заново, connect()
      * падает снова, и человек видит бесконечное «Подключаемся…» без единого
      * слова о причине. Ловим и показываем.
      */
    private val crashes = CoroutineExceptionHandler { _, e ->
        Log.e(TAG, "сбой в служебной корутине", e)
        VpnBus.fail("Внутренний сбой: ${e.message ?: e::class.java.simpleName}")
        runCatching { notifyError("Внутренний сбой: ${e.message ?: e::class.java.simpleName}") }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + crashes)

    /** Один мьютекс на весь жизненный цикл туннеля. */
    private val lock = Mutex()

    /** Заявки на перестройку правил. CONFLATED: важна последняя, а не каждая. */
    private val rebuild = Channel<Unit>(Channel.CONFLATED)

    @Volatile
    private var lastDown = 0L

    @Volatile
    private var lastUp = 0L

    @Volatile
    private var lastStatsAt = 0L

    /** Последний применённый список системных DNS — чтобы не переписывать конфиг зря. */
    @Volatile
    private var lastDns: List<String> = emptyList()

    override fun onCreate() {
        super.onCreate()
        repo = Repo.get(this)
        createChannel()
        // Движок от прошлой жизни приложения мог пережить нас: он держит старый
        // туннель и гонит трафик, а управлять им уже некому.
        scope.launch { runCatching { Engine(this@NoVpnService, repo.store).killLeftover() } }
        startRebuildLoop()
        startFailoverLoop()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopping = true
                scope.launch {
                    lock.withLock { teardown() }
                    stopSelf()
                }
                return START_NOT_STICKY
            }

            ACTION_RELOAD -> {
                rebuild.trySend(Unit)
                return START_STICKY
            }

            ACTION_RECONNECT -> {
                // Список приложений, исключённых из VPN, задаётся в момент
                // establish() и на лету не меняется — туннель нужно поднять заново.
                scope.launch {
                    lock.withLock {
                        closeTunnelAndEngine()
                        connect()
                    }
                }
                return START_STICKY
            }

            ACTION_CHANGE_RESERVE -> {
                // Человек в резервном режиме нажал «Сменить резервный сервер».
                scope.launch { runCatching { changeReserve() } }
                return START_STICKY
            }

            ACTION_USE_RESERVE -> {
                // Автовосстановление выключено, человек согласился уйти на резерв.
                scope.launch { runCatching { forceReserve() } }
                return START_STICKY
            }

            else -> {
                // Сюда попадают три случая: обычный запуск, перезапуск службы
                // системой (intent == null) и системный «Постоянный VPN», который
                // шлёт интент с action android.net.VpnService. Все три означают
                // «подключайся по сохранённому состоянию».
                stopping = false
                if (!startForegroundSafely(notification("Подключаемся…", null))) {
                    // Без foreground система убьёт службу через минуты, а человек
                    // решит, что «VPN сам выключается». Честнее не подключаться.
                    VpnBus.fail("Система не дала работать в фоне. Откройте приложение и попробуйте снова.")
                    stopSelf()
                    return START_NOT_STICKY
                }
                scope.launch { lock.withLock { connect() } }
                return START_STICKY
            }
        }
    }

    // ── подключение ──

    private suspend fun connect() {
        runCatching { connectInner() }.onFailure {
            Log.e(TAG, "подключение сорвалось", it)
            fail("Не удалось подключиться: ${it.message ?: it::class.java.simpleName}")
        }
    }

    private fun connectInner() {
        if (stopping) return
        VpnBus.setState(ConnState.CONNECTING)
        repo.denied?.let {
            fail(it.message)
            return
        }
        val node = repo.nodeFor()
        if (node == null) {
            fail("Сервер не выбран — откройте «Подключение».")
            return
        }
        VpnBus.setServer(node.name)

        val eng = Engine(this, repo.store).also { engine = it }
        if (!eng.isInstalled()) {
            fail("Движок не найден в сборке приложения.")
            return
        }

        val descriptor = establishTunnel()
        if (descriptor == null) {
            fail("Система не дала поднять туннель. Проверьте разрешение на VPN.")
            return
        }
        tun = descriptor
        if (stopping) return

        val secret = eng.newSecret()
        val config = repo.buildConfig(Config.TUN_FD, secret)
        if (config == null) {
            fail("Подписка не загружена — откройте «Подключение» и обновите её.")
            return
        }
        eng.start(config, descriptor.fd)?.let {
            fail(it)
            return
        }
        when (val started = eng.waitReady()) {
            is Engine.Started.Ok -> Unit
            is Engine.Started.PortBusy -> {
                fail(started.message)
                return
            }
            is Engine.Started.Died -> {
                fail("Движок остановился при запуске: ${started.message}")
                return
            }
            is Engine.Started.Timeout -> {
                fail("Движок не ответил за 15 секунд. ${started.message}")
                return
            }
        }
        if (stopping) return
        eng.control.selectProxy(node.name)

        lastDown = 0
        lastUp = 0
        lastStatsAt = System.currentTimeMillis()
        lastDns = repo.systemDns()

        // Новое подключение начинается как обычное: если прошлый сеанс завершился
        // в резервном режиме, сбрасываем его.
        VpnBus.setReserve(null)
        reserveReported = 0
        lastReserveReport = System.currentTimeMillis()

        VpnBus.setState(ConnState.ON)
        notify(notification("Подключено", node.name))
        registerNetworkCallback()
        startWatchdog()

        repo.recordDiag("info", "Подключено к серверу: ${node.name}")

        // Резервный пул обновляем в фоне, а затем сразу проверяем, что выбранный
        // сервер реально работает — если нет, подбор запускается без ожидания.
        // Заодно досылаем накопленный журнал диагностики (интернет уже есть).
        scope.launch {
            runCatching { repo.uploadDiag() }
            runCatching { repo.syncReserve() }
            triggerFailover()
        }
    }

    private fun establishTunnel(): ParcelFileDescriptor? {
        val st = repo.state.value
        val builder = Builder()
            .setSession(SESSION)
            .setMtu(Config.MTU)
            .addAddress("172.19.0.1", 30)
            .addRoute("0.0.0.0", 0)
            // DNS внутри туннеля: движок перехватывает любой :53 (dns-hijack),
            // поэтому адрес нужен лишь как «куда системе слать запросы».
            .addDnsServer("172.19.0.2")
            // IPv6 заворачиваем в туннель намеренно, хотя движок его не проксирует:
            // иначе часть трафика ушла бы мимо VPN настоящим адресом.
            .addAddress("fdfe:dcba:9876::1", 126)
            .addRoute("::", 0)
            .setConfigureIntent(
                PendingIntent.getActivity(
                    this, 0, Intent(this, MainActivity::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) builder.setMetered(false)

        // Анти-петля: собственный трафик приложения (а с ним и процесса движка —
        // у него тот же UID) не должен попадать в туннель, иначе соединение к
        // VPN-серверу завернулось бы само в себя и получился бы замкнутый контур:
        // «Подключено», а интернета нет. Правила DIRECT для адреса сервера от этого
        // НЕ спасают — сокет движка всё равно пошёл бы в туннель.
        // Поэтому неудача здесь фатальна, а не «ну и ладно».
        val selfExcluded = runCatching { builder.addDisallowedApplication(packageName) }.isSuccess
        if (!selfExcluded) {
            Log.e(TAG, "не удалось исключить себя из VPN — подключение отменено")
            return null
        }

        // Приложения, которым человек выбрал «напрямую», из туннеля исключаются
        // целиком: правил по процессам на Android нет (см. Rules). Но только в
        // умном режиме — в «Полном VPN» исключений быть не должно, иначе такое
        // приложение пойдёт с реального адреса, а человек уверен в обратном.
        if (repo.effectiveSmart(st)) {
            for (rule in st.apps) {
                if (rule.route != "direct") continue
                runCatching { builder.addDisallowedApplication(rule.pkg) }
                    .onFailure { Log.w(TAG, "приложение ${rule.pkg} не установлено, пропускаем") }
            }
        }

        return runCatching { builder.establish() }.getOrNull()
    }

    // ── перестройка правил без разрыва туннеля ──

    /**
     * Заявки на перестройку приходят пачками: смена сети даёт до полутора десятков
     * событий за пару секунд. Собираем их в одну — пересборка конфига это разбор
     * подписки, десятки тысяч правил и перезапись файла, делать это по каждому
     * чиху значит подвесить телефон на переключении Wi-Fi.
     */
    private fun startRebuildLoop() {
        scope.launch {
            for (unused in rebuild) {
                delay(REBUILD_DEBOUNCE_MS)
                // Забираем всё, что накопилось, пока ждали.
                while (rebuild.tryReceive().isSuccess) Unit
                lock.withLock { applyRules() }
            }
        }
    }

    private fun applyRules() {
        val eng = engine ?: return
        if (!eng.isAlive() || stopping) return
        val node = repo.nodeFor() ?: return
        val config = repo.buildConfig(Config.TUN_FD, eng.secret) ?: return
        repo.store.writeConfig(config)?.let {
            Log.e(TAG, "конфиг не записан: $it")
            return
        }
        if (eng.control.reload(repo.store.configFile().absolutePath)) {
            // Группа типа select помнит прошлый выбор: без явного указания движок
            // остался бы на старом сервере, хотя в окне выбран новый. В резервном
            // режиме удерживаем резервный сервер, а не сбрасываемся на обычный.
            val reserve = VpnBus.reserve.value
            val active = reserve?.server ?: node.name
            eng.control.selectProxy(active)
            VpnBus.setServer(active)
            notify(notification(if (reserve != null) "Резервное подключение" else "Подключено", active))
        }
    }

    // ── сторож ──

    private fun startWatchdog() {
        watchdog?.cancel()
        watchdog = scope.launch {
            var failures = 0
            while (isActive) {
                delay(WATCHDOG_MS)
                if (stopping) break
                val eng = engine ?: break
                if (!eng.isAlive()) {
                    failures++
                    Log.w(TAG, "движок умер, попытка восстановления №$failures")
                    VpnBus.setState(ConnState.RECONNECTING)
                    notify(notification("Восстанавливаем подключение…", null))
                    val restored = lock.withLock { restartEngine(eng) }
                    if (restored) {
                        failures = 0
                    } else if (failures >= MAX_RESTARTS) {
                        fail("Движок не запускается. Откройте приложение и подключитесь заново.")
                        return@launch
                    } else {
                        // Пауза растёт: если дело в нехватке памяти, долбиться каждые
                        // четыре секунды — верный способ сделать только хуже.
                        delay(WATCHDOG_MS * failures)
                    }
                    continue
                }

                // Возврат с полного VPN на умный по таймеру сервера (контракт, 7).
                checkFullTimeout()
                updateStats(eng)

                // Периодическая проверка реального доступа: если выбранный сервер
                // перестал пропускать трафик (блокировка на лету), подбор сам найдёт
                // рабочий. В резервном режиме тот же тик проверяет возврат на обычный.
                val now = System.currentTimeMillis()
                if (now - lastHealthTick >= HEALTH_TICK_MS && VpnBus.state.value == ConnState.ON) {
                    lastHealthTick = now
                    triggerFailover()
                }
            }
        }
    }

    @Volatile
    private var lastHealthTick = 0L

    private fun restartEngine(eng: Engine): Boolean {
        val fd = tun?.fd ?: return false
        val config = repo.buildConfig(Config.TUN_FD, eng.newSecret()) ?: return false
        if (eng.start(config, fd) != null) return false
        if (eng.waitReady(10_000) !is Engine.Started.Ok) return false
        // После перезапуска движка удерживаем активный сервер: в резервном режиме —
        // резервный (он тоже в новом конфиге), иначе выбранный обычный.
        val reserve = VpnBus.reserve.value
        val active = reserve?.server ?: repo.nodeFor()?.name
        active?.let { eng.control.selectProxy(it) }
        // Счётчики движка обнулились вместе с ним: иначе скорость показывалась бы
        // нулевой до конца сессии, а трафик прыгнул бы назад.
        lastDown = 0
        lastUp = 0
        lastStatsAt = System.currentTimeMillis()
        VpnBus.setState(ConnState.ON)
        notify(notification(if (reserve != null) "Резервное подключение" else "Подключено", active))
        return true
    }

    private fun checkFullTimeout() {
        val st = repo.state.value
        if (st.smartRouting || st.fullSince <= 0) return
        val hours = repo.nodeFor(st)?.fullTimeoutHours ?: return
        if (hours <= 0) return
        val passed = System.currentTimeMillis() - st.fullSince
        if (passed < (hours * 3600_000).toLong()) return
        repo.update { it.copy(smartRouting = true, fullSince = 0) }
        rebuild.trySend(Unit)
        notify(notification("Вернулись на умную маршрутизацию", repo.nodeFor()?.name))
    }

    private fun updateStats(eng: Engine) {
        val now = System.currentTimeMillis()
        if (now - lastStatsAt < STATS_MS) return
        val totals = eng.control.totals() ?: return
        // Делим на РЕАЛЬНО прошедшее время: после сна экрана тик приходит с
        // опозданием, и деление на константу рисовало бы «480 МБ/с».
        val seconds = ((now - lastStatsAt) / 1000.0).coerceAtLeast(0.5)
        val downSpeed = ((totals.down - lastDown).coerceAtLeast(0) / seconds).toLong()
        val upSpeed = ((totals.up - lastUp).coerceAtLeast(0) / seconds).toLong()
        lastDown = totals.down
        lastUp = totals.up
        lastStatsAt = now
        reportReserveUsageIfNeeded(totals.down + totals.up)
        VpnBus.setStats(
            VpnStats(
                downTotal = totals.down, upTotal = totals.up,
                downSpeed = downSpeed, upSpeed = upSpeed,
                connections = totals.connections,
                pingMs = VpnBus.stats.value.pingMs,
            ),
        )
        if (repo.state.value.settings.notifySpeed && VpnBus.state.value == ConnState.ON) {
            notify(notification("Подключено", repo.nodeFor()?.name, speedLine(downSpeed, upSpeed)))
        }
    }

    private fun speedLine(down: Long, up: Long): String = "↓ ${speed(down)}  ↑ ${speed(up)}"

    private fun speed(bytesPerSec: Long): String = when {
        bytesPerSec >= 1_000_000 -> "%.1f МБ/с".format(bytesPerSec / 1_000_000.0)
        bytesPerSec >= 1_000 -> "%d КБ/с".format(bytesPerSec / 1_000)
        else -> "$bytesPerSec Б/с"
    }

    // ── диагностика и переключение на резерв ──

    /** Идёт оценка: не запускаем вторую параллельно (delay-тесты идут секундами). */
    @Volatile
    private var evaluating = false

    @Volatile
    private var lastReturnCheck = 0L

    /** Запросы «проверь и переключись, если надо». CONFLATED — важна последняя. */
    private val failover = Channel<Unit>(Channel.CONFLATED)

    private fun startFailoverLoop() {
        scope.launch {
            for (unused in failover) {
                delay(400)
                while (failover.tryReceive().isSuccess) Unit
                runCatching { evaluate() }.onFailure { Log.w(TAG, "оценка сорвалась: ${it.message}") }
            }
        }
    }

    private fun triggerFailover() {
        failover.trySend(Unit)
    }

    private data class Candidate(val name: String, val host: String, val reserve: Boolean)

    /** Реальный доступ ЧЕРЕЗ прокси: delay-тест к настоящему сайту (не ping, не порт). */
    private fun worksThrough(eng: Engine, name: String): Boolean {
        for (url in HEALTH_URLS) {
            if (stopping || !eng.isAlive()) return false
            if (eng.control.delay(name, url, HEALTH_TIMEOUT_MS) != null) return true
        }
        return false
    }

    /**
     * Первый реально рабочий сервер из списка. Проверяем пачками параллельно:
     * резервных серверов может быть под сотню (у каждого оператора свой рабочий),
     * и перебирать их по очереди по 3 секунды — это минуты ожидания. Внутри пачки
     * берём кандидата с наименьшим номером среди ответивших — порядок сохраняется.
     */
    private suspend fun firstWorking(eng: Engine, candidates: List<Candidate>): Candidate? {
        for (chunk in candidates.chunked(HEALTH_CONCURRENCY)) {
            if (stopping || !eng.isAlive()) return null
            val checked = coroutineScope {
                chunk.map { c -> async(Dispatchers.IO) { c to worksThrough(eng, c.name) } }.map { it.await() }
            }
            checked.firstOrNull { it.second }?.let { return it.first }
        }
        return null
    }

    private fun normalCandidates(): List<Candidate> =
        repo.representatives().map { Candidate(it.name, it.host, false) }

    private fun reserveCandidates(): List<Candidate> =
        repo.reserveNodes().map { Candidate(it.name, it.map["server"]?.toString().orEmpty(), true) }

    private fun serverAddrs(): List<Pair<String, Int>> =
        repo.parsedSub()?.let { Sub.hostsOf(it) }.orEmpty().map { it to 443 }

    private fun applySelection(eng: Engine, c: Candidate) {
        eng.control.selectProxy(c.name)
        VpnBus.setServer(c.name)
        if (c.reserve) {
            VpnBus.setReserve(ReserveInfo(c.name, c.host))
            notify(notification("Резервное подключение", c.name))
            repo.recordDiag("reserve", "Ушли на резервный сервер: ${c.name}")
        } else {
            val wasReserve = VpnBus.reserve.value != null
            VpnBus.setReserve(null)
            notify(notification("Подключено", c.name))
            repo.recordDiag("switch", if (wasReserve) "Вернулись на обычный сервер: ${c.name}" else "Переключение на сервер: ${c.name}")
        }
    }

    /**
     * Оценка и подбор рабочего сервера. Порядок (контракт задания, §2):
     * текущий → другие обычные → диагностика → резерв (с реальной проверкой) →
     * если ничего не заработало, честное сообщение вместо вечного «Подключаемся…».
     * Возврат на обычный, когда сеть нормализовалась, — отдельной проверкой ниже.
     */
    private suspend fun evaluate() {
        if (evaluating || stopping) return
        val eng = engine ?: return
        if (!eng.isAlive()) return
        evaluating = true
        try {
            val auto = repo.state.value.settings.autoFailover
            val inReserve = VpnBus.reserve.value != null
            val current = VpnBus.server.value

            // Работаем через резерв — периодически пробуем вернуться на обычный.
            if (inReserve) {
                val now = System.currentTimeMillis()
                if (now - lastReturnCheck >= RETURN_CHECK_MS) {
                    lastReturnCheck = now
                    val back = firstWorking(eng, normalCandidates())
                    if (back != null) {
                        Log.i(TAG, "обычная сеть восстановилась — возврат на ${back.name}")
                        applySelection(eng, back)
                        VpnBus.setDiagnosis(NetDiagnosis.OK)
                        return
                    }
                }
                // Текущий резерв ещё жив — остаёмся на нём.
                if (current != null && worksThrough(eng, current)) return
            } else if (current != null && worksThrough(eng, current)) {
                // Обычный сервер работает — всё хорошо.
                VpnBus.setReserve(null)
                VpnBus.setDiagnosis(NetDiagnosis.OK)
                VpnBus.setOfferReserve(false)
                return
            }

            // Текущий не отвечает через себя. Автоматика выключена — только
            // диагностируем и предлагаем резерв, сами не переключаемся (§3).
            if (!auto) {
                val d = Diag.diagnose(serverAddrs())
                VpnBus.setDiagnosis(d.diagnosis)
                if (d.diagnosis != NetDiagnosis.OK && repo.reserveAvailable()) VpnBus.setOfferReserve(true)
                return
            }

            // Автоматика включена: ищем рабочий обычный сервер (параллельно).
            firstWorking(eng, normalCandidates().filter { it.name != current })?.let { c ->
                Log.i(TAG, "переключение на рабочий обычный сервер ${c.name}")
                applySelection(eng, c)
                VpnBus.setDiagnosis(NetDiagnosis.OK)
                return
            }

            // Обычных рабочих нет — диагностируем сеть.
            val d = Diag.diagnose(serverAddrs())
            VpnBus.setDiagnosis(d.diagnosis)
            Log.i(TAG, "диагностика: ${d.detail}")
            repo.recordDiag("diagnosis", "Обычные серверы не пропускают трафик. Диагностика: ${d.detail}")
            scope.launch { runCatching { repo.uploadDiag() } }
            if (d.diagnosis == NetDiagnosis.NO_INTERNET) {
                // Интернета нет вовсе — переключаться некуда, ждём восстановления сети.
                return
            }
            if (!repo.reserveAvailable()) {
                repo.recordDiag("info", "Резервных серверов нет — восстановить нечем.")
                return
            }

            // Пробуем резерв с РЕАЛЬНОЙ проверкой интернета через него (§4). Из сотни
            // серверов реально работают единицы — параллельная проверка находит их быстро.
            firstWorking(eng, reserveCandidates())?.let { c ->
                Log.i(TAG, "уход на рабочий резервный сервер ${c.name}")
                applySelection(eng, c)
                return
            }

            // Резерв есть, но ни один сервер реально не заработал (§11).
            Log.w(TAG, "резерв не восстановил соединение")
            repo.recordDiag("error", "Резерв проверен, но ни один сервер не заработал.")
            scope.launch { runCatching { repo.uploadDiag() } }
            VpnBus.setReserve(null)
            notifyError(
                "Сеть работает в ограниченном режиме, но резервные серверы сейчас не смогли " +
                    "восстановить соединение. Попробуйте другую сеть или Wi-Fi.",
            )
        } finally {
            evaluating = false
        }
    }

    /** Смена резервного сервера вручную: берём следующий рабочий, кроме текущего. */
    private suspend fun changeReserve() {
        val eng = engine ?: return
        if (!eng.isAlive() || !repo.reserveAvailable()) return
        val current = VpnBus.reserve.value?.server
        val list = reserveCandidates()
        val start = list.indexOfFirst { it.name == current }
        val ordered = (if (start >= 0) list.drop(start + 1) + list.take(start + 1) else list)
            .filter { it.name != current }
        firstWorking(eng, ordered)?.let {
            applySelection(eng, it)
            return
        }
        notifyError("Другой рабочий резервный сервер не найден.")
    }

    /** Ручной уход на резерв (автоматика выключена, человек согласился). */
    private suspend fun forceReserve() {
        val eng = engine ?: return
        if (!eng.isAlive() || !repo.reserveAvailable()) return
        VpnBus.setOfferReserve(false)
        firstWorking(eng, reserveCandidates())?.let {
            applySelection(eng, it)
            return
        }
        notifyError(
            "Сеть работает в ограниченном режиме, но резервные серверы сейчас не смогли " +
                "восстановить соединение. Попробуйте другую сеть или Wi-Fi.",
        )
    }

    /**
     * В резервном режиме периодически докладываем расход на панель (§12).
     *
     * Считаем дельту ОБЩЕГО трафика движка за время работы через резерв. Это
     * небольшая переоценка (в резерв попадает и то, что шло напрямую), но в
     * ограниченной сети, когда резерв и включается, почти весь трафик и так идёт
     * через VPN. Точный по-соединениям учёт пробовали, но надёжно проверить на
     * безголовом эмуляторе не удалось, а риск обнулить статистику выше пользы.
     */
    private fun reportReserveUsageIfNeeded(totalBytes: Long) {
        val info = VpnBus.reserve.value ?: run { reserveReported = totalBytes; return }
        val now = System.currentTimeMillis()
        if (now - lastReserveReport < RESERVE_REPORT_MS) return
        val delta = totalBytes - reserveReported
        lastReserveReport = now
        reserveReported = totalBytes
        if (delta > 0) scope.launch { repo.reportReserveUsage(info.host, delta) }
    }

    @Volatile
    private var reserveReported = 0L

    @Volatile
    private var lastReserveReport = 0L

    // ── смена сети ──

    private fun registerNetworkCallback() {
        if (netCallback != null) return
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // Привязываем туннель к новой сети: иначе после перехода
                // Wi-Fi ↔ мобильный интернет движок продолжит слать пакеты в
                // исчезнувший интерфейс, и соединение «висит».
                runCatching { setUnderlyingNetworks(arrayOf(network)) }
                rebuild.trySend(Unit)
                // Существенная смена сети (Wi-Fi ↔ мобильный, смена оператора) —
                // повод перепроверить доступ: где было плохо, могло стать хорошо,
                // и наоборот. Возврат с резерва тоже случается здесь (§2).
                lastReturnCheck = 0
                triggerFailover()
            }

            override fun onLost(network: Network) {
                runCatching { setUnderlyingNetworks(null) }
            }

            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) {
                // Событие прилетает на каждое обновление адреса, маршрута и DNS —
                // по десятку раз за переключение сети. Пересобираем конфиг, только
                // если изменилось то, что в него попадает.
                val dns = repo.systemDns()
                if (dns != lastDns) {
                    lastDns = dns
                    rebuild.trySend(Unit)
                }
            }
        }
        // Именно СЕТЬ ПО УМОЛЧАНИЮ: подписка на «любую сеть с интернетом» ловила бы
        // и посторонние сети (оператор поднял мобильную на секунду при живом Wi-Fi),
        // и мы бы врали системе о том, через что на самом деле идёт туннель.
        val ok = runCatching { cm.registerDefaultNetworkCallback(cb) }.isSuccess
        if (ok) {
            netCallback = cb
        } else {
            Log.e(TAG, "не удалось подписаться на смену сети: после переключения Wi-Fi/LTE потребуется переподключение")
        }
    }

    private fun unregisterNetworkCallback() {
        val cb = netCallback ?: return
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        // Ссылку теряем только если система действительно её отпустила: иначе
        // колбэк остался бы зарегистрированным навсегда вместе со всей службой.
        if (runCatching { cm.unregisterNetworkCallback(cb) }.isSuccess) netCallback = null
    }

    // ── остановка ──

    /** Гасит движок и туннель, оставляя службу живой. */
    private fun closeTunnelAndEngine() {
        watchdog?.cancel()
        watchdog = null
        unregisterNetworkCallback()
        engine?.stop()
        engine = null
        runCatching { tun?.close() }
        tun = null
        lastDown = 0
        lastUp = 0
    }

    private fun teardown() {
        closeTunnelAndEngine()
        // В конфиге ключи подписки и токен управления — после отключения он не нужен.
        repo.store.deleteConfig()
        VpnBus.setStats(VpnStats())
        VpnBus.setState(ConnState.OFF)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    }

    /**
     * Авария. Туннель снимаем (иначе телефон остался бы без интернета вовсе), но
     * молча не исчезаем: снять постоянное уведомление и уйти — это ровно то
     * поведение, из-за которого человек потом говорит «он сам выключился».
     * Оставляем обычное уведомление с причиной.
     */
    private fun fail(message: String) {
        Log.e(TAG, "подключение не удалось: $message")
        runCatching { repo.recordDiag("error", message) }
        closeTunnelAndEngine()
        VpnBus.fail(message)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        notifyError(message)
        stopSelf()
    }

    /** Человек отозвал разрешение на VPN или систему занял другой клиент. */
    override fun onRevoke() {
        Log.w(TAG, "разрешение на VPN отозвано")
        stopping = true
        scope.launch {
            lock.withLock { teardown() }
            stopSelf()
        }
    }

    override fun onDestroy() {
        // Смахнули приложение из недавних — служба остаётся жить (stopWithTask=false),
        // сюда попадаем только при настоящей остановке. Главный поток блокировать
        // нельзя: сигнал и выход, дожидаться завершения незачем.
        stopping = true
        engine?.stop(wait = false)
        runCatching { tun?.close() }
        unregisterNetworkCallback()
        VpnBus.setState(ConnState.OFF)
        rebuild.close()
        failover.close()
        scope.cancel()
        super.onDestroy()
    }

    // ── уведомление ──

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Подключение", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Постоянное уведомление, пока VPN работает"
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ALERT, "Сбои подключения", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Сообщение, если VPN остановился"
                setShowBadge(true)
            },
        )
    }

    private fun openIntent(): PendingIntent = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun notification(title: String, server: String?, extra: String? = null): Notification {
        val stop = PendingIntent.getService(
            this, 1, Intent(this, NoVpnService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val mode = if (repo.effectiveSmart()) "Умная маршрутизация" else "Полный VPN"
        val text = listOfNotNull(server, extra).joinToString(" · ").ifEmpty { mode }
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_novpn)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openIntent())
            .addAction(0, "Отключить", stop)
            .build()
    }

    private fun notifyError(message: String) {
        val n = NotificationCompat.Builder(this, CHANNEL_ALERT)
            .setSmallIcon(R.drawable.ic_stat_novpn)
            .setContentTitle("VPN отключился")
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setContentIntent(openIntent())
            .build()
        runCatching { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ERROR_ID, n) }
    }

    private fun startForegroundSafely(n: Notification): Boolean {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else 0
        return runCatching { ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type) }
            .onFailure { Log.e(TAG, "startForeground не прошёл", it) }
            .isSuccess
    }

    private fun notify(n: Notification) {
        if (stopping) return
        runCatching {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, n)
        }
    }

    companion object {
        private const val TAG = "novpn.service"
        private const val CHANNEL = "vpn"
        private const val CHANNEL_ALERT = "vpn-alert"
        private const val NOTIFICATION_ID = 1
        private const val NOTIFICATION_ERROR_ID = 2
        private const val SESSION = "NoVPN"
        private const val WATCHDOG_MS = 4_000L
        private const val STATS_MS = 5_000L
        private const val REBUILD_DEBOUNCE_MS = 1_500L
        private const val MAX_RESTARTS = 3

        /** Проверка реального доступа через прокси — к настоящим сайтам, не 204-only. */
        private val HEALTH_URLS = listOf(
            "http://cp.cloudflare.com/generate_204",
            "http://www.google.com/generate_204",
        )
        private const val HEALTH_TIMEOUT_MS = 3_000
        /** Сколько серверов проверять параллельно (перебор сотни резервных). */
        private const val HEALTH_CONCURRENCY = 8
        /** Как часто сторож проверяет доступ выбранного сервера. */
        private const val HEALTH_TICK_MS = 12_000L
        /** Как часто из резервного режима пробуем вернуться на обычный. */
        private const val RETURN_CHECK_MS = 45_000L
        /** Как часто докладываем резервный расход на панель. */
        private const val RESERVE_REPORT_MS = 60_000L

        const val ACTION_START = "ru.appswire.novpn.START"
        const val ACTION_STOP = "ru.appswire.novpn.STOP"
        const val ACTION_RELOAD = "ru.appswire.novpn.RELOAD"
        const val ACTION_RECONNECT = "ru.appswire.novpn.RECONNECT"
        const val ACTION_CHANGE_RESERVE = "ru.appswire.novpn.CHANGE_RESERVE"
        const val ACTION_USE_RESERVE = "ru.appswire.novpn.USE_RESERVE"

        fun start(context: Context) {
            val i = Intent(context, NoVpnService::class.java).setAction(ACTION_START)
            runCatching { context.startForegroundService(i) }
        }

        fun stop(context: Context) {
            runCatching {
                context.startService(Intent(context, NoVpnService::class.java).setAction(ACTION_STOP))
            }
        }

        /** Применить изменившиеся правила без разрыва соединения. */
        fun reload(context: Context) {
            if (!VpnBus.isRunning) return
            runCatching {
                context.startService(Intent(context, NoVpnService::class.java).setAction(ACTION_RELOAD))
            }
        }

        /** Поднять туннель заново: нужно после смены списка приложений. */
        fun reconnect(context: Context) {
            if (!VpnBus.isRunning) return
            runCatching {
                context.startService(Intent(context, NoVpnService::class.java).setAction(ACTION_RECONNECT))
            }
        }

        /** Сменить резервный сервер вручную (в резервном режиме). */
        fun changeReserve(context: Context) {
            if (!VpnBus.isRunning) return
            runCatching {
                context.startService(Intent(context, NoVpnService::class.java).setAction(ACTION_CHANGE_RESERVE))
            }
        }

        /** Уйти на резерв вручную (когда автовосстановление выключено). */
        fun useReserve(context: Context) {
            if (!VpnBus.isRunning) return
            runCatching {
                context.startService(Intent(context, NoVpnService::class.java).setAction(ACTION_USE_RESERVE))
            }
        }
    }
}
