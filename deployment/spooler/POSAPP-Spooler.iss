#define AppName "POS Print Spooler"
#ifndef AppVersion
  #define AppVersion "1.2.23"
#endif
#define AppId "{{80657A48-9BCB-4455-8CA9-A18139FDFC58}"
#ifndef StageRoot
  #define StageRoot "..\out\stage"
#endif
#ifndef InstallerOutputDir
  #define InstallerOutputDir "..\out"
#endif
#ifdef RuntimeUpdate
  #define StageDir StageRoot + "\spooler-update-runtime"
  #define OutputName "POSAPP-Spooler-Typst-Only-Runtime-Update"
  #define UpdateMode "RuntimeTransition"
#else
#ifdef UpdateOnly
  #define StageDir StageRoot + "\spooler-update-core"
  #define OutputName "POSAPP-Spooler-Typst-Only-Update"
  #define UpdateMode "Core"
#else
  #define StageDir StageRoot + "\spooler"
  #define OutputName "POSAPP-Spooler-Typst-Only-Setup"
#endif
#endif
[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={autopf}\POS-Spooler
DefaultGroupName=POS Print Spooler
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
SetupMutex=POSAPP-Spooler-Installer,Global\POSAPP-Spooler-Installer
#ifdef UpdateOnly
CreateAppDir=no
Uninstallable=no
AllowCancelDuringInstall=no
#else
Uninstallable=yes
#endif
[Files]
#ifdef UpdateOnly
Source: "{#StageDir}\*"; DestDir: "{tmp}\spooler-update-payload"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\windows\Update-Spooler.ps1"; DestDir: "{tmp}"; Flags: ignoreversion
#else
Source: "{#StageDir}\*"; DestDir: "{tmp}\spooler-install-payload"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\windows\Install-Spooler.ps1"; DestDir: "{tmp}\spooler-install-payload\deployment\windows"; Flags: ignoreversion
Source: "..\windows\Remove-SpoolerRuntime.ps1"; DestDir: "{tmp}\spooler-install-payload\deployment\windows"; Flags: ignoreversion
Source: "..\windows\Detect-LocalPosServer.ps1"; Flags: dontcopy ignoreversion
#endif
[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\deployment\windows\Remove-SpoolerRuntime.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveSpoolerRuntime"
[UninstallDelete]
Type: filesandordirs; Name: "{app}"
[Code]
var ServerPage, KeyPage, StationPage: TInputQueryWizardPage; LocalServerDetected: Boolean;
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
begin StringChangeEx(Value, '\', '\\', True); StringChangeEx(Value, '"', '\"', True); StringChangeEx(Value, #13, '\r', True); StringChangeEx(Value, #10, '\n', True); StringChangeEx(Value, #9, '\t', True); Result := Value; end;
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
function IsRepairInstall: Boolean;
begin Result := FileExists('C:\ProgramData\POS-Spooler\config\spooler.env'); end;
function IsDigits(Value: string): Boolean;
var I: Integer;
begin
  Result := Value <> '';
  if not Result then exit;
  for I := 1 to Length(Value) do
    if (Value[I] < '0') or (Value[I] > '9') then begin Result := False; exit; end;
end;
function IsValidLocalServerUrl(Value: string): Boolean;
var PortText: string; Port: Integer;
begin
  Result := False;
  if Copy(Value, 1, Length('http://127.0.0.1:')) <> 'http://127.0.0.1:' then exit;
  PortText := Copy(Value, Length('http://127.0.0.1:') + 1, Length(Value));
  if not IsDigits(PortText) then exit;
  Port := StrToIntDef(PortText, 0);
  Result := (Port >= 1) and (Port <= 65535);
end;
function IsValidServerOrigin(Value: string): Boolean;
var LowerValue, Authority, Host, PortText: string; SchemeLength, ColonAt, Port: Integer;
begin
  Result := False;
  if (Value = '') or (Value <> Trim(Value)) then exit;
  LowerValue := Lowercase(Value);
  if Copy(LowerValue, 1, Length('https://')) = 'https://' then SchemeLength := Length('https://')
  else if Copy(LowerValue, 1, Length('http://')) = 'http://' then SchemeLength := Length('http://')
  else exit;
  Authority := Copy(Value, SchemeLength + 1, Length(Value));
  if (Authority <> '') and (Authority[Length(Authority)] = '/') then Delete(Authority, Length(Authority), 1);
  if (Authority = '') or (Pos('/', Authority) > 0) or (Pos('\', Authority) > 0) or
     (Pos('@', Authority) > 0) or (Pos('?', Authority) > 0) or (Pos('#', Authority) > 0) or
     (Pos(' ', Authority) > 0) then exit;
  if Authority[1] = '[' then begin
    ColonAt := Pos(']', Authority);
    if (ColonAt <= 2) then exit;
    Host := Copy(Authority, 1, ColonAt);
    PortText := Copy(Authority, ColonAt + 1, Length(Authority));
    if (PortText <> '') and (PortText[1] = ':') then Delete(PortText, 1, 1)
    else if PortText <> '' then exit;
  end else begin
    ColonAt := Pos(':', Authority);
    if ColonAt > 0 then begin
      Host := Copy(Authority, 1, ColonAt - 1);
      PortText := Copy(Authority, ColonAt + 1, Length(Authority));
      if Pos(':', PortText) > 0 then exit;
    end else begin Host := Authority; PortText := ''; end;
  end;
  if Host = '' then exit;
  if (Copy(LowerValue, 1, Length('http://')) = 'http://') and
     (Lowercase(Host) <> 'localhost') and (Lowercase(Host) <> '127.0.0.1') and (Lowercase(Host) <> '[::1]') then exit;
  if PortText <> '' then begin
    if not IsDigits(PortText) then exit;
    Port := StrToIntDef(PortText, 0);
    if (Port < 1) or (Port > 65535) then exit;
  end;
  Result := True;
end;
function IsValidSpoolerKey(Value: string): Boolean;
var I: Integer; C: Char;
begin
  Result := Length(Value) = 43;
  if not Result then exit;
  for I := 1 to Length(Value) do begin
    C := Value[I];
    if not (((C >= 'A') and (C <= 'Z')) or ((C >= 'a') and (C <= 'z')) or ((C >= '0') and (C <= '9')) or (C = '_') or (C = '-')) then begin Result := False; exit; end;
  end;
end;
procedure TryDetectLocalPosServer;
var ResultPath, DetectorPath: string; ResultCode: Integer; Lines: TArrayOfString;
begin
  LocalServerDetected := False;
  ServerPage.Values[0] := '';
  KeyPage.Values[0] := '';
  ResultPath := ExpandConstant('{tmp}\posapp-local-server-detection.txt');
  try
    try
      if SaveStringToFile(ResultPath, '', False) then begin
        if Exec(ExpandConstant('{sys}\icacls.exe'), '"' + ResultPath + '" /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then begin
          ExtractTemporaryFile('Detect-LocalPosServer.ps1');
          DetectorPath := ExpandConstant('{tmp}\Detect-LocalPosServer.ps1');
          if Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -ExecutionPolicy Bypass -File "' + DetectorPath + '" -ResultFile "' + ResultPath + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) and LoadStringsFromFile(ResultPath, Lines) and (GetArrayLength(Lines) = 2) and IsValidLocalServerUrl(Lines[0]) and IsValidSpoolerKey(Lines[1]) then begin
            ServerPage.Values[0] := Lines[0];
            KeyPage.Values[0] := Lines[1];
            LocalServerDetected := True;
          end;
        end;
      end;
    except
      LocalServerDetected := False;
      ServerPage.Values[0] := '';
      KeyPage.Values[0] := '';
    end;
  finally
    DeleteFile(ResultPath);
  end;
end;
procedure InitializeWizard;
begin
#ifdef UpdateOnly
#ifdef RuntimeUpdate
  UpdatePage:=CreateInputOptionPage(wpWelcome,'Transition to the Typst-only runtime','Review the packaged runtime transition','This explicit transition removes Chromium and replaces the Node dependencies with the Typst-only profile. Station identity, server URL, key, printer mappings and queue state remain in place.',False,False);
#else
  UpdatePage:=CreateInputOptionPage(wpWelcome,'Update POS Print Spooler','Review the packaged update','This update changes spooler application files only. Station identity, server URL, key, printer mappings and queue state remain in place.',False,False);
#endif
  UpdatePage.Add('I understand that this update requires an existing packaged spooler installation.');
  UpdatePage.Add('Target spooler version is {#AppVersion}.');
  UpdateProgressPage:=CreateOutputProgressPage('Updating POS Print Spooler','Applying the packaged update.');
  if WizardSilent and (AcceptUpdate = '1') then begin
    UpdatePage.Values[0] := True;
    UpdatePage.Values[1] := True;
  end;
#else
  ServerPage:=CreateInputQueryPage(wpWelcome,'POS server','Connect this spooler','Enter the full POS URL.'); ServerPage.Add('POS server URL:',False); KeyPage:=CreateInputQueryPage(ServerPage.ID,'Shared key','Authenticate the spooler','The key is stored only in ProgramData.'); KeyPage.Add('Spooler key:',True); StationPage:=CreateInputQueryPage(KeyPage.ID,'Station identity','Identify this printer station','Use a unique station ID.'); StationPage.Add('Station ID:',False); StationPage.Add('Station name:',False);
  if not IsRepairInstall then TryDetectLocalPosServer;
#endif
end;
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
#ifdef UpdateOnly
  if WizardSilent and (AcceptUpdate = '1') and (PageID = UpdatePage.ID) then Result := True;
#else
  if LocalServerDetected and ((PageID = ServerPage.ID) or (PageID = KeyPage.ID)) then Result := True;
#endif
end;
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
#ifdef UpdateOnly
  if (CurPageID = UpdatePage.ID) and ((not UpdatePage.Values[0]) or (not UpdatePage.Values[1])) then begin MsgBox('Select both confirmations before updating the spooler.', mbError, MB_OK); Result := False; end;
#else
  if IsRepairInstall then exit;
  if (CurPageID = ServerPage.ID) and (not IsValidServerOrigin(ServerPage.Values[0])) then begin MsgBox('POS server URL is required. Enter a valid HTTP or HTTPS origin without a path, query, or sign-in details.', mbError, MB_OK); Result := False; end
  else if (CurPageID = KeyPage.ID) and (Trim(KeyPage.Values[0]) = '') then begin MsgBox('Spooler key is required.', mbError, MB_OK); Result := False; end
  else if (CurPageID = StationPage.ID) and ((Trim(StationPage.Values[0]) = '') or (Trim(StationPage.Values[1]) = '')) then begin MsgBox('Station ID and name are required.', mbError, MB_OK); Result := False; end;
#endif
end;
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  { PowerShell owns validation, locking, and the stop/start boundary. }
end;
function ReadTextFile(Path: string): string;
var Lines: TArrayOfString; I: Integer;
begin
  Result := '';
  if LoadStringsFromFile(Path, Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
      Result := Result + Lines[I] + #13#10;
end;
procedure CurStepChanged(CurStep: TSetupStep);
var ConfigPath,ResultPath,Json,CompletionText,SpoolerScript,PayloadRoot: string; ResultCode: Integer; ExecOk: Boolean; JsonLines,CompletionLines: TArrayOfString;
begin if CurStep=ssPostInstall then begin
#ifdef UpdateOnly
  ResultPath:=ExpandConstant('{tmp}\spooler-update-result.json');
  SpoolerScript:=ExpandConstant('{tmp}\Update-Spooler.ps1'); PayloadRoot:=ExpandConstant('{tmp}\spooler-update-payload');
  try
    if not WizardSilent then begin UpdateProgressPage.SetText('Starting print spooler update...', ''); UpdateProgressPage.SetProgress(0, 0); UpdateProgressPage.Show; end;
    try
      ExecOk := ExecAndLogOutput(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),'-NoProfile -ExecutionPolicy Bypass -File "'+SpoolerScript+'" -Mode {#UpdateMode} -PayloadRoot "'+PayloadRoot+'" -ResultFile "'+ResultPath+'"','',SW_HIDE,ewWaitUntilTerminated,ResultCode,@UpdateProgressLog);
      CompletionText := ReadTextFile(ResultPath);
      if (not ExecOk) or (ResultCode<>0) then begin if CompletionText = '' then CompletionText := ReadTextFile(ExpandConstant('{commonappdata}\POS-Spooler\logs\update-error.txt')); if CompletionText = '' then CompletionText := 'The updater failed before it could write diagnostics.'; RaiseException('POS Print Spooler update failed:'+ #13#10 + CompletionText); end;
    finally
      if not WizardSilent then UpdateProgressPage.Hide;
    end;
    if not WizardSilent then begin
      // Start-Spooler only waits for SCM Running, and NSSM reports Running as soon as
      // it spawns node and restarts it by default - so a crash-looping agent still
      // looks green here. Losing rollback is the deliberate trade; it only works if
      // the operator is told to look. The install branch already does this.
      if Pos('SPOOLER_NOT_YET_REGISTERED', CompletionText) > 0 then
        MsgBox('The spooler was updated but this station has not reconnected to the POS server.' + #13#10 + 'Check Settings > Print queue before leaving the till. If it stays offline, re-run the previous installer.' + #13#10#13#10 + CompletionText, mbError, MB_OK)
      else if CompletionText <> '' then MsgBox(CompletionText, mbInformation, MB_OK);
    end;
  finally DeleteFile(ResultPath); end;
#else
  WizardForm.StatusLabel.Caption := 'Preparing spooler configuration...'; ConfigPath:=ExpandConstant('{tmp}\spooler-response.json'); ResultPath:=ExpandConstant('{tmp}\spooler-provisioning-result.txt'); Json:='{"ServerUrl":"'+JsonEscape(ServerPage.Values[0])+'","SpoolerKey":"'+JsonEscape(KeyPage.Values[0])+'","SpoolerId":"'+JsonEscape(StationPage.Values[0])+'","SpoolerName":"'+JsonEscape(StationPage.Values[1])+'"}'; SaveStringToFile(ConfigPath,'',False); SaveStringToFile(ResultPath,'',False); Exec(ExpandConstant('{sys}\icacls.exe'),'"'+ConfigPath+'" /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F','',SW_HIDE,ewWaitUntilTerminated,ResultCode); if ResultCode<>0 then RaiseException('Response protection failed.'); Exec(ExpandConstant('{sys}\icacls.exe'),'"'+ResultPath+'" /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F','',SW_HIDE,ewWaitUntilTerminated,ResultCode); if ResultCode<>0 then RaiseException('Result protection failed.'); SetArrayLength(JsonLines,1); JsonLines[0]:=Json; if not SaveStringsToUTF8FileWithoutBOM(ConfigPath,JsonLines,False) then RaiseException('Response write failed.'); try WizardForm.StatusLabel.Caption := 'Installing print spooler service...'; PayloadRoot:=ExpandConstant('{tmp}\spooler-install-payload'); SpoolerScript:=ExpandConstant('{tmp}\spooler-install-payload\deployment\windows\Install-Spooler.ps1'); ExecOk := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),'-NoProfile -ExecutionPolicy Bypass -File "'+SpoolerScript+'" -ConfigFile "'+ConfigPath+'" -ResultFile "'+ResultPath+'" -PayloadRoot "'+PayloadRoot+'"','',SW_HIDE,ewWaitUntilTerminated,ResultCode); if (not ExecOk) or (ResultCode<>0) then begin CompletionText := ReadTextFile(ResultPath); if CompletionText = '' then CompletionText := ReadTextFile(ExpandConstant('{commonappdata}\POS-Spooler\logs\install-error.txt')); if CompletionText = '' then CompletionText := 'The installer failed before it could write diagnostics.'; RaiseException('POS Print Spooler provisioning failed:' + #13#10 + CompletionText); end; CompletionText := ReadTextFile(ResultPath); if (Pos('SPOOLER_SERVER_UNREACHABLE', CompletionText) > 0) or (Pos('SPOOLER_SERVER_UNHEALTHY', CompletionText) > 0) or (Pos('SPOOLER_NOT_YET_REGISTERED', CompletionText) > 0) then WizardForm.FinishedLabel.Caption := 'Installation completed. The spooler could not confirm the POS server yet. Check the server URL and key, then watch Settings > Print queue.'; WizardForm.StatusLabel.Caption := 'Print spooler installation completed.'; finally DeleteFile(ConfigPath); DeleteFile(ResultPath); end;
#endif
end; end;
