import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.AlertDialog
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Text
import androidx.compose.material.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import com.arkivanov.decompose.DefaultComponentContext
import com.arkivanov.essenty.lifecycle.LifecycleRegistry
import com.sun.jna.Platform
import feature.root.component.DefaultRootComponent
import feature.root.ui.RootScreen
import ui.theme.VLauncherTheme
import utils.runOnUiThread
import java.awt.Dimension
import java.awt.Menu
import java.awt.MenuBar
import java.awt.image.ColorModel

fun main() {
    val lifecycle = LifecycleRegistry()

    AppContainer.gameBundleInteractor.initialize()

    val root = runOnUiThread {
        DefaultRootComponent(
            componentContext = DefaultComponentContext(
                lifecycle = lifecycle,
            )
        )
    }

    application {
        val windowState = rememberWindowState()
        var isCloseRequested by remember { mutableStateOf(false) }
        LaunchedEffect(Unit) {
            when {
                Platform.isWindows() -> {
//                    val hwnd: WinDef.HWND = User32.INSTANCE.GetForegroundWindow()
//                    val color = 0x121212 // Темно-серый цвет
//                    User32.INSTANCE.SetSysColors(1, intArrayOf(User32.COLOR_ACTIVECAPTION), intArrayOf(color))
                }

                Platform.isMac() -> {
//                    val nsApplication = NSApplication.INSTANCE
//                    val sharedApp = nsApplication.sharedApplication()
//                    sharedApp.setAppearance(NSAppearance.INSTANCE.appearanceNamed("NSAppearanceNameDarkAqua"))
                }

                else -> {
                }
            }
        }
        VLauncherTheme {
            Window(
                state = rememberWindowState(),
                onCloseRequest = ::exitApplication,
                title = "VLauncher",
            ) {
                window.minimumSize = Dimension(800, 600)
                window.background = java.awt.Color.BLACK
                val menu = MenuBar().apply { add(Menu()) }
                window.menuBar = menu

                RootScreen(root)
            }
        }
    }
}


@Composable
private fun ExitDialog(
    onExitApplication: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        buttons = {
            Row(
                modifier = Modifier.fillMaxWidth().padding(8.dp),
                horizontalArrangement = Arrangement.End,
            ) {
                TextButton(onClick = onDismiss) {
                    Text(text = "Отмена")
                }

                TextButton(onClick = onExitApplication) {
                    Text(text = "Выйи")
                }
            }
        },
        title = { Text(text = "Хуй") },
        text = { Text(text = "Хочешь себаса??") },
        modifier = Modifier.width(400.dp),
    )
}

//interface NSApplication : com.sun.jna.Library {
//    companion object {
//        val INSTANCE: NSApplication = Native.load("AppKit", NSApplication::class.java)
//    }
//
//    fun sharedApplication(): NSApplicationPointer
//}
//
//interface NSAppearance : com.sun.jna.Library {
//    companion object {
//        val INSTANCE: NSAppearance = Native.load("AppKit", NSAppearance::class.java)
//    }
//
//    fun appearanceNamed(name: String): Pointer
//}
//
//interface NSApplicationPointer : PointerType {
//    fun setAppearance(appearance: Pointer)
//}