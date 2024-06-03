package ui.theme

import androidx.compose.material.Colors
import androidx.compose.material.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

val LocalAppTheme = staticCompositionLocalOf<AppTheme> { error("No theme provided") }

@Composable
fun VLauncherTheme(
    appTheme: AppTheme = DarkTheme,
    content: @Composable () -> Unit
) {
    CompositionLocalProvider(LocalAppTheme provides appTheme) {
        MaterialTheme(
            colors = Colors(
                primary = appTheme.colors.primary,
                primaryVariant = appTheme.colors.primaryVariant,
                secondary = appTheme.colors.secondary,
                background = appTheme.colors.background,
                surface = appTheme.colors.surface,
                onPrimary = appTheme.colors.onPrimary,
                onSecondary = appTheme.colors.onSecondary,
                onBackground = appTheme.colors.onBackground,
                onSurface = appTheme.colors.onSurface,
                secondaryVariant = appTheme.colors.secondaryVariant,
                error = Color.Red,
                onError = Color.White,
                isLight = false,
            ),
            typography = appTheme.typography,
            shapes = appTheme.shapes,
            content = content
        )
    }
}