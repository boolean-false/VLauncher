package feature.game_list.component

import com.arkivanov.decompose.ComponentContext
import com.boolfalse.rickandmorty.utils.state.SharedEventFlow
import feature.game_list.ui.GameListUiAction
import feature.game_list.ui.model.GameListUiState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import utils.decompose.CoroutineComponent
import utils.decompose.CoroutineComponentImpl

class PreviewGameListComponent : GameListComponent {
    override val uiAction = SharedEventFlow<GameListUiAction>()
    override val uiState = MutableStateFlow(GameListUiState.preview())
    override fun emitUiAction(action: GameListUiAction) {}
    override fun gameSelect(name: String) {}
}