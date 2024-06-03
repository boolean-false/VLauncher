package feature.add_release.domain

import AppContainer
import Settings
import domain.models.ReleaseInfo
import feature.add_release.domain.model.ReleaseForCurrentOS
import io.exoquery.fansi.Str
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import net.lingala.zip4j.ZipFile
import utils.SystemInfo
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption


class AddReleaseInteractor {
    private val gameRepository = AppContainer.gameRepository

    // Метод получения релиза для текущей ОС со ссылкой на скачивание
    suspend fun getReleasesForCurrentOS(): List<ReleaseForCurrentOS> {
        val currentOS = SystemInfo.current()
        val releaseList = gameRepository.getGameReleaseList()

        return releaseList.map { releaseGame ->
            val asset = releaseGame.assets.find { asset ->
                isValidContentType(asset.contentType, currentOS)
            }
            ReleaseForCurrentOS(
                id = releaseGame.id,
                version = releaseGame.name,
                downloadUrl = asset?.url
            )
        }
    }

    suspend fun installRelease(
        name: String,
        url: String,
        version: String,
        onProgress: (Float) -> Unit,
        onSuccess: () -> Unit
    ) {
        val targetDir = "${Settings.targetDirectory}/"
        val targetPath = targetDir + name
        // Качаем
        gameRepository.downloadAndSaveRelease(
            dirPath = targetDir,
            url = url,
            name = name,
            onProgress = { currentBytes, lengthBytes ->
                val progress = (currentBytes.toFloat() / lengthBytes) * 100
                onProgress(progress)
            },
        ) { outputPath ->
            // Мы типа скачали и нам нужно посмотреть че мы вообще скачали. Если это zip, РАСПАКОУКА
            if (outputPath.contains("zip")) {
                unzipRelease(
                    outputPath = outputPath,
                    targetPath = targetPath
                )

                saveBundleConfig(
                    version = version,
                    targetPath = targetPath,
                    executable = "VoxelEngine.exe"
                )

                onSuccess()
            }
        }
    }

    private fun isValidContentType(contentType: String, os: SystemInfo): Boolean {
        return when (os) {
            SystemInfo.WINDOWS -> contentType.contains("zip")
            SystemInfo.MACOS -> false
            SystemInfo.LINUX -> contentType.contains("appimage") || contentType.contains("octet-stream")
            SystemInfo.UNKNOWN -> false
        }
    }

    /**
     * Сохранения файла конфигурации сборки
     */
    private fun saveBundleConfig(
        version: String,
        targetPath: String,
        executable: String
    ) {
        val systemInfo = SystemInfo.current()

        val releaseInfo = ReleaseInfo(
            version = version,
            targetOS = systemInfo.identifier,
            executable = executable
        )

        val json = Json.encodeToString(releaseInfo)
        val infoFile = File(targetPath, "bundle.json")
        infoFile.writeText(json)
    }

    /**
     * Разархивирование zip сборки для Windows
     */
    private fun unzipRelease(
        outputPath: String,
        targetPath: String
    ) {
        val tempDir = File("temp")
        tempDir.mkdir()

        val archiveFile = File(outputPath)
        val outputDir = File(targetPath)
        outputDir.mkdirs()

        ZipFile(outputPath).extractAll(tempDir.absolutePath)

        tempDir.listFiles()?.firstOrNull()?.listFiles()?.forEach { file ->
            Files.move(
                file.toPath(),
                outputDir.toPath().resolve(file.name),
                StandardCopyOption.REPLACE_EXISTING
            )
        }

        tempDir.deleteRecursively()
        archiveFile.delete()
    }
}

