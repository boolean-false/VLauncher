package ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.Shapes
import androidx.compose.material.Typography
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

object DarkTheme : AppTheme {
    override val colors = AppColors(
        primary = Color(0xFFB0BEC5),
        primaryVariant = Color(0xFF37474F),
        secondary = Color(0xFF121212),
        secondaryVariant = Color(0xFF1B1B1B),
        background = Color(0xFF263238),
        surface = Color(0xFF121212),
        onPrimary = Color(0xFF263238),
        onSecondary = Color(0xFFFFFFFF),
        onBackground = Color(0xFFB0BEC5),
        onSurface = Color(0xFFB0BEC5),
    )

    override val typography = Typography(
        h1 = TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Bold,
            fontSize = 30.sp
        ),
        h2 = TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Bold,
            fontSize = 24.sp
        ),
        h3 = TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Bold,
            fontSize = 20.sp
        ),
        body1 = TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = 16.sp
        )
    )

    override val shapes = Shapes(
        small = RoundedCornerShape(4),
        medium = RoundedCornerShape(6),
        large = RoundedCornerShape(8)
    )
}
