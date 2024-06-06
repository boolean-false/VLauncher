package feature.add_release.component

import feature.add_release.ui.model.AddReleaseUiAction
import feature.add_release.ui.model.AddReleaseUiState
import utils.state.SharedEventFlow
import kotlinx.coroutines.flow.MutableStateFlow

class PreviewAddReleaseComponent : AddReleaseComponent {
    override val uiAction = SharedEventFlow<AddReleaseUiAction>()
    override val uiState = MutableStateFlow(AddReleaseUiState.preview())
    override fun emitUiAction(action: AddReleaseUiAction) {}
    override fun changeName(newVal: String) {}
    override fun changeRelease(releaseId: Long) {}
    override fun onApply() {}
}