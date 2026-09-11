package ru.appswire.novpn.net

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import ru.appswire.novpn.core.Sub
import java.util.concurrent.TimeUnit

/**
 * Один HTTP-клиент на приложение.
 *
 * Важно: запросы к панели и спискам идут МИМО туннеля — приложение исключено из
 * VPN целиком (см. VpnRunner: addDisallowedApplication на свой же пакет).
 * Иначе обновление подписки зависело бы от работоспособности самого VPN.
 */
object Http {

    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .callTimeout(40, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    data class Response(val code: Int, val body: String, val etag: String?)

    /** GET с User-Agent подписки и необязательным условным запросом по ETag. */
    fun get(url: String, etag: String? = null): Response {
        val req = Request.Builder()
            .url(url)
            .header("User-Agent", Sub.USER_AGENT)
            .apply { if (!etag.isNullOrBlank()) header("If-None-Match", etag) }
            .build()
        client.newCall(req).execute().use { r ->
            // 304 отдаёт пустое тело — это не ошибка, это «не менялось».
            val text = if (r.code == 304) "" else (r.body?.string() ?: "")
            return Response(r.code, text, r.header("ETag"))
        }
    }

    /** Запрос с телом (личная резервная подписка, отчёт о резервном расходе).
     *  Возвращает код ответа или null при сетевой ошибке. Тело ответа не читаем. */
    fun send(method: String, url: String, jsonBody: String?): Int? = runCatching {
        val body = jsonBody?.toRequestBody("application/json".toMediaType())
        val req = Request.Builder()
            .url(url)
            .header("User-Agent", Sub.USER_AGENT)
            .method(method, body)
            .build()
        client.newCall(req).execute().use { it.code }
    }.getOrNull()

    /** Скачать файл целиком (обновление приложения). Возвращает null при неуспехе. */
    fun getBytes(url: String): ByteArray? {
        val req = Request.Builder().url(url).header("User-Agent", Sub.USER_AGENT).build()
        return runCatching {
            client.newCall(req).execute().use { r ->
                if (!r.isSuccessful) null else r.body?.bytes()
            }
        }.getOrNull()
    }
}
