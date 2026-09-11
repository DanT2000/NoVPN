package ru.appswire.novpn.system

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.drawable.Drawable

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

    fun list(context: Context, refresh: Boolean = false): List<Entry> {
        cache?.let { if (!refresh) return it }
        val pm = context.packageManager
        val out = runCatching {
            pm.getInstalledPackages(PackageManager.GET_PERMISSIONS)
                .asSequence()
                .filter { pkg ->
                    pkg.requestedPermissions?.contains(android.Manifest.permission.INTERNET) == true
                }
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
        }.getOrDefault(emptyList())
        cache = out
        return out
    }

    fun icon(context: Context, pkg: String): Drawable? = runCatching {
        context.packageManager.getApplicationIcon(pkg)
    }.getOrNull()
}
