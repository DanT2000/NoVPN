package ru.appswire.novpn.vpn

import ru.appswire.novpn.store.State
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
import android.net.NetworkCapabilities
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
import ru.appswire.novpn.ui.Flags

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

    /** Сериализует ВЫБОР сервера/резерва: сторож (evaluate) и ручные changeReserve/
     *  forceReserve не должны одновременно менять активный прокси движка и VpnBus —
     *  иначе в шине повисает несогласованное состояние (сервер от одного, флаг резерва
     *  от другого). Отдельный от `lock`: подключение/остановку не блокирует. */
    private val selection = Mutex()

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
                // Ручное выключение тоже отмечаем: по журналу должно быть видно, где VPN
                // перезапускал человек, а где приложение само («restart»).
                runCatching { repo.recordDiag("info", "VPN выключен вручную") }
                scope.launch {
                    // Пока ждали замок, мог прийти новый START (он ставит stopping=false и
                    // поднимает свежую сессию). Тогда НЕ рвём её и не глушим службу — иначе
                    // остались бы с работающим VPN у «остановленной» службы вне foreground.
                    lock.withLock { if (stopping) teardown() }
                    if (stopping) stopSelf()
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
                // Новая сессия по просьбе человека или системы — серия самоперезапусков с нуля.
                selfHealStreak = 0
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
        // Уже подключены (повторный ACTION_START / sticky-рестарт поверх живого туннеля):
        // поднять второй движок поверх старого — значит осиротить прежний (его поток
        // mirrorLog крутится вечно) и утечь дескриптор туннеля. Ничего не поднимаем.
        engine?.let { old ->
            if (old.isAlive() && tun != null) {
                VpnBus.setState(ConnState.ON)
                notify(statusNotification())
                return
            }
        }
        // Недобитые остатки прежней сессии (движок мёртв, но ссылка/туннель остались) —
        // прибираем, чтобы не текли, перед новым подключением.
        if (engine != null || tun != null) closeTunnelAndEngine()
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
        sessionGen++
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
        when (val started = eng.waitReady(abort = { stopping })) {
            is Engine.Started.Ok -> Unit
            is Engine.Started.Aborted -> return
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
        lastAppliedNode = node.name

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
        repo.recordDiag("dns", repo.networksDiag())

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

        val fd = runCatching { builder.establish() }.getOrNull()
        // Запоминаем состав исключений, с которым туннель поднят: если человек
        // потом поменяет режим приложения, applyRules увидит расхождение и поднимет
        // туннель заново, а не оставит старые исключения (см. tunAppsSignature).
        if (fd != null) lastTunApps = tunAppsSignature(st)
        return fd
    }

    /** Последний состав исключений туннеля — с чем он реально поднят сейчас. */
    @Volatile
    private var lastTunApps: String = ""

    /** Тип сети (TRANSPORT_WIFI/CELLULAR/…), на которой сейчас работает туннель. -1 —
     *  ещё не знаем. Ведётся и в onAvailable, и опросом в стороже: на MIUI система душит
     *  сетевые колбэки VPN-службе в фоне (onAvailable приходит только первый раз), поэтому
     *  на колбэк полагаться нельзя — сторож опрашивает cm.activeNetwork сам. По смене типа
     *  туннель переустанавливается (чинит значок сети). */
    @Volatile
    private var establishedTransport: Int = -1

    /** Сама физическая сеть под туннелем (не только её тип). Смена SIM или новая сессия
     *  оператора — это «мобильная → мобильная»: тип тот же, а сеть другая. По одному типу
     *  опрос такую смену не видел, туннель оставался на исчезнувшей сети, и помогало
     *  только ручное выкл/вкл VPN (06.10.2026, МегаФон → МТС → МегаФон). */
    @Volatile
    private var establishedNetwork: Network? = null

    /** Физическая сеть под туннелем: служба исключает себя из VPN, поэтому её «сеть по
     *  умолчанию» — это реальная Wi-Fi/мобильная сеть, а не туннель. */
    private fun currentUnderlyingNetwork(): Network? {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return runCatching { cm.activeNetwork }.getOrNull()
    }

    /** Основной тип сети (transport). Только Wi-Fi/мобильный/Ethernet различаем —
     *  именно их смена ломает значок сети на MIUI. Прочее и «нет сети» → -1. */
    private fun transportOf(network: Network?): Int {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = network?.let { runCatching { cm.getNetworkCapabilities(it) }.getOrNull() } ?: return -1
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> NetworkCapabilities.TRANSPORT_WIFI
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> NetworkCapabilities.TRANSPORT_CELLULAR
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> NetworkCapabilities.TRANSPORT_ETHERNET
            else -> -1
        }
    }

    /** Переустановка туннеля (как Amnezia): закрываем и поднимаем заново — так система
     *  перепроверяет сеть и перерисовывает значок в шторке. Сериализуем общим мьютексом.
     *  @param expectedGen поколение сессии, по проверке которой решили перезапускать. Пока
     *    ждали мьютекс, туннель могли уже переустановить (смена сети) или поднять упавший
     *    движок: тогда свежий исправный не рвём — вывод о старой сессии к нему не относится.
     *  @param journal запись «restart» — пишется, только если перезапуск и правда случился.
     *  @return был ли перезапуск. */
    private suspend fun reestablishTunnel(reason: String, expectedGen: Int? = null, journal: String? = null): Boolean {
        lock.withLock {
            if (stopping || engine?.isAlive() != true) return false
            if (expectedGen != null && sessionGen != expectedGen) return false
            journal?.let { repo.recordDiag("restart", it) }
            repo.recordDiag("network", "$reason → переустановка туннеля")
            Log.i(TAG, "reestablishTunnel: $reason")
            closeTunnelAndEngine()
            connect()
            return true
        }
    }

    /**
     * Отпечаток того, что влияет на СОСТАВ туннеля (addDisallowedApplication):
     * список «прямых» приложений в умном режиме. В полном VPN исключений нет.
     * Смена сайтовых правил на отпечаток не влияет — их движок применяет на лету.
     */
    private fun tunAppsSignature(st: State): String {
        if (!repo.effectiveSmart(st)) return "full"
        return st.apps.filter { it.route == "direct" }.map { it.pkg }.sorted().joinToString(",")
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

    private suspend fun applyRules() {
        val eng = engine ?: return
        if (!eng.isAlive() || stopping) return
        // Диагностика перемежающегося сбоя прямого доступа: фиксируем, с каким DNS
        // для прямых доменов пересобирается конфиг (пусто/чужой = причина «Сбер не
        // открывается»). Только логирование, на маршрутизацию не влияет.
        repo.recordDiag("dns", repo.networksDiag())
        // Если поменялся СОСТАВ туннеля (человек перевёл приложение из «Напрямую» во
        // «Через VPN» или обратно, либо сменился режим Умный/Полный), одним reload
        // конфига не обойтись: список исключений задаётся только в establish().
        // Поднимаем туннель заново автоматически — раньше это требовало ручного
        // перезапуска, из-за чего приложение шло мимо VPN, хотя выбрано «Через VPN».
        if (tunAppsSignature(repo.state.value) != lastTunApps) {
            scope.launch {
                lock.withLock {
                    if (stopping) return@withLock
                    // Пока стояли в очереди за мьютексом, туннель могли уже поднять с
                    // нужным составом (пачка переключений подряд) — тогда не дёргаем.
                    if (tunAppsSignature(repo.state.value) == lastTunApps) return@withLock
                    closeTunnelAndEngine()
                    connect()
                }
            }
            return
        }
        val node = repo.nodeFor() ?: return
        // Режим резерва читаем ОДИН раз: и для флага полного туннеля, и для выбора активного
        // сервера (устраняем TOCTOU между двумя чтениями VpnBus.reserve).
        val reserveAtBuild = VpnBus.reserve.value
        // В резервном режиме весь трафик уводим через резерв (белые списки ломают и прямой
        // доступ к российским сайтам), кроме российских сервисов и правил «напрямую» —
        // см. Repo.rules(forceFull).
        val config = repo.buildConfig(Config.TUN_FD, eng.secret, reserveAtBuild != null) ?: return
        repo.store.writeConfig(config)?.let {
            Log.e(TAG, "конфиг не записан: $it")
            return
        }
        // Мутацию активного прокси движка и VpnBus сериализуем ТЕМ ЖЕ мьютексом, что и
        // applySelection: иначе гонка со сторожем (evaluate) оставляла конфиг умным, пока
        // шина показывает резерв, и наоборот. Если режим резерва сменился, пока собирался
        // конфиг, — не применяем устаревший (следующий rebuild соберёт правильный).
        selection.withLock {
            if (stopping || engine !== eng || !eng.isAlive()) return@withLock
            if (VpnBus.reserve.value != reserveAtBuild) return@withLock
            if (eng.control.reload(repo.store.configFile().absolutePath)) {
                // Группа select помнит прошлый выбор — указываем сервер явно.
                val before = VpnBus.server.value
                val active = reserveAtBuild?.server ?: activeNormal(node.name)
                eng.control.selectProxy(active)
                VpnBus.setServer(active)
                notify(statusNotification())
                // Сервер сменился (человек выбрал другой) — сразу проверить, что он живой,
                // а не ждать двух промахов сторожа.
                if (active != before) triggerFailover()
            }
        }
    }

    /** Обычный сервер, выбранный ЯВНО последним: при подключении или сменой в настройках. */
    @Volatile
    private var lastAppliedNode: String? = null

    /**
     * Какой обычный сервер ставить после пересборки конфига или перезапуска движка.
     * Пока выбор человека тот же, держим сервер, на который ушёл автоподбор: раньше любая
     * пересборка (правка правил, смена DNS, переезд сети) вслепую возвращала движок на
     * выбранный в настройках — уже мёртвый — сервер, и VPN стоял до следующего подбора.
     * Сменил человек сервер или режим Умный/Полный — берём его выбор.
     */
    private fun activeNormal(node: String): String {
        val cur = VpnBus.server.value
        val keepAuto = node == lastAppliedNode && cur != null && cur != node &&
            repo.representatives().any { it.name == cur }
        lastAppliedNode = node
        return if (keepAuto) cur!! else node
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

                // СМЕНА ТИПА СЕТИ опросом (Wi-Fi↔мобильный). На MIUI/HyperOS система душит
                // сетевые колбэки VPN-службе (onAvailable приходит только первый раз),
                // поэтому переустановку по колбэку ждать нельзя — опрашиваем текущую сеть
                // сами. Если тип сменился — переустанавливаем туннель, иначе значок сети в
                // шторке остаётся неверным (Wi-Fi с «!», пропадает «4G»). Опрос дешёвый.
                val curNet = currentUnderlyingNetwork()
                val curTransport = transportOf(curNet)
                if (curTransport != -1) {
                    if (establishedTransport == -1) {
                        establishedTransport = curTransport
                        establishedNetwork = curNet
                    } else if (curTransport != establishedTransport) {
                        establishedTransport = curTransport
                        establishedNetwork = curNet
                        selfHealStreak = 0 // новая сеть — и серия самоперезапусков новая
                        reestablishTunnel("Смена типа сети (опрос)")
                        continue
                    } else if (curNet != null && curNet != establishedNetwork) {
                        // Тот же тип, но ДРУГАЯ сеть (сменили SIM, оператор переподнял
                        // сессию), а колбэк система не прислала — переезжаем сами.
                        val first = establishedNetwork == null
                        establishedNetwork = curNet
                        if (!first) {
                            selfHealStreak = 0
                            moveToNetwork(curNet, "опрос")
                        }
                    }
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
                    if (VpnBus.reserve.value != null) {
                        // В резервном режиме подбор нужен всегда (проверить возврат).
                        triggerFailover()
                    } else {
                        // Обычный режим: не срываемся на первом же промахе — одиночный
                        // сбой проверки бывает при микрообрыве сети и проходит сам.
                        // Полноценный подбор запускаем только после двух подряд, чтобы
                        // не пугать человека ложным «резерв недоступен».
                        val cur = VpnBus.server.value
                        if (cur != null && worksThrough(eng, cur)) {
                            healthMisses = 0
                            // Связь есть — снимаем прежний диагноз (например «нет
                            // интернета», выставленный при пропаже сети). Иначе метка
                            // висела бы и после того, как интернет вернулся.
                            markServerOk()
                        } else if (++healthMisses >= 2) {
                            healthMisses = 0
                            triggerFailover()
                        }
                    }
                }

                // Сторож белых списков: смотрит на саму сеть, а не на ответ сервера.
                if (now - lastWhitelistWatch >= WHITELIST_WATCH_MS &&
                    VpnBus.state.value == ConnState.ON && VpnBus.reserve.value == null
                ) {
                    lastWhitelistWatch = now
                    scope.launch { watchWhitelist() }
                }
            }
        }
    }

    @Volatile
    private var lastHealthTick = 0L

    @Volatile
    private var healthMisses = 0

    @Volatile
    private var lastWhitelistWatch = 0L

    @Volatile
    private var watchingWhitelist = false

    /**
     * Сторож белых списков. Лёгкая проверка сервера (ответ 204 через туннель) под белыми
     * списками бывает ложно-успешной: на МТС 30.09.2026 она 14 минут подряд считала
     * «Нидерланды» рабочими, а YouTube не грузился, — диагностика не запускалась вовсе, и
     * человек так и не узнал, в чём дело. Поэтому раз в минуту (и сразу после смены сети)
     * смотрим на саму сеть, мимо туннеля: российские сайты открываются, а зарубежные нет —
     * это белые списки. Предупреждаем, даже если сервер вроде бы отвечает и даже если
     * резерва нет. Снимает отметку тоже только сторож — когда зарубежные снова открылись.
     */
    private suspend fun watchWhitelist() {
        if (watchingWhitelist || stopping) return
        watchingWhitelist = true
        try {
            // В обычной сети это один маленький запрос; полная диагностика — только если
            // зарубежное не открылось (см. Diag.whitelistCheck).
            val d = Diag.whitelistCheck(serverAddrs())
            if (stopping || VpnBus.reserve.value != null) return
            val known = VpnBus.diagnosis.value
            if (d == null) {
                // Отметку смотрим и отдельно от диагноза: короткая пропажа сети затирает
                // RESTRICTED на «нет интернета», а снять её должен именно сторож.
                if (known == NetDiagnosis.RESTRICTED || restrictedSticky) {
                    Log.i(TAG, "сторож: ограничения сняты")
                    repo.recordDiag("diagnosis", "Ограничения сети сняты (сторож): зарубежные сайты снова открываются.")
                    VpnBus.setOfferReserve(false)
                    markNormal()
                }
                return
            }
            if (d.diagnosis == NetDiagnosis.RESTRICTED && known != NetDiagnosis.RESTRICTED) {
                Log.i(TAG, "сторож: похоже на белые списки: ${d.detail}")
                repo.recordDiag("diagnosis", "Сеть похожа на белые списки (сторож). Диагностика: ${d.detail}")
                setDiagnosis(d.diagnosis)
                maybeNotifyDiagnosis(d)
                if (repo.reserveAvailable()) VpnBus.setOfferReserve(true)
                scope.launch { runCatching { repo.uploadDiag() } }
            }
        } finally {
            watchingWhitelist = false
        }
    }

    @Volatile
    private var lastSelfHeal = 0L

    /** Сколько самоперезапусков подряд не помогло. Обнуляется, как только туннель ожил,
        при смене сети и при новом подключении. */
    @Volatile
    private var selfHealStreak = 0

    /** Пора ли перезапускать: не чаще раза в пару минут и не больше SELF_HEAL_MAX_STREAK
        раз подряд — см. selfHealExhausted. */
    private fun selfHealDue(): Boolean =
        !selfHealExhausted() && System.currentTimeMillis() - lastSelfHeal >= SELF_HEAL_MIN_MS

    /**
     * Перезапуски подряд не помогли — дело не в туннеле, а в сервере: он принимает
     * TCP-соединение, но не проксирует (устройство перевыпущено, REALITY отвергает
     * движок, DPI режет протокол, посредник провайдера открывает любой порт). Раньше
     * перезапуск шёл бесконечно раз в 10 минут, каждый раз рвал ВСЕ соединения (и
     * прямой трафик умного режима) и звенел уведомлением, а резерв так и не предлагался.
     * Теперь считаем сервер недоступным до смены сети или до первого ответа через туннель.
     */
    private fun selfHealExhausted(): Boolean = selfHealStreak >= SELF_HEAL_MAX_STREAK

    /** Полная диагностика с поправкой на исчерпанные перезапуски: «сеть в порядке и
        сервер достижим» после них — это не залипший туннель, а неработающий сервер. */
    private suspend fun diagnoseServers(): Diag.Result {
        val d = Diag.diagnose(serverAddrs())
        if (d.diagnosis != NetDiagnosis.OK || !selfHealExhausted()) return d
        repo.recordDiag(
            "diagnosis",
            "Перезапуски туннеля не помогли ($selfHealStreak подряд): сервер принимает соединение, " +
                "но трафик через него не идёт — считаем его недоступным.",
        )
        return d.copy(diagnosis = NetDiagnosis.SERVER_DOWN)
    }

    /**
     * Самовосстановление: переустановить туннель и движок — то же, что выкл/вкл VPN
     * кнопкой. Видно в журнале (отдельная категория «restart») и уведомлением: раньше
     * перезапуск, сделанный человеком или приложением, ничем не отмечался.
     * @param gen поколение сессии, по проверке которой решили: туннель уже переустановили
     *   (смена сети) или подняли упавший движок — свежий не трогаем.
     */
    private suspend fun selfHeal(reason: String, gen: Int) {
        val prevAt = lastSelfHeal
        val prevStreak = selfHealStreak
        val n = prevStreak + 1
        lastSelfHeal = System.currentTimeMillis()
        selfHealStreak = n
        val restarted = reestablishTunnel(
            "Самовосстановление",
            expectedGen = gen,
            journal = "Перезапуск туннеля (автоматически, №$n): $reason",
        )
        if (!restarted) {
            lastSelfHeal = prevAt
            selfHealStreak = prevStreak
            return
        }
        Log.i(TAG, "самовосстановление №$n: $reason")
        scope.launch { runCatching { repo.uploadDiag() } }
        // Уведомляем один раз за серию: повторные перезапуски видны в журнале, а звенеть
        // каждый раз незачем.
        if (n == 1 && !stopping && engine?.isAlive() == true) {
            val at = java.text.SimpleDateFormat("HH:mm", java.util.Locale.US).format(java.util.Date())
            notifyInfo("Подключение перезапущено", "Трафик через VPN не шёл — NoVPN сам перезапустил туннель в $at.")
        }
    }

    /**
     * Сервер ответил на лёгкую проверку — снимаем диагноз, КРОМЕ белых списков: под
     * ними этот ответ бывает ложным (МТС пропускает мелкие запросы и режет реальный
     * трафик). Иначе отметка «белые списки» гасла бы через секунды после сторожа, а
     * человеку приходило бы «обнаружены / сняты» по кругу. Отметку смотрим по
     * restrictedSticky, а не по диагнозу: «нет интернета» при короткой пропаже сети
     * затирал RESTRICTED, и сюда приходило ложное «Ограничения сети сняты».
     */
    private fun markServerOk() {
        // Через туннель снова идёт трафик — счётчик бесполезных перезапусков с нуля.
        selfHealStreak = 0
        if (restrictedSticky || VpnBus.diagnosis.value == NetDiagnosis.RESTRICTED) {
            clearNoInternet()
            return
        }
        if (VpnBus.diagnosis.value != NetDiagnosis.OK) markNormal()
    }

    /**
     * Связь через туннель снова есть, а на шине ещё «нет интернета» (сеть пропадала на
     * секунды) — возвращаем то, что было до пропажи. НЕ markNormal: под белыми списками
     * он слал бы ложное «Ограничения сети сняты», а в резерве шторка так и висела бы на
     * «Нет интернета» (его проверка стоит раньше резерва), хотя трафик идёт.
     */
    private fun clearNoInternet() {
        if (VpnBus.diagnosis.value != NetDiagnosis.NO_INTERNET) return
        setDiagnosis(if (restrictedSticky) NetDiagnosis.RESTRICTED else diagBeforeOutage)
    }

    /**
     * Поколение сессии движка: растёт при каждом подключении и перезапуске упавшего
     * движка (тот же объект Engine, но новый процесс). Оценка, начатая на прежнем
     * поколении, свои выводы к новому не применяет (см. evaluate).
     */
    @Volatile
    private var sessionGen = 0

    private fun restartEngine(eng: Engine): Boolean {
        // Движок умер и поднимается заново — проверки, начатые до этого, устарели.
        sessionGen++
        val fd = tun?.fd ?: return false
        val config = repo.buildConfig(Config.TUN_FD, eng.newSecret(), VpnBus.reserve.value != null) ?: return false
        if (eng.start(config, fd) != null) return false
        if (eng.waitReady(10_000, abort = { stopping }) !is Engine.Started.Ok) return false
        // После перезапуска движка удерживаем активный сервер: в резервном режиме —
        // резервный (он тоже в новом конфиге), иначе текущий обычный (см. activeNormal).
        val reserve = VpnBus.reserve.value
        val active = reserve?.server ?: repo.nodeFor()?.name?.let { activeNormal(it) }
        active?.let {
            eng.control.selectProxy(it)
            // Шина должна знать, через кого движок идёт теперь: по ней рисуется шторка
            // и от неё сторож проверяет «текущий» сервер.
            VpnBus.setServer(it)
        }
        // Счётчики движка обнулились вместе с ним: иначе скорость показывалась бы
        // нулевой до конца сессии, а трафик прыгнул бы назад.
        lastDown = 0
        lastUp = 0
        lastStatsAt = System.currentTimeMillis()
        VpnBus.setState(ConnState.ON)
        notify(statusNotification())
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
        notify(notification("Вернулись на умную маршрутизацию", channelLabel()))
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
            notify(statusNotification(speedLine(downSpeed, upSpeed)))
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
        // Причина — в журнал: «сервер не пропускает трафик» при живом интернете иначе не
        // разобрать (боевая сборка не отлаживается). Повтор той же строки журнал склеивает.
        eng.control.lastDelayError?.let { repo.recordDiag("health", "Проверка «$name» не прошла: $it") }
        return false
    }

    /**
     * Реальный ОБХОД ограничений через прокси — строже, чем worksThrough. Грузим
     * несколько внешних сайтов, которые в белых списках напрямую недоступны (в т.ч.
     * YouTube), и требуем, чтобы БЫСТРО ответило НЕ МЕНЬШЕ двух. Так резерв
     * подтверждает, что реально пробивает ограничение, а не просто «жив»: через
     * российский или мёртвый сервер YouTube и Google не загрузятся — он и отсеется,
     * даже если по флагу его не распознали. Для выбора аварийного сервера (§4).
     */
    private fun bypassesWell(eng: Engine, name: String): Boolean {
        var ok = 0
        for (url in BYPASS_URLS) {
            if (stopping || !eng.isAlive()) return false
            if (eng.control.delay(name, url, BYPASS_TIMEOUT_MS) != null) {
                ok++
                if (ok >= BYPASS_MIN_OK) return true
            }
        }
        return false
    }

    /**
     * Первый реально рабочий сервер из списка. Проверяем пачками параллельно:
     * резервных серверов может быть под сотню (у каждого оператора свой рабочий),
     * и перебирать их по очереди по 3 секунды — это минуты ожидания. Внутри пачки
     * берём кандидата с наименьшим номером среди ответивших — порядок сохраняется.
     *
     * `check` — критерий годности: обычным серверам достаточно worksThrough
     * («жив»), аварийным даём bypassesWell («реально обходит»).
     */
    private suspend fun firstWorking(
        eng: Engine,
        candidates: List<Candidate>,
        check: (Engine, String) -> Boolean = { e, n -> worksThrough(e, n) },
    ): Candidate? {
        for (chunk in candidates.chunked(HEALTH_CONCURRENCY)) {
            if (stopping || !eng.isAlive()) return null
            val checked = coroutineScope {
                chunk.map { c -> async(Dispatchers.IO) { c to check(eng, c.name) } }.map { it.await() }
            }
            checked.firstOrNull { it.second }?.let { return it.first }
        }
        return null
    }

    private fun normalCandidates(): List<Candidate> =
        repo.representatives().map { Candidate(it.name, it.host, false) }

    /**
     * Кандидаты аварийного пула. Российские серверы исключаем: в подписках-резервах
     * попадаются чисто российские точки («YouTube без рекламы» и т. п.), а из России
     * российское ограничение не обойти — для входа по белым спискам они бесполезны.
     */
    private fun reserveCandidates(): List<Candidate> =
        repo.reserveNodes()
            .filterNot { Flags.isRussian(it.name) }
            .map { Candidate(it.name, it.map["server"]?.toString().orEmpty(), true) }

    /** Адреса серверов для диагностики — с РЕАЛЬНЫМ портом точки (см. Sub.endpointsOf). */
    private fun serverAddrs(): List<Pair<String, Int>> =
        repo.parsedSub()?.let { Sub.endpointsOf(it) }.orEmpty()

    private suspend fun applySelection(eng: Engine, c: Candidate) = selection.withLock {
        // Не коммитим выбор, если сессия уже сменилась (teardown/reconnect подняли новый
        // движок или всё снесли) — иначе в VpnBus повис бы сервер уже мёртвого движка.
        if (stopping || engine !== eng || !eng.isAlive()) return@withLock
        val wasReserve = VpnBus.reserve.value != null
        eng.control.selectProxy(c.name)
        VpnBus.setServer(c.name)
        if (c.reserve) {
            VpnBus.setReserve(ReserveInfo(c.name, c.host))
            notify(statusNotification())
            repo.recordDiag("reserve", "Ушли на резервный сервер: ${c.name}")
            // Первый уход на резерв: пересобираем конфиг полным туннелем (белые
            // списки — умная маршрутизация уже не спасает). Смена одного резерва на
            // другой полного пересбора не требует — режим уже полный.
            if (!wasReserve) rebuild.trySend(Unit)
        } else {
            VpnBus.setReserve(null)
            notify(statusNotification())
            repo.recordDiag("switch", if (wasReserve) "Вернулись на обычный сервер: ${c.name}" else "Переключение на сервер: ${c.name}")
            // Вернулись на обычный сервер — возвращаем и умную маршрутизацию.
            if (wasReserve) rebuild.trySend(Unit)
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
        // Проверки идут секундами, а за это время туннель могли переустановить (смена сети,
        // перезапуск упавшего движка). Тогда выводы о СТАРОМ движке к новой сессии не
        // относятся: убитый нами же eng «не пропускает трафик», и раньше по этому ложному
        // диагнозу рвали только что поднятый исправный туннель и писали в журнал неправду.
        val gen = sessionGen
        fun stale() = stopping || engine !== eng || sessionGen != gen || !eng.isAlive()
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
                    if (stale()) return
                    // Под белыми списками обычный сервер бывает ложно «живым»: МТС пропускает
                    // мелкую проверку и режет реальный трафик. 30.09.2026 так вернулись с
                    // рабочего резерва на неработающие «Нидерланды». Возвращаемся, только
                    // когда сама сеть перестала быть ограниченной, — по ПОЛОЖИТЕЛЬНОМУ признаку,
                    // как и сторож: зарубежное открывается напрямую. Раньше хватало «не
                    // RESTRICTED», а им был и разовый сбой прямых проб (NO_INTERNET), и OK по
                    // одному TCP до сервера — и уходили с рабочего резерва на неработающий.
                    if (back != null && Diag.externalUp()) {
                        if (stale()) return
                        Log.i(TAG, "обычная сеть восстановилась — возврат на ${back.name}")
                        applySelection(eng, back)
                        markNormal()
                        return
                    }
                }
                // Текущий резерв ещё жив — остаёмся на нём. Если сеть перед этим пропадала,
                // снимаем «нет интернета»: иначе шторка так и показывала бы его.
                if (current != null && worksThrough(eng, current)) {
                    clearNoInternet()
                    return
                }
            } else if (current != null && worksThrough(eng, current)) {
                // Обычный сервер работает — всё хорошо (кроме белых списков: их отметку
                // и предложение резерва снимает только сторож, см. markServerOk).
                VpnBus.setReserve(null)
                markServerOk()
                if (!restrictedSticky) VpnBus.setOfferReserve(false)
                return
            }
            if (stale()) return

            // Текущий не отвечает через себя. Автоматика выключена — только
            // диагностируем и предлагаем резерв, сами не переключаемся (§3).
            if (!auto) {
                val d = diagnoseServers()
                if (stale()) return
                applyDiagnosis(d)
                // Перезапуск туннеля — не смена сервера, поэтому делаем его и без автоматики.
                if (d.diagnosis == NetDiagnosis.OK && selfHealDue()) {
                    selfHeal("сеть в порядке и сервер доступен, а через туннель трафик не шёл", gen)
                    return
                }
                if (d.diagnosis != NetDiagnosis.OK && repo.reserveAvailable()) VpnBus.setOfferReserve(true)
                return
            }

            // Автоматика включена: ищем рабочий обычный сервер (параллельно).
            firstWorking(eng, normalCandidates().filter { it.name != current })?.let { c ->
                if (stale()) return
                Log.i(TAG, "переключение на рабочий обычный сервер ${c.name}")
                applySelection(eng, c)
                markServerOk()
                return
            }
            if (stale()) return

            // Обычных рабочих нет — диагностируем сеть.
            val d = diagnoseServers()
            if (stale()) return
            applyDiagnosis(d)
            Log.i(TAG, "диагностика: ${d.detail}")
            repo.recordDiag("diagnosis", "Обычные серверы не пропускают трафик. Диагностика: ${d.detail}")
            scope.launch { runCatching { repo.uploadDiag() } }
            if (d.diagnosis == NetDiagnosis.NO_INTERNET) {
                // Интернета нет вовсе — переключаться некуда, ждём восстановления сети.
                return
            }
            // Сеть напрямую в порядке и сервер достижим, а через туннель не идёт ничего —
            // туннель «залип» (после сбоя оператора, смены SIM без колбэка и т. п.). Человек в
            // этом случае выключает и включает VPN — делаем это сами (06.10.2026 после сбоя
            // МегаФона помог только ручной перезапуск). Резерв тут не поможет: он идёт через
            // тот же залипший туннель. Не больше SELF_HEAL_MAX_STREAK раз подряд — дальше
            // diagnoseServers считает сервер недоступным, и очередь доходит до резерва.
            if (d.diagnosis == NetDiagnosis.OK && selfHealDue()) {
                selfHeal("сеть в порядке и сервер доступен, а через туннель трафик не шёл", gen)
                return
            }
            if (!repo.reserveAvailable()) {
                repo.recordDiag("info", "Резервных серверов нет — восстановить нечем.")
                return
            }

            // Пробуем резерв с РЕАЛЬНОЙ проверкой ОБХОДА через него (§4): не «жив ли»,
            // а грузятся ли внешние сайты (YouTube и др.). Из сотни серверов реально
            // обходят единицы — параллельная проверка находит их быстро.
            firstWorking(eng, reserveCandidates()) { e, n -> bypassesWell(e, n) }?.let { c ->
                if (stale()) return
                Log.i(TAG, "уход на рабочий резервный сервер ${c.name}")
                applySelection(eng, c)
                return
            }
            if (stale()) return

            // Пока перебирали резерв (это секунды), обычный сервер мог ожить —
            // блокировки и микрообрывы бывают краткими. Перепроверяем текущий и
            // все обычные, прежде чем пугать человека: именно из-за этого приходило
            // ложное «резерв недоступен», хотя интернет уже работал.
            if (current != null && worksThrough(eng, current)) {
                markServerOk()
                return
            }
            firstWorking(eng, normalCandidates().filter { it.name != current })?.let { c ->
                if (stale()) return
                applySelection(eng, c)
                markServerOk()
                return
            }
            if (stale()) return

            // Резерв есть, но ни один сервер реально не заработал (§11). Отдельным
            // уведомлением НЕ пугаем: про белые списки уже сообщили выше через
            // maybeNotifyDiagnosis, а состояние резерва человек видит в приложении.
            Log.w(TAG, "резерв не восстановил соединение")
            repo.recordDiag("error", "Резерв проверен, но ни один сервер не заработал.")
            scope.launch { runCatching { repo.uploadDiag() } }
            VpnBus.setReserve(null)
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
        firstWorking(eng, ordered) { e, n -> bypassesWell(e, n) }?.let {
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
        firstWorking(eng, reserveCandidates()) { e, n -> bypassesWell(e, n) }?.let {
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

                // СМЕНА ТИПА СЕТИ (Wi-Fi ↔ мобильный) — переустанавливаем туннель, как
                // это делает Amnezia. Почему не мягкой заменой underlying: на MIUI/HyperOS
                // сеть, на которую перешли ПОСЛЕ поднятия туннеля, система не
                // перепроверяет — в шторке остаётся Wi-Fi с «!» или пропадает «4G», хотя
                // интернет есть. Полная переустановка туннеля заставляет систему
                // перепровалидировать сеть и перерисовать значок. Тип-фильтр не даёт
                // дёргать переустановку на мелких событиях (та же сеть, смена адреса).
                val newTransport = transportOf(network)
                val prev = establishedTransport
                // Сеть и правда другая (а не повтор колбэка после переустановки туннеля —
                // он приходит с той же сетью): серия самоперезапусков начинается заново.
                if (establishedNetwork != null && establishedNetwork != network) selfHealStreak = 0
                // Запоминаем текущий тип ДО решения: первое событие после подключения
                // задаёт базовую линию (prev было -1) и переустановку не вызывает; в
                // переустановленном туннеле первый onAvailable снова придёт с тем же
                // типом и совпадёт — цикла нет.
                if (newTransport != -1) establishedTransport = newTransport
                // И саму сеть: иначе опрос сочтёт её «новой» и переедет второй раз.
                establishedNetwork = network
                if (prev != -1 && newTransport != -1 && newTransport != prev &&
                    !stopping && engine?.isAlive() == true
                ) {
                    val label = netLabel(network)
                    scope.launch { reestablishTunnel("Сеть → $label (смена типа, колбэк)") }
                    return
                }

                // Тот же тип сети (или первое событие после подключения): мягкий переезд.
                moveToNetwork(network, "")
            }

            override fun onLost(network: Network) {
                runCatching { setUnderlyingNetworks(null) }
                // Если заменяющей сети нет (выключили и Wi-Fi, и мобильный) —
                // интернета сейчас нет вовсе. Показываем это сразу, чтобы на главной
                // не висело «Подключено» при мёртвой сети. При переходе Wi-Fi ↔ LTE
                // activeNetwork уже указывает на новую сеть, и мы сюда не заходим.
                if (runCatching { cm.activeNetwork }.getOrNull() == null) {
                    setDiagnosis(NetDiagnosis.NO_INTERNET)
                    repo.recordDiag("network", "Сеть пропала — интернета нет")
                }
            }

            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) {
                // Событие прилетает на каждое обновление адреса, маршрута и DNS —
                // по десятку раз за переключение сети. Пересобираем конфиг, только
                // если изменилось то, что в него попадает.
                val dns = repo.systemDns()
                if (dns != lastDns) {
                    lastDns = dns
                    // Момент смены DNS — самое узкое место: если тут «ПУСТО», прямые
                    // домены на зарубежном DoH. Снимок пишем именно здесь, чтобы
                    // поймать переходное окно, а не уже устаканившееся состояние.
                    repo.recordDiag("dns", "смена DNS: " + repo.networksDiag())
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
            // Подключились, когда сети уже нет: onAvailable не придёт, поэтому
            // выставляем диагноз сразу, иначе на главной висит «Подключено».
            if (runCatching { cm.activeNetwork }.getOrNull() == null) {
                setDiagnosis(NetDiagnosis.NO_INTERNET)
            }
        } else {
            Log.e(TAG, "не удалось подписаться на смену сети: после переключения Wi-Fi/LTE потребуется переподключение")
        }
    }

    /**
     * Мягкий переезд туннеля на сеть того же типа — из колбэка системы или из опроса
     * сторожа (на HyperOS колбэк может не прийти). Старые соединения движка (в т.ч. к
     * VPN-серверу) остались на исчезнувшей сети. Сбрасываем их РАЗ, чтобы движок сразу
     * передознился на новой, а не ждал таймаутов — из-за этого после Wi-Fi↔LTE трафик
     * иногда «висел» до перезапуска. Событие — одно на смену сети, не цикл, поэтому
     * рабочий трафик это не рвёт (при смене сети рвать и так нечего).
     */
    private fun moveToNetwork(network: Network, source: String) {
        // Привязываем туннель к новой сети: иначе движок продолжит слать пакеты в
        // исчезнувший интерфейс, и соединение «висит».
        runCatching { setUnderlyingNetworks(arrayOf(network)) }
        rebuild.trySend(Unit)
        val label = netLabel(network)
        scope.launch(Dispatchers.IO) {
            val dropped = engine?.takeIf { it.isAlive() }?.control?.closeConnections() ?: false
            repo.recordDiag(
                "network",
                "Сеть → $label: переезд туннеля" + (if (source.isNotEmpty()) " ($source)" else "") +
                    if (dropped) ", соединения сброшены" else "",
            )
            // ВАЖНО: даём серверу ПЕРЕПОДНЯТЬСЯ на новой сети, прежде чем судить
            // «жив/мёртв». Иначе первая же проверка (сеть ещё настраивается) ошибочно сочтёт
            // сервер недоступным и уведёт на резерв — а потом висим на нём. Пауза = grace.
            delay(NET_SETTLE_MS)
            // Существенная смена сети — повод перепроверить доступ и вернуться с резерва,
            // если сеть нормализовалась (§2).
            lastReturnCheck = 0
            // Новая сеть (сменили SIM, ушли с Wi-Fi) — сразу посмотреть, не белые ли там
            // списки, а не ждать минуту до следующего обхода сторожа.
            lastWhitelistWatch = 0
            triggerFailover()
        }
    }

    /** Человекочитаемый тип сети — для журнала диагностики (Wi-Fi / мобильный / …). */
    private fun netLabel(network: Network): String {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = runCatching { cm.getNetworkCapabilities(network) }.getOrNull() ?: return "новая сеть"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "мобильный интернет"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Ethernet"
            else -> "новая сеть"
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
        // Вместе с диагнозом (его сбрасывает OFF) забываем и отметку белых списков.
        restrictedSticky = false
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

    /**
     * Что показать в шторке про канал. В резервном режиме — «Резервный канал»: имя
     * резервного сервера («Автовыбор LTE» и т. п.) человеку ничего не говорит, а видеть
     * там обычный сервер — прямо неверно. Иначе — сервер, через который идём СЕЙЧАС
     * (после автоподбора он может отличаться от выбранного в настройках).
     */
    private fun channelLabel(): String? =
        if (VpnBus.reserve.value != null) RESERVE_LABEL else VpnBus.server.value ?: repo.nodeFor()?.name

    /** Уведомление «подключено» по текущему состоянию. Его же перерисовывает счётчик
        скорости, поэтому состояние берём с шины, а не из настроек: иначе через секунду
        после ухода на резерв шторка снова показывала «Подключено · Нидерланды». */
    private fun statusNotification(extra: String? = null): Notification = when {
        // Сеть оператора не отвечает вовсе — честно так и пишем. 06.10.2026 МегаФон 20 минут
        // не возвращал ни байта, приложение это видело (диагностика NO_INTERNET), а в шторке
        // висело «Подключено · Нидерланды», и человек не понимал, что происходит.
        VpnBus.diagnosis.value == NetDiagnosis.NO_INTERNET ->
            notification("Нет интернета", "Сеть не отвечает — ждём восстановления", extra)
        VpnBus.reserve.value != null -> notification("Резервное подключение", channelLabel(), extra)
        else -> notification("Подключено", channelLabel(), extra)
    }

    /** Единая точка смены диагноза: шторка перерисовывается сразу, а не со следующим
        обновлением скорости (его может и не быть — показ скорости выключаемый). */
    private fun setDiagnosis(d: NetDiagnosis) {
        val cur = VpnBus.diagnosis.value
        val changed = cur != d
        // Что было до пропажи сети — чтобы вернуть, когда связь через туннель восстановится.
        if (d == NetDiagnosis.NO_INTERNET && cur != NetDiagnosis.NO_INTERNET) diagBeforeOutage = cur
        if (d == NetDiagnosis.RESTRICTED) restrictedSticky = true
        VpnBus.setDiagnosis(d)
        if (changed && VpnBus.state.value == ConnState.ON) notify(statusNotification())
    }

    /**
     * Отметка «белые списки» — отдельно от текущего диагноза. Диагноз «нет интернета»
     * при пропаже сети на секунды затирал RESTRICTED, и первая же удачная лёгкая проверка
     * (на МТС она проходит и под белыми списками) слала ложное «Ограничения сети сняты»,
     * убирала предложение резерва, а через минуту сторож снова слал «Обнаружены». Ставит
     * её любой RESTRICTED, снимает только положительный признак: зарубежное открывается
     * напрямую (сторож, диагностика с ext=+, возврат с резерва) — см. markNormal.
     */
    @Volatile
    private var restrictedSticky = false

    /** Диагноз до пропажи сети (см. clearNoInternet). */
    @Volatile
    private var diagBeforeOutage = NetDiagnosis.UNKNOWN

    /** Итог полной диагностики: на шину, в уведомления и в отметку белых списков. */
    private fun applyDiagnosis(d: Diag.Result) {
        // Зарубежное открылось напрямую — это не белые списки. Если про ограничения сообщали,
        // шлём парное «сняты» и при SERVER_DOWN: отметки уже нет, сторож «сняты» не пришлёт,
        // а следующее «Обнаружены» гасится как повтор — человек не узнал бы ни о том, ни о другом.
        if (d.externalUp) {
            restrictedSticky = false
            emitRestrictedLifted()
        }
        setDiagnosis(d.diagnosis)
        maybeNotifyDiagnosis(d)
    }

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

    /** Последний диагноз, о котором уже уведомили, — чтобы не слать одно и то же. */
    @Volatile
    private var lastNotifiedDiag: NetDiagnosis = NetDiagnosis.OK

    /** Были ли мы уже уведомили об ограничениях (белых списках) — чтобы затем
        отправить парное «сняты» и не слать «сняты» без «обнаружены». */
    @Volatile
    private var notifiedRestricted = false

    /**
     * Уведомления по просьбе владельца — временное решение, пока собираем базу по
     * логам. Шлём ТОЛЬКО про белые списки: «обнаружены ограничения» при переходе в
     * ограниченный режим и «ограничения сняты», когда сеть нормализовалась. Про
     * «нет интернета» и «серверы недоступны» не уведомляем: человек и так это
     * видит, а лишние всплывашки только мешают. Диагностика при этом пишется в лог
     * в любом случае — уведомления её не заменяют.
     */
    private fun maybeNotifyDiagnosis(d: Diag.Result) {
        if (d.diagnosis == lastNotifiedDiag) return
        lastNotifiedDiag = d.diagnosis
        when (d.diagnosis) {
            NetDiagnosis.RESTRICTED -> {
                // Уже сообщили, а «сняты» не было — сеть лишь пропадала на секунды (между
                // ними был «нет интернета»). Второе «Обнаружены» подряд не шлём.
                if (notifiedRestricted) return
                notifiedRestricted = true
                // Сервер при этом может и отвечать (МТС пропускает соединение, но режет
                // трафик), поэтому не утверждаем «серверы недоступны».
                val next = when {
                    !repo.reserveAvailable() ->
                        "Резервного канала нет: зарубежные сайты могут не открываться, пока действуют ограничения."
                    repo.state.value.settings.autoFailover -> "Пробуем резервный канал."
                    else -> "Можно включить резервный канал в приложении."
                }
                notifyInfo(
                    "Обнаружены ограничения сети",
                    "Похоже на белые списки: российские сайты открываются, а зарубежные — нет. $next " +
                        "Признаки: ${d.detail}. Можно проверить в Hub.",
                )
            }
            // «Сняты» — только по положительному признаку: OK бывает и по одному TCP до
            // сервера при закрытом зарубежном (ru=- ext=- novpn=+), а это не снятие.
            NetDiagnosis.OK -> if (d.externalUp) emitRestrictedLifted()
            else -> Unit // NO_INTERNET, SERVER_DOWN — молча, только лог
        }
    }

    /** Если раньше сообщали об ограничениях — уведомить, что они сняты (один раз). */
    private fun emitRestrictedLifted() {
        if (!notifiedRestricted) return
        notifiedRestricted = false
        notifyInfo(
            "Ограничения сети сняты",
            "Белые списки больше не обнаруживаются — обычная сеть восстановилась.",
        )
    }

    /**
     * Сеть снова нормальная. Единая точка для всех путей возврата на обычный
     * сервер: сбрасывает диагноз в OK и, если до этого сообщали об ограничениях,
     * шлёт парное «ограничения сняты».
     */
    private fun markNormal() {
        restrictedSticky = false
        setDiagnosis(NetDiagnosis.OK)
        lastNotifiedDiag = NetDiagnosis.OK
        emitRestrictedLifted()
    }

    /** Информационное уведомление (диагностика). Отдельный id, чтобы не затирать ошибку. */
    private fun notifyInfo(title: String, text: String) {
        val n = NotificationCompat.Builder(this, CHANNEL_ALERT)
            .setSmallIcon(R.drawable.ic_stat_novpn)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(openIntent())
            .build()
        runCatching { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_DIAG_ID, n) }
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
        /** Подпись канала в шторке, пока работаем через резерв. */
        private const val RESERVE_LABEL = "Резервный канал"
        private const val NOTIFICATION_ID = 1
        private const val NOTIFICATION_ERROR_ID = 2
        private const val NOTIFICATION_DIAG_ID = 3
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

        /**
         * Проверка реального ОБХОДА для аварийного пула: внешние сайты, которые в
         * белых списках недоступны напрямую. YouTube — главный маркер (в РФ режется),
         * плюс запасные. Все отдают 204 и отвечают быстро; российский или мёртвый
         * сервер их не пропустит — такой резерв не выберем.
         */
        private val BYPASS_URLS = listOf(
            "https://www.youtube.com/generate_204",
            "https://www.google.com/generate_204",
            "https://cp.cloudflare.com/generate_204",
            "https://www.gstatic.com/generate_204",
        )
        private const val BYPASS_TIMEOUT_MS = 3_500
        /** Сколько внешних сайтов должно реально загрузиться, чтобы счесть обход рабочим. */
        private const val BYPASS_MIN_OK = 2
        /** Сколько серверов проверять параллельно (перебор сотни резервных). */
        private const val HEALTH_CONCURRENCY = 8
        /** Как часто сторож проверяет доступ выбранного сервера. */
        private const val HEALTH_TICK_MS = 12_000L
        /** Как часто из резервного режима пробуем вернуться на обычный. */
        private const val RETURN_CHECK_MS = 45_000L
        /** Пауза после смены сети перед вердиктом о доступности сервера: даём ему
         *  переподняться на новой сети, иначе уходим на резерв по ложной тревоге. */
        private const val NET_SETTLE_MS = 4_000L
        /** Как часто сторож смотрит, не белые ли списки в сети (плюс сразу после её смены).
         *  В обычной сети это один маленький запрос — телефон и трафик не нагружает. */
        private const val WHITELIST_WATCH_MS = 60_000L
        /** Самовосстановление туннеля: не чаще раза в 2 минуты; после SELF_HEAL_MAX_STREAK
         *  бесполезных попыток подряд — больше не перезапускаем до смены сети или ожившего
         *  туннеля, сервер считаем недоступным (см. selfHealExhausted). */
        private const val SELF_HEAL_MIN_MS = 120_000L
        private const val SELF_HEAL_MAX_STREAK = 3
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
                .onFailure { Log.w(TAG, "не удалось запустить службу (запуск из фона на Android 12+?): ${it.message}") }
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
