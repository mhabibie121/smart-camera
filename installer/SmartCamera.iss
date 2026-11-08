; =============================================================================
;  Smart Camera - installer (Inno Setup 6)
;  Build: npm run build  lalu  npm run installer   ->  dist\Setup-Smart-Camera-<versi>.exe
;
;  Isi folder release\ (hasil npm run build) dipasang ke Program Files.
;  Data (database, rekaman) disimpan di C:\ProgramData\Smart Camera\data, supaya
;  aman saat update/uninstall dan hanya bisa dibaca Administrator & SYSTEM.
; =============================================================================
#define AppName      "Smart Camera"
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppPublisher "Smart Camera"

[Setup]
AppId={{8EDE69AB-285F-40C3-A132-D2FC26E81189}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=Setup-Smart-Camera-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
WizardStyle=modern
UninstallDisplayIcon={app}\cctv.exe
UninstallDisplayName={#AppName}
CloseApplications=no
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup

[Types]
Name: "full";    Description: "Lengkap: monitoring + rekaman (seperti NVR)"
Name: "monitor"; Description: "Monitoring saja (live view)"
Name: "custom";  Description: "Pilih sendiri"; Flags: iscustom

[Components]
Name: "core";   Description: "Live view & monitoring (wajib)"; Types: full monitor custom; Flags: fixed
Name: "record"; Description: "Rekaman: rekam terus-menerus, timpa saat hardisk penuh, putar ulang & ekspor"; Types: full

[Tasks]
Name: "autostart"; Description: "Jalankan otomatis saat Windows menyala (tanpa perlu login)"
Name: "firewall";  Description: "Buka port di Windows Firewall (supaya bisa dibuka dari PC lain)"
Name: "desktopicon"; Description: "Buat shortcut di Desktop"; Flags: unchecked

[Dirs]
Name: "{commonappdata}\{#AppName}\data"

[Files]
Source: "..\release\cctv.exe";               DestDir: "{app}"; Flags: ignoreversion
Source: "..\release\mediamtx.exe";           DestDir: "{app}"; Flags: ignoreversion
Source: "..\release\mediamtx.yml";           DestDir: "{app}"; Flags: ignoreversion; AfterInstall: FixMediaMtxConfig
Source: "..\release\contoh-kamera.csv";      DestDir: "{app}"; Flags: ignoreversion
Source: "..\release\THIRD-PARTY-NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "service.ps1";                       DestDir: "{app}"; Flags: ignoreversion

[INI]
; Shortcut ke halaman aplikasi
Filename: "{app}\Smart Camera.url"; Section: "InternetShortcut"; Key: "URL"; String: "{code:WebUrl}"
Filename: "{app}\Smart Camera.url"; Section: "InternetShortcut"; Key: "IconFile"; String: "{app}\cctv.exe"
Filename: "{app}\Smart Camera.url"; Section: "InternetShortcut"; Key: "IconIndex"; String: "0"

[Icons]
Name: "{group}\{#AppName}";                Filename: "{app}\Smart Camera.url"
Name: "{group}\Hapus {#AppName}";          Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}";          Filename: "{app}\Smart Camera.url"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\service.ps1"" -Install -AppDir ""{app}"" -DataDir ""{commonappdata}\{#AppName}\data"" {code:ServiceFlags}"; \
  StatusMsg: "Menyalakan layanan Smart Camera..."; Flags: runhidden waituntilterminated
Filename: "{code:WebUrl}"; Description: "Buka Smart Camera sekarang"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\service.ps1"" -Uninstall -AppDir ""{app}"""; \
  Flags: runhidden waituntilterminated; RunOnceId: "StopSmartCamera"

[UninstallDelete]
Type: files; Name: "{app}\Smart Camera.url"
Type: files; Name: "{app}\.env"

[Code]
var
  AdminPage: TInputQueryWizardPage;
  PortPage: TInputQueryWizardPage;
  PortPrepared: Boolean;
  ExistingPort: String;   // port dari instalasi sebelumnya (update)

function DataDir(): String;
begin
  Result := ExpandConstant('{commonappdata}\{#AppName}\data');
end;

// Instal pertama = belum ada database. Update: password admin lama tetap, halaman dilewati.
function IsFreshInstall(): Boolean;
begin
  Result := not FileExists(DataDir() + '\cctv.db');
end;

// ---------- Port ----------
// Dicek lewat PowerShell (bahasa Windows apa pun aman, beda dengan teks netstat).
function PortInUse(Port: Integer; Udp: Boolean): Boolean;
var
  Code: Integer;
  Cmd: String;
begin
  if Udp then
    Cmd := 'if (Get-NetUDPEndpoint -LocalPort ' + IntToStr(Port) + ' -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }'
  else
    Cmd := 'if (Get-NetTCPConnection -State Listen -LocalPort ' + IntToStr(Port) + ' -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }';
  Result := Exec('powershell.exe', '-NoProfile -NonInteractive -Command "' + Cmd + '"', '', SW_HIDE, ewWaitUntilTerminated, Code)
    and (Code = 1);
end;

// PORT=... dari .env instalasi sebelumnya (kalau ada)
function ReadExistingPort(): String;
var
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := '';
  if LoadStringsFromFile(AddBackslash(WizardDirValue()) + '.env', Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
      if Pos('PORT=', Trim(Lines[I])) = 1 then
        Result := Trim(Copy(Trim(Lines[I]), 6, 10));
end;

function WebPort(): String;
begin
  Result := Trim(PortPage.Values[0]);
end;

function WebUrl(Param: String): String;
begin
  if WebPort() = '80' then Result := 'http://localhost'
  else Result := 'http://localhost:' + WebPort();
end;

// Isi otomatis: port lama (update), 80 kalau kosong, atau port kosong berikutnya
procedure PreparePortPage();
var
  Candidates: array of Integer;
  I: Integer;
  Note: String;
begin
  ExistingPort := ReadExistingPort();
  if ExistingPort <> '' then
  begin
    PortPage.Values[0] := ExistingPort;
    PortPage.SubCaptionLabel.Caption := 'Update: tetap memakai port ' + ExistingPort + ' seperti sebelumnya.';
    exit;
  end;
  Candidates := [80, 8080, 8000, 8081, 8888, 3000, 8090, 8181];
  for I := 0 to GetArrayLength(Candidates) - 1 do
    if not PortInUse(Candidates[I], False) then
    begin
      PortPage.Values[0] := IntToStr(Candidates[I]);
      if Candidates[I] = 80 then
        Note := 'Port 80 kosong. Smart Camera bisa dibuka cukup dengan alamat http://IP-server (tanpa nomor port).'
      else
        Note := 'Port 80 sedang dipakai program lain, jadi dipilih port ' + IntToStr(Candidates[I]) +
          '. Alamatnya: http://IP-server:' + IntToStr(Candidates[I]);
      PortPage.SubCaptionLabel.Caption := Note;
      exit;
    end;
  PortPage.Values[0] := '';
  PortPage.SubCaptionLabel.Caption := 'Semua port umum sedang dipakai. Isi port lain yang masih kosong (1 - 65535).';
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = PortPage.ID) and not PortPrepared then
  begin
    PortPrepared := True;
    PreparePortPage();
  end;
end;

// Sesuaikan alamat cek izin MediaMTX ke port aplikasi (aplikasi juga memperbaikinya sendiri saat jalan)
procedure FixMediaMtxConfig();
var
  Yml: AnsiString;
  S: String;
begin
  if LoadStringFromFile(ExpandConstant('{app}\mediamtx.yml'), Yml) then
  begin
    S := String(Yml);
    StringChangeEx(S, '127.0.0.1:3000/internal', '127.0.0.1:' + WebPort() + '/internal', True);
    SaveStringToFile(ExpandConstant('{app}\mediamtx.yml'), AnsiString(S), False);
  end;
end;

procedure InitializeWizard();
begin
  PortPage := CreateInputQueryPage(wpSelectTasks,
    'Port aplikasi web', 'Alamat untuk membuka Smart Camera di browser',
    '');
  PortPage.Add('Port:', False);

  AdminPage := CreateInputQueryPage(PortPage.ID,
    'Akun admin', 'Buat password untuk login admin pertama',
    'Username admin: admin' + #13#10 +
    'Password ini dipakai untuk masuk ke halaman Admin. Bisa diganti nanti dari aplikasi.');
  AdminPage.Add('Password (minimal 6 karakter):', True);
  AdminPage.Add('Ulangi password:', True);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = AdminPage.ID) and not IsFreshInstall();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  P: Integer;
begin
  Result := True;
  if CurPageID = PortPage.ID then
  begin
    P := StrToIntDef(WebPort(), 0);
    if (P < 1) or (P > 65535) then
    begin
      MsgBox('Isi port dengan angka 1 - 65535.', mbError, MB_OK);
      Result := False;
    end
    else if (P = 8889) or (P = 8189) or (P = 9997) or (P = 9996) then
    begin
      MsgBox('Port ' + IntToStr(P) + ' dipakai Smart Camera untuk video. Pilih port lain.', mbError, MB_OK);
      Result := False;
    end
    else if (WebPort() <> ExistingPort) and PortInUse(P, False) then
    begin
      MsgBox('Port ' + IntToStr(P) + ' sedang dipakai program lain. Pilih port lain.', mbError, MB_OK);
      Result := False;
    end
    // Port video harus kosong (kecuali update: dipakai Smart Camera sendiri, nanti dihentikan dulu)
    else if (ExistingPort = '') and (PortInUse(8889, False) or PortInUse(8189, True)) then
      Result := MsgBox('Port video 8889/8189 sedang dipakai program lain (mis. MediaMTX lain yang masih jalan).' + #13#10 +
        'Video tidak akan tampil sampai program itu ditutup.' + #13#10#13#10 + 'Lanjutkan instalasi?',
        mbConfirmation, MB_YESNO) = IDYES;
  end;
  if CurPageID = AdminPage.ID then
  begin
    if Length(AdminPage.Values[0]) < 6 then
    begin
      MsgBox('Password minimal 6 karakter.', mbError, MB_OK);
      Result := False;
    end
    else if AdminPage.Values[0] <> AdminPage.Values[1] then
    begin
      MsgBox('Kedua password tidak sama.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function ServiceFlags(Param: String): String;
begin
  Result := '';
  if WizardIsTaskSelected('autostart') then Result := Result + ' -AutoStart';
  if WizardIsTaskSelected('firewall') then Result := Result + ' -Firewall';
  Result := Result + ' -WebPort ' + WebPort();
end;

// Update: hentikan layanan lama dulu supaya file bisa ditimpa
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Script: String;
begin
  Result := '';
  Script := ExpandConstant('{app}\service.ps1');
  if FileExists(Script) then
    Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + Script + '" -Stop -AppDir "' +
      ExpandConstant('{app}') + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

// Ditulis di awal pemasangan (sebelum layanan dinyalakan di [Run]), supaya saat
// aplikasi pertama jalan, .env & password admin dari installer sudah tersedia.
procedure CurStepChanged(CurStep: TSetupStep);
var
  Env: String;
begin
  if CurStep = ssInstall then
  begin
    ForceDirectories(ExpandConstant('{app}'));
    ForceDirectories(DataDir());
    // Pengaturan aplikasi: lokasi data & modul yang dipasang
    Env := '# Dibuat oleh installer Smart Camera' + #13#10 +
           'PORT=' + WebPort() + #13#10 +
           'DATA_DIR=' + DataDir() + #13#10;
    if WizardIsComponentSelected('record') then
      Env := Env + 'RECORD_MODULE=1' + #13#10
    else
      Env := Env + 'RECORD_MODULE=0' + #13#10;
    SaveStringToFile(ExpandConstant('{app}\.env'), Env, False);
    // Password admin awal: dibaca aplikasi sekali saat pertama jalan, lalu langsung dihapus
    if IsFreshInstall() then
      SaveStringToFile(DataDir() + '\initial-admin.txt', AdminPage.Values[0], False);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if DirExists(DataDir()) and
       (MsgBox('Hapus juga semua data Smart Camera?' + #13#10#13#10 +
               'Termasuk daftar kamera, user, pengaturan, dan REKAMAN di:' + #13#10 + DataDir() + #13#10#13#10 +
               'Pilih "No" kalau mau dipasang lagi nanti dengan data yang sama.',
               mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES) then
      DelTree(ExpandConstant('{commonappdata}\{#AppName}'), True, True, True);
  end;
end;
