package api.models.release

import domain.models.ReleaseAsset
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ReleaseAssetApiModel(
    @SerialName("browser_download_url")
    val downloadUrl: String?,
    @SerialName("content_type")
    val contentType: String?,
    @SerialName("size")
    val size: Long?
)

fun ReleaseAssetApiModel.toDomain(): ReleaseAsset {
    return ReleaseAsset(
        url = this.downloadUrl.orEmpty(),
        contentType = this.contentType.orEmpty(),
        size = this.size ?: 0
    )
}