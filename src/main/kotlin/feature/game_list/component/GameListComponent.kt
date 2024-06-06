package feature.game_list.component

import androidx.compose.runtime.Stable
import utils.state.SharedEventFlow
import feature.game_list.ui.GameListUiAction
import feature.game_list.ui.model.GameListUiState
import kotlinx.coroutines.flow.StateFlow

@Stable
interface GameListComponent {
    val uiAction: SharedEventFlow<GameListUiAction>
    val uiState: StateFlow<GameListUiState>
    fun emitUiAction(action: GameListUiAction)
    fun runGame(name: String)
    fun gameDelete(name: String)
    fun gameStop(name: String)
    fun gameLogs(name: String)
    fun showFolderGame(name: String)
}