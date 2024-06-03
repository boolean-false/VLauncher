package api.repositories

import api.GithubApi
import api.models.release.toDomain
import domain.models.ReleaseGame
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.onDownload
import io.ktor.client.request.get
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

class GameRepository(
    private val httpClient: HttpClient,
    private val githubApi: GithubApi
) {
    private companion object {
        private const val GITHUB_REPO = "MihailRis/VoxelEngine-Cpp"
    }

    suspend fun getGameReleaseList(): List<ReleaseGame> {
        return githubApi.getReleases(GITHUB_REPO).map { it.toDomain() }
    }

    suspend fun downloadAndSaveRelease(
        dirPath: String,
        url: String,
        name: String,
        onProgress: (bytesSentTotal: Long, contentLength: Long) -> Unit,
        onSuccess: (outputPath: String) -> Unit
    ) {
        val ext = url.split(".").last()
        val file = File("${dirPath}$name.$ext")
        file.parentFile.mkdirs()

        withContext(Dispatchers.IO) {
            val httpResponse = httpClient.get(url) {
                onDownload { bytesSentTotal, contentLength ->
                    onProgress(bytesSentTotal, contentLength)
                }
            }
            val responseBody: ByteArray = httpResponse.body()
            file.writeBytes(responseBody)
            onSuccess(file.path)
        }
    }
}