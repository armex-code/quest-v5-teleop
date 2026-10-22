<#
.SYNOPSIS
  Start the whole rig in one command: web page + WS bridge + V5 serial, plus
  the 360 camera.

.DESCRIPTION
  Launches three processes and ties their lifetimes together, so Ctrl+C stops
  everything:

    run.py     HTTPS page (8443) + WHEP proxy + WSS bridge (8765) + V5 serial
    mediamtx   repackages the camera stream as WebRTC. No transcoding
    ffmpeg     Insta360 X5 over USB -> NVENC H.264 -> mediamtx

  The V5 program itself runs ON the brain and is not started here on purpose:
  it takes whatever position the jaws are in at startup as "fully open", so
  it must be started by hand with the jaws open. -DeployV5 uploads it for you
  but still leaves pressing Run to you.

.EXAMPLE
  .\start_all.ps1
  Everything, with the real camera.

.EXAMPLE
  .\start_all.ps1 -Test
  Everything, but a generated test pattern instead of the camera. Good for
  checking the headset end without the X5 plugged in.

.EXAMPLE
  .\start_all.ps1 -NoCamera
  Just the robot side - identical to the old start_server.bat.

.EXAMPLE
  .\start_all.ps1 -Force
  Same, but kill whatever is still holding our ports from a previous run.
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

  [string] $Serial = '',          # pin the V5 port, e.g. COM14
  [switch] $NoSerial,             # run without the V5 (UI / twin testing)
  [switch] $NoCamera,             # robot side only
  [switch] $Test,                 # generated pattern instead of the camera
  [switch] $DeployV5,             # upload v5/main.py to slot 3 first
  [switch] $ShowFfmpeg,
  [switch] $Force                 # kill stale holders of our ports
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'scripts\lib_launch.ps1')

$mediamtx = Join-Path $root 'bin\mediamtx.exe'
$procs = @()

Say ''
Say '  Quest -> V5 teleop' 'White'
Say '  ------------------' 'DarkGray'

# ---------------------------------------------------------------- preflight --
if (-not (Test-Path (Join-Path $root 'server\certs\cert.pem'))) {
  $ip = Get-HostIp
  Say "  error: no TLS certificate in server\certs\" 'Red'
  Say "         generate one in Git Bash:  ./scripts/gen_cert.sh $ip" 'Yellow'
  exit 1
}
foreach ($t in @('python') + $(if ($NoCamera) { @() } else { @('ffmpeg') })) {
  if (-not (Get-Command $t -ErrorAction SilentlyContinue)) {
    Say "  error: '$t' is not on PATH" 'Red'; exit 1
  }
}
if (-not $NoCamera -and -not (Test-Path $mediamtx)) {
  Say "  error: missing $mediamtx" 'Red'
  Say "         unzip mediamtx_v1.21.2_windows_amd64.zip into bin\" 'Yellow'
  exit 1
}

$tcp = @(8443, 8765); $udp = @()
if (-not $NoCamera) { $tcp += @(8554, 8889); $udp += 8189 }
if (-not (Test-PortsFree $tcp $udp -Force:$Force)) { exit 1 }

# ------------------------------------------------------------- V5 upload ----
if ($DeployV5) {
  $vexcom = Find-Vexcom
  if (-not $vexcom) {
    Say '  error: vexcom not found (is the VEX VS Code extension installed?)' 'Red'
    exit 1
  }
  # The admin interface (USB MI_00) is the one that accepts uploads; the user
  # interface (MI_02) is what run.py reads telemetry from.
  $admin = Get-CimInstance Win32_PnPEntity | Where-Object {
    $_.Name -match 'COM(\d+)' -and $_.PNPDeviceID -match 'VID_2888' -and
    $_.PNPDeviceID -match 'MI_00'
  } | Select-Object -First 1
  if (-not $admin -or $admin.Name -notmatch 'COM(\d+)') {
    Say '  error: no V5 admin port found - is the brain plugged in and on?' 'Red'
    exit 1
  }
  $port = 'COM' + $Matches[1]
  Say "  [v5]       uploading v5\main.py to slot 3 via $port" 'DarkGray'
  $staged = Join-Path $env:TEMP 'qteleop.py'   # brain shows the filename as the name
  Copy-Item (Join-Path $root 'v5\main.py') $staged -Force
  & $vexcom --slot 3 --write $staged $port | Out-Null
  if ($LASTEXITCODE -ne 0) { Say '  v5 upload FAILED' 'Red'; exit 1 }
  Say '  [v5]       uploaded. Open the jaws, then press Run on the brain.' 'Yellow'
}

# ------------------------------------------------------------------- run ----
try {
  if (-not $NoCamera) {
    # Working directory is server/ so relative paths in mediamtx.yml resolve.
    $procs += Launch 'mediamtx' $mediamtx @('mediamtx.yml') (Join-Path $root 'server')
    Say '  [mediamtx] starting' 'DarkGray'

    $ff = Get-CameraFfmpegArgs -Device $Device -AudioDevice $AudioDevice `
            -Width $Width -Height $Height -Fps $Fps -Bitrate $Bitrate `
            -Encoder $Encoder -Preset $Preset -H264Profile $H264Profile `
            -InputCodec $InputCodec -Test:$Test -ShowFfmpeg:$ShowFfmpeg
    if ($Test) { Say '  [ffmpeg]   TEST PATTERN (no camera)' 'Yellow' }
    else       { Say "  [ffmpeg]   '$Device' ${Width}x${Height}@$Fps -> $Encoder $Preset @ $Bitrate" 'DarkGray' }
    $procs += Launch 'ffmpeg' 'ffmpeg' $ff
  } else {
    Say '  [camera]   skipped (-NoCamera)' 'Yellow'
  }

  $srvArgs = @((Join-Path $root 'server\run.py'))
  if ($NoSerial) { $srvArgs += '--no-serial' }
  elseif ($Serial) { $srvArgs += @('--serial', $Serial) }
  $procs += Launch 'run.py' 'python' $srvArgs
  Say '  [run.py]   page + WS bridge + V5 serial' 'DarkGray'

  $ip = Get-HostIp
  Say ''
  Say '  On the Quest, open:' 'White'
  Say "      https://${ip}:8443" 'Cyan'
  Say '  Accept the certificate on BOTH that and:' 'DarkGray'
  Say "      https://${ip}:8765" 'DarkGray'
  if ($ip -notlike '192.168.137.*') {
    Say ''
    Say '  NOTE: Mobile Hotspot does not look active, so that is this PC on its' 'Yellow'
    Say '  normal network. Works only if the Quest is on the same network AND' 'Yellow'
    Say '  it allows client-to-client traffic - most campus Wi-Fi does not.' 'Yellow'
  }
  Say ''
  Say '  In the headset:  X = go live (starts held)   Y = passthrough <-> 360' 'DarkGray'
  Say '  Ctrl+C stops everything.' 'DarkGray'
  Say ''

  Watch-Procs $procs
}
finally {
  Say ''
  Say '  shutting down' 'DarkGray'
  Stop-Procs $procs
}
