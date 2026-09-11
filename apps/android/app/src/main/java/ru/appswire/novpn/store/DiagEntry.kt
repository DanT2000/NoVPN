package ru.appswire.novpn.store

import kotlinx.serialization.Serializable

/**
 * Запись журнала диагностики подключения (§13). Копится на устройстве и досылается
 * на панель, когда интернет восстановился, — чтобы на этапе тестирования была видна
 * реальная причина сбоя (нет интернета / сервер недоступен / ограниченный режим /
 * ушли на резерв). Отправку можно выключить в настройках.
 */
@Serializable
data class DiagEntry(
    /** Время события на устройстве (ISO-8601). */
    val at: String,
    /** Категория: diagnosis | switch | reserve | error | info. */
    val kind: String,
    val text: String,
    /** Уже отправлено на панель. */
    val uploaded: Boolean = false,
)
