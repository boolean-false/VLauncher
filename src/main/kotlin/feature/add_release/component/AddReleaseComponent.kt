package feature.add_release.component

import androidx.compose.runtime.Stable
import feature.add_release.ui.model.AddReleaseUiAction
import feature.add_release.ui.model.AddReleaseUiState
import utils.state.SharedEventFlow
import kotlinx.coroutines.flow.StateFlow

@Stable
interface AddReleaseComponent {
    val uiAction: SharedEventFlow<AddReleaseUiAction>
    val uiState: StateFlow<AddReleaseUiState>
    fun emitUiAction(action: AddReleaseUiAction)
    fun changeName(newVal: String)
    fun changeRelease(releaseId: Long)
    fun onApply()
}