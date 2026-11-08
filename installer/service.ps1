# Smart Camera - pasang / lepas layanan otomatis (dipanggil oleh installer).
#
# Tidak memakai program service pihak ketiga: memakai Task Scheduler bawaan Windows.
#   - jalan sebagai SYSTEM saat Windows menyala (tidak perlu ada yang login)
#   - otomatis dijalankan ulang kalau berhenti (tiap 1 menit, berulang)
#   - tanpa batas waktu jalan (bawaan Task Scheduler: 3 hari, lalu dimatikan)
#
# Pemakaian:
#   service.ps1 -Install   -AppDir <folder aplikasi> -DataDir <folder data> [-AutoStart] [-Firewall] [-WebPort 80]
#   service.ps1 -Stop      -AppDir <folder aplikasi>
#   service.ps1 -Uninstall -AppDir <folder aplikasi>
param(
  [switch]$Install,
  [switch]$Stop,
  [switch]$Uninstall,
  [string]$AppDir,
  [string]$DataDir,
  [switch]$AutoStart,
  [switch]$Firewall,
  [int]$WebPort = 3000
)
$ErrorActionPreference = 'Continue'
$TaskPath = '\Smart Camera\'
$Tasks = @(
  @{ Name = 'MediaMTX'; Exe = 'mediamtx.exe'; Args = '"{APP}\mediamtx.yml"' },
  @{ Name = 'Web';      Exe = 'cctv.exe';     Args = '' }
)
$FwRules = @(
  @{ Name = "Smart Camera - Web (TCP $WebPort)"; Proto = 'TCP'; Port = $WebPort; Web = $true },
  @{ Name = 'Smart Camera - Video (TCP 8889)';  Proto = 'TCP'; Port = 8889 },
  @{ Name = 'Smart Camera - Video (UDP 8189)';  Proto = 'UDP'; Port = 8189 }
)

function Stop-SmartCamera {
  foreach ($t in $Tasks) {
    Stop-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -ErrorAction SilentlyContinue
  }
  # Pastikan proses dari folder aplikasi ini benar-benar berhenti (file bisa ditimpa saat update)
  if ($AppDir) {
    $full = (Resolve-Path -LiteralPath $AppDir -ErrorAction SilentlyContinue).Path
    if ($full) {
      Get-Process cctv, mediamtx -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($full, [StringComparison]::OrdinalIgnoreCase) } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 1
}

function Remove-Firewall {
  # Semua aturan Smart Camera (termasuk port lama kalau port web pernah diganti)
  Get-NetFirewallRule -DisplayName 'Smart Camera - *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

if ($Stop) { Stop-SmartCamera; exit 0 }

if ($Uninstall) {
  Stop-SmartCamera
  foreach ($t in $Tasks) {
    Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -Confirm:$false -ErrorAction SilentlyContinue
  }
  Remove-Firewall
  exit 0
}

if ($Install) {
  if (-not $AppDir -or -not $DataDir) { Write-Error 'AppDir dan DataDir wajib diisi'; exit 1 }

  # Folder data: hanya Administrator & SYSTEM (berisi database dengan login kamera & rekaman)
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $root = Split-Path -Parent $DataDir
  & icacls "$root" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /T /C /Q | Out-Null

  Stop-SmartCamera
  foreach ($t in $Tasks) {
    Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -Confirm:$false -ErrorAction SilentlyContinue
  }

  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 9999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $trigger = New-ScheduledTaskTrigger -AtStartup

  foreach ($t in $Tasks) {
    $exe = Join-Path $AppDir $t.Exe
    $argStr = $t.Args.Replace('{APP}', $AppDir)
    $action = if ($argStr) { New-ScheduledTaskAction -Execute $exe -Argument $argStr -WorkingDirectory $AppDir }
              else { New-ScheduledTaskAction -Execute $exe -WorkingDirectory $AppDir }
    $taskArgs = @{
      Action = $action; Principal = $principal; Settings = $settings
      Description = 'Smart Camera - layanan live view & rekaman CCTV'
    }
    if ($AutoStart) { $taskArgs.Trigger = $trigger }  # tanpa autostart: hanya jalan saat dinyalakan manual
    $task = New-ScheduledTask @taskArgs
    Register-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -InputObject $task -Force | Out-Null
  }

  Remove-Firewall
  if ($Firewall) {
    foreach ($r in $FwRules) {
      $exe = if ($r.Web) { Join-Path $AppDir 'cctv.exe' } else { Join-Path $AppDir 'mediamtx.exe' }
      # Semua profil: jaringan kantor sering terdeteksi "Public". Tetap dibatasi ke program & port ini saja.
      New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow -Protocol $r.Proto `
        -LocalPort $r.Port -Program $exe -Profile Any | Out-Null
    }
  }

  # Nyalakan sekarang (MediaMTX dulu, lalu aplikasi web)
  foreach ($t in $Tasks) {
    Start-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name
    Start-Sleep -Seconds 2
  }
  exit 0
}

Write-Host 'Pakai -Install, -Stop, atau -Uninstall'
exit 1
