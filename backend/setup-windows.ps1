# One-time set-up for running the processor natively on Windows, without WSL
# or Task Scheduler. Run it from this folder (backend) of your project with:
#   powershell -ExecutionPolicy Bypass -File setup-windows.ps1
# It can be run again at any time: each step skips what is already done.
#
# Everything goes under %LOCALAPPDATA%\StudyLibrary: a checkout of the
# production branch, the Python environment, Tesseract's languages, the
# Kokoro model and the logs. backend\study\desktop.py explains the layout.

[CmdletBinding()]
param(
    # The repository to clone. By default, the origin of the checkout this script is in.
    [string]$Repo = "",
    [string]$Branch = "production"
)

$ErrorActionPreference = "Stop"
# Invoke-WebRequest is many times slower while it draws its progress bar.
$ProgressPreference = "SilentlyContinue"

$StudyHome = Join-Path $env:LOCALAPPDATA "StudyLibrary"
$RepoDir = Join-Path $StudyHome "repo"
$Backend = Join-Path $RepoDir "backend"
$Venv = Join-Path $StudyHome ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"
$PythonW = Join-Path $Venv "Scripts\pythonw.exe"
$TessData = Join-Path $StudyHome "tessdata"
$Kokoro = Join-Path $StudyHome "models\kokoro"

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

function Refresh-Path {
    # Installers change PATH for new windows only; this window needs it now.
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
}

function Quietly([scriptblock]$Block) {
    # Windows PowerShell turns a native command's error output into a
    # terminating error under "Stop", even when it is thrown away.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Block 2>$null } finally { $ErrorActionPreference = $previous }
}

function Download($url, $target) {
    if (Test-Path $target) { return }
    Write-Host "Downloading $(Split-Path $target -Leaf)"
    $partial = "$target.part"
    Invoke-WebRequest -Uri $url -OutFile $partial -UseBasicParsing
    Move-Item -Force $partial $target
}

New-Item -ItemType Directory -Force -Path $StudyHome, (Join-Path $StudyHome "logs") | Out-Null

Step "Installing the tools with winget"
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget is missing. Install App Installer from the Microsoft Store, then run this again."
}
$packages = @(
    "Git.Git",
    "Python.Python.3.12",
    "UB-Mannheim.TesseractOCR",
    "ArtifexSoftware.GhostScript",
    "Gyan.FFmpeg",
    "TheDocumentFoundation.LibreOffice"
)
foreach ($id in $packages) {
    winget list --id $id --exact --accept-source-agreements | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "$id is already installed"
        continue
    }
    Write-Host "Installing $id"
    winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget could not install $id (exit code $LASTEXITCODE)" }
}
Refresh-Path

Step "Getting the code"
if (-not (Test-Path (Join-Path $RepoDir ".git"))) {
    if (-not $Repo) {
        $Repo = Quietly { git -C $PSScriptRoot remote get-url origin }
        if (-not $Repo) { throw "Pass the repository with -Repo, or run this from inside your project's checkout." }
    }
    # The processor follows the branch the Worker is deployed from, so it never
    # runs code that expects routes not yet deployed.
    git clone --branch $Branch $Repo $RepoDir
    if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
} else {
    Write-Host "Checkout already at $RepoDir"
}

Step "Settings"
$envFile = Join-Path $Backend ".env"
if (-not (Test-Path $envFile)) {
    $existing = Join-Path $PSScriptRoot ".env"
    if (Test-Path $existing) {
        Copy-Item $existing $envFile
        Write-Host "Copied your settings from $existing"
    } else {
        Copy-Item (Join-Path $Backend ".env.example") $envFile
        Write-Host "Fill in the settings in Notepad, save, and close it to carry on."
        Start-Process notepad.exe $envFile -Wait
    }
} else {
    Write-Host "Settings already at $envFile"
}

Step "Stopping Study Library if it is running"
# pip cannot replace a library a running process has loaded. A job cut short
# here is picked up again by the Worker's stale-job sweep.
Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" |
    Where-Object { $_.CommandLine -match "study\.desktop|study\.processor|backend\.tts\.server" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Step "Python environment"
if (-not (Test-Path $Python)) {
    if (Get-Command py -ErrorAction SilentlyContinue) { py -3.12 -m venv $Venv } else { python -m venv $Venv }
    if ($LASTEXITCODE -ne 0) { throw "could not create the Python environment" }
}
& $Python -m pip install --upgrade pip --quiet
& $Python -m pip install -r (Join-Path $Backend "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "pip could not install the requirements" }

Step "Tesseract languages"
# Readings come in English, French and German; osd turns sideways pages upright.
New-Item -ItemType Directory -Force -Path $TessData | Out-Null
foreach ($lang in "eng", "fra", "deu") {
    Download "https://github.com/tesseract-ocr/tessdata_fast/raw/main/$lang.traineddata" (Join-Path $TessData "$lang.traineddata")
}
Download "https://github.com/tesseract-ocr/tessdata/raw/main/osd.traineddata" (Join-Path $TessData "osd.traineddata")

Step "Kokoro speech model"
New-Item -ItemType Directory -Force -Path $Kokoro | Out-Null
$release = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
Download "$release/kokoro-v1.0.int8.onnx" (Join-Path $Kokoro "kokoro-v1.0.int8.onnx")
Download "$release/voices-v1.0.bin" (Join-Path $Kokoro "voices-v1.0.bin")

Step "Shortcuts"
$shell = New-Object -ComObject WScript.Shell
function Make-Shortcut($folder, $arguments) {
    $link = $shell.CreateShortcut((Join-Path $folder "Study Library.lnk"))
    $link.TargetPath = $PythonW
    $link.Arguments = $arguments
    $link.WorkingDirectory = $Backend
    $link.Description = "Study Library"
    $link.Save()
    Write-Host "Shortcut in $folder"
}
Make-Shortcut ([Environment]::GetFolderPath("Programs")) "-m study.desktop"
Make-Shortcut ([Environment]::GetFolderPath("Desktop")) "-m study.desktop"
# At sign-in, the processor and speech server start with no window.
Make-Shortcut ([Environment]::GetFolderPath("Startup")) "-m study.desktop --headless"

Step "Retiring the WSL processor"
$task = Get-ScheduledTask -TaskName "Study Library processor" -ErrorAction SilentlyContinue
if ($task) {
    try {
        Disable-ScheduledTask -TaskName "Study Library processor" | Out-Null
        Write-Host "Disabled the scheduled task. Delete it in Task Scheduler once you are happy."
    } catch {
        Write-Warning "Could not disable the scheduled task; disable it in Task Scheduler: $_"
    }
}
if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
    # Frees port 8765 and stops the old processor claiming jobs.
    Quietly { wsl.exe -d Ubuntu-24.04 -- pkill -f "study.processor|backend.tts.server" } | Out-Null
}

Step "Starting Study Library"
Start-Process -FilePath $PythonW -ArgumentList "-m", "study.desktop" -WorkingDirectory $Backend
Write-Host "Done. Logs are in $(Join-Path $StudyHome 'logs')."
