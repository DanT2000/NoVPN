package ru.appswire.novpn

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import ru.appswire.novpn.data.Repo

class NoVpnApp : Application() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        val repo = Repo.get(this)
        // При каждом запуске тихо освежаем профили и списки: подписку могли
        // отключить, а списки — обновить. Ошибки здесь не показываем: человек
        // увидит их там, где сам нажмёт «Обновить».
        scope.launch {
            val state = repo.state.value
            if (state.subUrl.isNotBlank()) {
                runCatching { repo.refreshMeta() }
                if (state.settings.autoUpdateLists) runCatching { repo.syncLists() }
            }
        }
    }
}
