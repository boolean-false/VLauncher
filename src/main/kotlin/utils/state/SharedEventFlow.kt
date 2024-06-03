package com.boolfalse.rickandmorty.utils.state

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first

/**
 * Позволет эммитить сразу нескольким подписчикам все отправленные события.
 * Ждёт, когда появится хотябы один подписчик, а затем отправляем ему все ивенты.
 */
class SharedEventFlow<T> : FlowCollector<T>, Flow<T> {

    private val sharedFlow = MutableSharedFlow<T>()

    override suspend fun emit(value: T) {
        sharedFlow.subscriptionCount.first { it > 0 } // ждёт пока у sharedFlow появятся подписчики
        sharedFlow.emit(value)
    }

    override suspend fun collect(collector: FlowCollector<T>) {
        sharedFlow.collect(collector)
    }

    /**
     * Проверяем есть ли подписчики у sharedFlow
     */
    fun isExistSubscription(): Boolean {
        return sharedFlow.subscriptionCount.value > 0
    }
}
