package utils.state

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first

class SharedEventFlow<T> : FlowCollector<T>, Flow<T> {

    private val sharedFlow = MutableSharedFlow<T>()

    override suspend fun emit(value: T) {
        sharedFlow.subscriptionCount.first { it > 0 }
        sharedFlow.emit(value)
    }

    override suspend fun collect(collector: FlowCollector<T>) {
        sharedFlow.collect(collector)
    }

    fun isExistSubscription(): Boolean {
        return sharedFlow.subscriptionCount.value > 0
    }
}
