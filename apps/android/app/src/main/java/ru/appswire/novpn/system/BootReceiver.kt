package ru.appswire.novpn.system

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.util.Log
import ru.appswire.novpn.data.Repo
import ru.appswire.novpn.vpn.NoVpnService

/**
 * Автозапуск после перезагрузки и после обновления приложения.
 *
 * Работает не везде: начиная с Android 12 запуск foreground-службы из фона
 * ограничен, а оболочки вроде MIUI глушат такие приёмники до первого ручного
 * открытия приложения. Поэтому это «лучшее усилие», а надёжный способ —
 * системный «Постоянный VPN» (always-on), на который приложение и указывает
 * человеку в разделе «Работа в фоне».
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_LOCKED_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) return

        val repo = Repo.get(context)
        val state = repo.state.value
        if (!state.onboarded || !state.settings.autoconnect) return
        if (state.subUrl.isBlank() || state.servers.isEmpty()) return

        // Разрешение на VPN даёт человек, и оно переживает перезагрузку. Если его
        // нет — стартовать нечего, системный диалог из приёмника не показать.
        if (VpnService.prepare(context) != null) {
            Log.i(TAG, "автозапуск пропущен: разрешение на VPN ещё не выдано")
            return
        }
        Log.i(TAG, "автозапуск после $action")
        NoVpnService.start(context)
    }

    private companion object {
        const val TAG = "novpn.boot"
    }
}
