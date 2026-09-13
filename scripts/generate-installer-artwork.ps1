Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $projectRoot "src-tauri\windows"
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$background = [System.Drawing.ColorTranslator]::FromHtml("#171b20")
$grid = [System.Drawing.ColorTranslator]::FromHtml("#27313a")
$line = [System.Drawing.ColorTranslator]::FromHtml("#35414c")
$tile = [System.Drawing.ColorTranslator]::FromHtml("#44484b")
$paper = [System.Drawing.ColorTranslator]::FromHtml("#e8e7e0")
$muted = [System.Drawing.ColorTranslator]::FromHtml("#aab2bc")

function New-Canvas([int]$width, [int]$height) {
    $bitmap = [System.Drawing.Bitmap]::new(
        $width,
        $height,
        [System.Drawing.Imaging.PixelFormat]::Format24bppRgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear($background)
    return $bitmap, $graphics
}

function Add-RoundedRectangle($graphics, $brush, [float]$x, [float]$y, [float]$size) {
    $radius = $size * 0.17
    $diameter = $radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
    $path.AddArc($x + $size - $diameter, $y, $diameter, $diameter, 270, 90)
    $path.AddArc($x + $size - $diameter, $y + $size - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($x, $y + $size - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    $graphics.FillPath($brush, $path)
    $path.Dispose()
}

function Convert-LogoPoints([float]$x, [float]$y, [float]$size, $points) {
    return [System.Drawing.PointF[]]@(
        $points | ForEach-Object {
            [System.Drawing.PointF]::new($x + $_[0] * $size / 1024, $y + $_[1] * $size / 1024)
        }
    )
}

function Add-Monogram($graphics, [float]$x, [float]$y, [float]$size) {
    $tileBrush = [System.Drawing.SolidBrush]::new($tile)
    $paperBrush = [System.Drawing.SolidBrush]::new($paper)
    Add-RoundedRectangle $graphics $tileBrush $x $y $size
    $v = Convert-LogoPoints $x $y $size @(
        @(144, 256), @(256, 256), @(360, 616), @(464, 256), @(576, 256),
        @(416, 768), @(304, 768)
    )
    $l = Convert-LogoPoints $x $y $size @(
        @(640, 256), @(744, 256), @(744, 664), @(880, 664), @(880, 768), @(640, 768)
    )
    $graphics.FillPolygon($paperBrush, $v)
    $graphics.FillPolygon($paperBrush, $l)
    $tileBrush.Dispose()
    $paperBrush.Dispose()
}

$header, $headerGraphics = New-Canvas 150 57
$gridPen = [System.Drawing.Pen]::new($grid)
$linePen = [System.Drawing.Pen]::new($line)
foreach ($x in 30, 60, 90, 120) { $headerGraphics.DrawLine($gridPen, $x, 0, $x, 57) }
$headerGraphics.DrawLine($linePen, 0, 28, 150, 28)
Add-Monogram $headerGraphics 100 8 41
$header.Save(
    (Join-Path $outputDirectory "installer-header.bmp"),
    [System.Drawing.Imaging.ImageFormat]::Bmp
)
$headerGraphics.Dispose()
$header.Dispose()

$sidebar, $sidebarGraphics = New-Canvas 164 314
foreach ($x in 20, 52, 84, 116, 148) { $sidebarGraphics.DrawLine($gridPen, $x, 0, $x, 314) }
foreach ($y in 32, 64, 96, 128, 160, 192, 224, 256, 288) {
    $sidebarGraphics.DrawLine($gridPen, 0, $y, 164, $y)
}
$accentPen = [System.Drawing.Pen]::new($paper, 2)
$sidebarGraphics.DrawLine($accentPen, 20, 0, 20, 314)
Add-Monogram $sidebarGraphics 42 89 100
$paperPen = [System.Drawing.Pen]::new($paper, 3)
$mutedPen = [System.Drawing.Pen]::new($muted, 2)
$sidebarGraphics.DrawLine($paperPen, 42, 215, 142, 215)
$sidebarGraphics.DrawLine($paperPen, 42, 224, 114, 224)
$sidebarGraphics.DrawLine($mutedPen, 42, 238, 90, 238)
$sidebar.Save(
    (Join-Path $outputDirectory "installer-sidebar.bmp"),
    [System.Drawing.Imaging.ImageFormat]::Bmp
)
$sidebarGraphics.Dispose()
$sidebar.Dispose()

$gridPen.Dispose()
$linePen.Dispose()
$accentPen.Dispose()
$paperPen.Dispose()
$mutedPen.Dispose()

Write-Output "Generated NSIS artwork in $outputDirectory"
