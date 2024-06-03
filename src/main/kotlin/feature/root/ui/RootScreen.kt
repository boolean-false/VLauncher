package feature.root.ui

import androidx.compose.runtime.Composable
import com.arkivanov.decompose.extensions.compose.stack.Children
import feature.add_release.ui.compose.AddReleaseScreen
import feature.game_list.ui.GameListScreen
import feature.root.component.RootComponent

@Composable
fun RootScreen(
    component: RootComponent
) {
    Children(
        stack = component.stack
    ) {
        when (val instance = it.instance) {
            is RootComponent.Child.GameList -> {
                GameListScreen(
                    component = instance.component
                )
            }
            is RootComponent.Child.AddGameRelease -> {
                AddReleaseScreen(
                    component = instance.component
                )
            }
        }
    }

}

@Composable
private fun RootContent() {

}
