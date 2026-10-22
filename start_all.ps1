<#
.SYNOPSIS
  THE command. Everything the rig needs, in one go.

.DESCRIPTION
  Does the one-time chores (only when they are actually outstanding), then
  launches three processes and ties their lifetimes together, so Ctrl+C stops
  everything:

    firewall   adds the inbound rules if missing - ONE UAC prompt, first run
               only. UDP 8189 especially: without it the page loads and the
               360 view stays black forever
    v5 upload  re-flashes slot 3 only when v5/main.py has actually changed,
               compared by hash against .v5_deployed
    run.py     HTTPS page (8443) + WHEP proxy + WSS bridge (8765) + V5 serial
    mediamtx   repackages the camera stream as WebRTC. No transcoding
    ffmpeg     Insta360 X5 over USB -> NVENC H.264 -> mediamtx

  The V5 program is uploaded but deliberately NOT started: it takes whatever
  position the jaws are in at startup as "fully open", so you must open the
  jaws and press Run on the brain yourself.

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
  [switch] $NoDeploy,             # don't upload v5/main.py even if it changed
  [switch] $NoFirewall,           # don't offer to add the inbound rules
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

# ------------------------------------------- firewall + V5, automatically ---
# Both are "set up once" chores, so they are folded in here rather than being
# separate commands you have to remember. Each is a no-op when already done.
if (-not $NoFirewall -and -not $NoCamera) { [void](Confirm-FirewallRules) }

$v5state = 'skipped'
if (-not $NoDeploy) {
  $v5state = Sync-V5Program $root 3
  switch ($v5state) {
    'uploaded'  { Say '  [v5]       main.py changed -> uploaded to slot 3' 'Green'
                  Say '             open the jaws, then press Run on the brain' 'Yellow' }
    'unchanged' { Say '  [v5]       slot 3 already matches main.py' 'DarkGray' }
    'failed'    { Say '  [v5]       upload FAILED - is the brain on and idle?' 'Red' }
    'skipped'   { Say '  [v5]       brain not detected, skipping upload' 'DarkGray' }
  }
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
