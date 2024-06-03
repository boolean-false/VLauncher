package feature.add_release.ui.model

import kotlinx.collections.immutable.ImmutableList
import kotlinx.collections.immutable.persistentListOf

data class AddReleaseUiState(
    val isLoading: Boolean,
    val name: String,
    val selectedRelease: ChangeReleaseAssetUiModel?,
    val selectReleaseAssetList: ImmutableList<ChangeReleaseAssetUiModel>,
    val installProgress: InstallProgressUiModel?
) {
    companion object {
        fun initial() = AddReleaseUiState(
            isLoading = false,
            name = "",
            selectedRelease = null,
            selectReleaseAssetList = persistentListOf(),
            installProgress = null
        )

        fun preview() = AddReleaseUiState(
            isLoading = false,
            name = "Супер дупер игруля",
            selectedRelease = ChangeReleaseAssetUiModel(
                id = 0,
                name = "1.2.3",
                isAvailable = true
            ),
            selectReleaseAssetList = persistentListOf(
                ChangeReleaseAssetUiModel(
                    id = 0,
                    name = "1.2.3",
                    isAvailable = true
                ),
                ChangeReleaseAssetUiModel(
                    id = 0,
                    name = "3.4.3",
                    isAvailable = true
                )
            ),
            installProgress = null
        )
    }
}