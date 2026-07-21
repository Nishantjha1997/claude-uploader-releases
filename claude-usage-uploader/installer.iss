; Claude Usage Uploader — Windows Installer
; Build: iscc installer.iss  (requires Inno Setup 6.x)
; Before building, make sure both files exist in this directory:
;   ClaudeUsageUploader.exe
;   service-account-key.json

#define AppName      "Claude Usage Uploader"
#define AppVersion   "2.0.4"
#define AppPublisher "Sigma Solve"
#define AppExeName   "ClaudeUsageUploader_v2.0.4-win-x64.exe"
#define AppKeyFile   "service-account-key.json"

[Setup]
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppId={{B7E2F1A3-4C8D-4E5F-9A2B-3D6E7F8A9B0C}
DefaultDirName={localappdata}\SigmaSolve\ClaudeUsageUploader
DefaultGroupName={#AppName}
OutputDir=dist
OutputBaseFilename=ClaudeUsageUploaderSetup-v{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=lowest
SetupLogging=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
english.WelcomeLabel2=This will install [name/ver] on your computer.%n%nThis tool silently collects Claude AI usage metrics and uploads them to Google Drive every Monday.%n%nClick Next to continue.

[Files]
; The service key remains an external IT-managed file and is copied by the
; setup code. It is never embedded into the distributable installer.
Source: "{#AppExeName}";  DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}";           Filename: "{app}\{#AppExeName}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

[Run]
; Optional: launch setup immediately after install (user enters their name)
Filename: "{app}\{#AppExeName}"; \
  Description: "Run first-time setup now (enter your name)"; \
  Flags: postinstall nowait skipifsilent unchecked

[UninstallRun]
; Remove the Windows Scheduled Task on uninstall
Filename: "schtasks.exe"; \
  Parameters: "/delete /tn ""ClaudeUsageUploader"" /f"; \
  Flags: runhidden; \
  RunOnceId: "RemoveScheduledTask"
Filename: "schtasks.exe"; \
  Parameters: "/delete /tn ""ClaudeUsageUploaderHealth"" /f"; \
  Flags: runhidden; \
  RunOnceId: "RemoveHealthScheduledTask"

[Code]
// -----------------------------------------------------------------------
// Pre-install check: key file must sit next to the installer
// -----------------------------------------------------------------------
function InitializeSetup(): Boolean;
var
  KeyPath: String;
begin
  Result := True;
  KeyPath := ExpandConstant('{src}\{#AppKeyFile}');
  if not FileExists(KeyPath) then
  begin
    MsgBox(
      '{#AppKeyFile} was not found next to the installer.' + #13#10 +
      #13#10 +
      'Place service-account-key.json beside ClaudeUsageUploaderSetup-v{#AppVersion}.exe' + #13#10 +
      'and run the installer again.',
      mbError, MB_OK
    );
    Result := False;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  SourceKey, DestinationKey: String;
begin
  if CurStep = ssPostInstall then
  begin
    SourceKey := ExpandConstant('{src}\{#AppKeyFile}');
    DestinationKey := ExpandConstant('{app}\{#AppKeyFile}');
    if not FileCopy(SourceKey, DestinationKey, False) then
      RaiseException('Could not copy the service credential into the install directory.');
  end;
end;

// -----------------------------------------------------------------------
// Post-uninstall cleanup: remove config folder from %APPDATA%
// -----------------------------------------------------------------------
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ConfigDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    ConfigDir := ExpandConstant('{userappdata}\ClaudeUsageUploader');
    if DirExists(ConfigDir) then
      DelTree(ConfigDir, True, True, True);
  end;
end;
