package api.models.release

import domain.models.ReleaseGame
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ReleaseGameApiModel(
    @SerialName("id")
    val id: Long,
    @SerialName("url")
    val url: String?,
    @SerialName("tag_name")
    val tagName: String?,
    @SerialName("name")
    val name: String?,
    @SerialName("published_at")
    val publishedAt: String?,
    @SerialName("assets")
    val assets: List<ReleaseAssetApiModel>?
)

fun ReleaseGameApiModel.toDomain(): ReleaseGame {
    return ReleaseGame(
        id = this.id,
        url = this.url.orEmpty(),
        tagName = this.tagName.orEmpty(),
        name = this.name.orEmpty(),
        publishedAt = this.publishedAt.orEmpty(),
        assets = this.assets?.map { it.toDomain() } ?: emptyList()
    )
}
