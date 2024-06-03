package feature.game_list.ui

import androidx.compose.desktop.ui.tooling.preview.Preview
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.Icon
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Surface
import androidx.compose.material.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import feature.game_list.component.GameListComponent
import feature.game_list.component.PreviewGameListComponent
import feature.game_list.ui.model.GamePreviewUiModel
import ui.component.app_bar.AppBarWidget
import ui.theme.VLauncherTheme

@Composable
fun GameListScreen(
    component: GameListComponent
) {
    val uiState by component.uiState.collectAsState()

    Surface(
        modifier = Modifier
            .fillMaxSize()
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            AppBarWidget(
                title = "Твои игрульки"
            )

            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 148.dp),
            ) {
                items(uiState.gameList) { game ->
                    GameCard(
                        uiState = game,
                        onClick = { name ->
                            component.gameSelect(name)
                        }
                    )
                }
                item {
                    AddGameCard(
                        onClick = {
                            component.emitUiAction(GameListUiAction.ShowAddRelease)
                        }
                    )
                }
            }
        }

    }
}

@Composable
fun GameCard(
    uiState: GamePreviewUiModel,
    onClick: (name: String) -> Unit
) {
    Surface(
        modifier = Modifier
            .padding(4.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable {
                onClick(uiState.name)
            }
            .pointerHoverIcon(PointerIcon.Hand),
        color = MaterialTheme.colors.secondaryVariant
    ) {
        Column(
            modifier = Modifier
                .padding(8.dp)
        ) {
            Text(
                text = uiState.name,
                style = MaterialTheme.typography.body1,
                color = MaterialTheme.colors.onSurface,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )

            Spacer(modifier = Modifier.height(8.dp))

            Text(
                text = "Модов: ${uiState.modsCount}",
                style = MaterialTheme.typography.subtitle2,
                color = MaterialTheme.colors.onSurface,
                textAlign = TextAlign.Center,
                maxLines = 1,
            )

            Spacer(modifier = Modifier.height(4.dp))

            Text(
                text = uiState.version,
                style = MaterialTheme.typography.subtitle2,
                color = MaterialTheme.colors.onSurface,
                textAlign = TextAlign.Center,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun AddGameCard(
    onClick: () -> Unit
) {
    Surface(
        modifier = Modifier
            .padding(4.dp)
            .size(
                width = 120.dp,
                height = 96.dp
            )
            .clip(RoundedCornerShape(8.dp))
            .clickable {
                onClick()
            }
            .pointerHoverIcon(PointerIcon.Hand),
        color = MaterialTheme.colors.secondaryVariant
    ) {
        Column(
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Icon(
                modifier = Modifier
                    .size(38.dp),
                imageVector = Icons.Default.Add,
                contentDescription = ""
            )
            Text("Добавить")
        }
    }
}

@Composable
@Preview
private fun PreviewGameListScreen() {
    VLauncherTheme {
        GameListScreen(
            component = PreviewGameListComponent()
        )
    }
}