package utils.decompose

import com.arkivanov.essenty.lifecycle.Lifecycle
import com.arkivanov.essenty.lifecycle.LifecycleOwner
import com.arkivanov.essenty.lifecycle.doOnDestroy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlin.coroutines.CoroutineContext

class CoroutineComponentImpl(
    lifecycleOwner: LifecycleOwner
) : CoroutineComponent {
    override val scope = lifecycleOwner.coroutineScope(Dispatchers.Main.immediate + SupervisorJob())
}

private fun CoroutineScope(context: CoroutineContext, lifecycle: Lifecycle): CoroutineScope {
    val scope = CoroutineScope(context)
    lifecycle.doOnDestroy(scope::cancel)
    return scope
}

private fun LifecycleOwner.coroutineScope(context: CoroutineContext): CoroutineScope {
    return CoroutineScope(context, lifecycle)
}

