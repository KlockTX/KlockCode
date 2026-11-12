# Benchmark figure, redrawn from the published numbers (no upstream artwork).
# ASCII-only on purpose so it stays readable under Windows PowerShell 5.1.
#   scripts/draw-benchmark-chart.ps1
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scripts
$outPath = Join-Path $root 'assets\benchmark-token-cache.png'

$W = 1400
$H = 620
$amber = [System.Drawing.Color]::FromArgb(245, 185, 66)
$white = [System.Drawing.Color]::FromArgb(244, 248, 255)
$muted = [System.Drawing.Color]::FromArgb(160, 174, 196)
$barGrey = [System.Drawing.Color]::FromArgb(84, 98, 122)
$panel = [System.Drawing.Color]::FromArgb(20, 28, 46)

$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$wash = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(26, 37, 61),
    [System.Drawing.Color]::FromArgb(9, 13, 22),
    20)
$g.FillRectangle($wash, $rect)
$gridPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(11, 255, 255, 255), 1)
for ($x = 0; $x -lt $W; $x += 32) { $g.DrawLine($gridPen, $x, 0, $x, $H) }
for ($y = 0; $y -lt $H; $y += 32) { $g.DrawLine($gridPen, 0, $y, $W, $y) }

$fontTitle = New-Object System.Drawing.Font('Segoe UI', 38, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fontHead = New-Object System.Drawing.Font('Segoe UI', 24, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fontVal = New-Object System.Drawing.Font('Consolas', 16, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fontLabel = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fontMeta = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$whiteBrush = New-Object System.Drawing.SolidBrush($white)
$amberBrush = New-Object System.Drawing.SolidBrush($amber)
$mutedBrush = New-Object System.Drawing.SolidBrush($muted)
$greyBrush = New-Object System.Drawing.SolidBrush($barGrey)
$panelBrush = New-Object System.Drawing.SolidBrush($panel)

$g.DrawString('Front-end + back-end bug fix | Agent comparison', $fontTitle, $whiteBrush, 56, 34)
$g.DrawString('Same model: DeepSeek-V4.1-Flash-1017 | Max effort | 1M context | non-authoritative, for reference only', $fontMeta, $mutedBrush, 58, 88)

$panelY = 140
$panelH = 420
$g.FillRectangle($panelBrush, 48, $panelY, 660, $panelH)
$g.FillRectangle($panelBrush, 724, $panelY, 628, $panelH)

$g.DrawString('Total tokens (lower is better)', $fontHead, $whiteBrush, 72, $panelY + 20)
$g.DrawString('Cache hit rate (higher is better)', $fontHead, $whiteBrush, 748, $panelY + 20)

# Left: total tokens. MeowCode is the upstream this fork derives from -> amber.
$tokenValues = @('13,257,143', '9,850,167', '8,046,746', '6,353,363', '5,123,379', '4,133,876')
$tokenLabels = @('DeepSeek', 'ZCode', 'OpenCode', 'WorkBuddy', 'MeowCode', 'Codex')
$tokenHeights = @(240, 178, 146, 115, 93, 75)
# Right: cache hit rates, highlighted bar is the upstream one (98.67%).
$cacheValues = @('98.75%', '98.67%', '98.66%', '98.65%', '98.49%', '98.25%')
$cacheLabels = @('ZCode', 'MeowCode', 'WorkBuddy', 'OpenCode', 'DeepSeek', 'Codex')
$cacheHeights = @(220, 219, 218, 217, 214, 210)

$barW = 64
$baseline = $panelY + 330

function Draw-Bars($values, $labels, $heights, $x0, $gap, $highlightIndex) {
    for ($i = 0; $i -lt $values.Count; $i++) {
        $x = $x0 + $i * $gap
        $h = $heights[$i]
        $brush = if ($i -eq $highlightIndex) { $amberBrush } else { $greyBrush }
        $g.FillRectangle($brush, $x, $baseline - $h, $barW, $h)
        $v = $values[$i]
        $g.DrawString($v, $fontVal, $whiteBrush, $x - 12, $baseline - $h - 32)
        $l = $labels[$i]
        $g.DrawString($l, $fontLabel, $mutedBrush, $x - 10, $baseline + 14)
    }
}
Draw-Bars $tokenValues $tokenLabels $tokenHeights 84 104 4
Draw-Bars $cacheValues $cacheLabels $cacheHeights 756 98 1

$amberLine = New-Object System.Drawing.SolidBrush($amber)
$g.FillRectangle($amberLine, 48, $panelY + $panelH - 12, 1304, 4)

$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $wash.Dispose(); $gridPen.Dispose()
$fontTitle.Dispose(); $fontHead.Dispose(); $fontVal.Dispose(); $fontLabel.Dispose(); $fontMeta.Dispose()
$whiteBrush.Dispose(); $amberBrush.Dispose(); $mutedBrush.Dispose(); $greyBrush.Dispose(); $panelBrush.Dispose(); $amberLine.Dispose()
Write-Output "[draw-benchmark-chart] $outPath ($W x $H)"
