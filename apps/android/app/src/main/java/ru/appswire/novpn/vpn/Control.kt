package ru.appswire.novpn.vpn

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
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
 *
 * Клиент один на всё приложение. Раньше он создавался на каждое обращение, а
 * сторож обращается каждые несколько секунд: за сутки работы это тысячи пулов
 * соединений и потоков, каждый со своим сокетом к петле — верный способ упереться
 * в лимит дескрипторов у службы, которая обязана жить неделями.
 */
class Control(private val port: Int, private val secret: String) {

    private val json = Json { ignoreUnknownKeys = true }
    private val base = "http://127.0.0.1:$port"
    private val jsonType = "application/json".toMediaType()

    private fun request(path: String) = Request.Builder()
        .url("$base$path")
        .header("Authorization", "Bearer $secret")

    /**
     * Кодирование ИМЕНИ прокси/группы как СЕГМЕНТА пути. `URLEncoder` кодирует по
     * правилам форм: пробел → «+». В пути «+» остаётся плюсом, а не пробелом, поэтому
     * контроллер mihomo не находит прокси с пробелом в имени (например «🇩🇪 Германия
     * 🐝»): `/proxies/<name>/delay` отвечает 404, и проверка сервера мгновенно
     * «проваливается» — из-за этого не срабатывал ни один резервный сервер. В пути
     * пробел обязан быть %20. Литеральный «+» URLEncoder даёт как %2B, его replace не
     * трогает — поэтому «RU+Moscow» не пострадает.
     */
    private fun seg(name: String): String =
        java.net.URLEncoder.encode(name, "UTF-8").replace("+", "%20")

    /** Отвечает ли на порту именно наш движок: у mihomo в /version есть поле meta. */
    fun isOurEngine(): Boolean = runCatching {
        client.newCall(request("/version").build()).execute().use { r ->
            if (!r.isSuccessful) return false
            r.body?.string().orEmpty().contains("\"meta\"")
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
        val path = "/proxies/" + seg(group)
        client.newCall(request(path).put(body).build()).execute().use { it.isSuccessful }
    }.getOrDefault(false)

    /**
     * Сбрасывает ВСЕ живые соединения движка. Нужно при смене сети: старые
     * соединения (в т.ч. к VPN-серверу) остаются висеть на исчезнувшей сети, и без
     * сброса движок ждёт их таймаута — трафик «висит», пока не оживёт сам или пока
     * не перезапустить VPN. Вызывать РАЗ по факту смены сети, а НЕ в цикле: в цикле
     * это рвало бы рабочий прямой трафик. При смене сети рвать нечего — соединения и
     * так мертвы.
     */
    fun closeConnections(): Boolean = runCatching {
        client.newCall(request("/connections").delete().build()).execute().use { it.isSuccessful }
    }.getOrDefault(false)

    /** Задержка до точки, мс; null — не ответила. */
    fun delay(name: String, url: String = "http://cp.cloudflare.com/generate_204", timeoutMs: Int = 3000): Int? =
        runCatching {
            val path = "/proxies/" + seg(name) +
                "/delay?timeout=$timeoutMs&url=" + java.net.URLEncoder.encode(url, "UTF-8")
            client.newCall(request(path).build()).execute().use { r ->
                if (!r.isSuccessful) return null
                val obj = json.parseToJsonElement(r.body?.string().orEmpty()) as? JsonObject
                (obj?.get("delay") as? JsonPrimitive)?.longOrNull?.toInt()
            }
        }.getOrNull()

    data class Totals(val down: Long, val up: Long, val connections: Int)

    /**
     * Сколько всего прошло через движок с момента запуска.
     *
     * Ответ `/connections` содержит ВЕСЬ список живых соединений со всеми полями — на
     * активном телефоне это сотни килобайт JSON. Ради двух чисел столько не читают,
     * поэтому разбираем поток и берём только итоги, не строя дерево целиком.
     */
    fun totals(): Totals? = runCatching {
        client.newCall(request("/connections").build()).execute().use { r ->
            if (!r.isSuccessful) return null
            val text = r.body?.string().orEmpty()
            val down = numberAfter(text, "\"downloadTotal\"")
            val up = numberAfter(text, "\"uploadTotal\"")
            if (down == null && up == null) return null
            Totals(down ?: 0, up ?: 0, countConnections(text))
        }
    }.getOrNull()

    /** Число сразу после ключа — без разбора всего документа. */
    private fun numberAfter(text: String, key: String): Long? {
        val at = text.indexOf(key)
        if (at < 0) return null
        var i = at + key.length
        while (i < text.length && (text[i] == ':' || text[i] == ' ')) i++
        val start = i
        while (i < text.length && text[i].isDigit()) i++
        return if (i > start) text.substring(start, i).toLongOrNull() else null
    }

    private fun countConnections(text: String): Int {
        val at = text.indexOf("\"connections\"")
        if (at < 0) return 0
        val arr = runCatching {
            (json.parseToJsonElement(text) as? JsonObject)?.get("connections") as? JsonArray
        }.getOrNull()
        return arr?.size ?: 0
    }

    companion object {
        /** Один клиент на приложение: обращения к петле частые и короткие. */
        private val client: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(3, TimeUnit.SECONDS)
                .readTimeout(10, TimeUnit.SECONDS)
                .build()
        }
    }
}
