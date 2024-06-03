import java.io.File
import java.util.prefs.Preferences

object Settings {
    private const val KEY_TARGET_DIR = "targetDirectory"
    private val prefs: Preferences = Preferences.userRoot().node(this.javaClass.name)
    private val defaultDirectory = File("instances").absolutePath

    var targetDirectory: String
        get() = prefs.get(KEY_TARGET_DIR, defaultDirectory).also {
            val file = File(it)
            if (!file.exists()) {
                file.mkdirs()
            }
        }
        set(value) = prefs.put(KEY_TARGET_DIR, value)
}