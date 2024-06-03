package utils

private const val WINDOWS_IDENT = "windows"
private const val MACOS_IDENT = "macos"
private const val LINUX_IDENT = "linux"
private const val UNKNOWN_IDENT = "unknown"

enum class SystemInfo(val identifier: String) {
    WINDOWS(WINDOWS_IDENT),
    MACOS(MACOS_IDENT),
    LINUX(LINUX_IDENT),
    UNKNOWN(UNKNOWN_IDENT);

    companion object {
        fun current(): SystemInfo {
            val osName = System.getProperty("os.name").lowercase()
            return when {
                osName.contains("win") -> WINDOWS
                osName.contains("mac") -> MACOS
                osName.contains("nix") || osName.contains("nux") || osName.contains("aix") -> LINUX
                else -> UNKNOWN
            }
        }

        fun fromString(value: String): SystemInfo {
            return when (value) {
                WINDOWS_IDENT -> WINDOWS
                MACOS_IDENT -> MACOS
                LINUX_IDENT -> LINUX
                else -> UNKNOWN
            }
        }
    }
}