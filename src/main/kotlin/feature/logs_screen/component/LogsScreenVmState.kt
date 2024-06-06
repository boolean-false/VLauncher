package feature.logs_screen.component

data class LogsScreenVmState(
    val gameName: String
) {
    companion object {
        fun initial() = LogsScreenVmState(
            gameName = ""
        )
    }
}