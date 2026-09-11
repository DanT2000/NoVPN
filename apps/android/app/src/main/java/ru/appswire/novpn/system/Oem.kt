package ru.appswire.novpn.system

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * Разрешения и ограничения, из-за которых VPN «сам выключается».
 *
 * Голый Android держит foreground-службу нормально. Проблемы начинаются на
 * оболочках производителей: MIUI/HyperOS, EMUI, ColorOS, FuntouchOS и им
 * подобные по своему усмотрению убивают процессы «ради батареи», и никакой
 * START_STICKY от этого не спасает — систему надо попросить руками, и сделать
 * это может только человек.
 *
 * Поэтому приложение не молчит, а показывает список того, что стоит разрешить,
 * с кнопками, ведущими прямо в нужный экран настроек.
 */
object Oem {

    /** Один пункт списка «Работа в фоне». */
    data class Hint(
        val id: String,
        val title: String,
        val text: String,
        /** Уже сделано (если можно проверить программно). null — проверить нельзя. */
        val done: Boolean?,
        val action: Intent?,
    )

    private val manufacturer: String get() = Build.MANUFACTURER.lowercase()

    val isXiaomi: Boolean get() = manufacturer.contains("xiaomi") || manufacturer.contains("redmi") || manufacturer.contains("poco")
    private val isHuawei: Boolean get() = manufacturer.contains("huawei") || manufacturer.contains("honor")
    private val isOppo: Boolean get() = manufacturer.contains("oppo") || manufacturer.contains("realme")
    private val isVivo: Boolean get() = manufacturer.contains("vivo")
    private val isSamsung: Boolean get() = manufacturer.contains("samsung")

    /** Оболочка известна своим «убийцей задач». */
    val needsAutostart: Boolean get() = isXiaomi || isHuawei || isOppo || isVivo

    fun ignoresBatteryOptimizations(context: Context): Boolean = runCatching {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        pm.isIgnoringBatteryOptimizations(context.packageName)
    }.getOrDefault(false)

    /**
     * Запрос на снятие ограничений батареи. Показывает системный диалог.
     * Google запрещает такой запрос приложениям без веской причины — для VPN
     * причина как раз есть: без него служба засыпает и связь рвётся.
     */
    fun batteryIntent(context: Context): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:${context.packageName}"))

    /** Экран «Автозапуск» конкретной оболочки. null — у производителя такого нет. */
    fun autostartIntent(context: Context): Intent? {
        val candidates: List<ComponentName> = when {
            isXiaomi -> listOf(
                ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
                ComponentName("com.miui.securitycenter", "com.miui.powercenter.PowerSettings"),
            )
            isHuawei -> listOf(
                ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
            )
            isOppo -> listOf(
                ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                ComponentName("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
            )
            isVivo -> listOf(
                ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
                ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
            )
            isSamsung -> listOf(
                ComponentName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
            )
            else -> emptyList()
        }
        val pm = context.packageManager
        for (c in candidates) {
            val intent = Intent().setComponent(c).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (intent.resolveActivity(pm) != null) return intent
        }
        return null
    }

    /** Системные настройки VPN — там включается «Постоянный VPN» (always-on). */
    fun vpnSettingsIntent(): Intent =
        Intent("android.net.vpn.SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Карточка приложения в настройках: батарея, автозапуск, уведомления. */
    fun appDetailsIntent(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Что стоит разрешить на этом устройстве, по порядку важности. */
    fun hints(context: Context): List<Hint> {
        val out = mutableListOf<Hint>()

        out += Hint(
            id = "battery",
            title = "Без ограничений батареи",
            text = "Иначе система усыпляет приложение, и через несколько минут без экрана связь рвётся. " +
                "Откройте и выберите «Разрешить».",
            done = ignoresBatteryOptimizations(context),
            action = batteryIntent(context),
        )

        if (needsAutostart) {
            val brand = when {
                isXiaomi -> "Xiaomi (MIUI/HyperOS)"
                isHuawei -> "Huawei/Honor"
                isOppo -> "OPPO/realme"
                else -> "vivo"
            }
            out += Hint(
                id = "autostart",
                title = "Автозапуск на $brand",
                text = "Оболочка запрещает приложениям стартовать самим и закрывает их в фоне. " +
                    "Включите NoVPN в списке автозапуска — иначе VPN не поднимется после перезагрузки " +
                    "и может выключиться, пока вы им не пользуетесь.",
                // Проверить программно нельзя: производитель наружу это не отдаёт.
                done = null,
                action = autostartIntent(context) ?: appDetailsIntent(context),
            )
            if (isXiaomi) {
                out += Hint(
                    id = "xiaomi-lock",
                    title = "Закрепить в недавних",
                    text = "На MIUI/HyperOS откройте список недавних задач, потяните карточку NoVPN вниз " +
                        "и нажмите на замок. Закреплённые приложения система не закрывает при очистке памяти.",
                    done = null,
                    action = null,
                )
            }
        }

        out += Hint(
            id = "always-on",
            title = "Постоянный VPN",
            text = "Системная настройка: Android сам поднимет VPN после перезагрузки и не даст трафику " +
                "уйти мимо туннеля. Настройки → Сеть → VPN → NoVPN → «Постоянный VPN».",
            done = null,
            action = vpnSettingsIntent(),
        )

        return out
    }
}
