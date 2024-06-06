package domain

import domain.models.InstalledGame
import domain.models.ReleaseInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import utils.SystemInfo
import java.awt.Desktop
import java.io.File

/**
 * Логика сканирования целевой папки сборок.
 */
class GameBundleInteractor {
    private val _games = MutableStateFlow<List<InstalledGame>>(emptyList())
    val games: StateFlow<List<InstalledGame>> = _games.asStateFlow()

    private val gameProcessInteractors = mutableMapOf<String, GameProcessInteractor>()

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

                        if (!gameProcessInteractors.containsKey(gameDir.name)) {
                            gameProcessInteractors[gameDir.name] = GameProcessInteractor(gameDir.name)
                        }
                    } catch (e: Exception) {
                        println("Exception: ${e.message}")
                    }
                }
            }
        }

        _games.value = newGames
    }

    fun runGame(gameName: String) {
        val game = _games.value.find { it.name == gameName } ?: return
        val interactor = gameProcessInteractors[gameName] ?: return
        interactor.runGame(game.executable)
    }

    fun stopGame(gameName: String) {
        val interactor = gameProcessInteractors[gameName] ?: return
        interactor.stopGame()
    }

    fun getGameLogs(gameName: String): StateFlow<List<String>> {
        val interactor = gameProcessInteractors[gameName]
            ?: throw IllegalArgumentException("Game not found: $gameName")
        return interactor.logs
    }

    fun isGameRunning(gameName: String): StateFlow<Boolean> {
        val interactor = gameProcessInteractors[gameName] ?: throw IllegalArgumentException("Game not found: $gameName")
        return interactor.isRunning
    }

    fun showGameFolder(gameName: String, folder: String = "") {
        val targetDirectory = Settings.targetDirectory
        val gameDir = File(targetDirectory, "$gameName/$folder")
        if (gameDir.exists() && gameDir.isDirectory) {
            try {
                if (Desktop.isDesktopSupported()) {
                    Desktop.getDesktop().open(gameDir)
                } else {
                    println("Desktop is not supported on this system.")
                }
            } catch (e: Exception) {
                println("Exception: ${e.message}")
            }
        } else {
            println("Game directory does not exist: $gameName")
        }
    }

    fun deleteGame(gameName: String) {
        val targetDirectory = Settings.targetDirectory
        val gameDir = File(targetDirectory, gameName)
        if (gameDir.exists() && gameDir.isDirectory) {
            gameDir.deleteRecursively()
            scanGamesDirectory()
        } else {
            println("Game directory does not exist: $gameName")
        }
    }
}