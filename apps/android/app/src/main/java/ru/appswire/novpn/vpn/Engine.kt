package ru.appswire.novpn.vpn

import android.content.Context
import android.util.Log
import ru.appswire.novpn.core.Config
import ru.appswire.novpn.store.Store
import java.io.File
import java.io.RandomAccessFile
import java.security.SecureRandom

/**
 * Процесс движка mihomo.
 *
 * Движок лежит в nativeLibraryDir под именем libmihomo.so — Android разрешает
 * запускать исполняемые файлы только оттуда (в каталоге данных приложения
 * execve запрещён политикой W^X). Файл там появляется благодаря
 * `useLegacyPackaging = true` в build.gradle.kts; без этого флага библиотеки
 * остаются внутри apk и запускать будет нечего.
 *
 * Сборка движка — GOOS=linux, не android (scripts/fetch-engine.py). Android-
 * вариант при старте TUN читает /data/system/packages.xml, а это root-only:
 * слушатель туннеля не поднимался, движок при этом жил и отвечал по
 * управляющему каналу, и телефон показывал «Подключено» без единого пакета.
 */
class Engine(private val context: Context, private val store: Store) {

    @Volatile
    var pid: Int = 0
        private set

    /** Код выхода движка, если он успел умереть, — для внятного сообщения. */
    @Volatile
    private var lastExit: Int? = null

    /** Токен управляющего канала: новый на каждый запуск, только в памяти. */
    @Volatile
    var secret: String = ""
        private set

    @Volatile
    private var controlCache: Control? = null

    /** Канал управления. Клиент внутри общий, пересоздаём только при смене токена. */
    val control: Control
        get() = controlCache ?: Control(Config.CONTROLLER_PORT, secret).also { controlCache = it }

    fun binary(): File = File(context.applicationInfo.nativeLibraryDir, "libmihomo.so")

    fun isInstalled(): Boolean = binary().exists()

    fun isAlive(): Boolean {
        val p = pid
        if (p <= 0) return false
        // -1 означает «ещё работает»; всё остальное — процесс завершился.
        val code = Native.waitPid(p, false)
        if (code == -1) return true
        if (code >= 0) lastExit = code
        pid = 0
        return false
    }

    /**
     * Запускает движок с готовым конфигом и дескриптором туннеля.
     * @return null при успехе, иначе текст ошибки для человека.
     */
    fun start(configYaml: String, tunFd: Int): String? {
        if (!Native.ensureLoaded()) return "Не удалось загрузить служебную библиотеку приложения."
        val exe = binary()
        if (!exe.exists()) {
            return "Движок не найден в сборке. Соберите приложение после scripts/fetch-engine.py."
        }
        stop()
        killLeftover()
        lastExit = null

        val dir = store.engineDir()
        store.writeConfig(configYaml)?.let { return "Не удалось записать конфиг: $it" }

        val env = arrayOf(
            "HOME=${dir.absolutePath}",
            "TMPDIR=${context.cacheDir.absolutePath}",
            // Движок не должен ходить в чужие каталоги за геобазами.
            "PATH=/system/bin",
        )
        val args = arrayOf("-d", dir.absolutePath, "-f", store.configFile().absolutePath)
        val result = Native.spawn(
            exe.absolutePath, args, env, dir.absolutePath, store.logFile().absolutePath, tunFd,
        )
        if (result <= 0) {
            return "Движок не запустился (код $result). Подробности — в журнале."
        }
        pid = result
        runCatching { pidFile().writeText(result.toString()) }
        Log.i(TAG, "движок запущен, pid=$pid")
        mirrorLog()
        return null
    }

    /**
     * Пишет журнал движка в системный лог.
     *
     * Без этого разобрать «подключено, но трафика нет» нельзя вообще: боевая
     * сборка не отлаживаемая, файлы приложения снаружи не прочитать, а движок
     * пишет только в свой файл. Строки уровня info секретов не содержат —
     * там домены и адреса серверов, то же самое видно в экране журнала.
     */
    private fun mirrorLog() {
        val file = store.logFile()
        val startedFor = pid
        Thread {
            var shown = 0L
            while (pid == startedFor && pid > 0) {
                runCatching {
                    val size = file.length()
                    if (size < shown) shown = 0            // журнал обрезали при рестарте
                    if (size > shown) {
                        java.io.RandomAccessFile(file, "r").use { raf ->
                            raf.seek(shown)
                            val buf = ByteArray((size - shown).toInt())
                            raf.readFully(buf)
                            shown = size
                            String(buf, Charsets.UTF_8).lineSequence()
                                .filter { it.isNotBlank() }
                                .forEach { Log.i(LOG_TAG, it) }
                        }
                    }
                }
                Thread.sleep(700)
            }
        }.apply { isDaemon = true; name = "novpn-engine-log" }.start()
    }

    private fun pidFile(): File = File(store.engineDir(), "engine.pid")

