package feature.game_list.ui.model

import feature.game_list.component.GameListVmState
import kotlinx.collections.immutable.ImmutableList
import kotlinx.collections.immutable.persistentListOf
import kotlinx.collections.immutable.toImmutableList

class GameListUiStateAssembler() {
    fun assembleUiState(vmState: GameListVmState): GameListUiState {
        val gameList = vmState.installedGameList.map {
            GamePreviewUiModel(
                name = it.name,
                version = it.version,
                modsCount = "0",
            )
        }.toImmutableList()

        return GameListUiState(
            gameList = gameList
        )
    }
}