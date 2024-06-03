package domain.models

data class ReleaseGame(
    val id: Long,
    val url: String,
    val tagName: String,
    val name: String,
    val publishedAt: String,
    val assets: List<ReleaseAsset>
)