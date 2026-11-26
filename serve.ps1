param(
  [int]$Port = 8080
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Add-Type -AssemblyName System.Net.HttpListener -ErrorAction SilentlyContinue

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$Port/"

$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".ico"  = "image/x-icon"
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
      if ($path -eq "/") { $path = "/index.html" }
      $filePath = Join-Path $root ($path.TrimStart("/"))
      $filePath = [System.IO.Path]::GetFullPath($filePath)

      if (-not $filePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        $res.StatusCode = 403
      } elseif (-not (Test-Path $filePath -PathType Leaf)) {
        $res.StatusCode = 404
        $bytes = [Text.Encoding]::UTF8.GetBytes("Not found: $path")
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $ext = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
        $ct = $mime[$ext]
        if (-not $ct) { $ct = "application/octet-stream" }
        $res.ContentType = $ct
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    } catch {
      $res.StatusCode = 500
    } finally {
      $res.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
}
