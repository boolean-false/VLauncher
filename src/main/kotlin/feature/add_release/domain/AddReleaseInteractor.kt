package feature.add_release.domain

import AppContainer
import Settings
import domain.models.ReleaseInfo
import feature.add_release.domain.model.ReleaseForCurrentOS
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import net.lingala.zip4j.ZipFile
import utils.SystemInfo
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.TimeUnit


class AddReleaseInteractor {
    private val gameRepository = AppContainer.gameRepository

    // Метод получения релиза для текущей ОС со ссылкой на скачивание
    suspend fun getReleasesForCurrentOS(): List<ReleaseForCurrentOS> {
        val currentOS = SystemInfo.current()
        val releaseList = gameRepository.getGameReleaseList()

        return releaseList.map { releaseGame ->
            println(releaseGame.assets)
            val asset = releaseGame.assets.find { asset ->
                isValidContentType(asset.url, asset.contentType, currentOS)
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

            if (outputPath.contains("dmg")) {
                extractDmgRelease(
                    dmgPath = outputPath,
                    targetPath = targetPath
                )

                saveBundleConfig(
                    version = version,
                    targetPath = targetPath,
                    executable = "VoxelEngine"
                )

                onSuccess()
            }

            // Appimage
            if (outputPath.contains("AppImage")) {
                processAppImage(
                    appImagePath = outputPath,
                    targetPath = targetPath
                )

                saveBundleConfig(
                    version = version,
                    targetPath = targetPath,
                    executable = "VoxelEngine.AppImage"
                )

                onSuccess()

            }
        }
    }

    private fun isValidContentType(url: String, contentType: String, os: SystemInfo): Boolean {
        return when (os) {
            SystemInfo.WINDOWS -> contentType.contains("zip") && url.contains("voxelengine")
            SystemInfo.MACOS -> contentType.contains("apple")
            SystemInfo.LINUX -> contentType.contains("octet-stream")
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


    private fun extractDmgRelease(
        dmgPath: String,
        targetPath: String
    ) {
        val tempMountPoint = File("/Volumes/tempMount")

        if (!tempMountPoint.exists()) {
            tempMountPoint.mkdir()
        }

        val outputDir = File(targetPath)
        outputDir.mkdirs()

        // Монтируем DMG файл
        val mountProcess = ProcessBuilder("hdiutil", "attach", dmgPath, "-mountpoint", tempMountPoint.absolutePath).start()
        if (!mountProcess.waitFor(60, TimeUnit.SECONDS)) {
            mountProcess.destroy()
            throw RuntimeException("Mounting DMG process timeout")
        }

        val mountOutput = mountProcess.inputStream.bufferedReader().readText()
        val mountError = mountProcess.errorStream.bufferedReader().readText()
        if (mountProcess.exitValue() != 0) {
            throw RuntimeException("Error mounting DMG: $mountError")
        }
        println(mountOutput)

        // Копируем файлы из смонтированного образа в целевую директорию
        try {
            copyDirectoryRecursively(tempMountPoint, outputDir)
        } catch (e: Exception) {
            throw RuntimeException("Error copying files: ${e.message}")
        } finally {
            // Размонтируем DMG файл
            val unmountProcess = ProcessBuilder("hdiutil", "detach", tempMountPoint.absolutePath).start()
            if (!unmountProcess.waitFor(60, TimeUnit.SECONDS)) {
//                unmountProcess.destroy()
                throw RuntimeException("Unmounting DMG process timeout")
            }

            val unmountOutput = unmountProcess.inputStream.bufferedReader().readText()
            val unmountError = unmountProcess.errorStream.bufferedReader().readText()

            File(dmgPath).delete()

            if (unmountProcess.exitValue() != 0) {
                throw RuntimeException("Error unmounting DMG: $unmountError")
            }
//            println(unmountOutput)
        }
    }

    private fun processAppImage(
        appImagePath: String,
        targetPath: String
    ) {
        val appImageFile = File(appImagePath)
        val outputDir = File(targetPath)
        val content = File(outputDir, "content")

        if (!outputDir.exists()) {
            outputDir.mkdirs()
        }
        if (!content.exists()) {
            content.mkdirs()
        }

        val targetAppImageFile = File(outputDir, "VoxelEngine.AppImage")
        appImageFile.copyTo(targetAppImageFile, overwrite = true)
        appImageFile.delete()
    }

    private fun copyDirectoryRecursively(source: File, target: File) {
        if (source.isDirectory) {
            if (!target.exists()) {
                target.mkdirs()
            }
            source.listFiles()?.forEach { file ->
                copyDirectoryRecursively(file, File(target, file.name))
            }
        } else {
            Files.copy(source.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }
}

