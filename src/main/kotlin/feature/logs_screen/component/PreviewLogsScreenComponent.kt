package feature.logs_screen.component

import utils.state.SharedEventFlow
import feature.logs_screen.ui.model.LogsScreenUiAction

class PreviewLogsScreenComponent : LogsScreenComponent {
    override val uiAction = SharedEventFlow<LogsScreenUiAction>()
    override val gameName: String = ""
    override fun emitUiAction(action: LogsScreenUiAction) {}
}