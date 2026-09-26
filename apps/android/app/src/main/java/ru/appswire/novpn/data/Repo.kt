package ru.appswire.novpn.data

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.NetworkCapabilities
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import ru.appswire.novpn.core.Config
import ru.appswire.novpn.core.Denied
import ru.appswire.novpn.core.DomainRule
import ru.appswire.novpn.core.ListsParser
import ru.appswire.novpn.core.Meta
import ru.appswire.novpn.core.Preset
import ru.appswire.novpn.core.MetaResult
import ru.appswire.novpn.core.RoutingLists
import ru.appswire.novpn.core.Rules
import ru.appswire.novpn.core.ServerEntry
import ru.appswire.novpn.core.Sub
import ru.appswire.novpn.core.deniedHuman
import ru.appswire.novpn.net.Http
import ru.appswire.novpn.store.DiagEntry
import ru.appswire.novpn.store.SiteRule
import ru.appswire.novpn.store.State
import ru.appswire.novpn.store.Store
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Состояние приложения и всё общение с панелью.
 *
 * Здесь же — сопоставление профилей подписки с meta.json (контракт, раздел 9.3):
 * у одного сервера бывает два профиля, умный и «Полный VPN», и в списке серверов
 * человек должен видеть ОДИН сервер с тумблером, а не два одинаковых.
 */
class Repo(private val app: Context) {

    val store = Store(app)

    private val _state = MutableStateFlow(store.loadState())
    val state: StateFlow<State> = _state.asStateFlow()

    // Списки и meta читаются лениво. Repo создаётся из Application.onCreate,
    // Service.onCreate и приёмника загрузки — всё это главный поток, а lists.json
    // при боевом списке панели весит мегабайты. Разбор JSON там съедал бы то самое
    // время, за которое служба обязана успеть показать уведомление, иначе система
    // убивает её с ошибкой.
    @Volatile
    private var listsCache: RoutingLists? = null

    @Volatile
    private var listsLoaded = false

    @Volatile
    private var metaCache: Meta? = null

    @Volatile
    private var metaLoaded = false

    var lists: RoutingLists?
        get() {
            if (!listsLoaded) synchronized(this) {
                if (!listsLoaded) {
                    listsCache = store.loadLists()
                    listsLoaded = true
                }
            }
            return listsCache
        }
        private set(value) {
            listsCache = value
            listsLoaded = true
        }

    var meta: Meta?
        get() {
            if (!metaLoaded) synchronized(this) {
                if (!metaLoaded) {
                    metaCache = store.loadMeta()
                    metaLoaded = true
                }
            }
            return metaCache
        }
        private set(value) {
            metaCache = value
            metaLoaded = true
        }

    /** Последний отказ панели (4xx). Пока он здесь — подключаться нельзя. */
    private val _denied = MutableStateFlow<Denied?>(null)
    val deniedFlow: StateFlow<Denied?> = _denied.asStateFlow()

    val denied: Denied? get() = _denied.value

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** Сериализует read-modify-write состояния. update() зовут и с главного потока (тумблеры
     *  UI), и с Dispatchers.IO (checkSubscription/refreshMeta), и со scope службы
     *  (checkFullTimeout) — без сериализации параллельные вызовы теряли изменения и писали
     *  несогласованное состояние на диск. */
    private val updateLock = Any()

    fun update(block: (State) -> State) {
        synchronized(updateLock) {
            val next = block(_state.value)
            _state.value = next
            store.saveState(next)
        }
    }

    // ── подписка ──

    /** Разобранная подписка из локальной копии: нужна и без сети. */
    fun parsedSub(): Sub.Parsed? {
        val raw = store.loadSubRaw() ?: return null
        return runCatching { Sub.parse(raw) }.getOrNull()
    }

