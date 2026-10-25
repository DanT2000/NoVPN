package ru.appswire.novpn.core

/**
 * Что делать, когда под туннелем оказалась сеть [net] (handle сети) типа [transport]
 * (TRANSPORT_WIFI/CELLULAR/ETHERNET, -1 — не распознан). Одно решение и для колбэка
 * системы, и для опроса сторожа: раньше у них были разные мнения о «текущей сети», и
 * каждое подключение и каждая смена сети давали лишний переезд со сбросом соединений.
 */
object NetSwitch {
    enum class Action {
        /** Та же сеть — ничего не трогаем. */
        NONE,
        /** Первая сеть сессии (или тип прошлой неизвестен) — только запоминаем. */
        BASELINE,
        /** Другая сеть того же типа (смена SIM, новая сессия оператора) — мягкий переезд. */
        MOVE,
        /** Сменился тип (Wi-Fi ↔ мобильный) — переустановка туннеля (значок сети на MIUI). */
        REESTABLISH,
    }

    fun decide(prevNet: Long?, prevTransport: Int, net: Long, transport: Int): Action = when {
        prevNet == null || prevTransport == -1 -> Action.BASELINE
        net == prevNet -> Action.NONE
        transport != -1 && transport != prevTransport -> Action.REESTABLISH
        else -> Action.MOVE
    }
}
