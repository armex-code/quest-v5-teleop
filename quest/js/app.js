// Quest → V5 teleop client (controllers only).
//
// Flow guided by the HUD, step by step:
//   connect → wake right controller → mark corner A → mark corner B → LIVE.
// Right controller = the pen: A/B mark the drawing-area corners, trigger =
// pen down, thumbstick click = clear trail. Left grip = move the twin.
//
// Visuals: translucent gridded panel spanning the calibrated drawing area
// with a live cursor dot (red while the pen is down), yellow corner markers,
// and the digital twin (solid = encoders, ghost = commanded, green trail).
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
let wsStatus = 'connecting';
let serialOk = false;
let serialMsg = 'waiting for server…';
let wsRetryMs = 1000;
let seq = 0;
let lastSend = 0;

// Calibration + smoothing state
const cal = { a: null, b: null };
let ema = null;        // smoothed {x, z} of the right controller
let lastRightY = 1.0;  // height of the right cursor (for the area visual)
let lastUV = null;

// Scene objects
let twin = null;
let lastTm = null;
let lastTipPos = null;
let areaVis = null;    // { group, cursor, halfX, halfZ, center }
let penNow = false;
let paused = false;    // X button: freeze the arm (server holds + raises pen)

checkSupport();
connectWS();

// ── WebSocket ────────────────────────────────────────────────────────────────

function connectWS() {
  const url = `wss://${location.hostname}:${WS_PORT}`;
  ws = new WebSocket(url);
  wsStatus = 'connecting';

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
      serialOk = !!msg.ok;
      serialMsg = msg.msg;
    }
  };
  ws.onclose = () => {
    wsStatus = 'retrying';
    serialOk = false;
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
      optionalFeatures: ['dom-overlay'],
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

  // In-scene HUD: canvas texture on a plane 0.65 m in front of the camera.
  hudCanvas = document.createElement('canvas');
  hudCanvas.width = 1100;
  hudCanvas.height = 560;
  hudCtx = hudCanvas.getContext('2d');
  hudTexture = new THREE.CanvasTexture(hudCanvas);
  const hudMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.44, 0.224),
    new THREE.MeshBasicMaterial({ map: hudTexture, transparent: true }),
  );
  hudMesh.position.set(0, -0.16, -0.65);
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
  // in the V5's IK frame forward is +x and lateral is +y.
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
    lastTipPos = null;
  }
}

// ── Drawing-area visual: gridded panel + corner markers + cursor dot ───────

function updateAreaVisuals() {
  if (areaVis) { scene.remove(areaVis.group); areaVis = null; }

  const group = new THREE.Group();
  const cornerMat = new THREE.MeshBasicMaterial({ color: 0xffd60a });
  for (const c of [cal.a, cal.b]) {
    if (!c) continue;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.014, 14, 10), cornerMat);
    m.position.set(c.x, c.y ?? 1.0, c.z);
    group.add(m);
  }

  let cursor = null, halfX = 0, halfZ = 0, center = null;
  if (cal.a && cal.b) {
    const dx = Math.abs(cal.b.x - cal.a.x);
    const dz = Math.abs(cal.b.z - cal.a.z);
    if (dx >= MIN_CAL_SIZE && dz >= MIN_CAL_SIZE) {
      const cx = (cal.a.x + cal.b.x) / 2;
      const cz = (cal.a.z + cal.b.z) / 2;
      const cy = ((cal.a.y ?? 1.0) + (cal.b.y ?? 1.0)) / 2;
      center = new THREE.Vector3(cx, cy, cz);
      halfX = dx / 2;
      halfZ = dz / 2;

      const panelGroup = new THREE.Group();
      panelGroup.position.copy(center);

      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(dx, dz),
        new THREE.MeshBasicMaterial({
          color: 0x38c0ff, transparent: true, opacity: 0.12,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      panel.rotation.x = -Math.PI / 2;
      panelGroup.add(panel);

      // Grid: 8 divisions each way, plus a brighter border.
      const gpts = [];
      const N = 8;
      for (let i = 0; i <= N; i++) {
        const fx = -halfX + (dx * i) / N;
        const fz = -halfZ + (dz * i) / N;
        gpts.push(new THREE.Vector3(fx, 0.001, -halfZ),
                  new THREE.Vector3(fx, 0.001, halfZ));
        gpts.push(new THREE.Vector3(-halfX, 0.001, fz),
                  new THREE.Vector3(halfX, 0.001, fz));
      }
      panelGroup.add(new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(gpts),
        new THREE.LineBasicMaterial({
          color: 0x38c0ff, transparent: true, opacity: 0.35,
        }),
      ));
      const border = [
        [-halfX, -halfZ], [halfX, -halfZ], [halfX, halfZ],
        [-halfX, halfZ], [-halfX, -halfZ],
      ].map(([x, z]) => new THREE.Vector3(x, 0.002, z));
      panelGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(border),
        new THREE.LineBasicMaterial({ color: 0x38c0ff }),
      ));

      // Cursor dot: where the arm is being told to go, projected on the panel.
      cursor = new THREE.Mesh(
        new THREE.SphereGeometry(0.011, 14, 10),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      cursor.position.y = 0.006;
      panelGroup.add(cursor);

      group.add(panelGroup);
      areaVis = { group, cursor, halfX, halfZ, center };
    }
  }
  if (!areaVis) areaVis = { group, cursor: null, halfX, halfZ, center };
  scene.add(group);
}