    /**
     * Скачивает подписку, разбирает и сохраняет. Затем спрашивает панель про
     * профили. Возвращает количество серверов или текст ошибки.
     */
    suspend fun checkSubscription(url: String): Result<Int> = withContext(Dispatchers.IO) {
        val clean = url.trim()
        // Только https: в подписке ключи и uuid, по открытому каналу за ней не ходят.
        // Единственное исключение — отладочная сборка и адрес хоста эмулятора:
        // так туннель проверяется локальным стендом без боевой панели.
        val debugStand = isDebuggable() && clean.startsWith("http://10.0.2.2")
        if (!clean.startsWith("https://") && !debugStand) {
            return@withContext Result.failure(IllegalArgumentException("Ссылка должна начинаться с https://"))
        }
        // Личная ссылка https://<домен>/k/<accessToken> (её шлём пользователю) → сначала
        // разрешаем её в прямой URL подписки; иначе за ней тянулась бы HTML-страница кабинета.
        val effective = if (clean.contains("/k/")) {
            resolveAccessLink(clean)
                ?: return@withContext Result.failure(IllegalStateException("Не удалось разобрать личную ссылку — попросите у администратора новую"))
        } else {
            clean
        }
        val resp = runCatching { Http.get(effective) }.getOrElse {
            return@withContext Result.failure(IllegalStateException("Панель недоступна: ${it.message}"))
        }
        if (resp.code == 404) {
            return@withContext Result.failure(IllegalStateException("Подписка недействительна — проверьте ссылку"))
        }
        if (resp.code !in 200..299) {
            return@withContext Result.failure(IllegalStateException("Панель ответила ${resp.code}"))
        }
        val parsed = runCatching { Sub.parse(resp.body) }.getOrElse {
            return@withContext Result.failure(IllegalStateException(it.message ?: "Подписка не разобрана"))
        }
        store.saveSubRaw(resp.body)
        // Храним ЭФФЕКТИВНЫЙ (разрешённый) URL: резерв/meta должны идти на /sub/…, не на /k/.
        update { it.copy(subUrl = effective) }
        refreshMeta()
        val servers = rebuildServers(parsed)
        Result.success(servers.map { it.key }.distinct().size)
    }

    /**
     * Личная ссылка вида https://<домен>/k/<accessToken> — её мы шлём пользователю.
     * Спрашиваем панель `GET <origin>/api/public/resolve?token=<token>` и получаем прямые
     * URL подписки. Берём полный профиль (обход белых списков) если он есть, иначе обычный.
     * Возвращает null, если это не /k/-ссылка не удалось разобрать (тогда вызывающий даст
     * человеку понятную ошибку).
     */
    private fun resolveAccessLink(url: String): String? {
        val idx = url.indexOf("/k/")
        if (idx < 0) return null
        val origin = url.substring(0, idx)
        if (!origin.startsWith("http")) return null
        val token = url.substring(idx + 3)
            .substringBefore('/').substringBefore('?').substringBefore('#').trim()
        if (token.isEmpty()) return null
        val resp = runCatching { Http.get("$origin/api/public/resolve?token=$token") }.getOrNull()
            ?: return null
        if (resp.code !in 200..299) return null
        // Легковесный разбор без модели: сначала full (обход), затем обычная подписка.
        fun grab(key: String): String? =
            Regex("\"$key\"\\s*:\\s*\"([^\"]+)\"").find(resp.body)?.groupValues?.getOrNull(1)
        return grab("full") ?: grab("sub")
    }

