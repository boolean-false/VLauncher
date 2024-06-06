package feature.game_list.component

import utils.state.SharedEventFlow
import feature.game_list.ui.GameListUiAction
import feature.game_list.ui.model.GameListUiState
import kotlinx.coroutines.flow.MutableStateFlow

class PreviewGameListComponent : GameListComponent {
    override val uiAction = SharedEventFlow<GameListUiAction>()
    override val uiState = MutableStateFlow(GameListUiState.preview())
    override fun emitUiAction(action: GameListUiAction) {}
    override fun runGame(name: String) {}
    override fun gameDelete(name: String) {}
    override fun gameStop(name: String) {}
    override fun gameLogs(name: String) {}
    override fun showFolderGame(name: String) {}
}