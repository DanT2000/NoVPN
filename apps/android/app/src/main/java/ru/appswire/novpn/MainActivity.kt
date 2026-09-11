package ru.appswire.novpn

import android.Manifest
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import ru.appswire.novpn.data.Repo
import ru.appswire.novpn.ui.AppRoot
import ru.appswire.novpn.ui.NoVpnTheme
import ru.appswire.novpn.vpn.NoVpnService
import ru.appswire.novpn.vpn.VpnBus
import java.net.URLDecoder

class MainActivity : ComponentActivity() {

    private lateinit var repo: Repo

    /** Ссылка из novpn://subscribe?url=… — подхватывается экраном подписки. */
    private var deepLink by mutableStateOf<String?>(null)

    private val vpnPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK) {
            askNotifications()
            NoVpnService.start(this)
        } else {
            VpnBus.fail("Без разрешения на VPN подключиться нельзя. Нажмите «Запустить» ещё раз и выберите «ОК».")
        }
    }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* отказ не мешает работе */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        repo = Repo.get(this)
        handleDeepLink(intent)
        handleConnectRequest(intent)

        setContent {
            val state by repo.state.collectAsState()
            NoVpnTheme(theme = state.settings.theme) {
                AppRoot(
                    repo = repo,
                    deepLink = deepLink,
                    onDeepLinkUsed = { deepLink = null },
                    onConnect = ::connect,
                    onDisconnect = { NoVpnService.stop(this) },
                    onRulesChanged = { NoVpnService.reload(this) },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
        handleConnectRequest(intent)
    }

    /**
     * Плитка быстрых настроек не может показать системный диалог разрешения на
     * VPN — открывает нас с просьбой подключиться. Флаг снимаем сразу, чтобы
     * поворот экрана не запускал подключение второй раз.
     */
    private fun handleConnectRequest(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_CONNECT, false) != true) return
        intent.removeExtra(EXTRA_CONNECT)
        if (repo.state.value.onboarded && !VpnBus.isRunning) connect()
    }

    private fun handleDeepLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "novpn") return
        // novpn://subscribe?url=<кодированная ссылка>
        val raw = data.getQueryParameter("url")
            ?: data.encodedQuery?.substringAfter("url=", "")?.takeIf { it.isNotBlank() }
            ?: return
        deepLink = runCatching { URLDecoder.decode(raw, "UTF-8") }.getOrDefault(raw)
    }

    /**
     * Подключение. Сначала системный диалог разрешения на VPN: без него
     * establish() вернёт null, и туннель не поднимется.
     */
    private fun connect() {
        // Сначала — разрешение на VPN. Два системных запроса подряд запускать
        // нельзя: второй теряется, и человек не видит вопроса про VPN вовсе.
        // Уведомления спросим после, когда туннель уже разрешён.
        val prepare = VpnService.prepare(this)
        if (prepare != null) {
            runCatching { vpnPermission.launch(prepare) }
                .onFailure { VpnBus.fail("Система не показала запрос разрешения на VPN: ${it.message}") }
            return
        }
        askNotifications()
        NoVpnService.start(this)
    }

    /** Без уведомления не видно ни состояния, ни кнопки «Отключить». */
    private fun askNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        if (!granted) runCatching { notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }
    }

    companion object {
        /** Открыть приложение и сразу подключиться (из плитки быстрых настроек). */
        const val EXTRA_CONNECT = "ru.appswire.novpn.CONNECT"
    }
}
