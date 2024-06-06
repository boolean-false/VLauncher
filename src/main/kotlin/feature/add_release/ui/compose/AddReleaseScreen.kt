package feature.add_release.ui.compose

import androidx.compose.desktop.ui.tooling.preview.Preview
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.Button
import androidx.compose.material.CircularProgressIndicator
import androidx.compose.material.DropdownMenuItem
import androidx.compose.material.ExperimentalMaterialApi
import androidx.compose.material.ExposedDropdownMenuBox
import androidx.compose.material.LinearProgressIndicator
import androidx.compose.material.MaterialTheme
import androidx.compose.material.OutlinedTextField
import androidx.compose.material.Surface
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import feature.add_release.component.AddReleaseComponent
import feature.add_release.component.PreviewAddReleaseComponent
import feature.add_release.ui.model.AddReleaseUiAction
import feature.add_release.ui.model.AddReleaseUiState
import feature.add_release.ui.model.InstallProgressUiModel
import ui.component.app_bar.AppBarWidget
import ui.theme.VLauncherTheme

@Composable
fun AddReleaseScreen(
    component: AddReleaseComponent
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
        ) {
            AppBarWidget(
                title = "Добавить образ",
                onBackClick = {
                    component.emitUiAction(AddReleaseUiAction.Back)
                }
            )

            when {
                uiState.isLoading -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier
                                .size(80.dp)
                                .align(Alignment.Center)
                        )
                    }
                }

                (uiState.installProgress != null) -> {
                    InstallProgressContent(uiState.installProgress!!)
                }

                else -> {
                    AddReleaseScreenContent(
                        uiState = uiState,
                        onChangeName = component::changeName,
                        onChangeRelease = component::changeRelease,
                        onApplyClick = component::onApply
                    )
                }
            }
        }
    }
}

@Composable
private fun InstallProgressContent(
    uiState: InstallProgressUiModel
) {
    Column(
        modifier = Modifier
            .fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = uiState.stateText,
            style = MaterialTheme.typography.h4,
            color = MaterialTheme.colors.onSurface
        )

        LinearProgressIndicator(
            modifier = Modifier
                .fillMaxWidth(),
            progress = uiState.progress
        )
    }
}

@OptIn(ExperimentalMaterialApi::class)
@Composable
private fun AddReleaseScreenContent(
    uiState: AddReleaseUiState,
    onChangeName: (newName: String) -> Unit,
    onChangeRelease: (releaseId: Long) -> Unit,
    onApplyClick: () -> Unit
) {
    // DropDown expanded state
    var expanded by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .padding(top = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        OutlinedTextField(
            value = uiState.name,
            onValueChange = onChangeName,
            label = { Text("Название") },
            modifier = Modifier.fillMaxWidth()
        )

        Box(
            modifier = Modifier
                .fillMaxWidth()
        ) {
            ExposedDropdownMenuBox(
                expanded = expanded,
                onExpandedChange = {
                    expanded = !expanded
                }
            ) {
                // TODO Переделать
                if (uiState.selectedRelease != null) {
                    Text(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(MaterialTheme.colors.secondaryVariant)
                            .clickable { }
                            .pointerHoverIcon(PointerIcon.Hand)
                            .padding(16.dp),
                        text = uiState.selectedRelease.name
                    )
                }

                ExposedDropdownMenu(
                    expanded = expanded,
                    onDismissRequest = {
                        expanded = false
                    }
                ) {
                    uiState.selectReleaseAssetList.map {
                        DropdownMenuItem(
                            onClick = {
                                if (!it.isAvailable) return@DropdownMenuItem
                                expanded = false
                                onChangeRelease(it.id)
                            }
                        ) {
                            Text(it.name)
                        }
                    }
                }
            }
        }

        Button(
            onClick = onApplyClick,
            modifier = Modifier.align(Alignment.End),
            enabled = uiState.isApplyEnabled
        ) {
            Text("Установить")
        }
    }
}

@Composable
@Preview
private fun PreviewAddReleaseScreen() {
    VLauncherTheme {
        AddReleaseScreen(
            component = PreviewAddReleaseComponent()
        )
    }
}
