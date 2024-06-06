import api.GithubApi
import api.repositories.GameRepository
import domain.GameBundleInteractor
import io.ktor.client.HttpClient
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

object AppContainer {
    private val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = true
        isLenient = true
    }

    private val httpClient: HttpClient by lazy {
        HttpClient {
            install(ContentNegotiation) {
                json(json)
            }
        }
    }

    private val gitHubApi: GithubApi by lazy {
        GithubApi(json, httpClient)
    }

    val gameRepository: GameRepository by lazy {
        GameRepository(
            httpClient = httpClient,
            githubApi = gitHubApi
        )
    }

    val gameBundleInteractor: GameBundleInteractor by lazy {
        GameBundleInteractor()
    }
}