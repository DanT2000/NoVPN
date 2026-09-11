package ru.appswire.novpn.vpn

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.TimeUnit

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

    /** TCP-достижимость хотя бы одного сервера NoVPN (по адресу и порту). */
    private suspend fun anyServerUp(servers: List<Pair<String, Int>>): Boolean = coroutineScope {
        if (servers.isEmpty()) return@coroutineScope false
        servers.take(4).map { (host, port) ->
            async(Dispatchers.IO) {
                runCatching {
                    Socket().use { s ->
                        s.connect(InetSocketAddress(host, port), 4000)
                        s.isConnected
                    }
                }.getOrDefault(false)
            }
        }.any { it.await() }
    }

    /**
     * Полная диагностика. `servers` — адреса обычных серверов NoVPN (host, port),
     * чтобы отличить «наши серверы недоступны» от «интернета нет вовсе».
     */
    suspend fun diagnose(servers: List<Pair<String, Int>>): Result = withContext(Dispatchers.IO) {
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
     *  - крайние случаи трактуем осторожно.
     */
    fun classify(russiaUp: Boolean, externalUp: Boolean, novpnUp: Boolean): NetDiagnosis = when {
        !russiaUp && !externalUp && !novpnUp -> NetDiagnosis.NO_INTERNET
        externalUp && novpnUp -> NetDiagnosis.OK
        externalUp && !novpnUp -> NetDiagnosis.SERVER_DOWN
        !externalUp && russiaUp -> NetDiagnosis.RESTRICTED
        novpnUp -> NetDiagnosis.OK
        else -> NetDiagnosis.RESTRICTED
    }
}
