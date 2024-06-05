package domain.models

import utils.SystemInfo

data class InstalledGame(
    val name: String,
    val version: String,
    val systemInfo: SystemInfo,
    val executable: String
)