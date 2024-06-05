package domain

import domain.models.InstalledGame
import domain.models.ReleaseInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import utils.SystemInfo
import java.io.File

/**
 * Логика сканирования целевой папки сборок.
 */
class GameBundleInteractor {
    private val _games = MutableStateFlow<List<InstalledGame>>(emptyList())
    val games: StateFlow<List<InstalledGame>> = _games.asStateFlow()



    fun initialize() {
        scanGamesDirectory()
        println(games)
    }

    private fun scanGamesDirectory() {
        val targetDirectory = Settings.targetDirectory
        val dir = File(targetDirectory)
        if (!dir.exists() || !dir.isDirectory) return
        val newGames = mutableListOf<InstalledGame>()

        dir.listFiles()?.forEach { gameDir ->
            if (gameDir.isDirectory) {
                val infoFile = File(gameDir, "bundle.json")
                if (infoFile.exists()) {
                    try {
                        val releaseInfo = Json.decodeFromString<ReleaseInfo>(infoFile.readText())
                        val game = InstalledGame(
                            name = gameDir.name,
                            version = releaseInfo.version,
                            systemInfo = SystemInfo.fromString(releaseInfo.targetOS),
                            executable = releaseInfo.executable
                        )
                        newGames.add(game)
                    } catch (e: Exception) {
                        // Логгирование или обработка ошибки
                        println("Exception: ${e.message}")
                    }
                }
            }
        }

        _games.value = newGames
    }
}