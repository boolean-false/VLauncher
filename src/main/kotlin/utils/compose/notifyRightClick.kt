package utils.compose

import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.isSecondaryPressed
import androidx.compose.ui.input.pointer.pointerInput
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive

fun Modifier.notifyRightClick(block: () -> Unit): Modifier =
    composed {
        val blockState = rememberUpdatedState(block)

        pointerInput(Unit) {
            while (currentCoroutineContext().isActive) {
                awaitPointerEventScope {
                    val event = awaitPointerEvent(PointerEventPass.Initial)

                    if (event.buttons.isSecondaryPressed) {
                        blockState.value()
                    }
                }
            }
        }
    }