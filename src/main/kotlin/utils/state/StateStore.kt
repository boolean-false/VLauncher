package utils.state

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Общий стор для стейтов экрана.
 * Они могут быть как Логическим стейтами (которые содержат доменные данные),
 * так и UI стейтами (которые содержат данные для непосредственной отрисовки элементов экрана).
 *
 * Когда какой стейт сохранять в данном классе?
 * 1. Для простых экранов с небольшим количеством элементов и простой логикой, подойдет UI стейт.
 * 2. А для экранов со сложной логикой лучше разделять UI стейт и логический стейт. В таком случае сохранять в
 * данном классе нужно логический VM стейт.
 *
 * Цель данного класса - хранить стейт и предоставлять удобный интерфейс для обновления стейта.
 */
class StateStore<S>(initialState: S) {

    private val mutableStateFlow = MutableStateFlow(initialState)
    val stateFlow: StateFlow<S> = mutableStateFlow.asStateFlow()

    val value get() = stateFlow.value

    /**
     * Делает атомарное обновление стейта.
     * Атомарность достигается путем использования [StateFlow]
     */
    fun updateState(block: (S) -> S) {
        val currentState: S = mutableStateFlow.value
        val updatedState: S = block(currentState)

        mutableStateFlow.value = updatedState
    }

    /**
     * Делает атомарное обновление стейта, без блокировки потоков
     * Данная функция защищена от ошибок Concurrency
     *
     * Мы можем обновить состояние с помощью suspend, чтобы не блокировать основной поток.
     * на любом Dispatchers
     *
     * https://medium.com/geekculture/atomic-updates-with-mutablestateflow-dc0331724405
     */
    fun updateStateAtomic(block: (S) -> S) {
        mutableStateFlow.update(block)
    }
}
