package ru.appswire.novpn.vpn

import android.content.Context
import android.util.Log
import ru.appswire.novpn.core.Config
import ru.appswire.novpn.store.Store
import java.io.File
import java.security.SecureRandom

/**
 * Процесс движка mihomo.
 *
 * Движок лежит в nativeLibraryDir под именем libmihomo.so — Android разрешает
 * запускать исполняемые файлы только оттуда (в каталоге данных приложения
 * execve запрещён политикой W^X). Файл там появляется благодаря
 * `useLegacyPackaging = true` в build.gradle.kts; без этого флага библиотеки
 * остаются внутри apk и запускать будет нечего.
 */
class Engine(private val context: Context, private val store: Store) {

    @Volatile
    var pid: Int = 0
        private set

    /** Токен управляющего канала: новый на каждый запуск, только в памяти. */
    @Volatile
    var secret: String = ""
        private set

    val control: Control
        get() = Control(Config.CONTROLLER_PORT, secret)

    fun binary(): File = File(context.applicationInfo.nativeLibraryDir, "libmihomo.so")

    fun isInstalled(): Boolean = binary().let { it.exists() && it.canExecute() }

    fun isAlive(): Boolean {
        val p = pid
        if (p <= 0) return false
        // -1 означает «ещё работает»; всё остальное — процесс завершился.
        return Native.waitPid(p, false) == -1
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

        val dir = store.engineDir()
        val config = store.configFile()
        runCatching { config.writeText(configYaml) }
            .onFailure { return "Не удалось записать конфиг: ${it.message}" }

        val env = arrayOf(
            "HOME=${dir.absolutePath}",
            "TMPDIR=${context.cacheDir.absolutePath}",
            // Движок не должен ходить в чужие каталоги за геобазами.
            "PATH=/system/bin",
        )
        val args = arrayOf("-d", dir.absolutePath, "-f", config.absolutePath)
        val result = Native.spawn(
            exe.absolutePath, args, env, dir.absolutePath, store.logFile().absolutePath, tunFd,
        )
        if (result <= 0) {
            return "Движок не запустился (код $result). Подробности — в журнале."
        }
        pid = result
        pidFile().writeText(result.toString())
        Log.i(TAG, "движок запущен, pid=$pid")
        return null
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
     * Проверяем, что убиваем именно свой движок: pid мог достаться чужому
     * процессу, и стрелять вслепую нельзя.
     */
    private fun killLeftover() {
        val f = pidFile()
        val old = runCatching { f.readText().trim().toInt() }.getOrNull() ?: return
        f.delete()
        if (old <= 0 || old == pid) return
        val cmdline = runCatching { File("/proc/$old/cmdline").readText() }.getOrNull() ?: return
        if (!cmdline.contains("libmihomo.so")) return
        Log.w(TAG, "остался движок от прошлого запуска, pid=$old — убираем")
        Native.killPid(old, Native.SIGKILL)
    }

    /** Новый токен управляющего канала. Вызывается перед сборкой конфига. */
    fun newSecret(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        secret = bytes.joinToString("") { "%02x".format(it) }
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
        while (System.currentTimeMillis() < deadline) {
            if (!isAlive()) return Started.Died(logHint())
            if (ctl.isOurEngine()) return Started.Ok
            val hint = portBusyHint()
            if (hint != null) return Started.PortBusy(hint)
            Thread.sleep(150)
        }
        return Started.Timeout(logHint())
    }

    private fun logHint(): String {
        val tail = store.logTail(30)
        return tail.lines().lastOrNull { it.isNotBlank() }.orEmpty()
    }

    private fun portBusyHint(): String? {
        val text = runCatching { store.logFile().readText() }.getOrNull()?.lowercase() ?: return null
        return if (text.contains("address already in use") || text.contains("bind:")) {
            "Порт управления занят другим приложением."
        } else null
    }

    sealed class Started {
        object Ok : Started()
        data class PortBusy(val message: String) : Started()
        data class Died(val message: String) : Started()
        data class Timeout(val message: String) : Started()
    }

    fun stop() {
        val p = pid
        if (p <= 0) return
        Native.killPid(p, Native.SIGTERM)
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
    }
}
