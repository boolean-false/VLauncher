package feature.add_release.component

import AppContainer
import com.arkivanov.decompose.ComponentContext
import com.boolfalse.rickandmorty.utils.state.SharedEventFlow
import feature.add_release.domain.AddReleaseInteractor
import feature.add_release.ui.model.AddReleaseUiAction
import feature.add_release.ui.model.AddReleaseUiState
import feature.add_release.ui.model.AddReleaseUiStateAssembler
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import utils.decompose.CoroutineComponent
import utils.decompose.CoroutineComponentImpl
import utils.decompose.launchSafe
import utils.state.StateStore
import java.lang.Exception

class DefaultAddReleaseComponent(
    val componentContext: ComponentContext
) : AddReleaseComponent,
    ComponentContext by componentContext,
    CoroutineComponent by CoroutineComponentImpl(componentContext) {
    private val addReleaseInteractor = AddReleaseInteractor()


    private val uiStateAssembler = AddReleaseUiStateAssembler()
    private val stateStore = StateStore(AddReleaseVmState.initial())

    override val uiAction = SharedEventFlow<AddReleaseUiAction>()
    override val uiState = stateStore.stateFlow
        .map(uiStateAssembler::assembleUiState)
        .stateIn(
            scope = scope,
            started = SharingStarted.Eagerly,
            initialValue = AddReleaseUiState.initial()
        )

    init {
        loadReleaseList()
    }

    private fun loadReleaseList() {
        launchSafe(errorHandler = ::handleError) {
            val releaseList = addReleaseInteractor.getReleasesForCurrentOS()
            val selectedRelease = releaseList.firstOrNull { it.downloadUrl != null }

            stateStore.updateState {
                it.copy(
                    selectedReleaseId = selectedRelease?.id,
                    releaseList = releaseList,
                    isLoading = false
                )
            }
        }
    }


    override fun onApply() {
        // Попробуем скачать
        val currentRelease = stateStore.value.releaseList.firstOrNull {
            it.id == stateStore.value.selectedReleaseId
        }

        if (currentRelease?.downloadUrl == null) return

        stateStore.updateState {
            it.copy(
                downloadProgress = 0f
            )
        }


        launchSafe(errorHandler = ::handleError) {
            println(currentRelease.downloadUrl)
            addReleaseInteractor.installRelease(
                name = stateStore.value.name,
                version = currentRelease.version,
                url = currentRelease.downloadUrl,
                onProgress = { downloadingProgress ->
                    val progress = if (downloadingProgress == 100f) null else downloadingProgress
                    stateStore.updateState {
                        it.copy(
                            downloadProgress = progress
                        )
                    }
                }
            ) {
               AppContainer.gameBundleInteractor.initialize()
                emitUiAction(AddReleaseUiAction.Back)
            }
        }
    }

    override fun emitUiAction(action: AddReleaseUiAction) {
        scope.launch {
            uiAction.emit(action)
        }
    }

    override fun changeName(newVal: String) {
        stateStore.updateState {
            it.copy(
                name = newVal
            )
        }
    }

    override fun changeRelease(releaseId: Long) {
        stateStore.updateState {
            it.copy(
                selectedReleaseId = releaseId
            )
        }
    }

    private fun handleError(exception: Exception) {
        println("Exception: ${exception.message}")
    }
}