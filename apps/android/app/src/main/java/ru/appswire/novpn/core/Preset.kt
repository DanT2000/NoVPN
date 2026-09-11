package ru.appswire.novpn.core

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import ru.appswire.novpn.R

/**
 * Встроенный пресет доменов — тот же, что у десктопа (`apps/desktop/src/data/sites.json`,
 * из него собран `res/raw/preset_sites.json`).
 *
 * Зачем он нужен, хотя есть списки с панели:
 *
 * - `direct` — российские сервисы (банки, госуслуги, карты, маркетплейсы). Панель их
 *   НЕ присылает: `upstream.json` по контракту — плоский список того, что уводится в
 *   VPN, категории «напрямую» там нет. Без этого слоя любое широкое правило из
 *   upstream (по ключевому слову или регэкспу) утащило бы российский сервис за границу,
 *   и он показал бы заглушку. На десктопе этот слой есть всегда, значит должен быть и тут.
 * - `vpn` — запас на первый запуск: пока AutoRoute ещё не скачался, приложение не должно
 *   быть пустышкой, в которой «VPN включён, а ничего не изменилось».
 *
 * Как только списки с панели пришли, они главнее: пресет остаётся только слоем
 * «напрямую», который сильнее их (см. порядок правил в Config).
 */
object Preset {

    @Serializable
    private data class Raw(val direct: List<String> = emptyList(), val vpn: List<String> = emptyList())

    @Volatile
    private var cache: Raw? = null

    private fun load(context: Context): Raw {
        cache?.let { return it }
        val parsed = runCatching {
            val text = context.resources.openRawResource(R.raw.preset_sites)
                .bufferedReader()
                .use { it.readText() }
            Json { ignoreUnknownKeys = true }.decodeFromString<Raw>(text)
        }.getOrDefault(Raw())
        cache = parsed
        return parsed
    }

    /** Домены, обязанные идти напрямую. Слой логики, в интерфейсе не показывается. */
    fun directDomains(context: Context): List<String> = load(context).direct

    /** Запас «через VPN» до первой синхронизации списков. */
    fun fallbackVpnDomains(context: Context): List<String> = load(context).vpn
}