    /**
     * Добивает движок, оставшийся от прошлой жизни приложения.
     *
     * Такое бывает: систему прижало по памяти, она убила наш процесс, а дочерний
     * движок остался — он держит дескриптор туннеля и продолжает гнать трафик,
     * но управлять им уже некому. Если просто поднять второй, туннель окажется
     * поделён между двумя процессами, и «интернета нет» до перезагрузки.
     *
     * Ищем двумя способами: по pid-файлу (быстро) и обходом /proc (надёжно —
     * файл могли не успеть записать). Чужие процессы нам не видны: начиная с
     * Android 9 в /proc видны только процессы своего UID, так что случайно
     * выстрелить в постороннее приложение нельзя. Дополнительно сверяем cmdline.
     */
    fun killLeftover() {
        val victims = linkedSetOf<Int>()
        runCatching { pidFile().readText().trim().toInt() }.getOrNull()?.let { victims += it }
        runCatching {
            File("/proc").listFiles()?.forEach { entry ->
                val p = entry.name.toIntOrNull() ?: return@forEach
                if (p == android.os.Process.myPid()) return@forEach
                val cmd = runCatching { File(entry, "cmdline").readText() }.getOrNull() ?: return@forEach
                if (cmd.contains("libmihomo.so")) victims += p
            }
        }
        for (p in victims) {
            if (p <= 0 || p == pid) continue
            val cmd = runCatching { File("/proc/$p/cmdline").readText() }.getOrNull() ?: continue
            if (!cmd.contains("libmihomo.so")) continue
            Log.w(TAG, "остался движок от прошлого запуска, pid=$p — убираем")
            Native.killPid(p, Native.SIGKILL)
            // Ждём, пока освободится управляющий порт: иначе новый экземпляр
            // упрётся в «address already in use», и человеку покажут ложное
            // «порт занят другим приложением».
            val deadline = System.currentTimeMillis() + 1500
            while (System.currentTimeMillis() < deadline && File("/proc/$p").exists()) {
                Thread.sleep(50)
            }
        }
        runCatching { pidFile().delete() }
    }

    /** Новый токен управляющего канала. Вызывается перед сборкой конфига. */
    fun newSecret(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        secret = bytes.joinToString("") { "%02x".format(it) }
        controlCache = null
        return secret
    }

    /**
     * Ждём, пока движок начнёт отвечать НА СВОЁМ управляющем канале.
     *
     * Проверяем не «порт слушает», а что отвечает именно наш экземпляр: токен
     * знает только он. Иначе чужой clash на том же порту приняли бы за свой и
     * объявили «Подключено», уведя трафик через постороннее приложение.
     */
    fun waitReady(timeoutMs: Long = 15_000): Started {
        val deadline = System.currentTimeMillis() + timeoutMs
        val ctl = control
        var checks = 0
        while (System.currentTimeMillis() < deadline) {
            if (!isAlive()) return Started.Died(diedReason())
            if (ctl.isOurEngine()) return Started.Ok
            // Журнал читаем не на каждой итерации: это файл на диске.
            if (++checks % 7 == 0) portBusyHint()?.let { return Started.PortBusy(it) }
            Thread.sleep(150)
        }
        return Started.Timeout(store.logTail(5))
    }

    /** Почему движок умер: код выхода от хелпера плюс последняя строка журнала. */
    private fun diedReason(): String {
        val code = lastExit
        val human = when (code) {
            125 -> "не удалось передать туннель движку"
            126 -> "не удалось перейти в рабочий каталог"
            127 -> "файл движка не запустился"
            else -> null
        }
        val tail = store.logTail(5).lines().lastOrNull { it.isNotBlank() }.orEmpty()
        return listOfNotNull(human, code?.let { "код $it" }, tail.takeIf { it.isNotEmpty() })
            .joinToString(", ")
            .ifEmpty { "причина неизвестна" }
    }

    private fun portBusyHint(): String? {
        val tail = store.logTail(40).lowercase()
        return if (tail.contains("address already in use") || tail.contains("bind:")) {
            "Порт управления занят другим приложением."
        } else null
    }

    sealed class Started {
        object Ok : Started()
        data class PortBusy(val message: String) : Started()
        data class Died(val message: String) : Started()
        data class Timeout(val message: String) : Started()
    }

    /**
     * Останавливает движок.
     * @param wait ждать корректного завершения. false — только сигнал, без
     *   блокировки: так вызывают из onDestroy, где держать главный поток нельзя.
     */
    fun stop(wait: Boolean = true) {
        val p = pid
        if (p <= 0) return
        Native.killPid(p, Native.SIGTERM)
        if (!wait) {
            Native.killPid(p, Native.SIGKILL)
            pid = 0
            runCatching { pidFile().delete() }
            return
        }
        // Даём закрыть соединения, потом добиваем: висящий движок с живым
        // туннелем — это «интернета нет» до перезагрузки телефона.
        val deadline = System.currentTimeMillis() + 3000
        while (System.currentTimeMillis() < deadline) {
            if (Native.waitPid(p, false) != -1) break
            Thread.sleep(100)
        }
        if (Native.waitPid(p, false) == -1) {
            Native.killPid(p, Native.SIGKILL)
            Native.waitPid(p, true)
        }
        pid = 0
        runCatching { pidFile().delete() }
    }

    companion object {
        private const val TAG = "novpn.engine"

        /** Отдельная метка, чтобы отфильтровать журнал движка: adb logcat -s novpn.mihomo */
        private const val LOG_TAG = "novpn.mihomo"

        /** Хвост текстового файла без чтения его целиком. */
        fun tailOf(file: File, maxBytes: Long): String = runCatching {
            if (!file.exists()) return ""
            RandomAccessFile(file, "r").use { raf ->
                val from = (raf.length() - maxBytes).coerceAtLeast(0)
                raf.seek(from)
                val buf = ByteArray((raf.length() - from).toInt())
                raf.readFully(buf)
                String(buf, Charsets.UTF_8)
            }
        }.getOrDefault("")
    }
}
