package feature.add_release.component

import feature.add_release.domain.model.ReleaseForCurrentOS

data class AddReleaseVmState(
    val isLoading: Boolean,
    val name: String,
    val selectedReleaseId: Long?,
    val releaseList: List<ReleaseForCurrentOS>,
    val downloadProgress: Float?
) {
    companion object {
        fun initial() = AddReleaseVmState(
            isLoading = true,
            selectedReleaseId = null,
            name = "",
            releaseList = listOf(),
            downloadProgress = null
        )
    }
}