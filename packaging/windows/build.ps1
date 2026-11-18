<#
.SYNOPSIS
  Builds dist\StudyLibrarySetup.exe for Study Library, optionally verifies and publishes it.

.DESCRIPTION
  Runs unchanged on Windows PowerShell 5.1 and PowerShell 7. Steps, in order:
    1. Create build\windows\venv with 64-bit Python and install the app plus PyInstaller.
    2. Run the packaging unit tests (skip with -SkipTests).
    3. Download, hash-check and extract FFmpeg, Tesseract and Ghostscript (build_helpers.py fetch).
    4. Build the onedir app with PyInstaller and copy the vendor tools beside StudyLibrary.exe.
    5. Refuse to continue if any .env file or secret value made it into the output.
    6. Optionally Authenticode-sign, then compile installer.iss with Inno Setup.
    7. With -Verify: silently install into build\windows\verify, run the installed exe's
       self-test through pytest, then uninstall.
    8. With -Publish: upload to Cloudflare R2, versioned object first and latest.json last.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\windows\build.ps1 -Verify
#>
[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$PythonExe = "",
    [switch]$PinHashes,
    [switch]$Verify,
    [switch]$Publish,
    [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Here = $PSScriptRoot
$Root = (Resolve-Path (Join-Path $Here "..\..")).Path
$Build = Join-Path $Root "build\windows"
$Dist = Join-Path $Root "dist"
$Venv = Join-Path $Build "venv"
$Py = Join-Path $Venv "Scripts\python.exe"
$Helpers = Join-Path $Here "build_helpers.py"
$AppOut = Join-Path $Build "pyi-dist\StudyLibrary"
$Setup = Join-Path $Dist "StudyLibrarySetup.exe"

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FilePath $($Arguments -join ' ') exited with code $LASTEXITCODE" }
}

function Find-Executable([string[]]$Candidates, [string]$WingetId, [string]$ChocoId) {
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    $name = Split-Path $Candidates[0] -Leaf
    $onPath = Get-Command $name -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
        Write-Step "Installing $WingetId with winget"
        & winget.exe install --id $WingetId --exact --silent --accept-package-agreements --accept-source-agreements | Out-Host
    } elseif (Get-Command choco.exe -ErrorAction SilentlyContinue) {
        Write-Step "Installing $ChocoId with Chocolatey"
        & choco.exe install $ChocoId -y --no-progress | Out-Host
    }
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    throw "$name was not found and could not be installed automatically; install $WingetId and retry"
}

function Resolve-BasePython {
    if ($PythonExe) { return $PythonExe }
    if (Get-Command uv.exe -ErrorAction SilentlyContinue) {
        foreach ($minor in @("3.12", "3.11", "")) {
            try {
                $exe = if ($minor) { & uv.exe python find $minor 2>$null } else { & uv.exe python find 2>$null }
                if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path $exe.Trim())) { return $exe.Trim() }
            } catch { }
        }
    }
    if (Get-Command py.exe -ErrorAction SilentlyContinue) {
        foreach ($minor in @("3.12", "3.11")) {
            try {
                $exe = & py.exe "-$minor" -c "import sys; print(sys.executable)" 2>$null
                if ($LASTEXITCODE -eq 0 -and $exe) { return ($exe | Select-Object -First 1).Trim() }
            } catch { }
        }
    }
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($python) { return $python.Source }
    throw "64-bit Python 3.11 or 3.12 is required: winget install --id Python.Python.3.12 -e"
}

function Install-Dependencies {
    if (-not (Test-Path $Py)) {
        Write-Step "Creating build virtual environment"
        Invoke-Native (Resolve-BasePython) @("-m", "venv", $Venv)
    }
    Invoke-Native $Py @("-c", "import struct, sys; assert struct.calcsize('P') == 8, 'need 64-bit Python'; assert sys.version_info >= (3, 10), 'need Python 3.10+'")
    Invoke-Native $Py @("-m", "pip", "install", "--disable-pip-version-check", "--quiet", "--upgrade", "pip")
    $installed = $false
    foreach ($rel in @("backend\requirements.txt", "requirements.txt")) {
        $req = Join-Path $Root $rel
        if (Test-Path $req) { Invoke-Native $Py @("-m", "pip", "install", "--quiet", "-r", $req); $installed = $true; break }
    }
    if (-not $installed) {
        foreach ($rel in @("backend", ".")) {
            if (Test-Path (Join-Path $Root "$rel\pyproject.toml")) {
                Invoke-Native $Py @("-m", "pip", "install", "--quiet", (Join-Path $Root $rel)); $installed = $true; break
            }
        }
    }
    if (-not $installed) { throw "No backend\requirements.txt, requirements.txt or pyproject.toml found" }
    Invoke-Native $Py @("-m", "pip", "install", "--quiet", "pyinstaller==6.11.1", "pytest==8.3.3")
}

