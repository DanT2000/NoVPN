package ru.appswire.novpn.vpn

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Состояние подключения, как его видит человек. */
enum class ConnState { OFF, CONNECTING, ON, RECONNECTING, ERROR }

/**
 * Резервный режим: приложение временно ушло на аварийный сервер, потому что
 * обычная инфраструктура NoVPN недоступна (блокировки, ограниченная сеть).
 * Для человека это отдельный явный статус, а не «просто другой сервер».
 */
data class ReserveInfo(
    /** Имя активного резервного сервера (без внутренних деталей подписки). */
    val server: String,
    /** Хост сервера — для отчёта о расходе на панель. */
    val host: String,
)

/** Итог диагностики сети — чтобы объяснить человеку, что происходит. */
enum class NetDiagnosis {
    /** Пока не проверяли. */
    UNKNOWN,
    /** Интернета на устройстве нет вовсе. */
    NO_INTERNET,
    /** Интернет есть, но обычные серверы NoVPN недоступны. */
    SERVER_DOWN,
    /** Похоже на ограниченный режим сети (белые списки). */
    RESTRICTED,
    /** Сеть в порядке. */
    OK,
}

data class VpnStats(
    val downTotal: Long = 0,
    val upTotal: Long = 0,
    val downSpeed: Long = 0,
    val upSpeed: Long = 0,
    val connections: Int = 0,
    /** Задержка до выбранного сервера, мс; null — не мерили. */
    val pingMs: Int? = null,
)

/**
 * Общая шина между службой VPN и интерфейсом.
 *
 * Служба живёт дольше интерфейса и переживает закрытие приложения, поэтому
 * состояние держим не в экране, а здесь: окно открылось — сразу увидело правду,
 * а не «выключено», пока VPN на самом деле работает.
 */
object VpnBus {

    private val _state = MutableStateFlow(ConnState.OFF)
    val state: StateFlow<ConnState> = _state.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _stats = MutableStateFlow(VpnStats())
    val stats: StateFlow<VpnStats> = _stats.asStateFlow()

    /** Имя сервера, которым подключены (для уведомления и экрана). */
    private val _server = MutableStateFlow<String?>(null)
    val server: StateFlow<String?> = _server.asStateFlow()

    /** Не null — работаем через резервный сервер. */
    private val _reserve = MutableStateFlow<ReserveInfo?>(null)
    val reserve: StateFlow<ReserveInfo?> = _reserve.asStateFlow()

    /** Последний итог диагностики сети. */
    private val _diagnosis = MutableStateFlow(NetDiagnosis.UNKNOWN)
    val diagnosis: StateFlow<NetDiagnosis> = _diagnosis.asStateFlow()

    /** Предложить перейти на резерв вручную (когда автовосстановление выключено). */
    private val _offerReserve = MutableStateFlow(false)
    val offerReserve: StateFlow<Boolean> = _offerReserve.asStateFlow()

    fun setState(s: ConnState) {
        _state.value = s
        if (s == ConnState.ON || s == ConnState.OFF) _error.value = null
        // Вышли из работы — сбрасываем резервный режим и подсказки.
        if (s == ConnState.OFF) {
            _reserve.value = null
            _offerReserve.value = false
            _diagnosis.value = NetDiagnosis.UNKNOWN
        }
    }

    fun setReserve(info: ReserveInfo?) {
        _reserve.value = info
        if (info != null) _offerReserve.value = false
    }

    fun setDiagnosis(d: NetDiagnosis) {
        _diagnosis.value = d
    }

    fun setOfferReserve(v: Boolean) {
        _offerReserve.value = v
    }

    fun fail(message: String) {
        _error.value = message
        _state.value = ConnState.ERROR
    }

    fun setStats(s: VpnStats) {
        _stats.value = s
    }

    fun setServer(name: String?) {
        _server.value = name
    }

    fun clearError() {
        _error.value = null
    }

    val isRunning: Boolean
        get() = _state.value == ConnState.ON || _state.value == ConnState.CONNECTING ||
            _state.value == ConnState.RECONNECTING
}