    private fun isDebuggable(): Boolean =
        (app.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0

    /** Спросить панель про профили. Никогда не бросает (контракт, раздел 2). */
    suspend fun refreshMeta(): MetaResult = withContext(Dispatchers.IO) {
        val sub = _state.value.subUrl
        val url = Meta.metaUrl(sub) ?: return@withContext MetaResult(meta = meta, source = "none")
        val resp = runCatching { Http.get(url) }.getOrElse {
            return@withContext MetaResult(meta = meta, source = if (meta != null) "cache" else "none", networkError = it.message)
        }
        when {
            resp.code in 200..299 -> {
                val parsed = runCatching { Meta.parse(resp.body) }.getOrNull()
                    ?: return@withContext MetaResult(meta = meta, source = if (meta != null) "cache" else "none", networkError = "meta.json не разобран")
                _denied.value = null
                // Кэшируем только то, что поняли: непонятную версию не пишем.
                if (!parsed.unsupported) {
                    store.saveMetaRaw(resp.body)
                    meta = parsed
                }
                parsedSub()?.let { rebuildServers(it) }
                // Полный профиль могли отозвать, пока соединение живёт (контракт, §9.4).
                // Тогда выбранная точка сменилась, и движку надо об этом сказать —
                // иначе телефон продолжит гнать весь трафик в туннель до перезапуска.
                if (ru.appswire.novpn.vpn.VpnBus.isRunning) {
                    ru.appswire.novpn.vpn.NoVpnService.reload(app)
                }
                MetaResult(meta = parsed, source = "network", unsupported = parsed.unsupported)
            }

            resp.code in 400..499 -> {
                // 4xx — авторитетный отказ. Кэш НЕ стираем (доступ могут вернуть),
                // но подключаться нельзя до валидного 200.
                val kind = runCatching {
                    ((json.parseToJsonElement(resp.body) as? JsonObject)
                        ?.get("error") as? JsonObject)
                        ?.get("type").let { (it as? JsonPrimitive)?.contentOrNull }
                }.getOrNull() ?: if (resp.code == 404) "not_found" else "denied"
                val d = Denied(resp.code, kind, deniedHuman(kind))
                _denied.value = d
                MetaResult(meta = meta, source = "network", denied = d)
            }

            // 5xx и прочее — панель нездорова, это не сигнал об отзыве.
            else -> MetaResult(
                meta = meta,
                source = if (meta != null) "cache" else "none",
                networkError = "панель ответила ${resp.code}",
            )
        }
    }

    /** Собирает список серверов из подписки и meta.json. */
    fun rebuildServers(parsed: Sub.Parsed): List<ServerEntry> {
        val m = meta
        val entries = when (parsed) {
            is Sub.Parsed.Nodes -> parsed.nodes.map { node ->
                val p = node.profile
                val host = node.map["server"]?.toString().orEmpty()
                // Основной ключ — profileId из meta.novpn. Запасной (контракт, §3) —
                // адрес узла: у старых панелей и чужих подписок meta.novpn нет вовсе,
                // и сопоставлять можно только по нему.
                val prof = p?.let { m?.byId(it.profileId) }
                    ?: m?.profiles?.firstOrNull { it.host.isNotEmpty() && it.host == host }
                ServerEntry(
                    name = node.name,
                    profileId = p?.profileId,
                    serverId = p?.serverId?.ifEmpty { null } ?: prof?.serverId?.ifEmpty { null },
                    host = host,
                    mode = prof?.mode ?: p?.mode ?: "smart",
                    recommended = prof?.recommended ?: false,
                    lanAccess = prof?.routing?.lanAccess ?: false,
                    fullTimeoutHours = prof?.routing?.fullTimeoutHours ?: 0.0,
                )
            }

            is Sub.Parsed.Clash -> Sub.namesOf(parsed).map { ServerEntry(name = it) }
        }
        update { st ->
            val key = st.serverKey?.takeIf { k -> entries.any { it.key == k } }
                ?: entries.firstOrNull { it.recommended }?.key
                ?: entries.firstOrNull()?.key
            st.copy(servers = entries, serverKey = key)
        }
        return entries
    }

    // ── серверы и профили ──

    /** Все профили выбранного сервера. */
    fun groupOf(st: State = _state.value): List<ServerEntry> {
        val key = st.serverKey ?: return emptyList()
        return st.servers.filter { it.key == key }
    }

    /** Есть ли у выбранного сервера профиль «Полный VPN». */
    fun fullAvailable(st: State = _state.value): Boolean = groupOf(st).any { it.mode == "full" }

    /** Реальный режим: выключенная умная действует только при наличии полного профиля. */
    fun effectiveSmart(st: State = _state.value): Boolean = st.smartRouting || !fullAvailable(st)

    /** Точка подключения, которой подключаемся. */
    fun nodeFor(st: State = _state.value): ServerEntry? {
        val group = groupOf(st)
        if (group.isEmpty()) return null
        if (!effectiveSmart(st)) group.firstOrNull { it.mode == "full" }?.let { return it }
        return group.firstOrNull { it.mode != "full" } ?: group.first()
    }

    /** Представители для списка серверов: по одному на сервер, умный профиль. */
    fun representatives(st: State = _state.value): List<ServerEntry> {
        val seen = linkedMapOf<String, ServerEntry>()
        for (s in st.servers) {
            val prev = seen[s.key]
            if (prev == null || (prev.mode == "full" && s.mode != "full")) seen[s.key] = s
        }
        return seen.values.toList()
    }

    // ── списки маршрутизации ──

    suspend fun syncLists(): Result<Int> = withContext(Dispatchers.IO) {
        val sub = _state.value.subUrl
        val base = Meta.baseOf(sub)
            ?: return@withContext Result.failure(IllegalStateException("Нет адреса панели"))
        // Адрес списков берём из meta, но только если он ведёт на ТУ ЖЕ панель: иначе
        // подписка могла бы увести клиента за правилами на чужой сервер.
        val url = meta?.routingResources?.get("upstream")?.takeIf { it.startsWith("$base/") }
            ?: "$base/routing/upstream.json"
        val resp = runCatching { Http.get(url, lists?.etag) }.getOrElse {
            return@withContext Result.failure(IllegalStateException("Списки недоступны: ${it.message}"))
        }
        // 304 — не менялось: рабочая копия остаётся, это успех, а не ошибка.
        if (resp.code == 304) {
            update { it.copy(listsSyncedAt = System.currentTimeMillis()) }
            return@withContext Result.success(lists?.total ?: 0)
        }
        if (resp.code !in 200..299 || !ListsParser.looksLikeList(resp.body)) {
            return@withContext Result.failure(IllegalStateException("Панель отдала не список (${resp.code})"))
        }
        val parsed = runCatching { ListsParser.parse(resp.body, resp.etag) }.getOrElse {
            return@withContext Result.failure(IllegalStateException("Список не разобран: ${it.message}"))
        }
        lists = parsed
        store.saveLists(parsed)
        update { it.copy(listsSyncedAt = System.currentTimeMillis()) }
        Result.success(parsed.total)
    }

    // ── правила для движка ──

    /**
     * Системные DNS устройства.
     *
     * Значение `system` движку на Android не подходит: он читает /etc/resolv.conf,
     * которого здесь нет, и молча уезжает на свои зашитые 114.114.114.114 и 8.8.8.8.
     * Поэтому адреса подставляем явно.
     *
     * Берём именно НЕ-VPN сеть: после establish() активной сетью становится сам
     * туннель, и его «резолверы» — это мы же, то есть петля.
     *
     * Если у человека включён Private DNS в строгом режиме, открытый UDP-резолвер
     * подставлять нельзя — это тихо понизило бы шифрованный DNS до обычного.
     * В этом случае отдаём тот же сервер как DoT.
     */
    /** Последний НЕ пустой системный DNS — подстраховка на переходное окно смены сети. */
    @Volatile
    private var lastGoodDns: List<String> = emptyList()

    fun systemDns(): List<String> {
        val fresh = computeSystemDns()
        // Устойчивость к переходному окну смены сети (корень бага «Сбер/Озон не
        // открываются, лечит переподключение»): при смене соты/дата-SIM система на
        // доли секунды не отдаёт DNS ни на одной INTERNET-сети, и раньше systemDns()
        // возвращал ПУСТО. Тогда nameserver-policy для прямых (российских) доменов
        // пропадала, и они уходили на зарубежный DoH (1.1.1.1/8.8.8.8), который
        // оператор режет → NXDOMAIN. Держим последний рабочий, пока сеть не отдаст
        // новый — политика не обнуляется, прямой доступ не рвётся.
        return if (fresh.isNotEmpty()) {
            lastGoodDns = fresh
            fresh
        } else {
            lastGoodDns
        }
    }

    private fun computeSystemDns(): List<String> = runCatching {
        val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        // Предпочитаем сеть, НЕСУЩУЮ маршрут по умолчанию (реальный интернет-выход), а не
        // просто «первую валидированную»: при двух SIM и IMS-каналах DNS не той сети
        // недоступен через дефолтный маршрут, и прямые домены не резолвятся.
        var best: List<String> = emptyList()       // validated + маршрут по умолчанию
        var validated: List<String> = emptyList()  // validated без дефолт-маршрута
        var fallback: List<String> = emptyList()
        @Suppress("DEPRECATION")
        for (network in cm.allNetworks) {
            val caps = cm.getNetworkCapabilities(network) ?: continue
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
            if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue
            val props: LinkProperties = cm.getLinkProperties(network) ?: continue
            val privateDns = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                props.privateDnsServerName
            } else null
            val list = if (!privateDns.isNullOrBlank()) {
                listOf("tls://$privateDns")
            } else {
                props.dnsServers.mapNotNull { it.hostAddress }
                    // Адреса самого туннеля резолверами быть не могут.
                    .filterNot { it.startsWith("198.18.") || it.startsWith("172.19.") }
                    .distinct()
            }
            if (list.isEmpty()) continue
            // Проверенная системой сеть важнее: на ней и живёт реальный интернет; из них —
            // та, что несёт маршрут по умолчанию (именно через неё уходят наши сокеты).
            val validatedNet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            val hasDefaultRoute = props.routes.any { runCatching { it.isDefaultRoute }.getOrDefault(false) }
            when {
                validatedNet && hasDefaultRoute -> if (best.isEmpty()) best = list
                validatedNet -> if (validated.isEmpty()) validated = list
                fallback.isEmpty() -> fallback = list
            }
        }
        when {
            best.isNotEmpty() -> best
            validated.isNotEmpty() -> validated
            else -> fallback
        }
    }.getOrDefault(emptyList())

