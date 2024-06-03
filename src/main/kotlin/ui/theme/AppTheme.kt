package ui.theme

import androidx.compose.material.Shapes
import androidx.compose.material.Typography
import androidx.compose.ui.graphics.Color

interface AppTheme {
    val colors: AppColors
    val typography: Typography
    val shapes: Shapes
}

data class AppColors(
    val primary: Color,
    val primaryVariant: Color,
    val secondary: Color,
    val background: Color,
    val surface: Color,
    val onPrimary: Color,
    val onSecondary: Color,
    val onBackground: Color,
    val onSurface: Color,
    val secondaryVariant: Color
)