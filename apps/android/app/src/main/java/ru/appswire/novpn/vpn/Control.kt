package ru.appswire.novpn.vpn

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import ru.appswire.novpn.core.Config
import java.util.concurrent.TimeUnit

/**
 * Управляющий канал движка (external-controller).
 *
 * Канал слушает 127.0.0.1, а на Android к localhost может подключиться ЛЮБОЕ
 * приложение на устройстве. Поэтому доступ закрыт токеном: он генерируется на
 * каждый запуск движка и живёт только в памяти.
 */
class Control(private val port: Int, private val secret: String) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }
    private val base = "http://127.0.0.1:$port"
    private val jsonType = "application/json".toMediaType()

    private fun request(path: String) = Request.Builder()
        .url("$base$path")
        .header("Authorization", "Bearer $secret")

    /** Отвечает ли на порту именно наш движок: у mihomo в /version есть поле meta. */
    fun isOurEngine(): Boolean = runCatching {
        client.newCall(request("/version").build()).execute().use { r ->
            if (!r.isSuccessful) return false
            val body = r.body?.string().orEmpty()
            body.contains("\"meta\"")
        }
    }.getOrDefault(false)

    /** Применяет новый конфиг без разрыва соединений. */
    fun reload(configPath: String): Boolean = runCatching {
        val body = json.encodeToString(
            JsonObject.serializer(),
            JsonObject(mapOf("path" to JsonPrimitive(configPath))),
        ).toRequestBody(jsonType)
        client.newCall(request("/configs?force=true").put(body).build()).execute().use { it.isSuccessful }
    }.getOrDefault(false)

    /**
     * Выбирает точку в своей группе. Нужно ПОСЛЕ каждого reload: группа типа
     * `select` помнит прошлый выбор, и без явного указания движок останется на
     * старом сервере, хотя в интерфейсе выбран новый.
     */
    fun selectProxy(name: String, group: String = Config.GROUP): Boolean = runCatching {
        val body = json.encodeToString(
            JsonObject.serializer(),
            JsonObject(mapOf("name" to JsonPrimitive(name))),
        ).toRequestBody(jsonType)
        val path = "/proxies/" + java.net.URLEncoder.encode(group, "UTF-8")
        client.newCall(request(path).put(body).build()).execute().use { it.isSuccessful }
    }.getOrDefault(false)

    /** Задержка до точки, мс; null — не ответила. */
    fun delay(name: String, url: String = "http://cp.cloudflare.com/generate_204", timeoutMs: Int = 3000): Int? =
        runCatching {
            val path = "/proxies/" + java.net.URLEncoder.encode(name, "UTF-8") +
                "/delay?timeout=$timeoutMs&url=" + java.net.URLEncoder.encode(url, "UTF-8")
            client.newCall(request(path).build()).execute().use { r ->
                if (!r.isSuccessful) return null
                val obj = json.parseToJsonElement(r.body?.string().orEmpty()) as? JsonObject
                (obj?.get("delay") as? JsonPrimitive)?.longOrNull?.toInt()
            }
        }.getOrNull()

    data class Totals(val down: Long, val up: Long, val connections: Int)

    /** Сколько всего прошло через движок с момента запуска. */
    fun totals(): Totals? = runCatching {
        client.newCall(request("/connections").build()).execute().use { r ->
            if (!r.isSuccessful) return null
            val obj = json.parseToJsonElement(r.body?.string().orEmpty()) as? JsonObject ?: return null
            val down = (obj["downloadTotal"] as? JsonPrimitive)?.longOrNull ?: 0
            val up = (obj["uploadTotal"] as? JsonPrimitive)?.longOrNull ?: 0
            val conns = (obj["connections"] as? kotlinx.serialization.json.JsonArray)?.size ?: 0
            Totals(down, up, conns)
        }
    }.getOrNull()
}
