# Windows built-in OCR (Windows.Media.Ocr). Used by app.py to read PNG screenshots.
# Usage: powershell -File ocr_windows.ps1 <image path> <output json path>
# ASCII only (Windows PowerShell 5.1 reads scripts in the system code page).
param([string]$ImagePath, [string]$OutPath)
$ErrorActionPreference = 'Stop'
function Save($obj) { [IO.File]::WriteAllText($OutPath, ($obj | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding $false)) }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $null = $task.Wait(-1)
    return $task.Result
  }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'ja'))
  if ($null -eq $engine) { Save @{ error = 'nolang' }; exit 0 }
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($l in $result.Lines) {
    $words = @()
    foreach ($w in $l.Words) {
      $r = $w.BoundingRect
      $words += , @{ t = $w.Text; x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height }
    }
    $lines += , @{ words = $words }
  }
  Save @{ engine = 'windows'; width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; lines = $lines }
} catch {
  Save @{ error = $_.Exception.Message }
}