function updateAreaCursor() {
  if (!areaVis || !areaVis.cursor || !ema) return;
  const px = Math.max(-areaVis.halfX, Math.min(areaVis.halfX, ema.x - areaVis.center.x));
  const pz = Math.max(-areaVis.halfZ, Math.min(areaVis.halfZ, ema.z - areaVis.center.z));
  areaVis.cursor.position.set(px, 0.006, pz);
  areaVis.cursor.material.color.setHex(
    paused ? 0x8e8e93 : penNow ? 0xff3b30 : 0xffffff);
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

// Smooth the cursor, stream the pose.
function updateRightCursor(x, z, penDown, time, y) {
  if (y !== undefined) lastRightY = y;
  penNow = penDown;
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
      pen: penDown && !paused ? 1 : 0,
      ts: Math.round(time * 10) / 10,
    };
    // While paused, u/v are withheld: the server holds position + raises pen.
    if (lastUV && !paused) { msg.u = round4(lastUV.u); msg.v = round4(lastUV.v); }
    wsSend(msg);
  }
}

function setCorner(which) {
  if (!ema) return;
  cal[which] = { x: ema.x, z: ema.z, y: lastRightY };
  wsSend({ t: 'cal', c: which, x: round3(ema.x), z: round3(ema.z) });
  updateAreaVisuals();
}

// ── Frame loop ───────────────────────────────────────────────────────────────

function onFrame(time, frame) {
  let rightSeen = false;

  if (frame) {
    const ref = renderer.xr.getReferenceSpace();
    markers.left.visible = false;
    markers.right.visible = false;

    for (const src of frame.session.inputSources) {
      const hand = src.handedness;
      if (hand !== 'left' && hand !== 'right') continue;
      if (!src.gamepad) continue; // controllers only

      const gp = src.gamepad;
      const btn = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
      const trigger = btn(0);
      const pose = frame.getPose(src.targetRaySpace, ref);
      if (!pose) continue;

      const p = pose.transform.position;
      const marker = markers[hand];
      marker.position.set(p.x, p.y, p.z);
      marker.visible = true;
      marker.material.color.setHex(
        trigger ? 0xff3b30 : hand === 'right' ? 0x34c759 : 0x3a86ff);

      if (hand === 'right') {
        rightSeen = true;
        updateRightCursor(p.x, p.z, trigger, time, p.y);
        if (risingEdge('right', 4, btn(4))) setCorner('a'); // A button
        if (risingEdge('right', 5, btn(5))) setCorner('b'); // B button
        if (risingEdge('right', 3, btn(3))) clearTrail();   // stick click
      }

      if (hand === 'left') {
        if (risingEdge('left', 4, btn(4))) paused = !paused; // X → pause/resume
        if (btn(1) && twin) { // grip held → carry the twin
          twin.group.position.set(p.x, p.y, p.z);
        }
      }
    }
  }

  updateTwin();
  updateAreaCursor();

  if (time - lastHudDraw > HUD_REDRAW_MS) {
    drawHud(buildHudModel(rightSeen));
    lastHudDraw = time;
  }
  renderer.render(scene, camera);
}

// ── HUD ──────────────────────────────────────────────────────────────────────

