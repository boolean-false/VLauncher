package feature.root.component

import androidx.compose.runtime.Stable
import com.arkivanov.decompose.router.stack.ChildStack
import com.arkivanov.decompose.value.Value
import feature.add_release.component.AddReleaseComponent
import feature.game_list.component.GameListComponent

@Stable
interface RootComponent {
    val stack: Value<ChildStack<*, Child>>

    sealed class Child {
        class GameList(
            val component: GameListComponent
        ) : Child()

        class AddGameRelease(
            val component: AddReleaseComponent
        ) : Child()
    }
}