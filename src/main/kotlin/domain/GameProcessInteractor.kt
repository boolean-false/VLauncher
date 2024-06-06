package domain

import Settings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import utils.SystemInfo
import java.io.File
import java.util.concurrent.TimeUnit


/**
 * Интерактор запуска игры
 */
class GameProcessInteractor(
    private val gameName: String
) {
    private val _logs = MutableStateFlow<List<String>>(emptyList())
    val logs: StateFlow<List<String>> = _logs.asStateFlow()

    private val _isRunning = MutableStateFlow(false)
    val isRunning: StateFlow<Boolean> = _isRunning.asStateFlow()

    private var job: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var process: Process? = null


    fun runGame(
        executable: String,
        timeoutAmount: Long = 60,
        timeoutUnit: TimeUnit = TimeUnit.SECONDS,
    ) {
        job?.cancel()
        job = scope.launch {
            _isRunning.value = true
            val gamePath = "${Settings.targetDirectory}/$gameName"
            val gameDir = File(gamePath)

            val executableFile = File(gameDir, executable)
            if (!gameDir.exists() || !gameDir.isDirectory) {
                throw IllegalArgumentException("Game directory does not exist: $gamePath")
            }
            if (!executableFile.exists()) {
                throw IllegalArgumentException("Executable file does not exist or is not executable: ${executableFile.absolutePath}")
            }

            val processBuilder = when (SystemInfo.current()) {
                SystemInfo.WINDOWS -> {
                    ProcessBuilder(executableFile.absolutePath).directory(gameDir)
                }

                SystemInfo.MACOS -> {
                    val command = listOf("./${executableFile.name}")
                    ProcessBuilder(command).directory(gameDir)
                }

                SystemInfo.LINUX -> {
                    val command = listOf(executableFile.absolutePath, "--dir", gameDir.absolutePath)
                    executableFile.setExecutable(true)
                    ProcessBuilder(command).directory(gameDir)
                }

                else -> throw UnsupportedOperationException("Unsupported operating system")
            }

            runCatching {
                process = processBuilder
                    .redirectErrorStream(true)
                    .start()

                val reader = process!!.inputStream.bufferedReader()

                try {
                    var line: String?
                    while (process!!.isAlive) {
                        line = reader.readLine()
                        if (line != null) {
                            _logs.update { currentLogs -> currentLogs + line!! }
                        }
                    }

                    while (reader.readLine().also { line = it } != null) {
                        _logs.update { currentLogs -> currentLogs + (line ?: "") }
                    }
                } catch (e: Exception) {
                    println(e)
                } finally {
                    reader.close()
                    _isRunning.value = false
                }

                if (!process!!.waitFor(timeoutAmount, timeoutUnit)) {
                    process!!.destroy()
                    throw RuntimeException("Game process timeout")
                }
            }.onFailure {
                it.printStackTrace()
                _logs.update { currentLogs -> currentLogs + "Error: ${it.message}" }
                _isRunning.value = false
            }
        }
    }

    fun stopGame() {
        process?.destroy()
        job?.cancel()
        _isRunning.value = false
    }

    fun clearLogs() {
        _logs.value = emptyList()
    }
}