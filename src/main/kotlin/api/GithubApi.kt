package api

import api.models.release.ReleaseGameApiModel
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import java.net.http.HttpResponse

class GithubApi(
    private val json: Json,
    private val client: HttpClient
) {
    suspend fun getReleases(repository: String): List<ReleaseGameApiModel> {
        val response = client.get("https://api.github.com/repos/$repository/releases")
        val responseBody: String = response.bodyAsText()
        val jsonElement = json.parseToJsonElement(responseBody)
        if (jsonElement !is kotlinx.serialization.json.JsonArray) {
            throw IllegalArgumentException("Ожидался JSON массив, но получен: ${jsonElement::class.simpleName}")
        }
        return json.decodeFromString(responseBody)
    }
}