package feature.logs_screen.component

import com.arkivanov.decompose.ComponentContext
import utils.state.SharedEventFlow
import feature.logs_screen.ui.model.LogsScreenUiAction
import kotlinx.coroutines.launch
import utils.decompose.CoroutineComponent
import utils.decompose.CoroutineComponentImpl

class DefaultLogsScreenComponent(
    val componentContext: ComponentContext,
    override val gameName: String
) : LogsScreenComponent,
    ComponentContext by componentContext,
    CoroutineComponent by CoroutineComponentImpl(componentContext) {
    override val uiAction = SharedEventFlow<LogsScreenUiAction>()

    override fun emitUiAction(action: LogsScreenUiAction) {
        scope.launch {
            uiAction.emit(action)
        }
    }
}