function Get-AppVersion {
    if ($Version) { return $Version }
    try {
        $tag = & git -C $Root describe --tags --abbrev=0 2>$null
        if ($LASTEXITCODE -eq 0 -and $tag) { return ($tag | Select-Object -First 1).Trim().TrimStart("v") }
    } catch { }
    return "0.1.0"
}

function Invoke-Sign([string]$Path) {
    if (-not $env:SL_SIGN_PFX) { return }
    $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $signtool) { throw "SL_SIGN_PFX is set but signtool.exe was not found (install the Windows SDK)" }
    Invoke-Native $signtool.FullName @("sign", "/f", $env:SL_SIGN_PFX, "/p", $env:SL_SIGN_PASSWORD, "/fd", "sha256",
        "/tr", "http://timestamp.digicert.com", "/td", "sha256", $Path)
}

function Invoke-Verification {
    Write-Step "Verifying the installer with a silent install"
    $verifyRoot = Join-Path $Build "verify"
    if (Test-Path $verifyRoot) { Remove-Item $verifyRoot -Recurse -Force }
    $appDir = Join-Path $verifyRoot "app"
    New-Item -ItemType Directory -Force $verifyRoot | Out-Null
    $installArgs = @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/SKIPMODELS=1",
        "/MERGETASKS=`"!desktopicon,!libreoffice`"", "/DIR=`"$appDir`"", "/LOG=`"$verifyRoot\install.log`"")
    $proc = Start-Process -FilePath $Setup -ArgumentList $installArgs -Wait -PassThru
    if ($proc.ExitCode -ne 0) { throw "Silent install failed with exit code $($proc.ExitCode); see $verifyRoot\install.log" }
    $exe = Join-Path $appDir "StudyLibrary.exe"
    try {
        $env:SL_INSTALLED_EXE = $exe
        Invoke-Native $Py @("-m", "pytest", "-q", (Join-Path $Root "tests\packaging\test_installed_exe.py"))
        # Install the same build again exactly as backend/study/update.py does, which exercises the swap,
        # the clean-up and the relaunch; the relaunched copy gets a scratch home so it cannot touch real data.
        Write-Step "Verifying the in-place update and relaunch"
        $env:STUDY_HOME = Join-Path $verifyRoot "home"
        $updateArgs = @("/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/NOCLOSEAPPLICATIONS", "/SKIPMODELS=1",
            "/MERGETASKS=`"!libreoffice`"", "/UPDATE=1", "/LOG=`"$verifyRoot\update.log`"")
        $proc = Start-Process -FilePath $Setup -ArgumentList $updateArgs -Wait -PassThru
        if ($proc.ExitCode -ne 0) { throw "In-place update failed with exit code $($proc.ExitCode); see $verifyRoot\update.log" }
        if (Get-ChildItem $appDir -Filter "*.old") { throw "The in-place update left *.old copies in $appDir" }
        $deadline = (Get-Date).AddSeconds(30)
        do {
            $relaunched = @(Get-Process StudyLibrary -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir\*" })
            if ($relaunched.Count -eq 0) { Start-Sleep -Seconds 1 }
        } while (($relaunched.Count -eq 0) -and ((Get-Date) -lt $deadline))
        if ($relaunched.Count -eq 0) { throw "The in-place update did not reopen Study Library" }
        $relaunched | Stop-Process -Force
        Start-Sleep -Seconds 2
        Get-Process StudyLibrary -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir\*" } | Stop-Process -Force
        Invoke-Native $Py @("-m", "pytest", "-q", (Join-Path $Root "tests\packaging\test_installed_exe.py"))
    } finally {
        Remove-Item Env:SL_INSTALLED_EXE -ErrorAction SilentlyContinue
        Remove-Item Env:STUDY_HOME -ErrorAction SilentlyContinue
        $uninstaller = Join-Path $appDir "unins000.exe"
        if (Test-Path $uninstaller) {
            Start-Process -FilePath $uninstaller -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART") -Wait | Out-Null
            # The uninstaller relaunches itself from %TEMP% and returns early, so wait for the files to go.
            $deadline = (Get-Date).AddSeconds(120)
            while ((Test-Path $exe) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Seconds 1 }
            if (Test-Path $exe) { throw "Uninstall did not remove $exe" }
        }
    }
}

function Publish-ToR2([string]$AppVersion) {
    foreach ($name in @("R2_ACCOUNT_ID", "R2_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")) {
        if (-not (Test-Path "Env:$name")) { throw "-Publish needs the $name environment variable" }
    }
    $aws = (Get-Command aws -ErrorAction SilentlyContinue)
    if (-not $aws) { throw "-Publish needs the AWS CLI: winget install --id Amazon.AWSCLI -e" }
    # Recent AWS CLI releases send checksum headers that R2 can reject; only send them when required.
    $env:AWS_REQUEST_CHECKSUM_CALCULATION = "when_required"
    $env:AWS_RESPONSE_CHECKSUM_VALIDATION = "when_required"
    $endpoint = "https://$($env:R2_ACCOUNT_ID).r2.cloudflarestorage.com"
    $bucket = "s3://$($env:R2_BUCKET)"
    $sha = (Get-FileHash -Algorithm SHA256 $Setup).Hash.ToLower()
    $key = "releases/$AppVersion/StudyLibrarySetup.exe"
    $common = @("--endpoint-url", $endpoint, "--region", "auto")
    Write-Step "Uploading $key"
    Invoke-Native $aws.Source (@("s3", "cp", $Setup, "$bucket/$key", "--content-type", "application/vnd.microsoft.portable-executable",
        "--content-disposition", "attachment; filename=StudyLibrarySetup.exe", "--cache-control", "public, max-age=31536000, immutable") + $common)
    Invoke-Native $aws.Source (@("s3", "cp", "$Setup.sha256", "$bucket/$key.sha256", "--content-type", "text/plain") + $common)
    Invoke-Native $aws.Source (@("s3", "cp", "$bucket/$key", "$bucket/latest/StudyLibrarySetup.exe", "--content-disposition",
        "attachment; filename=StudyLibrarySetup.exe", "--content-type", "application/vnd.microsoft.portable-executable",
        "--metadata-directive", "REPLACE", "--cache-control", "no-cache") + $common)
    $latest = Join-Path $Build "latest.json"
    @{ version = $AppVersion; url = $key; sha256 = $sha } | ConvertTo-Json | Set-Content -Path $latest -Encoding ASCII
    Invoke-Native $aws.Source (@("s3", "cp", $latest, "$bucket/latest.json", "--content-type", "application/json", "--cache-control", "no-cache") + $common)
}

# ------------------------------------------------------------------------------------------ main
$AppVersion = Get-AppVersion
New-Item -ItemType Directory -Force $Build, $Dist | Out-Null
Install-Dependencies
$NumericVersion = (& $Py $Helpers numeric-version $AppVersion | Select-Object -First 1).Trim()
Write-Step "Building Study Library $AppVersion ($NumericVersion)"

if (-not $SkipTests) {
    Write-Step "Running packaging unit tests"
    Invoke-Native $Py @("-m", "pytest", "-q", (Join-Path $Root "tests\packaging"))
}

$SevenZip = Find-Executable @("$env:ProgramFiles\7-Zip\7z.exe") "7zip.7zip" "7zip"
$fetchArgs = @($Helpers, "fetch", "--cache", (Join-Path $Build "cache"), "--vendor", (Join-Path $Build "vendor"),
    "--seven-zip", $SevenZip, "--system-dir", (Join-Path $env:SystemRoot "System32"))
if ($PinHashes) { $fetchArgs += @("--pin", "--verify-assets") }
Write-Step "Fetching bundled tools"
Invoke-Native $Py $fetchArgs
Invoke-Native $Py @($Helpers, "gen-inno")
$Template = Join-Path $Build "env.template"
Invoke-Native $Py @($Helpers, "env-template", "--root", $Root, "--out", $Template)

Write-Step "Running PyInstaller"
$env:SL_ENV_TEMPLATE = $Template
$workPath = Join-Path $env:TEMP "study-library-pyi-work"
Invoke-Native $Py @("-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", (Join-Path $Build "pyi-dist"),
    "--workpath", $workPath, (Join-Path $Here "studylibrary.spec"))
Copy-Item -Path (Join-Path $Build "vendor") -Destination (Join-Path $AppOut "vendor") -Recurse -Force
Invoke-Native $Py @($Helpers, "scan", "--dist", $AppOut)
Invoke-Sign (Join-Path $AppOut "StudyLibrary.exe")

Write-Step "Compiling the installer"
$Iscc = Find-Executable @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") "JRSoftware.InnoSetup" "innosetup"
Invoke-Native $Iscc @("/Q", "/DAppVersion=$AppVersion", "/DNumericVersion=$NumericVersion", "/DSourceDir=$AppOut",
    "/DOutputDir=$Dist", (Join-Path $Here "installer.iss"))
Invoke-Sign $Setup
$Hash = (Get-FileHash -Algorithm SHA256 $Setup).Hash.ToLower()
Set-Content -Path "$Setup.sha256" -Value "$Hash  StudyLibrarySetup.exe" -Encoding ASCII
Write-Step "Built $Setup ($([math]::Round((Get-Item $Setup).Length / 1MB)) MB, sha256 $Hash)"

if ($Verify) { Invoke-Verification }
if ($Publish) { Publish-ToR2 $AppVersion }
Write-Step "Done"
