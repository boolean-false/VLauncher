package ui.component.app_bar

import androidx.compose.desktop.ui.tooling.preview.Preview
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.Icon
import androidx.compose.material.IconButton
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Surface
import androidx.compose.material.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ui.theme.VLauncherTheme

@Composable
fun AppBarWidget(
    title: String,
    onBackClick: (() -> Unit)? = null,
    endContent: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
    ) {
        if (onBackClick != null) {
            IconButton(
                modifier = Modifier
                    .size(28.dp),
                onClick = { onBackClick() },
            ) {
                Icon(Icons.Default.ArrowBack, contentDescription = "")
            }

            Spacer(
                modifier = Modifier
                    .width(16.dp)
            )
        }

        Text(
            text = title,
            style = MaterialTheme.typography.h5,
            color = MaterialTheme.colors.onSurface
        )

        Spacer(modifier = Modifier.weight(1f))

        if (endContent != null) {
            endContent()
        }
    }
}

@Preview
@Composable
private fun PreviewAppBarWidget() {
    VLauncherTheme {
        Surface {
            Column(
                modifier = Modifier
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                AppBarWidget(
                    title = "Аппбар1",
                    onBackClick = {}
                )
            }
        }
    }
}