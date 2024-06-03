package api

import api.models.release.ReleaseGameApiModel
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

class GithubApi(
    private val client: HttpClient
) {
    suspend fun getReleases(repository: String): List<ReleaseGameApiModel> {
        return client.get("https://api.github.com/repos/$repository/releases").body()
    }
}