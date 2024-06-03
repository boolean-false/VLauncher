package utils.decompose

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

inline fun CoroutineComponent.launchSafe(
    coroutineScope: CoroutineScope = scope,
    crossinline errorHandler: suspend (exception: Exception) -> Unit,
    crossinline block: suspend CoroutineScope.() -> Unit,
): Job {
    return coroutineScope.launch {
        try {
            block()
        } catch (exception: Exception) {
            errorHandler(exception)
        }
    }
}
