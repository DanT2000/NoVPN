package ru.appswire.novpn.system

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.drawable.Drawable
import android.util.LruCache
import androidx.core.graphics.drawable.toBitmap

/**
 * Установленные приложения, у которых вообще есть доступ в интернет.
 *
 * Разрешение QUERY_ALL_PACKAGES здесь не нужно и не запрашивается: оно считается
 * чувствительным, и Google требует для него отдельное обоснование. Список
 * приложений с разрешением INTERNET система отдаёт и без него —
 * `getInstalledPackages(GET_PERMISSIONS)` возвращает то, что видно приложению.
 */
object InstalledApps {

    data class Entry(
        val pkg: String,
        val label: String,
        val system: Boolean,
    )

    @Volatile
    private var cache: List<Entry>? = null

    /** Уже перечисленный список, если он есть — чтобы экран открывался без паузы. */
    fun cached(): List<Entry>? = cache

    fun list(context: Context, refresh: Boolean = false): List<Entry> {
        cache?.let { if (!refresh) return it }
        val pm = context.packageManager
        // На устройствах с большим числа пакетов (типично для Samsung с их огромным
        // предустановом) один bulk-вызов getInstalledPackages(GET_PERMISSIONS) может
        // кинуть TransactionTooLargeException — тогда список молча становился пустым, и
        // «раздельный туннель» переставал видеть приложения. Если bulk не дал результата,
        // перечисляем по одному пакету (много маленьких транзакций вместо одной гигантской).
        val out = runCatching { bulkList(pm, context) }.getOrNull()?.takeIf { it.isNotEmpty() }
            ?: perPackageList(pm, context)
        cache = out
        return out
    }

    private fun bulkList(pm: PackageManager, context: Context): List<Entry> =
        pm.getInstalledPackages(PackageManager.GET_PERMISSIONS)
            .asSequence()
            .filter { pkg -> pkg.requestedPermissions?.contains(android.Manifest.permission.INTERNET) == true }
            .filter { it.packageName != context.packageName }
            .map { pkg ->
                val info = pkg.applicationInfo
                Entry(
                    pkg = pkg.packageName,
                    label = info?.let { pm.getApplicationLabel(it).toString() } ?: pkg.packageName,
                    system = info != null && (info.flags and ApplicationInfo.FLAG_SYSTEM) != 0,
                )
            }
            .sortedWith(compareBy({ it.system }, { it.label.lowercase() }))
            .toList()

    private fun perPackageList(pm: PackageManager, context: Context): List<Entry> = runCatching {
        pm.getInstalledApplications(0)
            .asSequence()
            .filter { it.packageName != context.packageName }
            .filter { info ->
                runCatching {
                    pm.getPackageInfo(info.packageName, PackageManager.GET_PERMISSIONS)
                        .requestedPermissions?.contains(android.Manifest.permission.INTERNET) == true
                }.getOrDefault(false)
            }
            .map { info ->
                Entry(
                    pkg = info.packageName,
                    label = pm.getApplicationLabel(info).toString(),
                    system = (info.flags and ApplicationInfo.FLAG_SYSTEM) != 0,
                )
            }
            .sortedWith(compareBy({ it.system }, { it.label.lowercase() }))
            .toList()
    }.getOrDefault(emptyList())

    fun icon(context: Context, pkg: String): Drawable? = runCatching {
        context.packageManager.getApplicationIcon(pkg)
    }.getOrNull()
}

/**
 * Иконки приложений для списка. `getApplicationIcon` читает apk с диска и
 * растеризует адаптивную иконку — на сотне строк это заметная пауза, поэтому
 * грузим в фоне и держим готовые битмапы в памяти. Кэш ограничен по байтам:
 * 48dp-иконка это ~40 КБ, четырёх мегабайт хватает на сотню приложений.
 */
object AppIcons {

    private val cache = object : LruCache<String, Bitmap>(4 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    /** Готовая иконка без обращения к системе; null — ещё не грузили. */
    fun cached(pkg: String): Bitmap? = cache.get(pkg)

    /** Загрузить (или взять из кэша). Вызывать не на главном потоке. */
    fun load(context: Context, pkg: String, sizePx: Int): Bitmap? {
        cache.get(pkg)?.let { return it }
        val drawable = InstalledApps.icon(context, pkg) ?: return null
        val bitmap = runCatching { drawable.toBitmap(sizePx, sizePx) }.getOrNull() ?: return null
        cache.put(pkg, bitmap)
        return bitmap
    }
}
