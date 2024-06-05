package feature.game_list.component

import AppContainer
import com.arkivanov.decompose.ComponentContext
import com.boolfalse.rickandmorty.utils.state.SharedEventFlow
import feature.add_release.component.AddReleaseVmState
import feature.game_list.ui.GameListUiAction
import feature.game_list.ui.model.GameListUiState
import feature.game_list.ui.model.GameListUiStateAssembler
import game_process.GameProcessInteractor
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import utils.decompose.CoroutineComponent
import utils.decompose.CoroutineComponentImpl
import utils.decompose.launchSafe
import utils.state.StateStore

class DefaultGameListComponent(
    componentContext: ComponentContext,
) : GameListComponent,
    ComponentContext by componentContext,
    CoroutineComponent by CoroutineComponentImpl(componentContext) {
    private val gameBundleInteractor = AppContainer.gameBundleInteractor
    private val gameProcessInteractor = GameProcessInteractor()

    private val uiStateAssembler = GameListUiStateAssembler()
    private val stateStore = StateStore(
        GameListVmState.initial(
            installedGameList = gameBundleInteractor.games.value
        )
    )

    override val uiAction = SharedEventFlow<GameListUiAction>()
    override val uiState = stateStore.stateFlow
        .map(uiStateAssembler::assembleUiState)
        .stateIn(
            scope = scope,
            started = SharingStarted.Eagerly,
            initialValue = GameListUiState.initial()
        )

    init {
        collectGameBundles()
    }

    private fun collectGameBundles() {
        launchSafe(errorHandler = {}) {
            gameBundleInteractor.games.onEach { gameList ->
                stateStore.updateState {
                    it.copy(
                        installedGameList = gameList
                    )
                }
            }.stateIn(scope)
        }

        launchSafe(errorHandler = {}) {
            gameProcessInteractor.logs.onEach { logs ->
//                println("Log ${logs}")
            }.stateIn(scope)
        }
    }

    override fun gameSelect(name: String) {
        val game = stateStore.value.installedGameList.firstOrNull {it.name == name} ?: return
        gameProcessInteractor.runGame(
            gameName = name,
            executable = game.executable
        )
    }

    override fun emitUiAction(action: GameListUiAction) {
        scope.launch {
            uiAction.emit(action)
        }
    }
}