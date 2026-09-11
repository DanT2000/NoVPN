package ru.appswire.novpn.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import ru.appswire.novpn.MainActivity
import ru.appswire.novpn.R
import ru.appswire.novpn.core.Config
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
 * Чего это НЕ лечит: агрессивные «оптимизаторы» на оболочках производителей
 * (MIUI/HyperOS, EMUI, ColorOS). Там нужно разрешение на автозапуск и снятие
 * ограничений батареи — этим занимается экран «Работа в фоне» (Oem.kt).
 */
class NoVpnService : VpnService() {

    private lateinit var repo: Repo
    private var engine: Engine? = null
    private var tun: ParcelFileDescriptor? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var watchdog: Job? = null
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    @Volatile
    private var lastDown = 0L

    @Volatile
    private var lastUp = 0L

    override fun onCreate() {
        super.onCreate()
        repo = Repo.get(this)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                scope.launch {
                    teardown()
                    stopSelf()
                }
                return START_NOT_STICKY
            }

            ACTION_RELOAD -> {
                scope.launch { applyRules() }
                return START_STICKY
            }

            ACTION_RECONNECT -> {
                // Список приложений, исключённых из VPN, задаётся в момент
                // establish() и на лету не меняется — туннель нужно поднять заново.
                scope.launch {
                    watchdog?.cancel()
                    unregisterNetworkCallback()
                    engine?.stop()
                    engine = null
                    runCatching { tun?.close() }
                    tun = null
                    connect()
                }
                return START_STICKY
            }

