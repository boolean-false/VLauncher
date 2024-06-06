package feature.add_release.ui.model

import feature.add_release.component.AddReleaseVmState
import kotlinx.collections.immutable.toImmutableList

class AddReleaseUiStateAssembler {
    fun assembleUiState(vmState: AddReleaseVmState): AddReleaseUiState {
        val selectReleaseAssetList = vmState.releaseList.map { relese ->
            val assetName = buildString {
                append(relese.version)
                if (relese.downloadUrl == null) {
                    append(" (Не поддерживается текущей ОС)")
                }
            }
            ChangeReleaseAssetUiModel(
                id = relese.id,
                name = assetName,
                isAvailable = relese.downloadUrl != null
            )
        }.toImmutableList()

        val selectedRelease = selectReleaseAssetList
            .firstOrNull { it.id == vmState.selectedReleaseId }

        val installProgress = vmState.downloadProgress?.let {
            InstallProgressUiModel(
                stateText = "Загрузка",
                progress = it
            )
        }

        val isApplyEnabled =
            vmState.name.isNotEmpty() && !vmState.busyFolderNameList.contains(vmState.name)

        return AddReleaseUiState(
            name = vmState.name,
            selectReleaseAssetList = selectReleaseAssetList,
            selectedRelease = selectedRelease,
            isLoading = vmState.isLoading,
            installProgress = installProgress,
            isApplyEnabled = isApplyEnabled
        )
    }
}