function buildHudModel(rightSeen) {
  const m = {
    wsOk: wsStatus === 'connected',
    v5Ok: serialOk,
    pen: penNow,
    tm: lastTm,
    uv: lastUV,
  };

  if (!m.wsOk) {
    m.step = 'CONNECTING TO PC…';
    m.lines = [
      'If this never turns green:',
      `visit https://${location.hostname}:${WS_PORT} once`,
      'and accept the certificate, then reload.',
    ];
  } else if (!rightSeen) {
    m.step = 'WAKE THE RIGHT CONTROLLER';
    m.lines = ['Press any button on it.'];
  } else if (!cal.a) {
    m.step = 'STEP 1 OF 2 — MARK CORNER A';
    m.lines = [
      'Hold the RIGHT controller at the NEAR-LEFT',
      'corner of your drawing area, then press A.',
    ];
  } else if (!cal.b) {
    m.step = 'STEP 2 OF 2 — MARK CORNER B';
    m.lines = [
      'Move to the FAR-RIGHT corner (further away',
      'AND to the right), then press B.',
      'The arm goes LIVE when you press B!',
    ];
  } else if (!lastUV) {
    m.step = 'CORNERS TOO CLOSE — REDO';
    m.lines = [
      'The two corners must differ by 5 cm or more',
      'both left-right and near-far.',
      'Press A and B again at better spots.',
    ];
  } else if (paused) {
    m.paused = true;
    m.step = 'PAUSED — ARM HOLDING';
    m.lines = ['Press X (left controller) to resume.'];
  } else {
    m.live = true;
    m.step = m.pen ? 'DRAWING' : 'LIVE — ARM FOLLOWS YOUR HAND';
    m.lines = [
      'Stay inside the blue panel. Trigger = pen.',
      'X: pause   A/B: redo corners   R-stick: clear trail',
    ];
  }
  return m;
}

function drawHud(m) {
  const ctx = hudCtx;
  const W = hudCanvas.width, H = hudCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(10, 14, 18, 0.78)';
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 30);
  ctx.fill();

  // Status chips
  const chip = (x, label, ok, okText, badText) => {
    ctx.beginPath();
    ctx.arc(x, 52, 13, 0, Math.PI * 2);
    ctx.fillStyle = ok ? '#34c759' : '#ff453a';
    ctx.fill();
    ctx.fillStyle = '#e8edf2';
    ctx.font = '600 34px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${label} ${ok ? okText : badText}`, x + 28, 54);
  };
  chip(48, 'PC', m.wsOk, 'connected', 'offline');
  chip(430, 'ROBOT', m.v5Ok, 'connected', 'offline');
  if (m.live) {
    ctx.beginPath();
    ctx.arc(830, 52, 13, 0, Math.PI * 2);
    ctx.fillStyle = m.pen ? '#ff453a' : '#8e8e93';
    ctx.fill();
    ctx.fillStyle = '#e8edf2';
    ctx.fillText(`PEN ${m.pen ? 'DOWN' : 'up'}`, 858, 54);
  }

  ctx.strokeStyle = 'rgba(232,237,242,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(36, 96); ctx.lineTo(W - 36, 96); ctx.stroke();

  // Step banner
  ctx.fillStyle = m.live ? '#34c759' : m.paused ? '#ff9f0a' : '#38c0ff';
  ctx.font = '800 56px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(m.step, 48, 130);

  // Instructions
  ctx.fillStyle = '#e8edf2';
  ctx.font = '400 40px system-ui, sans-serif';
  (m.lines || []).forEach((line, i) => ctx.fillText(line, 48, 216 + i * 56));

  // Telemetry footer
  ctx.fillStyle = 'rgba(232,237,242,0.55)';
  ctx.font = '400 30px ui-monospace, monospace';
  const foot = [];
  if (m.tm) foot.push(`arm q1 ${m.tm.q[0].toFixed(1)}°  q2 ${m.tm.q[1].toFixed(1)}°`);
  if (m.uv) foot.push(`pos ${(m.uv.v * 100).toFixed(0)}%,${(m.uv.u * 100).toFixed(0)}%`);
  foot.push('L-grip: move twin');
  ctx.fillText(foot.join('    '), 48, H - 62);

  hudTexture.needsUpdate = true;
  readoutEl.textContent = `${m.step}\n${(m.lines || []).join('\n')}`;
}

function onSessionEnd() {
  renderer.setAnimationLoop(null);
  readoutEl.style.display = 'none';
  startBtn.disabled = false;
  setStatus('AR session ended. Tap Enter AR to restart.');
}

function round3(n) { return Math.round(n * 1000) / 1000; }
function round4(n) { return Math.round(n * 10000) / 10000; }

function setStatus(msg) {
  statusEl.textContent = msg;
}
