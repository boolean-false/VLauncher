package feature.root.component

import androidx.compose.runtime.Stable
import com.arkivanov.decompose.ComponentContext
import com.arkivanov.decompose.router.stack.ChildStack
import com.arkivanov.decompose.router.stack.StackNavigation
import com.arkivanov.decompose.router.stack.childStack
import com.arkivanov.decompose.router.stack.pop
import com.arkivanov.decompose.router.stack.pushNew
import com.arkivanov.decompose.value.Value
import feature.add_release.component.DefaultAddReleaseComponent
import feature.add_release.ui.model.AddReleaseUiAction
import feature.game_list.component.DefaultGameListComponent
import feature.game_list.ui.GameListUiAction
import feature.logs_screen.component.DefaultLogsScreenComponent
import feature.logs_screen.ui.model.LogsScreenUiAction
import io.exoquery.fansi.Str
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.serialization.Serializable
import utils.decompose.CoroutineComponent
import utils.decompose.CoroutineComponentImpl

@Stable
class DefaultRootComponent(
    componentContext: ComponentContext
) : RootComponent,
    ComponentContext by componentContext,
    CoroutineComponent by CoroutineComponentImpl(componentContext) {

    private val navigation = StackNavigation<Config>()

    override val stack: Value<ChildStack<*, RootComponent.Child>> = childStack(
        source = navigation,
        serializer = Config.serializer(),
        initialConfiguration = Config.GameList,
        handleBackButton = true,
        childFactory = ::child
    )

    private fun child(
        config: Config,
        componentContext: ComponentContext
    ): RootComponent.Child {
        return when (config) {
            is Config.GameList -> {
                val component = DefaultGameListComponent(
                    componentContext = componentContext,
                )

                component.uiAction.onEach { uiAction ->
                    when (uiAction) {
                        GameListUiAction.ShowAddRelease -> {
                            navigation.pushNew(Config.AddGameRelease)
                        }
                        is GameListUiAction.ShowLogList -> {
                            navigation.pushNew(Config.LogList(uiAction.gameName))
                        }
                    }
                }.launchIn(scope)

                RootComponent.Child.GameList(
                    component = component
                )
            }

            Config.AddGameRelease -> {
                val component = DefaultAddReleaseComponent(
                    componentContext = componentContext,
                )

                component.uiAction.onEach { uiAction ->
                    when (uiAction) {
                        AddReleaseUiAction.Back -> {
                            navigation.pop()
                        }
                    }
                }.launchIn(scope)

                RootComponent.Child.AddGameRelease(
                    component = component
                )
            }

            is Config.LogList -> {
                val component = DefaultLogsScreenComponent(
                    componentContext = componentContext,
                    gameName = config.gameName
                )

                component.uiAction.onEach { uiAction ->
                    when (uiAction) {
                        LogsScreenUiAction.Back -> {
                            navigation.pop()
                        }
                    }
                }.launchIn(scope)

                RootComponent.Child.LogList(
                    component = component
                )
            }
        }
    }


    @Serializable
    sealed interface Config {
        @Serializable
        data object GameList : Config

        @Serializable
        data class LogList(
            val gameName: String
        ) : Config

        @Serializable
        data object AddGameRelease : Config
    }

}
