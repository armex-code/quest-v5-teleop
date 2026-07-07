// Quest → V5 teleop client (M1–M5 in one page).
//
// - immersive-ar passthrough session, HUD (in-scene canvas + dom-overlay)
// - WebSocket to the host bridge (wss://<same-host>:8765), auto-reconnect
// - 2-corner calibration: hold RIGHT controller at the NEAR-LEFT corner of the
//   drawing area and press A, then at the FAR-RIGHT corner and press B.
//   After that, poses stream as u,v ∈ [0,1] at 25 Hz and the arm follows.
// - RIGHT trigger = pen down. LEFT grip (squeeze) = grab/move the twin.
//   RIGHT thumbstick click = clear the pen trail.
// - Digital twin: solid arm = encoder telemetry, translucent ghost = commanded
//   angles, green trail = pen-down path of the solid tip.
import * as THREE from 'three';

const startBtn = document.getElementById('start');
const statusEl = document.getElementById('status');
const readoutEl = document.getElementById('readout');
const overlayRoot = document.getElementById('overlay');

const HUD_REDRAW_MS = 100;   // 10 Hz is plenty for text
const WS_PORT = 8765;
const SEND_INTERVAL_MS = 40; // 25 Hz pose stream
const EMA_ALPHA = 0.18;      // pose smoothing (higher = snappier)
const TWIN_Q_SIGN = -1;      // set to 1 if the twin mirrors the real arm
const TWIN_SCALE = 0.006;    // meters per arm-cm → ~31 cm twin for a 51 cm arm
const TRAIL_MAX = 4000;      // points
const MIN_CAL_SIZE = 0.05;   // corners closer than 5 cm on an axis = invalid

let renderer, scene, camera;
let hudCanvas, hudCtx, hudTexture;
let lastHudDraw = 0;
const markers = { left: null, right: null };
const prevButtons = { left: {}, right: {} };

// Arm geometry (cm) — defaults match v5/main.py; overwritten by "cfg" msg.
let cfg = { l1: 20.5, l2: 30.5, ws: [-10.5, 10.5, 18, 48] };

// WebSocket state
let ws = null;
let wsStatus = 'connecting…';
let serialStatus = '?';
let wsRetryMs = 1000;
let seq = 0;
let lastSend = 0;

// Calibration + smoothing state
const cal = { a: null, b: null };
let ema = null; // smoothed {x, z} of the right controller
let lastRightY = 1.0; // height of the right cursor (for the area visual)
let lastUV = null;

// Twin state
let twin = null; // { group, solid:{shoulder,elbow,tip}, ghost:{...}, trail:{...} }
let lastTm = null;
let lastTipPos = null;

checkSupport();
connectWS();

// ── WebSocket ────────────────────────────────────────────────────────────────

function connectWS() {
  const url = `wss://${location.hostname}:${WS_PORT}`;
  ws = new WebSocket(url);
  wsStatus = 'connecting…';

  ws.onopen = () => {
    wsStatus = 'connected';
    wsRetryMs = 1000;
    seq = 0; // fresh sequence space per connection (see PROTOCOL.md)
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === 'tm') {
      lastTm = msg;
    } else if (msg.t === 'cfg') {
      const changed = msg.l1 !== cfg.l1 || msg.l2 !== cfg.l2;
      cfg = { l1: msg.l1, l2: msg.l2, ws: msg.ws || cfg.ws };
      if (changed && twin) buildTwin();
    } else if (msg.t === 'st') {
      serialStatus = msg.msg;
    }
  };
  ws.onclose = () => {
    wsStatus = `retry in ${(wsRetryMs / 1000).toFixed(0)}s`;
    setTimeout(connectWS, wsRetryMs);
    wsRetryMs = Math.min(wsRetryMs + 1000, 5000);
  };
  ws.onerror = () => ws.close();
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── WebXR session ────────────────────────────────────────────────────────────

async function checkSupport() {
  if (!window.isSecureContext) {
    setStatus('Not a secure context — WebXR requires HTTPS. See docs/HTTPS_SETUP.md.');
    return;
  }
  if (!navigator.xr) {
    setStatus('navigator.xr is missing — open this page in the Meta Quest Browser.');
    return;
  }
  const supported = await navigator.xr.isSessionSupported('immersive-ar');
  if (!supported) {
    setStatus('immersive-ar not supported on this device/browser.');
    return;
  }
  setStatus('Ready. Put the headset on and tap Enter AR.');
  startBtn.disabled = false;
  startBtn.addEventListener('click', enterAR);
}

