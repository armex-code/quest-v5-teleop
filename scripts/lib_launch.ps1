# Shared launcher helpers, dot-sourced by start_all.ps1 and start_camera.ps1.
# The ffmpeg argument list in particular lives here so the two launchers
# cannot drift apart - every encoder setting below was measured, and having
# two copies of it would guarantee one goes stale.

function Say([string] $msg, [string] $color = 'Gray') {
  Write-Host $msg -ForegroundColor $color
}

# Start-Process joins -ArgumentList with spaces and quotes nothing, so any
# argument containing a space (and this repo lives under "OneDrive - Al
# Akhawayn University...") arrives split in two.
function Quote([string] $s) {
  if ($s -match '[\s"]') { return '"' + ($s -replace '"', '\"') + '"' }
  return $s
}

function Launch([string] $label, [string] $exe, [string[]] $argv,
                [string] $workDir = $null) {
  $line = ($argv | ForEach-Object { Quote $_ }) -join ' '
  Write-Verbose "$label`: $exe $line"
  $sp = @{ FilePath = $exe; NoNewWindow = $true; PassThru = $true }
  if ($line)    { $sp.ArgumentList     = $line }
  if ($workDir) { $sp.WorkingDirectory = $workDir }
  # Hold the label ourselves: Windows cannot report ProcessName once a
  # process has exited, which is exactly when we want to name it.
  return [pscustomobject]@{ Label = $label; Proc = Start-Process @sp }
}

function Get-HostIp {
  # Only addresses that are actually usable. A disconnected Ethernet port can
  # hold a leftover manual 192.168.137.1 in the Deprecated state, and WebRTC
  # will not advertise an ICE candidate for a down interface - so naming that
  # address sends you to a URL that can never work, with no clue why.
  $up = (Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }).InterfaceIndex
  $usable = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.InterfaceIndex -in $up -and $_.AddressState -eq 'Preferred' -and
    $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*'
  }
  $hotspot = $usable | Where-Object { $_.IPAddress -like '192.168.137.*' } |
               Select-Object -First 1
  if ($hotspot) { return $hotspot.IPAddress }
  $pick = $usable | Sort-Object SkipAsSource, InterfaceMetric | Select-Object -First 1
  if ($pick) { return $pick.IPAddress }
  return '127.0.0.1'
}

$script:FW_RULES = @(
  @{ Name = 'Teleop page (TCP 8443)';      Proto = 'TCP'; Port = 8443 },
  @{ Name = 'Teleop WS bridge (TCP 8765)'; Proto = 'TCP'; Port = 8765 },
  # UDP 8189 carries the 360 video straight to the headset, bypassing the web
  # server. Forgetting it is THE classic failure: the page loads perfectly and
  # the world stays black forever.
  @{ Name = 'Teleop 360 media (UDP 8189)'; Proto = 'UDP'; Port = 8189 }
)

<#
Make sure our inbound rules exist, elevating only if some are missing.

Reading the rules needs no privileges, so the normal case (already set up) is
silent and non-elevated. Only the very first run raises a UAC prompt, and it
runs a throwaway script that does nothing but add the rules.
#>
function Confirm-FirewallRules {
  $missing = $script:FW_RULES | Where-Object {
    -not (Get-NetFirewallRule -DisplayName $_.Name -ErrorAction SilentlyContinue)
  }
  if (-not $missing) { return $true }

  Say ''
  Say '  Firewall rules are missing. Windows will ask for administrator once;' 'Yellow'
  Say '  after that this never prompts again:' 'Yellow'
  foreach ($r in $missing) { Say ("    " + $r.Name) 'DarkGray' }

  # Via a temp script rather than -Command: the rule names contain spaces and
  # parentheses, and quoting them through Start-Process is a losing game.
  $lines = $missing | ForEach-Object {
    "New-NetFirewallRule -DisplayName '$($_.Name)' -Direction Inbound " +
    "-Action Allow -Protocol $($_.Proto) -LocalPort $($_.Port) -Profile Any | Out-Null"
  }
  $tmp = Join-Path $env:TEMP 'teleop_firewall.ps1'
  Set-Content -Path $tmp -Value ($lines -join "`r`n") -Encoding ASCII

  try {
    Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden `
      -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', "`"$tmp`"")
  } catch {
    Say '  UAC declined. Continuing without the rules -- the page will load but' 'Red'
    Say '  the 360 view will stay black until UDP 8189 is allowed.' 'Red'
    return $false
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }

  $still = $script:FW_RULES | Where-Object {
    -not (Get-NetFirewallRule -DisplayName $_.Name -ErrorAction SilentlyContinue)
  }
  if ($still) { Say '  Some rules still missing; 360 video may not reach the headset.' 'Red'; return $false }
  Say '  Firewall rules added.' 'Green'
  return $true
}

