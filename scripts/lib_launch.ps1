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
