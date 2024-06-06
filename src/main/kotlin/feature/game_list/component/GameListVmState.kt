package feature.game_list.component

import domain.models.InstalledGame

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