<#
Upload v5/main.py to the brain, but only when it has actually changed.

Re-flashing on every launch would be wasteful and slow, so the SHA of the
last uploaded file is stamped next to the repo and compared. Returns one of
'skipped' | 'uploaded' | 'unchanged' | 'failed' so the caller can report it.
#>
function Sync-V5Program([string] $root, [int] $slot = 3) {
  $src = Join-Path $root 'v5\main.py'
  if (-not (Test-Path $src)) { return 'skipped' }

  $admin = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match 'COM(\d+)' -and $_.PNPDeviceID -match 'VID_2888' -and
    $_.PNPDeviceID -match 'MI_00'
  } | Select-Object -First 1
  if (-not $admin -or $admin.Name -notmatch 'COM(\d+)') { return 'skipped' }
  $port = 'COM' + $Matches[1]

  $vexcom = Find-Vexcom
  if (-not $vexcom) { return 'skipped' }

  $hash  = (Get-FileHash $src -Algorithm SHA256).Hash
  $stamp = Join-Path $root '.v5_deployed'
  if ((Test-Path $stamp) -and (Get-Content $stamp -Raw).Trim() -eq "$slot`:$hash") {
    return 'unchanged'
  }

  # The brain shows the uploaded filename as the program name.
  $staged = Join-Path $env:TEMP 'qteleop.py'
  Copy-Item $src $staged -Force
  & $vexcom --slot $slot --write $staged $port | Out-Null
  if ($LASTEXITCODE -ne 0) { return 'failed' }
  Set-Content -Path $stamp -Value "$slot`:$hash" -Encoding ASCII
  return 'uploaded'
}

<#
One screen telling you whether this machine is ready, and for anything that
is not, what to do about it. Every failure mode we have actually hit lives
here, because "it loads but the world is black" is miserable to diagnose
from inside a headset and trivial to catch from outside one.

