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
) {
    /**
     * Метка для экрана журнала: сегодняшнее — только время, прошлые дни — с датой.
     * Раньше показывалось одно время, и записи за разные дни выглядели как одна ночь
     * (06.10.2026 владелец разбирал «вчерашние 15:43» вперемешку с сегодняшними 05:53).
     */
    fun stamp(today: String): String {
        val date = at.substringBefore('T', "")
        val time = at.substringAfter('T', at)
        if (date.isEmpty() || date == today) return time
        val p = date.split('-')
        return if (p.size == 3) "${p[2]}.${p[1]} ${time.take(5)}" else at
    }

    companion object {
        /**
         * Та же запись (вид и текст) уже есть среди последних нескольких и моложе окна —
         * повтор не пишем. Пока туннель «залип», одни и те же две строки («обычные серверы
         * не пропускают трафик…», «резервных серверов нет…») шли каждые 8–30 с и за пару
         * минут вытесняли из журнала (50 последних) всё важное — например, перезапуски.
         */
        fun isRepeat(recent: List<DiagEntry>, kind: String, text: String, nowIso: String, windowSec: Long = 300): Boolean {
            val now = parse(nowIso) ?: return false
            return recent.takeLast(6).any { e ->
                e.kind == kind && e.text == text &&
                    parse(e.at)?.let { java.time.Duration.between(it, now).seconds in 0..windowSec } == true
            }
        }

        private fun parse(iso: String): java.time.LocalDateTime? =
            runCatching { java.time.LocalDateTime.parse(iso) }.getOrNull()
    }
}
