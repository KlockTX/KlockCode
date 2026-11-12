# KlockCode README banner, drawn from scratch with GDI+ primitives.
# All content is ASCII on purpose: this file must stay readable under Windows PowerShell 5.1.
# Run after scripts/draw-brand-mark.mjs so resources/icon.png is the new mark.
#   powershell -ExecutionPolicy Bypass -File scripts/draw-brand-banner.ps1
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scripts
$iconPath = Join-Path $root 'resources\icon.png'
$outPath = Join-Path $root 'KlockCode.png'

$W = 1600
$H = 520
$amber = [System.Drawing.Color]::FromArgb(245, 185, 66)
$white = [System.Drawing.Color]::FromArgb(244, 248, 255)
$muted = [System.Drawing.Color]::FromArgb(168, 180, 200)

$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# Background: deep indigo diagonal wash, no texture / no external image.
$rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$wash = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(26, 37, 61),
    [System.Drawing.Color]::FromArgb(9, 13, 22),
    20)
$g.FillRectangle($wash, $rect)

# Faint engineering grid.
$gridPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(13, 255, 255, 255), 1)
for ($x = 0; $x -lt $W; $x += 32) { $g.DrawLine($gridPen, $x, 0, $x, $H) }
for ($y = 0; $y -lt $H; $y += 32) { $g.DrawLine($gridPen, 0, $y, $W, $y) }

# A little harness graph on the right: nodes + directed edges, echoing the editable architecture.
$edgePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(72, 245, 185, 66), 2)
$nodes = @(
    @(1230, 118), @(1392, 176), @(1510, 108),
    @(1310, 300), @(1468, 356), @(1540, 262),
    @(1240, 430)
)
$edges = @(@(0,1), @(1,2), @(0,3), @(1,4), @(2,5), @(3,4), @(4,5), @(3,6))
foreach ($e in $edges) {
    $a = $nodes[$e[0]]; $b = $nodes[$e[1]]
    $g.DrawLine($edgePen, $a[0], $a[1], $b[0], $b[1])
}
$nodeFill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26, 37, 61))
$nodePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, 245, 185, 66), 3)
foreach ($n in $nodes) {
    # Square nodes: keep the whole banner consistent with the pixel-art mark.
    $s = 24
    $g.FillRectangle($nodeFill, $n[0] - $s / 2, $n[1] - $s / 2, $s, $s)
    $g.DrawRectangle($nodePen, $n[0] - $s / 2, $n[1] - $s / 2, $s, $s)
}

# The mark, composited from the freshly drawn resources/icon.png.
$icon = [System.Drawing.Image]::FromFile($iconPath)
$g.DrawImage($icon, 80, 100, 320, 320)

# Wordmark: "Klock" in white, "Code" in amber.
$fontWord = New-Object System.Drawing.Font('Segoe UI', 100, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fontTag = New-Object System.Drawing.Font('Segoe UI', 29, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fontMeta = New-Object System.Drawing.Font('Consolas', 20, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$whiteBrush = New-Object System.Drawing.SolidBrush($white)
$amberBrush = New-Object System.Drawing.SolidBrush($amber)
$mutedBrush = New-Object System.Drawing.SolidBrush($muted)

$wordX = 434
$wordY = 146
$g.DrawString('Klock', $fontWord, $whiteBrush, $wordX, $wordY)
$klockW = $g.MeasureString('Klock', $fontWord).Width
$g.DrawString('Code', $fontWord, $amberBrush, $wordX + $klockW - 12, $wordY)

$accent = New-Object System.Drawing.SolidBrush($amber)
$g.FillRectangle($accent, $wordX + 2, 272, 96, 6)

$g.DrawString('A programming agent whose architecture you can tweak freely.', $fontTag, $mutedBrush, $wordX, 306)
$g.DrawString('Electron  |  React  |  Local HTTP/SSE kernel  |  GPL-3.0', $fontMeta, $mutedBrush, $wordX + 2, 366)

$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose(); $bmp.Dispose(); $icon.Dispose()
$wash.Dispose(); $gridPen.Dispose(); $edgePen.Dispose(); $nodePen.Dispose(); $nodeFill.Dispose()
$fontWord.Dispose(); $fontTag.Dispose(); $fontMeta.Dispose()
$whiteBrush.Dispose(); $amberBrush.Dispose(); $mutedBrush.Dispose(); $accent.Dispose()
Write-Output "[draw-brand-banner] $outPath ($W x $H)"