async function enterAR() {
  startBtn.disabled = true;
  setStatus('Requesting AR session…');
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['dom-overlay', 'hand-tracking'],
      domOverlay: { root: overlayRoot },
    });
  } catch (err) {
    setStatus('requestSession failed: ' + err.message);
    startBtn.disabled = false;
    return;
  }

  if (!renderer) initScene();
  readoutEl.style.display = 'block';
  renderer.xr.setReferenceSpaceType('local-floor');
  await renderer.xr.setSession(session);
  session.addEventListener('end', onSessionEnd);
  renderer.setAnimationLoop(onFrame);
}

function initScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 50);
  scene.add(camera); // required so HUD children of the camera render

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  const light = new THREE.HemisphereLight(0xffffff, 0x445566, 2.4);
  scene.add(light);

  // In-scene HUD: canvas texture on a plane 0.6 m in front of the camera.
  hudCanvas = document.createElement('canvas');
  hudCanvas.width = 1024;
  hudCanvas.height = 480;
  hudCtx = hudCanvas.getContext('2d');
  hudTexture = new THREE.CanvasTexture(hudCanvas);
  const hudMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.42, 0.197),
    new THREE.MeshBasicMaterial({ map: hudTexture, transparent: true }),
  );
  hudMesh.position.set(0, -0.15, -0.6);
  camera.add(hudMesh);

  // One sphere per controller; red while its trigger is held.
  for (const hand of ['left', 'right']) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.02, 16, 12),
      new THREE.MeshBasicMaterial(),
    );
    m.visible = false;
    scene.add(m);
    markers[hand] = m;
  }

  buildTwin();
}

// ── Digital twin ─────────────────────────────────────────────────────────────

function makeArm(solid) {
  // Arm frame → twin local: arm-x → +x, arm-y → −z, joints rotate about +y.
  // rotation.y = θ maps +X to (cosθ, 0, −sinθ), which is exactly arm (cosθ, sinθ).
  const S = TWIN_SCALE;
  const mat = (color) => new THREE.MeshStandardMaterial(
    solid
      ? { color, roughness: 0.5 }
      : { color, transparent: true, opacity: 0.3, depthWrite: false });

  const linkMesh = (lenCm, color) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(lenCm * S, 0.014, 0.02), mat(color));
    m.position.x = (lenCm * S) / 2;
    return m;
  };

  const shoulder = new THREE.Group();
  shoulder.add(linkMesh(cfg.l1, solid ? 0x3a86ff : 0x9bbcff));
  shoulder.add(new THREE.Mesh(new THREE.SphereGeometry(0.016, 16, 12),
    mat(0x8899aa)));

  const elbow = new THREE.Group();
  elbow.position.x = cfg.l1 * S;
  elbow.add(linkMesh(cfg.l2, solid ? 0x34c759 : 0xa5e8b8));
  elbow.add(new THREE.Mesh(new THREE.SphereGeometry(0.013, 16, 12),
    mat(0x8899aa)));
  shoulder.add(elbow);

  const tip = new THREE.Object3D();
  tip.position.x = cfg.l2 * S;
  elbow.add(tip);
  const tipMesh = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 10),
    mat(solid ? 0xff3b30 : 0xffb4ae));
  tip.add(tipMesh);

  return { shoulder, elbow, tip };
}

