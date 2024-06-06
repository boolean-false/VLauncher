package feature.logs_screen.component

import androidx.compose.runtime.Stable
import utils.state.SharedEventFlow
import feature.logs_screen.ui.model.LogsScreenUiAction

@Stable
interface LogsScreenComponent {
    val uiAction: SharedEventFlow<LogsScreenUiAction>
    val gameName: String
    fun emitUiAction(action: LogsScreenUiAction)
}