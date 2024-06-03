package feature.add_release.domain.model

data class ReleaseForCurrentOS(
    val id: Long,
    val version: String,

    // Если ссылки нет, считаем что для текущего релиза под ОС
    val downloadUrl: String?
)