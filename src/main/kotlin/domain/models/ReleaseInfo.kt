package domain.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable


/**
 * Модель, которая хранит инфу о скачанной сборке
 */
@Serializable
data class ReleaseInfo(
    @SerialName("version")
    val version: String,
    @SerialName("targetOS")
    val targetOS: String,
    @SerialName("executable")
    val executable: String
)