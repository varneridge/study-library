# Starts the Study Library processor and local TTS speech server in WSL.
# Ensures Google Drive is running, mounts G: in WSL, and runs the processor.

$projectScript = "G:\My Drive\Antigravity\study-library\backend\run-processor.sh"

# 1. Ensure Google Drive is running and G: drive is ready
if (-not (Test-Path $projectScript)) {
    $proc = Get-Process -Name "GoogleDriveFS" -ErrorAction SilentlyContinue
    if (-not $proc) {
        $launcher = "C:\Program Files\Google\Drive File Stream\launch.bat"
        if (Test-Path $launcher) {
            Start-Process -FilePath $launcher -WindowStyle Hidden
        }
    }
    $timeout = 90
    while (-not (Test-Path $projectScript) -and $timeout -gt 0) {
        Start-Sleep -Seconds 2
        $timeout -= 2
    }
}

if (-not (Test-Path $projectScript)) {
    Write-Error "Google Drive G: could not be reached after waiting."
    exit 1
}

# 2. Ensure WSL mounts /mnt/g
wsl.exe -d Ubuntu-24.04 -u root -- bash -c "mountpoint -q /mnt/g || mount -t drvfs G: /mnt/g"

# 3. Run the processor script from G: drive
wsl.exe -d Ubuntu-24.04 -- bash "/mnt/g/My Drive/Antigravity/study-library/backend/run-processor.sh"
