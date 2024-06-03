package utils.decompose

import kotlinx.coroutines.CoroutineScope

interface CoroutineComponent {
    val scope: CoroutineScope
}
