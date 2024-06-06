package feature.game_list.ui

import AppContainer.gameBundleInteractor
import androidx.compose.desktop.ui.tooling.preview.Preview
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.AlertDialog
import androidx.compose.material.Button
import androidx.compose.material.DropdownMenu
import androidx.compose.material.DropdownMenuItem
import androidx.compose.material.Icon
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Surface
import androidx.compose.material.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.PopupProperties
import feature.game_list.component.GameListComponent
import feature.game_list.component.PreviewGameListComponent
import feature.game_list.ui.model.GamePreviewUiModel
import ui.component.app_bar.AppBarWidget
import ui.theme.VLauncherTheme
import utils.compose.notifyRightClick

@Composable
fun GameListScreen(
    component: GameListComponent
) {
    val uiState by component.uiState.collectAsState()
    var showDeleteDialog by remember { mutableStateOf(false) }
    var selectedGameName by remember { mutableStateOf("") }

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
                title = "Установленные образы"
            )

            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 148.dp),
            ) {
                items(uiState.gameList) { game ->
                    val isRunning by gameBundleInteractor.isGameRunning(game.name).collectAsState()

                    GameCard(
                        uiState = game,
                        isRunning = isRunning,
                        onShowFolderClick = {
                            component.showFolderGame(game.name)
                        },
                        onLaunchClick = {
                            component.runGame(game.name)
                        },
                        onDeleteClick = {
                            showDeleteDialog = true
                            selectedGameName = game.name
                        },
                        onStopClick = {
                            component.gameStop(game.name)
                        },
                        onLogsClick = {
                            component.gameLogs(game.name)
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

    if (showDeleteDialog) {
        AlertDialog(
            onDismissRequest = { showDeleteDialog = false },
            title = {
                Text(text = "Подтверждение удаления")
            },
            text = {
                Text("Вы уверены, что хотите удалить ${selectedGameName}? Это действие невозможно отменить.")
            },
            confirmButton = {
                Button(
                    onClick = {
                        component.gameDelete(selectedGameName)
                        showDeleteDialog = false
                    }) {
                    Text("Удалить")
                }
            },
            dismissButton = {
                Button(
                    onClick = {
                        showDeleteDialog = false
                    }) {
                    Text("Отменить")
                }
            }
        )
    }
}

@Composable
fun GameCard(
    uiState: GamePreviewUiModel,
    isRunning: Boolean,
    onShowFolderClick: () -> Unit,
    onLaunchClick: () -> Unit,
    onDeleteClick: () -> Unit,
    onStopClick: () -> Unit,
    onLogsClick: () -> Unit
) {
    var showMenu by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .padding(4.dp)
            .size(
                width = 120.dp,
                height = 96.dp
            )
            .clip(RoundedCornerShape(8.dp))
            .clickable {
                if (!isRunning) onLaunchClick()
                else onLogsClick()
            }
            .pointerHoverIcon(PointerIcon.Hand)
            .background(MaterialTheme.colors.secondaryVariant)
            .notifyRightClick {
                showMenu = true
            },
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(8.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
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
                text = uiState.version,
                style = MaterialTheme.typography.subtitle2,
                color = MaterialTheme.colors.onSurface,
                textAlign = TextAlign.Center,
                maxLines = 1,
            )
        }

        if (isRunning) {
            Text(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 4.dp),
                text = "Запущен",
                style = MaterialTheme.typography.caption,
                color = MaterialTheme.colors.onSurface,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }

        DropdownMenu(
            expanded = showMenu,
            onDismissRequest = { showMenu = false },
            properties = PopupProperties(
                focusable = true
            ),
            offset = DpOffset(x = 0.dp, y = 0.dp)
        ) {
            DropdownMenuItem(
                onClick = {
                    onShowFolderClick()
                    showMenu = false
                }
            ) {
                Text("Папка контент-паков", fontSize = 14.sp)
            }
            if (isRunning) {
                DropdownMenuItem(
                    onClick = {
                        onStopClick()
                        showMenu = false
                    }
                ) {
                    Text("Остановить", fontSize = 14.sp)
                }
            } else {
                DropdownMenuItem(
                    onClick = {
                        onDeleteClick()
                        showMenu = false
                    }
                ) {
                    Text("Удалить", fontSize = 14.sp)
                }
            }

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