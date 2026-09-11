package ru.appswire.novpn.vpn

/**
 * Мостик к нативному хелперу (app/src/main/cpp/spawn.c).
 *
 * Нужен ровно для одного: запустить движок отдельным процессом и отдать ему
 * файловый дескриптор туннеля. Java этого не умеет — ProcessBuilder передаёт
 * ребёнку только stdin/stdout/stderr.
 */
object Native {

    @Volatile
    private var loaded = false

    /** Библиотека грузится лениво: без VPN она не нужна, а ошибку загрузки
     *  надо показать человеку, а не уронить приложение при старте. */
    fun ensureLoaded(): Boolean {
        if (loaded) return true
        return runCatching {
            System.loadLibrary("novpnspawn")
            loaded = true
            true
        }.getOrDefault(false)
    }

    /**
     * Запускает exe. Возвращает pid (>0) или отрицательный код ошибки.
     * @param tunFd дескриптор туннеля; в ребёнке он окажется на Config.TUN_FD. -1 — без туннеля.
     */
    external fun spawn(
        exe: String,
        args: Array<String>,
        env: Array<String>,
        workDir: String,
        logPath: String,
        tunFd: Int,
    ): Int

    /** ≥0 — код выхода; -1 — ещё работает; -2 — процесса нет. */
    external fun waitPid(pid: Int, block: Boolean): Int

    external fun killPid(pid: Int, sig: Int): Int

    const val SIGTERM = 15
    const val SIGKILL = 9
}
