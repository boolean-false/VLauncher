package feature.game_list.component

import androidx.compose.runtime.Stable
import com.boolfalse.rickandmorty.utils.state.SharedEventFlow
import feature.game_list.ui.GameListUiAction
import feature.game_list.ui.model.GameListUiState
import kotlinx.coroutines.flow.StateFlow

@Stable
interface GameListComponent {
    val uiAction: SharedEventFlow<GameListUiAction>
    val uiState: StateFlow<GameListUiState>
    fun emitUiAction(action: GameListUiAction)
    fun gameSelect(name: String)
}