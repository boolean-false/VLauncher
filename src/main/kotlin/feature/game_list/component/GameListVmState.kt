package feature.game_list.component

import androidx.compose.runtime.Stable
import com.boolfalse.rickandmorty.utils.state.SharedEventFlow
import domain.models.InstalledGame
import feature.add_release.domain.model.ReleaseForCurrentOS
import feature.game_list.ui.GameListUiAction
import feature.game_list.ui.model.GameListUiState
import kotlinx.coroutines.flow.StateFlow

data class GameListVmState(
    val installedGameList: List<InstalledGame>
) {
    companion object {
        fun initial(
            installedGameList: List<InstalledGame>
        ) = GameListVmState(
            installedGameList = installedGameList
        )
    }
}