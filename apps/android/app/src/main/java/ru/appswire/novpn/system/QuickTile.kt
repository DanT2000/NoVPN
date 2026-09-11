package ru.appswire.novpn.system

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.VpnService
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import ru.appswire.novpn.MainActivity
import ru.appswire.novpn.R
import ru.appswire.novpn.vpn.ConnState
import ru.appswire.novpn.vpn.NoVpnService
import ru.appswire.novpn.vpn.VpnBus

/**
 * Плитка в шторке быстрых настроек: включить и выключить VPN, не открывая
 * приложение. Состояние берётся из [VpnBus] — той же шины, что и у экрана,
 * поэтому плитка не может показать «включено», когда служба уже упала.
 *
 * Если разрешение на VPN ещё не выдано, из плитки его не спросить — системный
 * диалог нужен поверх активности. Тогда открываем приложение с просьбой
 * подключиться: оно спросит разрешение и запустит службу само.
 */
class QuickTile : TileService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watch: Job? = null

    override fun onStartListening() {
        super.onStartListening()
        watch?.cancel()
        watch = scope.launch {
            VpnBus.state.collect { render(it) }
        }
    }

    override fun onStopListening() {
        watch?.cancel()
        watch = null
        super.onStopListening()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    override fun onClick() {
        super.onClick()
        if (VpnBus.isRunning) {
            NoVpnService.stop(this)
            return
        }
        if (VpnService.prepare(this) == null) {
            NoVpnService.start(this)
            return
        }
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_CONNECT, true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val pi = PendingIntent.getActivity(
                this, 2, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            startActivityAndCollapse(pi)
        } else {
            openLegacy(intent)
        }
    }

    /**
     * До Android 14 варианта с PendingIntent нет, а вариант с Intent на 14+ бросает
     * исключение — поэтому ветки разведены по версии, и предупреждение здесь ложное.
     */
    @Suppress("DEPRECATION")
    @android.annotation.SuppressLint("StartActivityAndCollapseDeprecated")
    private fun openLegacy(intent: Intent) {
        startActivityAndCollapse(intent)
    }

    private fun render(state: ConnState) {
        val tile = qsTile ?: return
        tile.icon = Icon.createWithResource(this, R.drawable.ic_stat_novpn)
        tile.label = "NoVPN"
        tile.state = when (state) {
            ConnState.ON, ConnState.CONNECTING, ConnState.RECONNECTING -> Tile.STATE_ACTIVE
            ConnState.OFF, ConnState.ERROR -> Tile.STATE_INACTIVE
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.subtitle = when (state) {
                ConnState.ON -> "Подключено"
                ConnState.CONNECTING -> "Подключаемся…"
                ConnState.RECONNECTING -> "Восстанавливаем…"
                ConnState.ERROR -> "Ошибка"
                ConnState.OFF -> "Выключено"
            }
        }
        tile.updateTile()
    }
}