function buildTwin() {
  const S = TWIN_SCALE;
  const old = twin;
  if (old) scene.remove(old.group);

  const group = new THREE.Group();
  // Float in front of where the user started; move it with LEFT grip.
  group.position.set(old ? old.group.position.x : 0.35,
                     old ? old.group.position.y : 1.05,
                     old ? old.group.position.z : -0.55);
  // IK frame: +x is "forward" (the 18–48 cm band). Point it away from the user.
  group.rotation.y = Math.PI / 2;

  // Base plate sized to the arm's reach.
  const reach = (cfg.l1 + cfg.l2 + 3) * S;
  const plate = new THREE.Mesh(
    new THREE.CylinderGeometry(reach, reach, 0.004, 48),
    new THREE.MeshStandardMaterial({
      color: 0x1b222b, transparent: true, opacity: 0.75, roughness: 0.9,
    }),
  );
  plate.position.y = -0.004;
  group.add(plate);

  // Workspace rectangle. cfg.ws is [lat_min, lat_max, fwd_min, fwd_max] in cm;
  // in the V5's IK frame (the frame q1/q2 live in) forward is +x and lateral
  // is +y, so build the rect as (fwd, lat) pairs.
  const [latMin, latMax, fwdMin, fwdMax] = cfg.ws;
  const rectPts = [
    [fwdMin, latMin], [fwdMax, latMin], [fwdMax, latMax],
    [fwdMin, latMax], [fwdMin, latMin],
  ].map(([x, y]) => new THREE.Vector3(x * S, 0.002, -y * S));
  group.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(rectPts),
    new THREE.LineBasicMaterial({ color: 0xffd60a }),
  ));

  const solid = makeArm(true);
  const ghost = makeArm(false);
  group.add(solid.shoulder);
  group.add(ghost.shoulder);

  // Pen trail: preallocated line, grows via drawRange.
  const trailPos = new Float32Array(TRAIL_MAX * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setDrawRange(0, 0);
  const trailLine = new THREE.Line(
    trailGeo, new THREE.LineBasicMaterial({ color: 0x34c759 }));
  trailLine.frustumCulled = false;
  group.add(trailLine);

  scene.add(group);
  twin = {
    group, solid, ghost,
    trail: { geo: trailGeo, pos: trailPos, count: 0 },
  };
  lastTipPos = null;
}

function clearTrail() {
  if (!twin) return;
  twin.trail.count = 0;
  twin.trail.geo.setDrawRange(0, 0);
  lastTipPos = null;
}

const _tipWorld = new THREE.Vector3();

function updateTwin() {
  if (!twin || !lastTm) return;
  const d2r = (deg) => THREE.MathUtils.degToRad(deg) * TWIN_Q_SIGN;
  twin.solid.shoulder.rotation.y = d2r(lastTm.q[0]);
  twin.solid.elbow.rotation.y = d2r(lastTm.q[1]);
  twin.ghost.shoulder.rotation.y = d2r(lastTm.qc[0]);
  twin.ghost.elbow.rotation.y = d2r(lastTm.qc[1]);

  if (lastTm.pen) {
    twin.solid.tip.getWorldPosition(_tipWorld);
    const p = twin.group.worldToLocal(_tipWorld.clone());
    p.y = 0.003; // pin the trail just above the plate
    if (!lastTipPos || lastTipPos.distanceTo(p) > 0.0008) {
      const t = twin.trail;
      if (t.count < TRAIL_MAX) {
        t.pos.set([p.x, p.y, p.z], t.count * 3);
        t.count += 1;
        t.geo.setDrawRange(0, t.count);
        t.geo.attributes.position.needsUpdate = true;
      }
      lastTipPos = p;
    }
  } else {
    lastTipPos = null; // next pen-down starts a fresh segment… visually close enough
  }
}

// ── Calibration + pose streaming ────────────────────────────────────────────

