param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\assets")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing.Common

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null

function New-RoundedRectanglePath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $diameter = $radius * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-IconPng([int]$size) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $inset = [Math]::Max(1, $size * 0.035)
  $extent = $size - ($inset * 2)
  $radius = $size * 0.215
  $shape = New-RoundedRectanglePath $inset $inset $extent $extent $radius
  $gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.PointF]::new(0, 0),
    [System.Drawing.PointF]::new($size, $size),
    [System.Drawing.Color]::FromArgb(255, 79, 111, 240),
    [System.Drawing.Color]::FromArgb(255, 32, 67, 190)
  )
  $graphics.FillPath($gradient, $shape)

  $highlight = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.PointF]::new(0, 0),
    [System.Drawing.PointF]::new(0, $size),
    [System.Drawing.Color]::FromArgb(52, 255, 255, 255),
    [System.Drawing.Color]::FromArgb(0, 255, 255, 255)
  )
  $graphics.FillPath($highlight, $shape)

  $fontSize = $size * 0.31
  $font = [System.Drawing.Font]::new("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $format = [System.Drawing.StringFormat]::new()
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $graphics.DrawString("CG", $font, [System.Drawing.Brushes]::White, [System.Drawing.RectangleF]::new(0, -($size * 0.012), $size, $size), $format)

  $stream = [System.IO.MemoryStream]::new()
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $stream.ToArray()

  $stream.Dispose()
  $format.Dispose()
  $font.Dispose()
  $highlight.Dispose()
  $gradient.Dispose()
  $shape.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
  Write-Output -NoEnumerate $bytes
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = [System.Collections.Generic.List[byte[]]]::new()
foreach ($size in $sizes) {
  $images.Add((New-IconPng $size))
}
[System.IO.File]::WriteAllBytes((Join-Path $resolvedOutput "app-icon.png"), $images[-1])

$iconPath = Join-Path $resolvedOutput "app-icon.ico"
$file = [System.IO.File]::Create($iconPath)
$writer = [System.IO.BinaryWriter]::new($file)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$sizes.Count)
$offset = 6 + (16 * $sizes.Count)
for ($index = 0; $index -lt $sizes.Count; $index++) {
  $size = $sizes[$index]
  $image = $images[$index]
  $writer.Write([byte]($(if ($size -eq 256) { 0 } else { $size })))
  $writer.Write([byte]($(if ($size -eq 256) { 0 } else { $size })))
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]32)
  $writer.Write([uint32]$image.Length)
  $writer.Write([uint32]$offset)
  $offset += $image.Length
}
foreach ($image in $images) {
  $writer.Write($image)
}
$writer.Dispose()
$file.Dispose()

Write-Host "Generated app icons in $resolvedOutput"
