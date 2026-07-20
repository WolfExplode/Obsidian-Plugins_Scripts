# Launches Obsidian with the Chrome DevTools Protocol port open (for the
# obsidian-devtools MCP server / console debugging). If Obsidian is already
# running, it is fully quit first so the debug flag actually takes effect.

$ExePath = "C:\Program Files\Obsidian\Obsidian.exe"
$Port    = 9222

if (-not (Test-Path $ExePath)) {
    Write-Host "Obsidian.exe not found at $ExePath" -ForegroundColor Red
    Write-Host "Update `$ExePath in this script to your install location." -ForegroundColor Yellow
    exit 1
}

# Quit any running instance so the flag applies on next launch.
$running = Get-Process Obsidian -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "Closing running Obsidian ($($running.Count) processes)..." -ForegroundColor Cyan
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

Write-Host "Launching Obsidian with --remote-debugging-port=$Port ..." -ForegroundColor Cyan
Start-Process -FilePath $ExePath -ArgumentList "--remote-debugging-port=$Port"

# Wait for the CDP endpoint to come up.
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Invoke-RestMethod -Uri "http://localhost:$Port/json" -TimeoutSec 2
        $ok = $true
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}

if ($ok) {
    Write-Host "DevTools port $Port is LIVE ($($r.Count) targets)." -ForegroundColor Green
    Write-Host "Verify: http://localhost:$Port/json" -ForegroundColor DarkGray
} else {
    Write-Host "Port $Port did not come up within 30s. Check that Obsidian started." -ForegroundColor Red
    exit 1
}
