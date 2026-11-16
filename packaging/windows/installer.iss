; Study Library installer (Inno Setup 6.3 or later).
; build.ps1 compiles this with /DAppVersion, /DNumericVersion, /DSourceDir and
; /DOutputDir, and writes generated\files.iss and generated\code.iss first.
; Installs per user into %LOCALAPPDATA%\Programs\StudyLibrary, so no administrator
; prompt is needed; user data lives separately in %LOCALAPPDATA%\StudyLibrary.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef NumericVersion
  #define NumericVersion "0.0.0.0"
#endif
#ifndef SourceDir
  #error SourceDir must point at the PyInstaller onedir output (build\windows\pyi-dist\StudyLibrary)
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist"
#endif
#define AppName "Study Library"
#define AppExe "StudyLibrary.exe"

[Setup]
; Never change AppId: it is how upgrades find the existing installation.
AppId={{8E1B2F0C-6A4D-4C8E-9F3B-2D7A5C1E4B90}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Study Library
VersionInfoVersion={#NumericVersion}
DefaultDirName={autopf}\StudyLibrary
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename=StudyLibrarySetup
Compression=lzma2/max
SolidCompression=yes
LZMANumBlockThreads=4
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
#if FileExists(AddBackslash(SourcePath) + "studylibrary.ico")
SetupIconFile=studylibrary.ico
#endif

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "libreoffice"; Description: "Install LibreOffice so Word and PowerPoint files can be imported (about 350 MB; Windows will ask for permission)"; GroupDescription: "Optional components:"; Flags: unchecked; Check: NeedsLibreOffice

[InstallDelete]
; Remove the previous runtime first so that modules deleted between versions cannot linger.
Type: filesandordirs; Name: "{app}\_internal"
Type: filesandordirs; Name: "{app}\vendor"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
#include "generated\files.iss"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{localappdata}\Microsoft\WindowsApps\winget.exe"; Parameters: "install --id TheDocumentFoundation.LibreOffice --exact --silent --accept-package-agreements --accept-source-agreements"; StatusMsg: "Installing LibreOffice. This can take several minutes and Windows may ask for permission..."; Tasks: libreoffice; Flags: runhidden waituntilterminated
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
var
  DownloadPage: TDownloadWizardPage;

#include "generated\code.iss"

function DataRoot(): String;
begin
  Result := ExpandConstant('{localappdata}\StudyLibrary');
end;

function NeedsLibreOffice(): Boolean;
begin
  Result := (not FileExists(ExpandConstant('{commonpf64}\LibreOffice\program\soffice.exe')))
    and (not FileExists(ExpandConstant('{commonpf32}\LibreOffice\program\soffice.exe')))
    and FileExists(ExpandConstant('{localappdata}\Microsoft\WindowsApps\winget.exe'));
end;

function OnDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  if (ProgressMax > 0) and (Progress = ProgressMax) then
    Log(Format('Downloaded %s', [FileName]));
  Result := True;
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage('Downloading voice models', 'Study Library is downloading its text-to-speech voices (about 350 MB).', @OnDownloadProgress);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Reason: String;
begin
  Result := True;
  if (CurPageID <> wpReady) or (ExpandConstant('{param:SKIPMODELS|0}') = '1') then
    Exit;
  DownloadPage.Clear;
  if AddModelDownloads(DownloadPage) = 0 then
    Exit;
  DownloadPage.Show;
  try
    try
      DownloadPage.Download;
    except
      if DownloadPage.AbortedByUser then
        Reason := 'it was cancelled'
      else
        Reason := GetExceptionMessage;
      Result := SuppressibleMsgBox('The voice model download did not finish because ' + Reason + '. ' +
        'Do you want to continue without it? Study Library will download the voices automatically the first time it starts.',
        mbConfirmation, MB_YESNO, IDYES) = IDYES;
    end;
  finally
    DownloadPage.Hide;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and DirExists(DataRoot()) then
    if SuppressibleMsgBox('Do you also want to delete your Study Library data, settings and downloaded voices in ' + DataRoot() + '? ' +
      'Choose No to keep them for a future reinstall.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
      DelTree(DataRoot(), True, True, True);
end;
