package feature.logs_screen.ui.compose

import AppContainer.gameBundleInteractor
import androidx.compose.desktop.ui.tooling.preview.Preview
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.rememberScrollbarAdapter
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.Icon
import androidx.compose.material.IconButton
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Surface
import androidx.compose.material.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
                    IconButton(
                        modifier = Modifier
                            .size(28.dp),
                        onClick = {
                            gameBundleInteractor.stopGame(component.gameName)
                            component.emitUiAction(LogsScreenUiAction.Back)
                        },
                    ) {
                        Icon(Icons.Outlined.Stop, contentDescription = "")
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
            SelectionContainer {
                Column {
                    logs.forEach { log ->
                        val annotatedLog = formatLog(log)
                        Text(
                            text = annotatedLog,
                            style = MaterialTheme.typography.body2.copy(
                                fontFamily = FontFamily.Monospace,
                                fontSize = 12.sp
                            ),
                            modifier = Modifier.padding(vertical = 2.dp)
                        )
                    }
                }
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

private fun formatLog(fullLog: String): AnnotatedString {
    val typeMaxCharCount = 21
    val log = fullLog.replaceFirst("[I] ", "")
    val timeRegex = """\d{4}/\d{2}/\d{2} (\d{2}:\d{2}:\d{2})\.\d{3}\+\d{4}""".toRegex()
    val tagRegex = """\[[^]]*]""".toRegex()

    return buildAnnotatedString {
        var lastIndex = 0

        timeRegex.find(log)?.let { matchResult ->
            append(log.substring(lastIndex, matchResult.range.first))
            withStyle(style = SpanStyle(color = Color.Cyan)) {
                append(matchResult.groupValues[1])
            }
            lastIndex = matchResult.range.last + 1
        }

        tagRegex.find(log, startIndex = lastIndex)?.let { matchResult ->
            val tag = matchResult.value.substring(1, matchResult.value.length - 1).trim()
            val paddedTag = tag.padEnd(typeMaxCharCount, ' ')
            append(log.substring(lastIndex, matchResult.range.first))
            withStyle(style = SpanStyle(color = Color(0xFFFFA500))) {
                append(paddedTag)
            }
            lastIndex = matchResult.range.last + 1
        }

        append(log.substring(lastIndex))
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