    /**
     * Диагностический снимок сетей для журнала. Пишется при пересборке конфига,
     * чтобы поймать перемежающийся сбой прямого доступа (Сбер и др. российские
     * сайты «нет интернета» после смены сети): показывает, какой резолвер выбрал
     * systemDns() для прямых доменов и почему. Если тут «ПУСТО» — прямые домены
     * ушли на зарубежный DoH, который оператор режет; если DNS чужой сети (напр.
     * 8.8.8.8 с IMS-канала) — тоже. Чистая диагностика: поведение НЕ меняет.
     */
    fun networksDiag(): String = runCatching {
        val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val chosen = systemDns()
        val active = runCatching { cm.activeNetwork }.getOrNull()
        val sb = StringBuilder()
        sb.append("DNS прямых = ")
        sb.append(if (chosen.isEmpty()) "ПУСТО→зарубежный DoH" else chosen.joinToString(","))
        @Suppress("DEPRECATION")
        for (network in cm.allNetworks) {
            val caps = cm.getNetworkCapabilities(network) ?: continue
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
            val t = when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cell"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "eth"
                else -> "other"
            }
            val inet = if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) 1 else 0
            val valid = if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) 1 else 0
            val lp = cm.getLinkProperties(network)
            val dns = lp?.dnsServers?.mapNotNull { it.hostAddress }?.joinToString(",").orEmpty()
            val iface = lp?.interfaceName ?: "?"
            val def = if (network == active) "*" else ""
            sb.append("; $def$iface/$t i$inet v$valid dns=[$dns]")
        }
        sb.toString()
    }.getOrDefault("networksDiag: n/a")

    /**
     * @param forceFull увести ВЕСЬ трафик в туннель, игнорируя умную маршрутизацию.
     *   Нужно в аварийном режиме (белые списки): там даже российские сайты напрямую
     *   не открываются, поэтому «умное» деление теряет смысл — всё идёт через рабочий
     *   резервный сервер. На пер-приложенческие исключения (addDisallowedApplication)
     *   это НЕ влияет: они задаются при поднятии туннеля и остаются как выбрал человек.
     */
    fun rules(st: State = _state.value, forceFull: Boolean = false): Rules {
        val node = nodeFor(st)
        val l = lists
        val useLists = st.settings.autoUpdateLists || l != null
        val smart = effectiveSmart(st) && !forceFull
        val userDomains = st.sites
            .filter { it.enabled }
            .map { DomainRule(it.domain, it.route == "vpn") }
        val dnsProvider = if (st.settings.dnsProvider == "custom") {
            st.settings.customDns.trim().ifEmpty { "cloudflare" }
        } else st.settings.dnsProvider

        return Rules(
            smart = smart,
            lanAccess = node?.lanAccess ?: false,
            bypassLocal = st.settings.bypassLocal,
            customLocal = st.settings.customLocalDomains,
            dnsProvider = dnsProvider,
            systemDns = systemDns(),
            userDomains = userDomains,
            // Российские сервисы идут напрямую ВСЕГДА: панель их не присылает
            // (upstream — это список того, что уводится в VPN), а без этого слоя любое
            // широкое правило из списков утащило бы банк или госуслуги за границу.
            listDirectDomains = Preset.directDomains(app) + if (useLists) l?.directDomains.orEmpty() else emptyList(),
            // Пока списки ещё не скачались, работаем по встроенному запасу — иначе
            // на свежей установке «VPN включён, а ничего не изменилось».
            listVpnDomains = when {
                !smart -> emptyList()
                !l?.vpnDomains.isNullOrEmpty() -> l!!.vpnDomains
                else -> Preset.fallbackVpnDomains(app)
            },
            listVpnFull = if (useLists && smart) l?.vpnFull.orEmpty() else emptyList(),
            listVpnKeywords = if (useLists && smart) l?.vpnKeywords.orEmpty() else emptyList(),
            listVpnRegex = if (useLists && smart) l?.vpnRegex.orEmpty() else emptyList(),
            listVpnIps = if (useLists && smart) l?.vpnIps.orEmpty() else emptyList(),
        )
    }

    /**
     * Готовый конфиг движка для текущего состояния.
     * @param forceFull аварийный полный туннель (белые списки) — см. [rules].
     */
    fun buildConfig(tunFd: Int, secret: String, forceFull: Boolean = false): String? {
        val parsed = parsedSub() ?: return null
        val node = nodeFor()
        val reserve = reserveNodes()
        return Config.build(
            parsed = parsed,
            rules = rules(forceFull = forceFull),
            selected = node?.name,
            tunFd = tunFd,
            secret = secret,
            // Резервные прокси кладём в тот же конфиг: уход на резерв — это один
            // selectProxy без пересборки и перезапуска движка.
            reserveProxies = reserve.map { it.map },
            reserveHosts = reserve.mapNotNull { it.map["server"]?.toString() },
        )
    }

    // ── резервный пул (аварийные внешние серверы) ──

    @Volatile
    private var reserveCache: List<Sub.Node>? = null

    @Volatile
    private var reserveLoaded = false

    /** Разобранные резервные серверы. Скрыты из обычного списка — только для аварии. */
    fun reserveNodes(): List<Sub.Node> {
        if (!reserveLoaded) synchronized(this) {
            if (!reserveLoaded) {
                reserveCache = store.loadReserveRaw()
                    ?.let { runCatching { Sub.parse(it) }.getOrNull() }
                    ?.let { (it as? Sub.Parsed.Nodes)?.nodes }
                reserveLoaded = true
            }
        }
        return reserveCache ?: emptyList()
    }

    fun reserveNames(): List<String> = reserveNodes().map { it.name }

    /** Хост резервного сервера по имени — для отчёта о расходе на панель. */
    fun reserveHostOf(name: String): String? =
        reserveNodes().firstOrNull { it.name == name }?.map?.get("server")?.toString()

    /** Есть ли доступный резерв (панель подтвердила и список непустой). */
    fun reserveAvailable(): Boolean = (meta?.backup?.available == true) && reserveNodes().isNotEmpty()

    /** Адрес резервного списка: из meta, но строго на ту же панель (как у списков). */
    private fun reserveUrl(): String? {
        val sub = _state.value.subUrl
        val base = Meta.baseOf(sub) ?: return null
        meta?.backup?.sub?.takeIf { it.startsWith("$base/") }?.let { return it }
        // Запасной вывод из адреса подписки: <base>/sub/<token>/backup.
        val metaUrl = Meta.metaUrl(sub) ?: return null
        return metaUrl.removeSuffix("/meta.json") + "/backup"
    }

    /** Обновить резервный пул. Никогда не бросает: резерв — это подстраховка. */
    suspend fun syncReserve(): Unit = withContext(Dispatchers.IO) {
        // Панель не предложила резерв этому пользователю — чистим локальную копию.
        if (meta != null && meta?.backup?.available != true) {
            store.deleteReserveRaw()
            synchronized(this@Repo) { reserveCache = emptyList(); reserveLoaded = true }
            return@withContext
        }
        val url = reserveUrl() ?: return@withContext
        val resp = runCatching { Http.get(url) }.getOrNull() ?: return@withContext
        if (resp.code !in 200..299 || resp.body.isBlank()) return@withContext
        val nodes = runCatching { Sub.parse(resp.body) }.getOrNull()
            ?.let { (it as? Sub.Parsed.Nodes)?.nodes } ?: return@withContext
        store.saveReserveRaw(resp.body)
        synchronized(this@Repo) { reserveCache = nodes; reserveLoaded = true }
    }

    /** Личная резервная подписка: добавить/заменить. Возвращает текст ошибки или null. */
    suspend fun setPersonalReserve(rawUrl: String): String? = withContext(Dispatchers.IO) {
        val url = rawUrl.trim()
        if (!url.startsWith("https://")) return@withContext "Ссылка должна начинаться с https://"
        val endpoint = personalReserveEndpoint() ?: return@withContext "Нет адреса панели"
        val body = JsonObject(mapOf("url" to JsonPrimitive(url))).toString()
        val code = Http.send("PUT", endpoint, body) ?: return@withContext "Панель недоступна"
        if (code !in 200..299) return@withContext "Панель ответила $code"
        syncReserve()
        null
    }

    suspend fun removePersonalReserve(): Unit = withContext(Dispatchers.IO) {
        val endpoint = personalReserveEndpoint() ?: return@withContext
        Http.send("DELETE", endpoint, null)
        syncReserve()
    }

    private fun personalReserveEndpoint(): String? {
        val metaUrl = Meta.metaUrl(_state.value.subUrl) ?: return null
        return metaUrl.removeSuffix("/meta.json") + "/backup/personal"
    }

    // ── журнал диагностики (§13) ──

    private val diagLock = Any()
    private val DIAG_MAX = 300

    @Volatile
    private var diagCache: MutableList<DiagEntry>? = null

    private fun diagList(): MutableList<DiagEntry> {
        diagCache?.let { return it }
        synchronized(diagLock) {
            diagCache?.let { return it }
            val loaded = store.loadDiag().toMutableList()
            diagCache = loaded
            return loaded
        }
    }

    /** Записать событие диагностики. Хвост ограничиваем, чтобы файл не рос. */
    fun recordDiag(kind: String, text: String) {
        synchronized(diagLock) {
            val list = diagList()
            list.add(DiagEntry(at = nowIsoLocal(), kind = kind, text = text))
            while (list.size > DIAG_MAX) list.removeAt(0)
            store.saveDiag(list)
        }
    }

    /** Последние записи для показа в приложении (новые первыми). */
    fun recentDiag(limit: Int = 50): List<DiagEntry> =
        synchronized(diagLock) { diagList().takeLast(limit).asReversed() }

    /** Досылает неотправленные записи на панель, когда есть интернет. Не бросает. */
    suspend fun uploadDiag(): Unit = withContext(Dispatchers.IO) {
        if (!_state.value.settings.sendDiagnostics) return@withContext
        val pending = synchronized(diagLock) { diagList().filterNot { it.uploaded } }
        if (pending.isEmpty()) return@withContext
        val metaUrl = Meta.metaUrl(_state.value.subUrl) ?: return@withContext
        val endpoint = metaUrl.removeSuffix("/meta.json") + "/diag"
        val items = pending.joinToString(",") {
            JsonObject(
                mapOf(
                    "at" to JsonPrimitive(it.at),
                    "kind" to JsonPrimitive(it.kind),
                    "text" to JsonPrimitive(it.text),
                ),
            ).toString()
        }
        val code = Http.send("POST", endpoint, "{\"items\":[$items]}") ?: return@withContext
        if (code in 200..299) synchronized(diagLock) {
            // Помечаем выгруженными ТОЛЬКО реально отправленные (snapshot `pending`). Записи,
            // добавленные во время POST, не отправлялись — их не трогаем, уйдут в следующий раз
            // (раньше метились все → терялись).
            val sent = pending.toHashSet()
            val list = diagList()
            for (i in list.indices) if (!list[i].uploaded && list[i] in sent) list[i] = list[i].copy(uploaded = true)
            store.saveDiag(list)
        }
    }

    private fun nowIsoLocal(): String = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
        .format(java.util.Date())

    /** Отчёт о резервном расходе: сколько байт ушло через резервный host. */
    suspend fun reportReserveUsage(host: String, bytes: Long): Unit = withContext(Dispatchers.IO) {
        if (host.isEmpty() || bytes <= 0) return@withContext
        val metaUrl = Meta.metaUrl(_state.value.subUrl) ?: return@withContext
        val endpoint = metaUrl.removeSuffix("/meta.json") + "/backup/usage"
        val body = JsonObject(
            mapOf("host" to JsonPrimitive(host), "bytes" to JsonPrimitive(bytes)),
        ).toString()
        Http.send("POST", endpoint, body)
    }

    // ── правила по сайтам ──

    fun addSite(domainRaw: String, route: String) {
        val domain = Config.cleanDomain(domainRaw) ?: return
        update { st ->
            if (st.sites.any { it.domain == domain }) st
            else st.copy(
                sites = st.sites + SiteRule(
                    id = "s${System.currentTimeMillis()}",
                    title = domain.substringBefore('.').replaceFirstChar { it.uppercase() },
                    domain = domain,
                    route = route,
                ),
            )
        }
    }

    fun removeSite(id: String) = update { st -> st.copy(sites = st.sites.filterNot { it.id == id }) }

    fun setSiteRoute(id: String, route: String) = update { st ->
        st.copy(sites = st.sites.map { if (it.id == id) it.copy(route = route) else it })
    }

    fun toggleSite(id: String) = update { st ->
        st.copy(sites = st.sites.map { if (it.id == id) it.copy(enabled = !it.enabled) else it })
    }

    companion object {
        // Это applicationContext, а не активность: держать его в статике безопасно,
        // он живёт столько же, сколько процесс.
        @SuppressLint("StaticFieldLeak")
        @Volatile
        private var instance: Repo? = null

        fun get(context: Context): Repo = instance ?: synchronized(this) {
            instance ?: Repo(context.applicationContext).also { instance = it }
        }
    }
}