Returns $true if nothing is outright broken (warnings are fine).
#>
function Show-Preflight([string] $root, [switch] $NoCamera, [switch] $NoSerial,
                        [string] $Device = 'Insta360 X5') {
  $rows = @()
  $fatal = $false
  function Row($state, $name, $detail) {
    $script:rows += [pscustomobject]@{ S = $state; N = $name; D = $detail }
  }
  $script:rows = @()

  # --- certificate: present, in date, and covering the IP we will serve on --
  $ip = Get-HostIp
  $certPath = Join-Path $root 'server\certs\cert.pem'
  if (-not (Test-Path $certPath)) {
    Row 'FAIL' 'certificate' "missing -> ./scripts/gen_cert.sh $ip"
    $fatal = $true
  } else {
    try {
      $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certPath)
      $san = ($c.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' })
      $txt = if ($san) { $san.Format($false) } else { '' }
      $days = [int]($c.NotAfter - (Get-Date)).TotalDays
      if ($days -lt 0) {
        Row 'FAIL' 'certificate' "EXPIRED -> ./scripts/gen_cert.sh $ip"; $fatal = $true
      } elseif ($txt -notmatch [regex]::Escape($ip)) {
        # The single most common silent failure after switching networks.
        Row 'WARN' 'certificate' "does NOT cover $ip -> ./scripts/gen_cert.sh $ip"
      } else {
        Row 'OK' 'certificate' "covers $ip, $days days left"
      }
    } catch {
      Row 'WARN' 'certificate' 'present but unreadable'
    }
  }

  # --- tools -------------------------------------------------------------
  # No 2>&1 on these either, for the same reason as the camera probe below.
  if (Get-Command python -EA SilentlyContinue) {
    Row 'OK' 'python' ((& python --version | Out-String).Trim())
  } else { Row 'FAIL' 'python' 'not on PATH'; $fatal = $true }

  if (-not $NoCamera) {
    $ff = Get-Command ffmpeg -EA SilentlyContinue
    if ($ff) {
      $v = ((& ffmpeg -version | Select-Object -First 1) -split ' ')[2]
      Row 'OK' 'ffmpeg' "v$v"
    } else { Row 'FAIL' 'ffmpeg' 'not on PATH'; $fatal = $true }

    if (Test-Path (Join-Path $root 'bin\mediamtx.exe')) { Row 'OK' 'mediamtx' 'bin\mediamtx.exe' }
    else { Row 'FAIL' 'mediamtx' 'missing -> unzip release into bin\'; $fatal = $true }
  }

  # --- firewall ----------------------------------------------------------
  $have = @($script:FW_RULES | Where-Object {
    Get-NetFirewallRule -DisplayName $_.Name -EA SilentlyContinue }).Count
  if ($have -eq $script:FW_RULES.Count) { Row 'OK' 'firewall' "$have/$($script:FW_RULES.Count) rules" }
  else { Row 'WARN' 'firewall' "$have/$($script:FW_RULES.Count) -> will prompt for admin once (UDP 8189 carries the video)" }

  # --- V5 brain ----------------------------------------------------------
  if ($NoSerial) {
    Row 'WARN' 'V5 brain' 'skipped (-NoSerial)'
  } else {
    $vex = @(Get-CimInstance Win32_PnPEntity -EA SilentlyContinue |
             Where-Object { $_.PNPDeviceID -match 'VID_2888' -and $_.Name -match 'COM(\d+)' })
    if ($vex.Count -ge 2) {
      $ports = ($vex | ForEach-Object { if ($_.Name -match 'COM(\d+)') { 'COM' + $Matches[1] } }) -join ' '
      Row 'OK' 'V5 brain' "$ports (admin + user)"
    } elseif ($vex.Count -eq 1) {
      Row 'WARN' 'V5 brain' 'only one port seen - brain may still be booting'
    } else {
      Row 'WARN' 'V5 brain' 'not detected -> plug in USB and power on'
    }
  }

  # --- camera ------------------------------------------------------------
  if (-not $NoCamera) {
    # ffmpeg prints the device list on STDERR and exits non-zero (there is no
    # real input). Piping that through 2>&1 would make PowerShell wrap each
    # line in an ErrorRecord, which under ErrorActionPreference='Stop' aborts
    # the whole script -- so redirect to a file instead and read it back.
    $tmp = [IO.Path]::GetTempFileName()
    try {
      Start-Process ffmpeg -ArgumentList '-hide_banner -f dshow -list_devices true -i dummy' `
        -NoNewWindow -Wait -RedirectStandardError $tmp | Out-Null
      $devs = Get-Content $tmp -Raw -ErrorAction SilentlyContinue
    } catch { $devs = '' } finally { Remove-Item $tmp -Force -EA SilentlyContinue }
    if ($devs -and $devs -match [regex]::Escape($Device)) {
      Row 'OK' 'camera' "'$Device' present"
    } else {
      Row 'WARN' 'camera' "'$Device' not found -> pick Webcam Mode on the camera screen"
    }
  }

  # --- network -----------------------------------------------------------
  $ssid = (netsh wlan show interfaces 2>$null | Select-String '^\s*SSID\s*:' |
           Select-Object -First 1)
  $ssidTxt = if ($ssid) { ($ssid.Line -split ':', 2)[1].Trim() } else { 'wired/unknown' }
  if ($ip -like '192.168.137.*') {
    Row 'OK' 'network' "Mobile Hotspot, $ip"
  } else {
    Row 'WARN' 'network' "$ssidTxt ($ip) - if the Quest cannot reach this PC, use Mobile Hotspot"
  }

  # --- ports -------------------------------------------------------------
  $tcp = @(8443, 8765); if (-not $NoCamera) { $tcp += @(8554, 8889) }
  $busy = @($tcp | Where-Object { Get-NetTCPConnection -State Listen -LocalPort $_ -EA SilentlyContinue })
  if ($busy) { Row 'WARN' 'ports' (($busy -join ', ') + ' in use -> re-run with -Force') }
  else { Row 'OK' 'ports' 'all free' }

  # --- render ------------------------------------------------------------
  Say ''
  Say '  SETUP CHECK' 'White'
  Say '  ---------------------------------------------------------------' 'DarkGray'
  foreach ($r in $script:rows) {
    $tag, $col = switch ($r.S) {
      'OK'   { '[ OK ]', 'Green' }
      'WARN' { '[WARN]', 'Yellow' }
      default { '[FAIL]', 'Red' }
    }
    Write-Host ("  {0} {1,-13}" -f $tag, $r.N) -ForegroundColor $col -NoNewline
    Write-Host (" " + $r.D) -ForegroundColor DarkGray
  }
  Say '  ---------------------------------------------------------------' 'DarkGray'
  Say ("  headset URL    https://{0}:8443" -f $ip) 'Cyan'
  Say ''
  return -not $fatal
}

function Find-Vexcom {
  $root = Join-Path $env:APPDATA 'Code\User\globalStorage\vexrobotics.vexcode\tools\vexcom'
  if (-not (Test-Path $root)) { return $null }
  # Version directory changes with the extension; take the newest.
  Get-ChildItem $root -Recurse -Filter 'vexcom.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}

<#
Ports we own. Stale holders are the single most common "it worked yesterday"
failure, and the error Python raises for it (WinError 10048) is noise unless
you already know what it means.
#>
function Test-PortsFree([int[]] $tcp, [int[]] $udp, [switch] $Force) {
  $busy = @()
  foreach ($p in $tcp) {
    $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue
    if ($c) { $busy += [pscustomobject]@{ Port = "TCP $p"; Pid = $c[0].OwningProcess } }
  }
  foreach ($p in $udp) {
    $c = Get-NetUDPEndpoint -LocalPort $p -ErrorAction SilentlyContinue
    if ($c) { $busy += [pscustomobject]@{ Port = "UDP $p"; Pid = $c[0].OwningProcessId } }
  }
  if (-not $busy) { return $true }

  foreach ($b in $busy) {
    $n = (Get-Process -Id $b.Pid -ErrorAction SilentlyContinue).ProcessName
    if ($Force) {
      Say ("  freeing " + $b.Port + " (was " + $n + ", pid " + $b.Pid + ")") 'Yellow'
      Stop-Process -Id $b.Pid -Force -ErrorAction SilentlyContinue
    } else {
      Say ("  " + $b.Port + " is already in use by " + $n + " (pid " + $b.Pid + ")") 'Red'
    }
  }
  if ($Force) { Start-Sleep -Seconds 2; return $true }
  Say '  An earlier run is probably still alive. Re-run with -Force to stop it.' 'Yellow'
  return $false
}

<#
ffmpeg arguments for the Insta360 X5 capture. Every value here was measured on
this machine, so change them deliberately:
  preset p4   p1 is explicitly "lowest quality"; p4 costs ~45% of the NVENC block
  35M         ~0.28 bits/pixel. Verified transparent vs the camera's own output
              (47.4 dB PSNR) -- raising it further is not visible
  rtbufsize   64M is ~3-4s. 16M overflowed and dropped frames at p4; much
              larger turns a momentary stall into permanent latency
  threads 6   decoding 2880x1440 MJPEG is the CPU bottleneck, not NVENC
  baseline    MediaMTX echoes the browser's offered profile without checking it
              against what we send, so a mismatch is possible. At 35 Mbit the
              efficiency High would buy is invisible; compatibility wins
  pkt_size    MediaMTX's limit is 1452 and ffmpeg's 1460 default makes it
              re-fragment every packet
#>
function Get-CameraFfmpegArgs {
  param(
    [string] $Device, [string] $AudioDevice, [int] $Width, [int] $Height,
    [int] $Fps, [string] $Bitrate, [string] $Encoder, [string] $Preset,
    [string] $H264Profile, [string] $InputCodec, [switch] $Test, [switch] $ShowFfmpeg
  )
  $a = @('-hide_banner')
  $a += if ($ShowFfmpeg) { @('-loglevel','warning','-stats') }
        else             { @('-loglevel','error','-nostats') }

  if ($Test) {
    $a += @('-re','-f','lavfi','-i',"testsrc2=size=${Width}x${Height}:rate=$Fps")
  } else {
    $a += @('-f','dshow','-rtbufsize','64M','-threads','6')
    if ($InputCodec -ne 'auto') { $a += @('-vcodec', $InputCodec) }
    $a += @('-video_size', "${Width}x${Height}", '-framerate', "$Fps")
    if ($AudioDevice) { $a += @('-i', "video=$Device`:audio=$AudioDevice") }
    else              { $a += @('-i', "video=$Device") }
  }

  # MJPEG decodes to full-range yuvj420p. Relabelling it yuv420p would keep
  # full-range values but tag them limited -> crushed blacks, clipped
  # highlights. Convert the range for real, and tag the result.
  if ($Test) { $a += @('-vf','format=yuv420p') }
  else       { $a += @('-vf','scale=in_range=pc:out_range=tv,format=yuv420p') }
  $a += @('-color_range','tv','-colorspace','bt709',
          '-color_primaries','bt709','-color_trc','bt709')

  $a += @('-c:v', $Encoder)
  switch ($Encoder) {
    'h264_nvenc' { $a += @('-preset',$Preset,'-tune','ull','-zerolatency','1','-rc','cbr') }
    'h264_amf'   { $a += @('-usage','ultralowlatency','-rc','cbr') }
    'libx264'    { $a += @('-preset','ultrafast','-tune','zerolatency') }
  }
  # No B-frames (they reorder output and add a frame of latency for nothing);
  # one keyframe a second so a joining headset gets a picture quickly.
  $a += @('-b:v',$Bitrate,'-maxrate',$Bitrate,'-bufsize','3M',
          '-g',"$Fps",'-bf','0','-profile:v',$H264Profile)
  if ($AudioDevice) { $a += @('-c:a','libopus','-b:a','64k','-ac','2') }

  $a += @('-pkt_size','1200','-f','rtsp','-rtsp_transport','tcp',
          'rtsp://127.0.0.1:8554/cam')
  return $a
}

<# Babysit: if any child dies, name it and tear the rest down rather than
   leaving a half-running stack that looks alive. #>
function Watch-Procs($procs) {
  while ($true) {
    Start-Sleep -Milliseconds 700
    $dead = $procs | Where-Object { $_.Proc.HasExited }
    if (-not $dead) { continue }
    foreach ($d in $dead) {
      Say ("  [" + $d.Label + "] exited with code " + $d.Proc.ExitCode) 'Red'
    }
    if ($dead.Label -contains 'ffmpeg') {
      Say '  ffmpeg quitting immediately usually means the camera is not in' 'Yellow'
      Say '  Webcam Mode, or the device name is wrong. Try -Probe.' 'Yellow'
    }
    return
  }
}

function Stop-Procs($procs) {
  foreach ($p in $procs) {
    if ($p -and -not $p.Proc.HasExited) {
      try { Stop-Process -Id $p.Proc.Id -Force -ErrorAction Stop } catch {}
    }
  }
}
