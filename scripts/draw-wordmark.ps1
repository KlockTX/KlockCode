# KlockCode wordmark, drawn from GDI+ glyph paths so it stays crisp at any size.
# Two colorways, same geometry: white on dark titlebar, near-black on light titlebar.
# All content is ASCII on purpose: this file must stay readable under Windows PowerShell 5.1.
#   powershell -ExecutionPolicy Bypass -File scripts/draw-wordmark.ps1
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scripts
$assets = Join-Path $root 'desktop\src\assets'

# Palette shared with scripts/draw-brand-banner.ps1 -- one brand, one set of values.
$white = [System.Drawing.Color]::FromArgb(244, 248, 255)
$amber = [System.Drawing.Color]::FromArgb(245, 185, 66)
$ink = [System.Drawing.Color]::FromArgb(11, 15, 24)
$mutedDark = [System.Drawing.Color]::FromArgb(139, 151, 173)   # brackets on dark titlebar
$mutedLight = [System.Drawing.Color]::FromArgb(107, 114, 128)  # brackets on light titlebar
$amberDeep = [System.Drawing.Color]::FromArgb(160, 90, 10)     # amber pushed to orange, 5.3:1 on white

$famName = 'Segoe UI'
$BOLD = 1
$TARGET_H = 377
$PAD = 3
$BRACKET_GAP = 0.05   # em units between a bracket and the word

$family = New-Object System.Drawing.FontFamily($famName)
$fmt = [System.Drawing.StringFormat]::GenericTypographic

# MeasureString needs a Graphics; a 1x1 probe is enough to read advance widths.
$probeBmp = New-Object System.Drawing.Bitmap(1, 1)
$gm = [System.Drawing.Graphics]::FromImage($probeBmp)
$gm.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

function Get-Advance([string]$text, [float]$em) {
    $f = New-Object System.Drawing.Font($family, $em, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $w = $gm.MeasureString($text, $f, [System.Drawing.PointF]::Empty, $fmt).Width
    $f.Dispose()
    return $w
}

function New-TextPath([string]$text, [float]$em) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddString($text, $family, $BOLD, $em, (New-Object System.Drawing.PointF(0, 0)), $fmt)
    return $p
}

# Move a run so its ink (not its advance box) starts at $x -- Segoe UI's angle
# brackets carry huge sidebearings, and advance-based layout leaves dead gaps.
function Set-InkLeft([System.Drawing.Drawing2D.GraphicsPath]$path, [float]$x) {
    $b = $path.GetBounds()
    $m = New-Object System.Drawing.Drawing2D.Matrix
    $m.Translate($x - $b.X, 0)
    $path.Transform($m)
    $m.Dispose()
}

function Get-Union([object[]]$paths) {
    $u = $paths[0].Clone()
    for ($i = 1; $i -lt $paths.Count; $i++) { $u.AddPath($paths[$i], $false) }
    return $u
}

# Lay out "<KlockCode/>" at a given em size.
# Returns the three paths plus the x where "Code" begins, so the word can be split into two colours.
function Get-Layout([float]$em) {
    $gap = $em * $BRACKET_GAP

    $lt = New-TextPath '<' $em
    Set-InkLeft $lt 0

    # The word is one run: native advance widths, so the k/C junction is typeset correctly.
    $word = New-TextPath 'KlockCode' $em
    $wordX = $lt.GetBounds().Right + $gap
    $wordLeft = $word.GetBounds().X
    Set-InkLeft $word $wordX

    # Seam sits at the "Klock" advance, which lands in the empty sidebearing gap before "C".
    $splitX = $wordX + (Get-Advance 'Klock' $em) - $wordLeft

    $slash = New-TextPath '/>' $em
    Set-InkLeft $slash ($word.GetBounds().Right + $gap)

    return @{ lt = $lt; word = $word; slash = $slash; splitX = $splitX }
}

# Pass 1: probe at a fixed em to learn the ink aspect, then solve for the exact height.
$PROBE = 500.0
$probeLay = Get-Layout $PROBE
$probeUnion = Get-Union @($probeLay.lt, $probeLay.word, $probeLay.slash)
$probeBox = $probeUnion.GetBounds()
$em = $PROBE * (($TARGET_H - 2 * $PAD) / $probeBox.Height)

# Pass 2: rebuild at the solved size (no transform scaling, so anti-aliasing stays clean).
$lay = Get-Layout $em
$union = Get-Union @($lay.lt, $lay.word, $lay.slash)
$box = $union.GetBounds()

$W = [int][Math]::Ceiling($box.Width) + 2 * $PAD
$H = [int][Math]::Ceiling($box.Height) + 2 * $PAD

$variants = @(
    @{ file = 'wordmark.png'; bracket = $mutedDark; word = $white; tail = $amber },
    @{ file = 'wordmark-black.png'; bracket = $mutedLight; word = $ink; tail = $amberDeep }
)

foreach ($v in $variants) {
    $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    # Ink box -> canvas: one translate, then fill every run in place.
    $g.TranslateTransform(-$box.X + $PAD, -$box.Y + $PAD)

    $brBracket = New-Object System.Drawing.SolidBrush($v.bracket)
    $brWord = New-Object System.Drawing.SolidBrush($v.word)
    $brTail = New-Object System.Drawing.SolidBrush($v.tail)

    $g.FillPath($brBracket, $lay.lt)
    $g.FillPath($brBracket, $lay.slash)

    # Two-tone word: fill the same path twice against complementary clip rects.
    $tall = [float]($H * 4)
    $leftRect = New-Object System.Drawing.RectangleF((-2 * $tall), (-$tall), ($lay.splitX + 2 * $tall), (2 * $tall))
    $rightRect = New-Object System.Drawing.RectangleF($lay.splitX, (-$tall), (2 * $tall), (2 * $tall))

    $g.SetClip($leftRect, [System.Drawing.Drawing2D.CombineMode]::Replace)
    $g.FillPath($brWord, $lay.word)
    $g.SetClip($rightRect, [System.Drawing.Drawing2D.CombineMode]::Replace)
    $g.FillPath($brTail, $lay.word)
    $g.ResetClip()

    $out = Join-Path $assets $v.file
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ("{0}  {1}x{2}" -f $v.file, $W, $H)

    $brBracket.Dispose(); $brWord.Dispose(); $brTail.Dispose()
    $g.Dispose(); $bmp.Dispose()
}

foreach ($k in 'lt', 'word', 'slash') { $lay[$k].Dispose(); $probeLay[$k].Dispose() }
$union.Dispose(); $probeUnion.Dispose()
$gm.Dispose(); $probeBmp.Dispose()
$family.Dispose()
