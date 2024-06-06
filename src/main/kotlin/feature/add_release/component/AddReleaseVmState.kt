package feature.add_release.component

import feature.add_release.domain.model.ReleaseForCurrentOS

data class AddReleaseVmState(
    val isLoading: Boolean,
    val name: String,
    val selectedReleaseId: Long?,
    val busyFolderNameList: List<String>,
    val releaseList: List<ReleaseForCurrentOS>,
    val downloadProgress: Float?
) {
    companion object {
        fun initial(
            busyFolderNameList: List<String>
        ) = AddReleaseVmState(
            isLoading = true,
            selectedReleaseId = null,
            name = "",
            releaseList = listOf(),
            busyFolderNameList = busyFolderNameList,
            downloadProgress = null
        )
    }
}