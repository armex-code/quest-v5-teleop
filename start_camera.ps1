<#
.SYNOPSIS
  The 360 camera half only (mediamtx + ffmpeg), for debugging it in isolation.

.DESCRIPTION
  Normally you want .\start_all.ps1, which runs this plus the robot side in
  one command. Use this one when you are iterating on camera settings and do
  not want to restart the web server and serial link each time.

  The page and the WHEP signalling are served by server/run.py, not here.

.EXAMPLE
  .\start_camera.ps1 -Probe
  Print every format the camera offers, then exit. Run this the first time.

.EXAMPLE
  .\start_camera.ps1 -AddFirewallRules
  Once, as administrator. Opens TCP 8443/8765 and - the one people forget -
  UDP 8189, which carries the video straight to the headset. Without it the
  page loads fine and the world stays black forever.
#>
[CmdletBinding()]
param(
  [string] $Device = 'Insta360 X5',
  [string] $AudioDevice = '',
  [int]    $Width  = 2880,
  [int]    $Height = 1440,
  [int]    $Fps    = 30,
  [string] $Bitrate = '35M',
  [ValidateSet('h264_nvenc','h264_amf','libx264')] [string] $Encoder = 'h264_nvenc',
  [ValidateSet('p1','p2','p3','p4','p5','p6','p7')] [string] $Preset = 'p4',
  # ($Profile would shadow PowerShell's automatic variable of that name.)
  [ValidateSet('baseline','main','high')] [string] $H264Profile = 'baseline',
  [ValidateSet('auto','mjpeg','rawvideo')] [string] $InputCodec = 'mjpeg',
  [switch] $Test,
  [switch] $Probe,
  [switch] $ShowFfmpeg,
  [switch] $AddFirewallRules,
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'scripts\lib_launch.ps1')

$mediamtx = Join-Path $root 'bin\mediamtx.exe'
$procs = @()

# ----------------------------------------------------------------- firewall --
if ($AddFirewallRules) {
  $admin = ([Security.Principal.WindowsPrincipal] `
            [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) {
    Say "-AddFirewallRules needs an elevated shell. Run PowerShell as administrator." 'Red'
    exit 1
  }
  $rules = @(
    @{ Name = 'Teleop page (TCP 8443)';      Proto = 'TCP'; Port = 8443 },
    @{ Name = 'Teleop WS bridge (TCP 8765)'; Proto = 'TCP'; Port = 8765 },
    @{ Name = 'Teleop 360 media (UDP 8189)'; Proto = 'UDP'; Port = 8189 }
  )
  foreach ($r in $rules) {
    Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue |
      Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow `
      -Protocol $r.Proto -LocalPort $r.Port -Profile Any | Out-Null
    Say ("  added: " + $r.Name) 'Green'
  }
  Say 'Firewall rules in place.' 'Green'
  exit 0
}

# -------------------------------------------------------------------- probe --
if ($Probe) {
  Say "Formats offered by '$Device':" 'Cyan'
  & ffmpeg -hide_banner -f dshow -list_options true -i "video=$Device"
  Say ''
  Say 'All capture devices:' 'Cyan'
  & ffmpeg -hide_banner -f dshow -list_devices true -i dummy
  exit 0
}

# ---------------------------------------------------------------- preflight --
if (-not (Test-Path $mediamtx)) {
  Say "error: missing $mediamtx" 'Red'
  Say '       unzip mediamtx_v1.21.2_windows_amd64.zip into bin\' 'Yellow'
  exit 1
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Say 'error: ffmpeg is not on PATH' 'Red'; exit 1
}
if (-not (Test-PortsFree @(8554, 8889) @(8189) -Force:$Force)) { exit 1 }

# ------------------------------------------------------------------- run ----
try {
  Say ''
  Say '  360 camera feed only' 'White'
  Say '  --------------------' 'DarkGray'

  $procs += Launch 'mediamtx' $mediamtx @('mediamtx.yml') (Join-Path $root 'server')
  Say '  [mediamtx] starting' 'DarkGray'

  $ff = Get-CameraFfmpegArgs -Device $Device -AudioDevice $AudioDevice `
          -Width $Width -Height $Height -Fps $Fps -Bitrate $Bitrate `
          -Encoder $Encoder -Preset $Preset -H264Profile $H264Profile `
          -InputCodec $InputCodec -Test:$Test -ShowFfmpeg:$ShowFfmpeg
  if ($Test) { Say '  [ffmpeg]   TEST PATTERN (no camera)' 'Yellow' }
  else       { Say "  [ffmpeg]   '$Device' ${Width}x${Height}@$Fps -> $Encoder $Preset @ $Bitrate" 'DarkGray' }
  $procs += Launch 'ffmpeg' 'ffmpeg' $ff

  Say ''
  Say '  Also run (separate window):  python server\run.py' 'White'
  Say '  Ctrl+C to stop.' 'DarkGray'
  Say ''

  Watch-Procs $procs
}
finally {
  Say ''
  Say '  shutting down' 'DarkGray'
  Stop-Procs $procs
}
