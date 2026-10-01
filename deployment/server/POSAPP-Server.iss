#define AppName "POSAPP Server"
#ifndef AppVersion
  #define AppVersion "1.0.9"
#endif
#define AppId "{{E99DB275-DDA0-43A0-95CD-7AE07185122C}"
#ifndef StageRoot
  #define StageRoot "..\out\stage"
#endif
#ifndef InstallerOutputDir
  #define InstallerOutputDir "..\out"
#endif
#ifdef UpdateOnly
  #ifdef RuntimeUpdate
    #define StageDir StageRoot + "\server-update-runtime"
    #define OutputName "POSAPP-Server-Runtime-Update"
    #define UpdateMode "RuntimeTransition"
  #else
    #define StageDir StageRoot + "\server-update-core"
    #define OutputName "POSAPP-Server-Update"
    #define UpdateMode "Core"
  #endif
#else
  #define StageDir StageRoot + "\server"
  #define OutputName "POSAPP-Server-Setup"
#endif
[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={autopf}\POSApp
DefaultGroupName=POSAPP
PrivilegesRequired=admin
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.17763
DisableProgramGroupPage=yes
DisableDirPage=yes
OutputDir={#InstallerOutputDir}
OutputBaseFilename={#OutputName}
Compression=lzma2/max
SolidCompression=yes
SetupMutex=POSAPP-Server-Installer,Global\POSAPP-Server-Installer
#ifdef UpdateOnly
CreateAppDir=no
Uninstallable=no
AllowCancelDuringInstall=no
#else
Uninstallable=yes
#endif
[Files]
#ifdef UpdateOnly
Source: "{#StageDir}\*"; DestDir: "{tmp}\posapp-update-payload"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\windows\Update-PosServer.ps1"; DestDir: "{tmp}"; Flags: ignoreversion
Source: "..\windows\InstallerUpdateState.ps1"; DestDir: "{tmp}"; Flags: ignoreversion
Source: "..\windows\ServerLayerState.ps1"; DestDir: "{tmp}"; Flags: ignoreversion
#else
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\windows\Install-PosServer.ps1"; DestDir: "{app}\deployment\windows"; Flags: ignoreversion
Source: "..\windows\ServerLayerState.ps1"; DestDir: "{app}\deployment\windows"; Flags: ignoreversion
Source: "..\windows\Repair-PosStartup.ps1"; DestDir: "{app}\deployment\windows"; Flags: ignoreversion
Source: "..\windows\Remove-PosRuntime.ps1"; DestDir: "{app}\deployment\windows"; Flags: ignoreversion
Source: "..\windows\Get-PortStatus.ps1"; DestDir: "{tmp}"; Flags: dontcopy
#endif
[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\deployment\windows\Remove-PosRuntime.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "RemovePosRuntime"
[UninstallDelete]
Type: filesandordirs; Name: "{app}"
Type: files; Name: "{commondesktop}\POS App.url"
Type: files; Name: "{commondesktop}\POS Database Admin.url"
[Code]
var RestaurantPage: TInputQueryWizardPage; PortsPage: TInputQueryWizardPage; PosPort, DatabasePort, PhpMyAdminPort: Integer;
#ifdef UpdateOnly
var UpdatePage: TInputOptionWizardPage; UpdateProgressPage: TOutputProgressWizardPage; AcceptUpdate: string;
#endif
function InitializeSetup(): Boolean;
var Version: TWindowsVersion;
begin
  Result := True;
#ifdef UpdateOnly
  AcceptUpdate := ExpandConstant('{param:ACCEPTUPDATE|0}');
  if WizardSilent and (AcceptUpdate <> '1') then begin
    Result := False;
    exit;
  end;
#endif
  GetWindowsVersionEx(Version);
  if Version.ProductType <> VER_NT_WORKSTATION then begin
    MsgBox('POSAPP supports Windows 10/11 workstation editions on native x64 only. Windows Server is not supported.', mbError, MB_OK);
    Result := False;
  end;
end;
function JsonEscape(Value: string): string;
begin
  StringChangeEx(Value, '\', '\\', True); StringChangeEx(Value, '"', '\"', True); StringChangeEx(Value, #13, '\r', True); StringChangeEx(Value, #10, '\n', True); StringChangeEx(Value, #9, '\t', True); Result := Value;
end;
#ifdef UpdateOnly
function IsSafeUpdateDetail(Value: string): Boolean;
begin
  Result := Value = '';
  if Result then exit;
  if (Pos('/', Value) = 1) or (Pos('\', Value) = 1) or (Pos(':', Value) > 0) or (Pos('..', Value) > 0) or (Pos(#13, Value) > 0) or (Pos(#10, Value) > 0) then begin
    Result := False;
    exit;
  end;
  Result := True;
end;
procedure UpdateProgressLog(const S: String; const Error, FirstLine: Boolean);
var Fields: TArrayOfString; Step, StepTotal, Completed, Total: Integer;
begin
  if Error or WizardSilent then begin Log(S); exit; end;
  if Copy(S, 1, Length('POSAPP_PROGRESS|')) <> 'POSAPP_PROGRESS|' then begin Log(S); exit; end;
  Fields := StringSplit(S, ['|'], stAll);
  if GetArrayLength(Fields) <> 7 then begin Log(S); exit; end;
  Step := StrToIntDef(Fields[1], 0); StepTotal := StrToIntDef(Fields[2], 0); Completed := StrToIntDef(Fields[3], -1); Total := StrToIntDef(Fields[4], -1);
  if (Step < 1) or (StepTotal < 1) or (Completed < 0) or (Total < 0) or ((Total > 0) and (Completed > Total)) then begin Log(S); exit; end;
  if not IsSafeUpdateDetail(Fields[6]) then begin Log(S); exit; end;
  UpdateProgressPage.SetText('Step ' + IntToStr(Step) + ' of ' + IntToStr(StepTotal) + ' — ' + Fields[5], Fields[6]);
  if Total > 0 then UpdateProgressPage.SetProgress(Completed, Total)
  else UpdateProgressPage.SetProgress(0, 0);
  WizardForm.Refresh;
end;
#endif
procedure InitializeWizard;
begin
#ifdef UpdateOnly
  #ifdef RuntimeUpdate
  UpdatePage := CreateInputOptionPage(wpWelcome, 'Transition POSAPP Server runtime', 'Review the packaged runtime transition', 'This explicit transition replaces Node dependencies together with application files. Existing data, ports, services and secrets remain in place.', False, False);
  #else
  UpdatePage := CreateInputOptionPage(wpWelcome, 'Update POSAPP Server', 'Review the packaged update', 'This fast update changes application files and approved additive migrations only. Verified Node dependencies remain in place.', False, False);
  #endif
  UpdatePage.Add('I understand that this update requires a valid packaged POSAPP installation and a database backup.');
  UpdatePage.Add('Installed version is older than target version {#AppVersion}.');
  UpdateProgressPage := CreateOutputProgressPage('Updating POSAPP Server', 'Applying the packaged update.');
  if WizardSilent and (AcceptUpdate = '1') then begin
    UpdatePage.Values[0] := True;
    UpdatePage.Values[1] := True;
  end;
#else
  RestaurantPage := CreateInputQueryPage(wpWelcome, 'Restaurant name', 'Identify this POS installation', 'This is stored as installation metadata.'); RestaurantPage.Add('Restaurant name:', False);
  PortsPage := CreateInputQueryPage(RestaurantPage.ID, 'Ports', 'Choose local service ports', 'Defaults are 3000, 3306 and 8081. The installer checks all three together when you continue.'); PortsPage.Add('POS port:', False); PortsPage.Add('Database port:', False); PortsPage.Add('phpMyAdmin port:', False); PortsPage.Values[0] := '3000'; PortsPage.Values[1] := '3306'; PortsPage.Values[2] := '8081';
#endif
end;
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
#ifdef UpdateOnly
  if WizardSilent and (AcceptUpdate = '1') and (PageID = UpdatePage.ID) then Result := True;
#endif
end;
function IsRepairInstall: Boolean;
begin Result := FileExists('C:\ProgramData\POSApp\install.json'); end;
function PortsAreAvailable: Boolean;
var ResultCode, I: Integer; PortScript, MessagePath, MessageText, OldNextCaption: string; MessageLines: TArrayOfString;
begin
  OldNextCaption := WizardForm.NextButton.Caption; WizardForm.NextButton.Caption := 'Checking...';
  ExtractTemporaryFile('Get-PortStatus.ps1'); PortScript := ExpandConstant('{tmp}\Get-PortStatus.ps1');
  MessagePath := ExpandConstant('{tmp}\port-status.txt');
  try
    Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -ExecutionPolicy Bypass -File "' + PortScript + '" -Ports ' + IntToStr(PosPort) + ',' + IntToStr(DatabasePort) + ',' + IntToStr(PhpMyAdminPort) + ' -RequireAvailable -MessageFile "' + MessagePath + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
    if (not Result) and LoadStringsFromFile(MessagePath, MessageLines) and (GetArrayLength(MessageLines) > 0) then begin MessageText := ''; for I := 0 to GetArrayLength(MessageLines) - 1 do MessageText := MessageText + MessageLines[I] + #13#10; MsgBox(MessageText, mbError, MB_OK); end;
  finally
    WizardForm.NextButton.Caption := OldNextCaption;
    DeleteFile(MessagePath);
  end;
end;
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
#ifdef UpdateOnly
  if (CurPageID = UpdatePage.ID) and ((not UpdatePage.Values[0]) or (not UpdatePage.Values[1])) then begin MsgBox('Select both confirmations before updating POSAPP.', mbError, MB_OK); Result := False; end;
#else
  if (CurPageID = RestaurantPage.ID) and (not IsRepairInstall) and (Trim(RestaurantPage.Values[0]) = '') then begin MsgBox('Restaurant name is required.', mbError, MB_OK); Result := False; exit; end;
  if CurPageID = PortsPage.ID then begin
    PosPort := StrToIntDef(PortsPage.Values[0], 0); DatabasePort := StrToIntDef(PortsPage.Values[1], 0); PhpMyAdminPort := StrToIntDef(PortsPage.Values[2], 0);
    if (PosPort < 1) or (DatabasePort < 1) or (PhpMyAdminPort < 1) or (PosPort = DatabasePort) or (PosPort = PhpMyAdminPort) or (DatabasePort = PhpMyAdminPort) then begin MsgBox('Ports must be valid and unique.', mbError, MB_OK); Result := False; exit; end;
    if (not IsRepairInstall) and (not PortsAreAvailable) then begin Result := False; exit; end;
  end;
#endif
end;
function PrepareToInstall(var NeedsRestart: Boolean): String;
var ResultCode: Integer;
begin
  Result := '';
#ifdef UpdateOnly
  { The update transaction owns the POSApp stop/start boundary. Never stop
    MariaDB or phpMyAdmin while staging an application-only update. }
#else
  if IsRepairInstall then begin
    WizardForm.StatusLabel.Caption := 'Stopping existing POS services...';
    Exec(ExpandConstant('{sys}\net.exe'), 'stop POSApp /y', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(ExpandConstant('{sys}\net.exe'), 'stop POSAppPhpMyAdmin /y', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(ExpandConstant('{sys}\net.exe'), 'stop POSAppMariaDB /y', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
#endif
end;
function ReadTextFile(Path: string): string;
var Lines: TArrayOfString; I: Integer;
begin
  Result := '';
  if LoadStringsFromFile(Path, Lines) then for I := 0 to GetArrayLength(Lines) - 1 do Result := Result + Lines[I] + #13#10;
end;
procedure CurStepChanged(CurStep: TSetupStep);
var ConfigPath, ResultPath, Json, CompletionText, PosScript, ServerStage, VendorDir: string; ResultCode: Integer; ExecOk: Boolean; JsonLines, CompletionLines: TArrayOfString;
begin
  if CurStep = ssPostInstall then begin
#ifdef UpdateOnly
    ResultPath := ExpandConstant('{tmp}\posapp-update-result.json');
    PosScript := ExpandConstant('{tmp}\Update-PosServer.ps1');
    ServerStage := ExpandConstant('{tmp}\posapp-update-payload');
    try
      if not WizardSilent then begin UpdateProgressPage.SetText('Starting POSAPP update...', ''); UpdateProgressPage.SetProgress(0, 0); UpdateProgressPage.Show; end;
      try
        ExecOk := ExecAndLogOutput(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -ExecutionPolicy Bypass -File "' + PosScript + '" -Mode {#UpdateMode} -PayloadRoot "' + ServerStage + '" -ResultFile "' + ResultPath + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode, @UpdateProgressLog);
        if (not ExecOk) or (ResultCode <> 0) then begin CompletionText := ReadTextFile(ResultPath); if CompletionText = '' then CompletionText := 'Update failed. Check C:\ProgramData\POSApp\logs\update-error.txt.'; RaiseException('POSAPP Server update failed:' + #13#10 + CompletionText); end;
      finally
        if not WizardSilent then UpdateProgressPage.Hide;
      end;
      if not WizardSilent then begin
        CompletionText := ReadTextFile(ResultPath); if CompletionText <> '' then MsgBox(CompletionText, mbInformation, MB_OK) else MsgBox('POSAPP Server update completed.', mbInformation, MB_OK);
      end;
    finally DeleteFile(ResultPath); end;
#else
    WizardForm.StatusLabel.Caption := 'Preparing POS configuration...';
    ResultPath := ExpandConstant('{tmp}\server-result.txt');
    ConfigPath := ExpandConstant('{tmp}\server-response.json'); Json := '{"RestaurantName":"' + JsonEscape(RestaurantPage.Values[0]) + '","PosPort":' + IntToStr(PosPort) + ',"DatabasePort":' + IntToStr(DatabasePort) + ',"PhpMyAdminPort":' + IntToStr(PhpMyAdminPort) + '}';
    SaveStringToFile(ConfigPath, '', False); Exec(ExpandConstant('{sys}\icacls.exe'), '"' + ConfigPath + '" /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode); if ResultCode <> 0 then RaiseException('Response protection failed.'); SetArrayLength(JsonLines, 1); JsonLines[0] := Json; if not SaveStringsToUTF8FileWithoutBOM(ConfigPath, JsonLines, False) then RaiseException('Response write failed.');
    SaveStringToFile(ResultPath, '', False); Exec(ExpandConstant('{sys}\icacls.exe'), '"' + ResultPath + '" /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode); if ResultCode <> 0 then RaiseException('Result protection failed.');
    try
      WizardForm.StatusLabel.Caption := 'Installing POS services and database... First-time database and private web-tool setup may take several minutes on a slower PC; do not close this window.';
      PosScript := ExpandConstant('{app}\deployment\windows\Install-PosServer.ps1'); ServerStage := ExpandConstant('{app}'); VendorDir := ExpandConstant('{app}\install\vendor');
      Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -ExecutionPolicy Bypass -File "' + PosScript + '" -ConfigFile "' + ConfigPath + '" -ResultFile "' + ResultPath + '" -ServerStage "' + ServerStage + '" -VendorDir "' + VendorDir + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode); if ResultCode <> 0 then begin CompletionText := ReadTextFile(ResultPath); if CompletionText <> '' then RaiseException('Server provisioning failed with exit code ' + IntToStr(ResultCode) + ':' + #13#10 + CompletionText) else RaiseException('Server provisioning failed with exit code ' + IntToStr(ResultCode) + '. Check C:\ProgramData\POSApp\logs\install-error.txt.'); end;
      WizardForm.StatusLabel.Caption := 'POS installation verified.';
      if LoadStringsFromFile(ResultPath, CompletionLines) then begin CompletionText := ''; for ResultCode := 0 to GetArrayLength(CompletionLines) - 1 do CompletionText := CompletionText + CompletionLines[ResultCode] + #13#10; MsgBox(CompletionText, mbInformation, MB_OK); end
      else MsgBox('POS App installed successfully. Credentials are stored in the protected ProgramData config files.', mbInformation, MB_OK);
    finally DeleteFile(ConfigPath); DeleteFile(ResultPath); end;
#endif
  end;
end;
