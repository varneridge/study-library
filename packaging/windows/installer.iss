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
; A second copy of Setup, such as one from a second press of Update now, refuses to start rather than installing over the first.
SetupMutex=StudyLibrarySetupMutex
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
; The in-app update (/UPDATE=1) closed Study Library, so it reopens it once every file is in place.
Filename: "{app}\{#AppExe}"; Flags: nowait runasoriginaluser; Check: IsInAppUpdate

[Code]
var
  DownloadPage: TDownloadWizardPage;
  UpdateFailure: String;
  SwappedAside: Boolean;
  UpdateFinished: Boolean;
  WaitsLeft: Integer;

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

{ ---- In-app update (/UPDATE=1), started by backend/study/update.py ---------------- }
const
  RuntimeParts = 3;
  AsideSuffix = '.old';
  WaitStepMs = 250;
  CloseWaitMs = 120000;

function IsInAppUpdate(): Boolean;
begin
  Result := ExpandConstant('{param:UPDATE|0}') = '1';
end;

function RuntimePart(Index: Integer): String;
begin
  case Index of
    0: Result := ExpandConstant('{app}\_internal');
    1: Result := ExpandConstant('{app}\vendor');
  else
    Result := ExpandConstant('{app}\{#AppExe}');
  end;
end;

function PartExists(const Path: String): Boolean;
begin
  Result := DirExists(Path) or FileExists(Path);
end;

procedure RemovePart(const Path: String);
begin
  if DirExists(Path) then
    DelTree(Path, True, True, True)
  else
    DeleteFile(Path);
end;

{ Renaming a folder fails while any process has a file inside it open, so a
  successful rename is both the proof that Study Library has fully exited and
  the backup that a failed update is restored from. }
function MoveAside(const Path: String): Boolean;
begin
  Result := not PartExists(Path);
  while not Result do begin
    Result := RenameFile(Path, Path + AsideSuffix);
    if Result or (WaitsLeft <= 0) then
      Exit;
    WaitsLeft := WaitsLeft - 1;
    Sleep(WaitStepMs);
  end;
end;

procedure PutRuntimeBack();
var
  I: Integer;
begin
  for I := 0 to RuntimeParts - 1 do
    if PartExists(RuntimePart(I) + AsideSuffix) then begin
      RemovePart(RuntimePart(I));
      RenameFile(RuntimePart(I) + AsideSuffix, RuntimePart(I));
    end;
end;

<event('PrepareToInstall')>
function UpdatePrepareToInstall(var NeedsRestart: Boolean): String;
var
  I, ResultCode: Integer;
begin
  Result := '';
  if not IsInAppUpdate() then
    Exit;
  for I := 0 to RuntimeParts - 1 do
    RemovePart(RuntimePart(I) + AsideSuffix);
  { Without /F, taskkill asks each Study Library window to close just as its
    close button does, so the app stops its own helper processes and nothing
    is killed in the middle of a write. }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM {#AppExe}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  WaitsLeft := CloseWaitMs div WaitStepMs;
  for I := 0 to RuntimeParts - 1 do
    if not MoveAside(RuntimePart(I)) then begin
      PutRuntimeBack();
      UpdateFailure := 'Study Library or one of its helper processes did not close within two minutes, so the update was not installed ' +
        'and nothing was changed. Restart Windows, open Study Library and then choose Update now again.';
      Result := UpdateFailure;
      Exit;
    end;
  SwappedAside := True;
end;

<event('CurStepChanged')>
procedure UpdateCurStepChanged(CurStep: TSetupStep);
var
  I: Integer;
begin
  if (CurStep <> ssPostInstall) or not SwappedAside then
    Exit;
  UpdateFinished := True;
  for I := 0 to RuntimeParts - 1 do
    RemovePart(RuntimePart(I) + AsideSuffix);
end;

<event('DeinitializeSetup')>
procedure UpdateDeinitializeSetup();
var
  ResultCode: Integer;
begin
  if not IsInAppUpdate() then
    Exit;
  if SwappedAside and not UpdateFinished then begin
    PutRuntimeBack();
    ExecAsOriginalUser(RuntimePart(2), '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
    UpdateFailure := 'The update did not finish, so the previous version of Study Library was put back as it was and has been opened again. ' +
      'The details are in ' + ExpandConstant('{log}') + '.';
  end;
  { MsgBox rather than SuppressibleMsgBox, because /SUPPRESSMSGBOXES would hide the only explanation the person gets. }
  if UpdateFailure <> '' then
    MsgBox(UpdateFailure, mbError, MB_OK);
end;