            else -> {
                // intent == null бывает в двух случаях: система перезапустила
                // службу после того, как убила её, и системный «Always-on VPN».
                // Оба означают «подключайся по сохранённому состоянию».
                startForegroundSafely(notification("Подключаемся…", null))
                scope.launch { connect() }
                return START_STICKY
            }
        }
    }

    // ── подключение ──

    private suspend fun connect() {
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
                fail("Движок остановился при запуске. ${started.message}")
                return
            }
            is Engine.Started.Timeout -> {
                fail("Движок не ответил за 15 секунд. ${started.message}")
                return
            }
        }
        eng.control.selectProxy(node.name)

        VpnBus.setState(ConnState.ON)
        notify(notification("Подключено", node.name))
        registerNetworkCallback()
        startWatchdog()
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
        // VPN-серверу завернулось бы само в себя.
        runCatching { builder.addDisallowedApplication(packageName) }
            .onFailure { Log.w(TAG, "не удалось исключить себя из VPN", it) }

        // Приложения, которым человек выбрал «напрямую», из туннеля исключаются
        // целиком: правил по процессам на Android нет (см. Rules).
        for (rule in st.apps) {
            if (rule.route != "direct") continue
            runCatching { builder.addDisallowedApplication(rule.pkg) }
                .onFailure { Log.w(TAG, "приложение ${rule.pkg} не установлено, пропускаем") }
        }

        return runCatching { builder.establish() }.getOrNull()
    }

    // ── перестройка правил без разрыва туннеля ──

    private fun applyRules() {
        val eng = engine ?: return
        if (!eng.isAlive()) return
        val node = repo.nodeFor() ?: return
        val config = repo.buildConfig(Config.TUN_FD, eng.secret) ?: return
        runCatching { repo.store.configFile().writeText(config) }
        if (eng.control.reload(repo.store.configFile().absolutePath)) {
            // Группа типа select помнит прошлый выбор: без явного указания движок
            // остался бы на старом сервере, хотя в окне выбран новый.
            eng.control.selectProxy(node.name)
            VpnBus.setServer(node.name)
            notify(notification("Подключено", node.name))
        }
    }

    // ── сторож ──

    private fun startWatchdog() {
        watchdog?.cancel()
        watchdog = scope.launch {
            var failures = 0
            var lastStats = System.currentTimeMillis()
            while (isActive) {
                delay(WATCHDOG_MS)
                val eng = engine ?: break
                if (!eng.isAlive()) {
                    failures++
                    Log.w(TAG, "движок умер, попытка восстановления №$failures")
                    VpnBus.setState(ConnState.RECONNECTING)
                    notify(notification("Восстанавливаем подключение…", null))
                    val fd = tun?.fd
                    val err = when {
                        fd == null -> "туннель закрыт"
                        else -> {
                            val config = repo.buildConfig(Config.TUN_FD, eng.newSecret())
                            if (config == null) "подписка не загружена" else eng.start(config, fd)
                        }
                    }
                    if (err == null && eng.waitReady(10_000) is Engine.Started.Ok) {
                        repo.nodeFor()?.let { eng.control.selectProxy(it.name) }
                        VpnBus.setState(ConnState.ON)
                        notify(notification("Подключено", repo.nodeFor()?.name))
                        failures = 0
                    } else if (failures >= MAX_RESTARTS) {
                        fail("Движок не запускается. Откройте приложение и подключитесь заново.")
                        return@launch
                    }
                    continue
                }

                // Возврат с полного VPN на умный по таймеру сервера (контракт, 7).
                checkFullTimeout()

                if (System.currentTimeMillis() - lastStats >= STATS_MS) {
                    lastStats = System.currentTimeMillis()
                    updateStats(eng)
                }
            }
        }
    }

    private fun checkFullTimeout() {
        val st = repo.state.value
        if (st.smartRouting || st.fullSince <= 0) return
        val hours = repo.nodeFor(st)?.fullTimeoutHours ?: return
        if (hours <= 0) return
        val passed = System.currentTimeMillis() - st.fullSince
        if (passed < (hours * 3600_000).toLong()) return
        repo.update { it.copy(smartRouting = true, fullSince = 0) }
        applyRules()
        notify(notification("Вернулись на умную маршрутизацию", repo.nodeFor()?.name))
    }

    private fun updateStats(eng: Engine) {
        val totals = eng.control.totals() ?: return
        val seconds = STATS_MS / 1000.0
        val downSpeed = ((totals.down - lastDown).coerceAtLeast(0) / seconds).toLong()
        val upSpeed = ((totals.up - lastUp).coerceAtLeast(0) / seconds).toLong()
        lastDown = totals.down
        lastUp = totals.up
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
                scope.launch {
                    delay(700)
                    applyRules()
                }
            }

            override fun onLost(network: Network) {
                runCatching { setUnderlyingNetworks(null) }
            }

            override fun onLinkPropertiesChanged(network: Network, lp: android.net.LinkProperties) {
                // Сменились DNS оператора — их адреса зашиты в конфиг движка.
                scope.launch { applyRules() }
            }
        }
        val req = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            // Именно НЕ-VPN сеть: иначе мы бы следили за собственным туннелем и
            // брали из него же адреса DNS — получилась бы петля.
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        runCatching { cm.registerNetworkCallback(req, cb) }.onSuccess { netCallback = cb }
    }

    private fun unregisterNetworkCallback() {
        val cb = netCallback ?: return
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        runCatching { cm.unregisterNetworkCallback(cb) }
        netCallback = null
    }

    // ── остановка ──

    private fun teardown() {
        watchdog?.cancel()
        watchdog = null
        unregisterNetworkCallback()
        engine?.stop()
        engine = null
        runCatching { tun?.close() }
        tun = null
        VpnBus.setStats(VpnStats())
        VpnBus.setState(ConnState.OFF)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    }

    private fun fail(message: String) {
        Log.e(TAG, "подключение не удалось: $message")
        watchdog?.cancel()
        unregisterNetworkCallback()
        engine?.stop()
        engine = null
        runCatching { tun?.close() }
        tun = null
        VpnBus.fail(message)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** Человек отозвал разрешение на VPN или систему занял другой клиент. */
    override fun onRevoke() {
        Log.w(TAG, "разрешение на VPN отозвано")
        scope.launch {
            teardown()
            stopSelf()
        }
    }

    override fun onDestroy() {
        // Смахнули приложение из недавних — служба остаётся жить (stopWithTask=false),
        // сюда попадаем только при настоящей остановке.
        engine?.stop()
        runCatching { tun?.close() }
        unregisterNetworkCallback()
        VpnBus.setState(ConnState.OFF)
        scope.cancel()
        super.onDestroy()
    }

    // ── уведомление ──

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(CHANNEL, "Подключение", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Постоянное уведомление, пока VPN работает"
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        nm.createNotificationChannel(channel)
    }

    private fun notification(title: String, server: String?, extra: String? = null): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, NoVpnService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val text = listOfNotNull(server, extra).joinToString(" · ").ifEmpty { "Умная маршрутизация" }
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_novpn)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(open)
            .addAction(0, "Отключить", stop)
            .build()
    }

    private fun startForegroundSafely(n: Notification) {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else 0
        runCatching { ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type) }
            .onFailure { Log.e(TAG, "startForeground не прошёл", it) }
    }

    private fun notify(n: Notification) {
        runCatching {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, n)
        }
    }

    companion object {
        private const val TAG = "novpn.service"
        private const val CHANNEL = "vpn"
        private const val NOTIFICATION_ID = 1
        private const val SESSION = "NoVPN"
        private const val WATCHDOG_MS = 4_000L
        private const val STATS_MS = 2_000L
        private const val MAX_RESTARTS = 3

        const val ACTION_START = "ru.appswire.novpn.START"
        const val ACTION_STOP = "ru.appswire.novpn.STOP"
        const val ACTION_RELOAD = "ru.appswire.novpn.RELOAD"
        const val ACTION_RECONNECT = "ru.appswire.novpn.RECONNECT"

        fun start(context: Context) {
            val i = Intent(context, NoVpnService::class.java).setAction(ACTION_START)
            // Для VPN-службы система позволяет старт из foreground; из фона
            // (загрузка телефона) сюда приходим только с разрешённым автозапуском.
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
    }
}
