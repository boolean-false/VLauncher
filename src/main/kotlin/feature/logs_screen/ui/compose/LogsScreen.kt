package feature.logs_screen.ui.compose

import AppContainer.gameBundleInteractor
import androidx.compose.desktop.ui.tooling.preview.Preview
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.VerticalScrollbar
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.rememberScrollbarAdapter
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.Button
import androidx.compose.material.CircularProgressIndicator
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Surface
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import feature.logs_screen.component.PreviewLogsScreenComponent
import feature.logs_screen.component.LogsScreenComponent
import feature.logs_screen.ui.model.LogsScreenUiAction
import ui.component.app_bar.AppBarWidget
import ui.theme.VLauncherTheme

@Composable
fun LogsScreen(
    component: LogsScreenComponent
) {
    val gameLogs by gameBundleInteractor.getGameLogs(component.gameName).collectAsState()
    val isRunning by gameBundleInteractor.isGameRunning(component.gameName).collectAsState()
    val scrollState = rememberScrollState()

    Surface(
        modifier = Modifier
            .fillMaxSize()
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            AppBarWidget(
                title = component.gameName,
                onBackClick = {
                    component.emitUiAction(LogsScreenUiAction.Back)
                },
                endContent = {
                    Button(
                        onClick = {
                            gameBundleInteractor.stopGame(component.gameName)
                            component.emitUiAction(LogsScreenUiAction.Back)
                        }
                    ) {
                        Text("Завершить")
                    }
                }
            )

            Spacer(modifier = Modifier.height(16.dp))

            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .weight(1f)
            ) {
                LogList(gameLogs, scrollState)
            }
        }
    }

    LaunchedEffect(isRunning) {
        if (!isRunning) {
            gameBundleInteractor.stopGame(component.gameName)
            component.emitUiAction(LogsScreenUiAction.Back)
        }
    }
}

@Composable
fun LogList(logs: List<String>, scrollState: ScrollState) {
    Box(
        modifier = Modifier
            .fillMaxSize()
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(scrollState)
                .padding(end = 12.dp)
        ) {
            logs.forEach { log ->
                Text(
                    text = log,
                    style = MaterialTheme.typography.body2,
                    color = MaterialTheme.colors.onSurface,
                    modifier = Modifier.padding(vertical = 2.dp)
                )
            }
        }

        LaunchedEffect(logs.size) {
            scrollState.animateScrollTo(scrollState.maxValue)
        }

        VerticalScrollbar(
            modifier = Modifier.align(Alignment.CenterEnd).fillMaxHeight(),
            adapter = rememberScrollbarAdapter(scrollState)
        )
    }
}

@Composable
@Preview
private fun PreviewAddReleaseScreen() {
    VLauncherTheme {
        LogsScreen(
            component = PreviewLogsScreenComponent()
        )
    }
}
