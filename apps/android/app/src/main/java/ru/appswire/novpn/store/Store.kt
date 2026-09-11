package ru.appswire.novpn.store

import android.content.Context
import kotlinx.serialization.json.Json
import ru.appswire.novpn.core.Meta
import ru.appswire.novpn.core.RoutingLists
import java.io.File

/**
 * Хранение на диске. Слоёв три, и они лежат раздельно намеренно:
 *
 *  - `state.json` — настройки и правила человека. Их не трогает ничто, кроме него.
 *  - `lists.json` — списки с панели, заменяются целиком при обновлении.
 *  - `meta.json`  — последняя удачная копия ответа панели (last-known-good).
 *
 * Смешать их значит рано или поздно затереть чужой труд при синхронизации.
 *
 * Запись атомарная: сначала во временный файл с fsync, потом переименование.
 * Телефон выключают в любой момент, и обрыв посреди записи не должен оставлять
 * усечённый JSON — иначе приложение не поднимется вовсе.
 */
class Store(context: Context) {

    private val dir: File = context.filesDir
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        prettyPrint = true
    }

    private fun file(name: String) = File(dir, name)

    private fun writeAtomic(name: String, text: String) {
        val target = file(name)
        val tmp = File(dir, "$name.tmp")
        tmp.outputStream().use { out ->
            out.write(text.toByteArray(Charsets.UTF_8))
            out.flush()
            out.fd.sync()
        }
        if (!tmp.renameTo(target)) {
            // На некоторых прошивках rename поверх существующего файла капризничает.
            target.delete()
            tmp.renameTo(target)
        }
    }

    private fun readText(name: String): String? = runCatching {
        val f = file(name)
        if (f.exists()) f.readText(Charsets.UTF_8) else null
    }.getOrNull()

    // ── состояние приложения ──

    fun loadState(): State = runCatching {
        readText(STATE)?.let { json.decodeFromString<State>(it) }
    }.getOrNull() ?: State()

    fun saveState(state: State) {
        runCatching { writeAtomic(STATE, json.encodeToString(State.serializer(), state)) }
    }

    // ── списки маршрутизации ──

    fun loadLists(): RoutingLists? = runCatching {
        readText(LISTS)?.let { json.decodeFromString<RoutingLists>(it) }
    }.getOrNull()

    fun saveLists(lists: RoutingLists) {
        runCatching { writeAtomic(LISTS, json.encodeToString(RoutingLists.serializer(), lists)) }
    }

    // ── ответ панели ──

    fun loadMeta(): Meta? = runCatching { readText(META)?.let { Meta.parse(it) } }.getOrNull()

    fun saveMetaRaw(text: String) {
        runCatching { writeAtomic(META, text) }
    }

    // ── сырой текст подписки: чтобы поднять конфиг без сети ──

    fun loadSubRaw(): String? = readText(SUB)

    fun saveSubRaw(text: String) {
        runCatching { writeAtomic(SUB, text) }
    }

    /** Рабочий каталог движка: конфиг и журнал. */
    fun engineDir(): File = File(dir, "engine").apply { mkdirs() }

    fun configFile(): File = File(engineDir(), "config.yaml")

    fun logFile(): File = File(engineDir(), "engine.log")

    /** Хвост журнала движка — для экрана диагностики. */
    fun logTail(lines: Int = 200): String = runCatching {
        val f = logFile()
        if (!f.exists()) return@runCatching "Журнал пока пуст."
        f.readLines().takeLast(lines).joinToString("\n")
    }.getOrDefault("Журнал прочитать не удалось.")

    companion object {
        private const val STATE = "state.json"
        private const val LISTS = "lists.json"
        private const val META = "meta.json"
        private const val SUB = "subscription.txt"
    }
}
