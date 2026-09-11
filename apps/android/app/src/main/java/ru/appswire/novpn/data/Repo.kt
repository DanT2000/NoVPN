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

    fun update(block: (State) -> State) {
        val next = block(_state.value)
        _state.value = next
        store.saveState(next)
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
        val resp = runCatching { Http.get(clean) }.getOrElse {
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
        update { it.copy(subUrl = clean) }
        refreshMeta()
        val servers = rebuildServers(parsed)
        Result.success(servers.map { it.key }.distinct().size)
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
    fun systemDns(): List<String> = runCatching {
        val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
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
            // Проверенная системой сеть важнее: на ней и живёт реальный интернет.
            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) return list
            if (fallback.isEmpty()) fallback = list
        }
        fallback
    }.getOrDefault(emptyList())

    fun rules(st: State = _state.value): Rules {
        val node = nodeFor(st)
        val l = lists
        val useLists = st.settings.autoUpdateLists || l != null
        val smart = effectiveSmart(st)
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

    /** Готовый конфиг движка для текущего состояния. */
    fun buildConfig(tunFd: Int, secret: String): String? {
        val parsed = parsedSub() ?: return null
        val node = nodeFor()
        return Config.build(
            parsed = parsed,
            rules = rules(),
            selected = node?.name,
            tunFd = tunFd,
            secret = secret,
        )
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
