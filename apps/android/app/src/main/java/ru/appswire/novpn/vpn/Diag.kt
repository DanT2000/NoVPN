package ru.appswire.novpn.vpn

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import ru.appswire.novpn.core.Sub
import java.net.InetSocketAddress
import java.net.Socket
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

/**
 * Диагностика сети по СОВОКУПНОСТИ признаков, а не по одному ping или одному сайту.
 *
 * Запросы идут напрямую, мимо туннеля: приложение исключено из VPN целиком
 * (addDisallowedApplication на свой пакет), поэтому эти пробы честно отражают
 * реальную сеть устройства — и когда VPN выключен, и когда работает.
 *
 * Как различаем ограниченный режим («белые списки»): в такой сети доступны
 * российские ресурсы (Яндекс, Ozon), но недоступны обычные внешние (Google,
 * Cloudflare) и серверы NoVPN. Не утверждаем «это точно белые списки» —
 * возвращаем RESTRICTED как «похоже на ограниченный режим».
 */
object Diag {

    /** Российские ресурсы: доступны даже в ограниченной сети. */
    private val RUSSIA = listOf("https://ya.ru/", "https://www.ozon.ru/", "https://vk.com/")

    /** Обычные внешние ресурсы: в ограниченной сети недоступны. */
    private val EXTERNAL = listOf(
        "https://www.google.com/generate_204",
        "https://cp.cloudflare.com/generate_204",
        "https://www.gstatic.com/generate_204",
    )

    data class Result(
        val diagnosis: NetDiagnosis,
        val russiaUp: Boolean,
        val externalUp: Boolean,
        val novpnUp: Boolean,
    ) {
        /** Строка для журнала диагностики. */
        val detail: String
            get() = "ru=${on(russiaUp)} ext=${on(externalUp)} novpn=${on(novpnUp)} → $diagnosis"

        private fun on(b: Boolean) = if (b) "+" else "-"
    }

    private val probe: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(4, TimeUnit.SECONDS)
            .callTimeout(6, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
    }

    /** Доступен ли хоть один URL из списка (любой ответ сервера считается «сеть дошла»). */
    private suspend fun anyReachable(urls: List<String>): Boolean = coroutineScope {
        urls.map { url ->
            async(Dispatchers.IO) {
                runCatching {
                    val req = Request.Builder().url(url).head().header("User-Agent", "NoVPN-Diag").build()
                    probe.newCall(req).execute().use { it.code in 200..499 }
                }.getOrDefault(false)
            }
        }.any { it.await() }
    }

    /**
     * Достижим ли хоть один сервер NoVPN. TLS/REALITY-сервер — по рукопожатию: TCP-соединение
     * мобильный оператор «принимает» сам даже к заблокированному адресу (31.10.2026 «Нидерланды»
     * под блоком давали novpn=+ → диагноз OK → три бесполезных перезапуска туннеля, 6–8 минут
     * до резерва). Ответ TLS посредник не подделает: REALITY без нашего ключа отдаёт рукопожатие
     * сайта-маски, а заблокированный адрес молчит.
     */
    private suspend fun anyServerUp(servers: List<Sub.Endpoint>): Boolean = coroutineScope {
        if (servers.isEmpty()) return@coroutineScope false
        servers.take(4).map { e ->
            async(Dispatchers.IO) {
                if (e.sni != null) tlsReachable(e.host, e.port, e.sni) else tcpReachable(e.host, e.port)
            }
        }.any { it.await() }
    }

    internal fun tcpReachable(host: String, port: Int, timeoutMs: Int = 4000): Boolean = runCatching {
        Socket().use { s ->
            s.connect(InetSocketAddress(host, port), timeoutMs)
            s.isConnected
        }
    }.getOrDefault(false)

    /** Завершилось ли TLS-рукопожатие. Сертификат не проверяем: данных не шлём, важен сам ответ. */
    internal fun tlsReachable(host: String, port: Int, sni: String, timeoutMs: Int = 4000): Boolean = runCatching {
        val ctx = SSLContext.getInstance("TLS").apply { init(null, arrayOf(TRUST_ANY), null) }
        (ctx.socketFactory.createSocket() as SSLSocket).use { s ->
            s.connect(InetSocketAddress(host, port), timeoutMs)
            s.soTimeout = timeoutMs
            s.sslParameters = s.sslParameters.apply { serverNames = listOf(SNIHostName(sni)) }
            s.startHandshake()
            true
        }
    }.getOrDefault(false)

    private val TRUST_ANY = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    /** Открылся ли хоть один URL — ПО ОЧЕРЕДИ до первого успеха: в обычной сети это
        ровно один маленький запрос, а не три параллельных. */
    private fun firstReachable(urls: List<String>): Boolean = urls.any { url ->
        runCatching {
            val req = Request.Builder().url(url).head().header("User-Agent", "NoVPN-Diag").build()
            probe.newCall(req).execute().use { it.code in 200..499 }
        }.getOrDefault(false)
    }

    /**
     * Проверка для сторожа белых списков — как можно легче. Зарубежное открылось → сеть не
     * ограничена, возвращаем null (один HEAD к generate_204 раз в минуту, соединение ещё и
     * переиспользуется). Не открылось → полная диагностика, чтобы отличить белые списки
     * от «интернета нет вовсе».
     */
    suspend fun whitelistCheck(servers: List<Sub.Endpoint>): Result? = withContext(Dispatchers.IO) {
        if (firstReachable(EXTERNAL)) null else diagnose(servers)
    }

    /**
     * Открывается ли зарубежное напрямую — положительный признак того, что сеть НЕ под
     * белыми списками. По нему возвращаемся с резерва: «не RESTRICTED» им не является
     * (разовый сбой прямых проб даёт NO_INTERNET, а один TCP до сервера — OK).
     * Параллельно: под белыми списками каждый запрос висит до таймаута.
     */
    suspend fun externalUp(): Boolean = withContext(Dispatchers.IO) { anyReachable(EXTERNAL) }

    /**
     * Полная диагностика. `servers` — точки обычных серверов NoVPN (адрес, порт, SNI),
     * чтобы отличить «наши серверы недоступны» от «интернета нет вовсе».
     */
    suspend fun diagnose(servers: List<Sub.Endpoint>): Result = withContext(Dispatchers.IO) {
        val russia = anyReachable(RUSSIA)
        val external = anyReachable(EXTERNAL)
        val novpn = anyServerUp(servers)
        Result(classify(russia, external, novpn), russia, external, novpn)
    }

    /**
     * Классификация по совокупности признаков (вынесено для тестируемости):
     *  - ничего не доступно → интернета нет;
     *  - внешние доступны и серверы NoVPN доступны → сеть в порядке;
     *  - внешние доступны, но серверы NoVPN нет → наши серверы недоступны;
     *  - внешних нет, но российские есть → похоже на ограниченный режим;
     *  - напрямую не открывается ничего → интернета нет, даже если TCP до нашего сервера
     *    прошёл: его бывает «открывает» посредник провайдера, а по OK туннель
     *    перезапускался впустую.
     */
    fun classify(russiaUp: Boolean, externalUp: Boolean, novpnUp: Boolean): NetDiagnosis = when {
        !russiaUp && !externalUp -> NetDiagnosis.NO_INTERNET
        externalUp && novpnUp -> NetDiagnosis.OK
        externalUp && !novpnUp -> NetDiagnosis.SERVER_DOWN
        else -> NetDiagnosis.RESTRICTED
    }
}
