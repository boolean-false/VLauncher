package feature.add_release.component

import api.repositories.GameRepository
import com.arkivanov.decompose.ComponentContext
import com.boolfalse.rickandmorty.utils.state.SharedEventFlow
import feature.add_release.ui.model.AddReleaseUiAction
import feature.add_release.ui.model.AddReleaseUiState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import utils.decompose.CoroutineComponent
import utils.decompose.CoroutineComponentImpl
import utils.decompose.launchSafe
import java.lang.Exception

class PreviewAddReleaseComponent : AddReleaseComponent {
    override val uiAction = SharedEventFlow<AddReleaseUiAction>()
    override val uiState = MutableStateFlow(AddReleaseUiState.preview())
    override fun emitUiAction(action: AddReleaseUiAction) {}
    override fun changeName(newVal: String) {}
    override fun changeRelease(releaseId: Long) {}
    override fun onApply() {}
}