function calibratedUV() {
  if (!cal.a || !cal.b || !ema) return null;
  const dx = cal.b.x - cal.a.x;
  const dz = cal.b.z - cal.a.z;
  if (Math.abs(dx) < MIN_CAL_SIZE || Math.abs(dz) < MIN_CAL_SIZE) return null;
  // u = depth (arm forward, serial field 1), v = lateral (serial field 2).
  const u = clamp01((ema.z - cal.a.z) / dz);
  const v = clamp01((ema.x - cal.a.x) / dx);
  return { u, v };
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function risingEdge(hand, idx, pressed) {
  const was = !!prevButtons[hand][idx];
  prevButtons[hand][idx] = pressed;
  return pressed && !was;
}

// Shared by controller and hand input: smooth the cursor, stream the pose.
function updateRightCursor(x, z, penDown, time, y) {
  if (y !== undefined) lastRightY = y;
  ema = ema
    ? { x: ema.x + EMA_ALPHA * (x - ema.x),
        z: ema.z + EMA_ALPHA * (z - ema.z) }
    : { x, z };
  lastUV = calibratedUV();
  if (time - lastSend >= SEND_INTERVAL_MS) {
    lastSend = time;
    const msg = {
      t: 'p', s: ++seq,
      x: round3(ema.x), z: round3(ema.z),
      pen: penDown ? 1 : 0,
      ts: Math.round(time * 10) / 10,
    };
    if (lastUV) { msg.u = round4(lastUV.u); msg.v = round4(lastUV.v); }
    wsSend(msg);
  }
}

function setCorner(which) {
  if (!ema) return;
  cal[which] = { x: ema.x, z: ema.z, y: lastRightY };
  wsSend({ t: 'cal', c: which, x: round3(ema.x), z: round3(ema.z) });
  updateCalArea();
}

// ── Control-area visual: translucent panel spanning the calibrated rect ─────

let calArea = null;

function updateCalArea() {
  if (calArea) { scene.remove(calArea); calArea = null; }
  if (!cal.a || !cal.b) return;
  const dx = Math.abs(cal.b.x - cal.a.x);
  const dz = Math.abs(cal.b.z - cal.a.z);
  if (dx < MIN_CAL_SIZE || dz < MIN_CAL_SIZE) return;

  const cx = (cal.a.x + cal.b.x) / 2;
  const cz = (cal.a.z + cal.b.z) / 2;
  const cy = ((cal.a.y ?? 1.0) + (cal.b.y ?? 1.0)) / 2;

  calArea = new THREE.Group();
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(dx, dz),
    new THREE.MeshBasicMaterial({
      color: 0x38c0ff, transparent: true, opacity: 0.14,
      side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  panel.rotation.x = -Math.PI / 2;
  calArea.add(panel);
  const border = [
    [-dx / 2, -dz / 2], [dx / 2, -dz / 2], [dx / 2, dz / 2],
    [-dx / 2, dz / 2], [-dx / 2, -dz / 2],
  ].map(([x, z]) => new THREE.Vector3(x, 0.001, z));
  calArea.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(border),
    new THREE.LineBasicMaterial({ color: 0x38c0ff }),
  ));
  calArea.position.set(cx, cy, cz);
  scene.add(calArea);
}

// ── Hand-tracking input (controller-free fallback) ──────────────────────────
// Right hand: index fingertip = cursor, thumb–index pinch = pen down.
// Left hand pinches (thumb against a fingertip):
//   index = corner A, middle = corner B, ring (hold) = move twin,
//   pinky = clear trail.

const PINCH_ON = 0.022;   // meters; hysteresis so the pen doesn't chatter
const PINCH_OFF = 0.035;
const pinchState = { left: {}, right: {} };

function jointPos(frame, ref, xrHand, name) {
  const joint = xrHand.get(name);
  if (!joint) return null;
  const pose = frame.getJointPose(joint, ref);
  return pose ? pose.transform.position : null;
}

function pinchDetect(handedness, finger, thumbP, fingerP) {
  const st = pinchState[handedness];
  if (!thumbP || !fingerP) return { on: !!st[finger], edge: false };
  const d = Math.hypot(thumbP.x - fingerP.x, thumbP.y - fingerP.y,
                       thumbP.z - fingerP.z);
  const on = st[finger] ? d < PINCH_OFF : d < PINCH_ON;
  const edge = on && !st[finger];
  st[finger] = on;
  return { on, edge };
}

function processHand(src, handedness, frame, ref, time, lines) {
  const h = src.hand;
  const thumb = jointPos(frame, ref, h, 'thumb-tip');
  const index = jointPos(frame, ref, h, 'index-finger-tip');
  const tag = handedness === 'right' ? 'R✋' : 'L✋';
  if (!index) {
    lines.push(`${tag} tracking lost`);
    return;
  }
  const pIndex = pinchDetect(handedness, 'index', thumb, index);

  const marker = markers[handedness];
  marker.position.set(index.x, index.y, index.z);
  marker.visible = true;
  marker.material.color.setHex(
    pIndex.on ? 0xff3b30 : handedness === 'right' ? 0x34c759 : 0x3a86ff);

  if (handedness === 'right') {
    updateRightCursor(index.x, index.z, pIndex.on, time, index.y);
    lines.push(`${tag} x ${fmt(index.x)}  z ${fmt(index.z)}   pen ${pIndex.on ? 'DOWN' : 'up'}`);
  } else {
    const pMiddle = pinchDetect('left', 'middle', thumb,
      jointPos(frame, ref, h, 'middle-finger-tip'));
    const pRing = pinchDetect('left', 'ring', thumb,
      jointPos(frame, ref, h, 'ring-finger-tip'));
    const pPinky = pinchDetect('left', 'pinky', thumb,
      jointPos(frame, ref, h, 'pinky-finger-tip'));

    if (pIndex.edge) setCorner('a');   // corner marked at the RIGHT cursor
    if (pMiddle.edge) setCorner('b');
    if (pRing.on && twin) twin.group.position.set(index.x, index.y, index.z);
    if (pPinky.edge) clearTrail();
  }
}

// ── Frame loop ───────────────────────────────────────────────────────────────

function onFrame(time, frame) {
  const lines = [];
  lines.push(`WS ${wsStatus}   V5: ${serialStatus}`);

  if (frame) {
    const ref = renderer.xr.getReferenceSpace();
    markers.left.visible = false;
    markers.right.visible = false;

    let handMode = false;
    for (const src of frame.session.inputSources) {
      const hand = src.handedness;
      if (hand !== 'left' && hand !== 'right') continue;

      if (src.hand) { // bare-hand tracking (no controller)
        handMode = true;
        processHand(src, hand, frame, ref, time, lines);
        continue;
      }

      const gp = src.gamepad;
      const btn = (i) => !!(gp && gp.buttons[i] && gp.buttons[i].pressed);
      const trigger = btn(0);
      const pose = frame.getPose(src.targetRaySpace, ref);

      if (pose) {
        const p = pose.transform.position;
        const marker = markers[hand];
        marker.position.set(p.x, p.y, p.z);
        marker.visible = true;
        marker.material.color.setHex(
          trigger ? 0xff3b30 : hand === 'right' ? 0x34c759 : 0x3a86ff);

        if (hand === 'right') {
          updateRightCursor(p.x, p.z, trigger, time, p.y);
          if (risingEdge('right', 4, btn(4))) setCorner('a'); // A button
          if (risingEdge('right', 5, btn(5))) setCorner('b'); // B button
          if (risingEdge('right', 3, btn(3))) clearTrail();   // stick click
          lines.push(`R  x ${fmt(p.x)}  z ${fmt(p.z)}   pen ${trigger ? 'DOWN' : 'up'}`);
        }

        if (hand === 'left') {
          if (btn(1) && twin) { // grip held → carry the twin
            twin.group.position.set(p.x, p.y, p.z);
          }
        }
      } else {
        lines.push(`${hand === 'right' ? 'R' : 'L'}  tracking lost`);
      }
    }

    const markA = handMode ? 'L✋ index-pinch' : 'press A';
    const markB = handMode ? 'L✋ middle-pinch' : 'press B';
    if (!cal.a) {
      lines.push(`CAL: hold R cursor at NEAR-LEFT corner, ${markA}`);
    } else if (!cal.b) {
      lines.push(`CAL: corner A set — R cursor at FAR-RIGHT corner, ${markB}`);
    } else if (!lastUV) {
      lines.push('CAL: corners too close — redo both (≥ 5 cm apart)');
    } else {
      lines.push(`CAL ok   u ${lastUV.u.toFixed(3)}  v ${lastUV.v.toFixed(3)}`);
    }

    lines.push(lastTm
      ? `TWIN q1 ${lastTm.q[0].toFixed(1)}°  q2 ${lastTm.q[1].toFixed(1)}°`
        + `   cmd ${lastTm.qc[0].toFixed(1)}° ${lastTm.qc[1].toFixed(1)}°`
      : 'TWIN no telemetry yet');
    lines.push(handMode
      ? 'R pinch: pen | L pinch: index=A mid=B ring=move-twin pinky=clear'
      : 'L-grip: move twin   R-stick click: clear trail');
  }

  updateTwin();

  if (time - lastHudDraw > HUD_REDRAW_MS) {
    drawHud(lines);
    lastHudDraw = time;
  }
  renderer.render(scene, camera);
}

// ── HUD / misc ───────────────────────────────────────────────────────────────

function drawHud(lines) {
  const ctx = hudCtx;
  ctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
  ctx.fillStyle = 'rgba(10, 14, 18, 0.72)';
  ctx.beginPath();
  ctx.roundRect(0, 0, hudCanvas.width, hudCanvas.height, 28);
  ctx.fill();
  ctx.font = '40px ui-monospace, monospace';
  ctx.fillStyle = '#e8edf2';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, 36, 28 + i * 54));
  hudTexture.needsUpdate = true;
  readoutEl.textContent = lines.join('\n');
}

function onSessionEnd() {
  renderer.setAnimationLoop(null);
  readoutEl.style.display = 'none';
  startBtn.disabled = false;
  setStatus('AR session ended. Tap Enter AR to restart.');
}

function fmt(n) {
  return (n >= 0 ? '+' : '') + n.toFixed(3);
}

function round3(n) { return Math.round(n * 1000) / 1000; }
function round4(n) { return Math.round(n * 10000) / 10000; }

function setStatus(msg) {
  statusEl.textContent = msg;
}
