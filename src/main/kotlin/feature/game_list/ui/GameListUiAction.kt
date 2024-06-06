package feature.game_list.ui

sealed class GameListUiAction {
    data object ShowAddRelease : GameListUiAction()
    data class ShowLogList(
        val gameName: String
    ) : GameListUiAction()
}