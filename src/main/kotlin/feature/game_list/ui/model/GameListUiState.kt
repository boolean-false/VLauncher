package feature.game_list.ui.model

import kotlinx.collections.immutable.ImmutableList
import kotlinx.collections.immutable.persistentListOf

data class GameListUiState(
    val gameList: ImmutableList<GamePreviewUiModel>
) {
    companion object {
        fun initial() = GameListUiState(
            gameList = persistentListOf()
        )
        fun preview() = GameListUiState(
            gameList = persistentListOf(
                GamePreviewUiModel(
                    name = "Игра1",
                    version = "1.2.3",
                    modsCount = "0",
                ),
                GamePreviewUiModel(
                    name = "Игра2",
                    version = "1.3.3",
                    modsCount = "2",
                )
            )
        )
    }
}