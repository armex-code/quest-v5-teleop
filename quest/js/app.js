// Quest → V5 teleop client (controllers only, fixed drawing panel).
//
// No calibration: a gridded panel with the SAME proportions as the robot's
// workspace (the yellow rectangle on the twin, scaled by PANEL_SCALE) appears
// in front of the user and is immediately live. Controls:
//   RIGHT controller = the end effector. Trigger held = gripper closed.
//   A               = move the panel to the controller (re-place it anywhere)
//   R-stick click   = clear the twin's carry trail
//   X (left)        = pause / resume (arm and gripper both hold as-is)
//   LEFT grip hold  = carry the digital twin
//   LEFT stick ◄ ►  = rotate the twin to match the real robot on the table
//
// Two worlds, switchable INSIDE the session with Y — no reload, no dropping
// out of VR:
//   passthrough  you are in the room with the robot
//   360 camera   a live Insta360 feed surrounds you, for operating remotely
//
// Both run in a single `immersive-ar` session. A headset cannot change session
// type in place, so instead of ending and restarting one (which dumps you back
// to the browser), we always request AR and simply show or hide an opaque
// sphere: opaque geometry covers passthrough completely, which is all "VR
// mode" ever actually meant here. Toggling is one visible flag.
//
// ?mode= only chooses which world you START in.
import * as THREE from 'three';
import { Pano } from './pano.js';
import { ControllerModel } from './controllers.js';

const params = new URLSearchParams(location.search);
const START_MODE = params.get('mode') === 'vr' ? 'vr' : 'ar';
const XR_MODE = 'immersive-ar';
let pano = null;
let panoShown = false;   // live state; starts from START_MODE on entry

const startBtn = document.getElementById('start');
const statusEl = document.getElementById('status');
const readoutEl = document.getElementById('readout');
const overlayRoot = document.getElementById('overlay');

const HUD_REDRAW_MS = 100;   // 10 Hz is plenty for text
const WS_PORT = 8765;
const SEND_INTERVAL_MS = 40; // 25 Hz pose stream
const EMA_ALPHA = 0.18;      // pose smoothing (higher = snappier)
const TWIN_Q_SIGN = -1;      // set to 1 if the twin mirrors the real arm
const TWIN_YAW_DEG = 90;     // default twin orientation; L-stick adjusts live
const TWIN_SCALE = 0.006;    // meters per arm-cm → ~31 cm twin for a 51 cm arm
// Height of the tower the arm is mounted on, in arm-cm. Eyeballed from a
// photo of the real build — adjust to taste, it is purely cosmetic and does
// not affect the kinematics.
const TWIN_BASE_CM = 22;
// Panel = workspace size x this. Two independent "bigger" knobs, don't
// confuse them: PANEL_SCALE makes the *hand* area bigger (you move further
// for the same robot motion, so control gets finer and your arm works
// harder), while the WORKSPACE in v5/main.py is what the *robot* can reach.
// With the 48 x 15 cm workspace, 1.8 gives a ~86 x 27 cm panel.
const PANEL_SCALE = 1.8;
// Grid cell = this many cm of real workspace, so counting cells is a distance.
const GRID_CM = 5;
const PANEL_POS = [0, 1.0, -0.45]; // default panel spot (relative to start)
const TRAIL_MAX = 4000;      // points

let renderer, scene, camera;
let hudCanvas, hudCtx, hudTexture;
let lastHudDraw = 0;
const markers = { left: null, right: null };
const ctlModels = { left: null, right: null };
const prevButtons = { left: {}, right: {} };

// Arm geometry (cm) — defaults match v5/main.py; overwritten by "cfg" msg.
// swap=1: the server transposes u/v for the robot's physical orientation, so
// the panel is built transposed too (its long axis = the workspace long axis).
let cfg = { l1: 20.5, l2: 30.5, ws: [-24, 24, 26, 41], swap: 1, fu: 0, fv: 1 };

// WebSocket state
let ws = null;
let wsStatus = 'connecting';
let serialOk = false;
let serialMsg = 'waiting for server…';
let wsRetryMs = 1000;
let seq = 0;
let lastSend = 0;

// Cursor / control state
let ema = null;        // smoothed {x, z} of the right controller
let lastUV = null;
let gripNow = false;
// SAFE START: begin held, never live on entry. Walking into a session with
// the arm already chasing your hand is how you get a surprise lunge — the
// panel lands wherever you happen to be standing and the arm snaps to it.
// Paused withholds u,v entirely, so the server never gets a pose to act on
// and no serial frame is sent at all until you deliberately go live.
let paused = true;
let armed = false;     // false until the first unpause — changes the HUD copy

// Scene objects
let twin = null;
let twinYaw = THREE.MathUtils.degToRad(TWIN_YAW_DEG);
let lastTm = null;
let lastTipPos = null;
let jawT = 1;          // eased jaw opening, 0 = shut, 1 = open
let panel = null;      // { group, cursor, halfW, halfD }
const ctlCards = { left: null, right: null }; // floating button guides

// Guarded: this runs at module top level, so a missing element would throw
// and take the whole client down before checkSupport() ever runs.
document.getElementById('mode-' + START_MODE)?.classList.add('on');
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
      const next = { l1: msg.l1, l2: msg.l2, ws: msg.ws || cfg.ws,
                     swap: msg.swap ?? cfg.swap,
                     fu: msg.fu ?? cfg.fu, fv: msg.fv ?? cfg.fv };
      const changed = JSON.stringify(next) !== JSON.stringify(cfg);
      cfg = next;
      if (changed && renderer) { buildTwin(); buildPanel(); }
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
  const supported = await navigator.xr.isSessionSupported(XR_MODE);
  if (!supported) {
    setStatus(`${XR_MODE} not supported on this device/browser.`);
    return;
  }
  startBtn.textContent = 'Enter';
  setStatus('Ready. Put the headset on and tap Enter. '
    + 'Y on the left controller swaps between passthrough and the 360 camera.');
  startBtn.disabled = false;
  startBtn.addEventListener('click', enterAR);
}

async function enterAR() {
  startBtn.disabled = true;
  setStatus(`Requesting ${XR_MODE} session…`);
  let session;
  try {
    session = await navigator.xr.requestSession(XR_MODE, {
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
  pano.applyRendererSettings(renderer); // must precede setSession
  setWorld(START_MODE === 'vr');
  await renderer.xr.setSession(session);
  session.addEventListener('end', onSessionEnd);
  renderer.setAnimationLoop(onFrame);
}

/**
 * Show or hide the 360 world. Instant — no session teardown, no reload, you
 * never leave the headset view.
 *
 * The WHEP connection is made lazily on first show and then kept, so staying
 * in passthrough costs no bandwidth, and flipping back and forth afterwards
 * does not re-handshake.
 */
function setWorld(showPano) {
  panoShown = showPano;
  pano.mesh.visible = showPano;
  if (showPano && pano.status === 'idle') pano.connect();
}

function toggleWorld() { setWorld(!panoShown); }

function initScene() {
  scene = new THREE.Scene();
  // Far plane must clear the panorama sphere (radius 500) or it is clipped
  // away entirely. Harmless for the close-up scene: with near = 0.01 the
  // depth resolution at 1 m is still ~6 micrometres, far finer than the
  // ~1 mm offsets the twin and panel rely on.
  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 2000);
  scene.add(camera); // required so HUD children of the camera render

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  const light = new THREE.HemisphereLight(0xffffff, 0x445566, 2.4);
  scene.add(light);

  // Always built, shown only on demand. Construction is cheap (one sphere)
  // and no WHEP handshake happens until the 360 world is first shown.
  pano = new Pano(scene, {
    radius: parseFloat(params.get('radius')) || undefined,
    fbScale: parseFloat(params.get('fbscale')) || undefined,
    yawDeg: parseFloat(params.get('yaw')) || 0,
    rollDeg: parseFloat(params.get('roll')) || 0,
    anchor: params.get('anchor') || 'head',
  });
  pano.mesh.visible = false;

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

  // One sphere per controller at the *pointer* tip; red while trigger held.
  for (const hand of ['left', 'right']) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 16, 12),
      new THREE.MeshBasicMaterial(),
    );
    m.visible = false;
    scene.add(m);
    markers[hand] = m;
  }

  // Plus the real Meta Touch Plus mesh at the *grip* pose, with a pip on each
  // button so the names on the floating card map onto something you can see.
  for (const hand of ['left', 'right']) {
    const model = new ControllerModel(hand);
    scene.add(model.group);
    ctlModels[hand] = model;
  }

  buildTwin();
  buildPanel();
  ctlCards.left = makeCtlCard();
  ctlCards.right = makeCtlCard();
}

// ── Controller button guides (floating cards, like VR game tooltips) ────────

function makeCtlCard() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 340;
  const tex = new THREE.CanvasTexture(canvas);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: false, transparent: true,
  }));
  sp.scale.set(0.15, 0.0797, 1);
  sp.renderOrder = 10;
  sp.visible = false;
  scene.add(sp);
  return { sp, canvas, ctx: canvas.getContext('2d'), tex, lastKey: '' };
}

// rows: [buttonName, action, isPressed]
function drawCtlCard(card, title, rows) {
  const key = title + rows.length + rows.map((r) => r[2] ? 1 : 0).join('');
  if (key === card.lastKey) return;
  card.lastKey = key;

  // Grow the canvas to fit — VR mode adds two 360-camera rows, and the
  // original fixed 340 px only had room for three.
  const needH = 100 + rows.length * 78 - 10;
  if (card.canvas.height !== needH) {
    card.canvas.height = needH;
    card.sp.scale.set(0.15, 0.15 * needH / card.canvas.width, 1);
  }

  const ctx = card.ctx;
  const W = card.canvas.width, H = card.canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(10, 14, 18, 0.82)';
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 26);
  ctx.fill();

  ctx.fillStyle = 'rgba(232,237,242,0.6)';
  ctx.font = '700 30px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, 30, 40);

  rows.forEach(([name, action, on], i) => {
    const y = 100 + i * 78;
    // button chip
    ctx.fillStyle = on ? '#34c759' : 'rgba(232,237,242,0.14)';
    ctx.beginPath();
    ctx.roundRect(30, y - 28, 210, 58, 14);
    ctx.fill();
    ctx.fillStyle = on ? '#0b100c' : '#e8edf2';
    ctx.font = '700 32px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(name, 30 + 105, y + 2);
    // action text
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e8edf2';
    ctx.font = '400 32px system-ui, sans-serif';
    ctx.fillText(action, 268, y + 2);
  });
  card.tex.needsUpdate = true;
}

// ── Digital twin ─────────────────────────────────────────────────────────────

// Jaw half-separation at the extremes, in twin metres.
const JAW_OPEN_Z = 0.015;
const JAW_SHUT_Z = 0.005;

/**
 * Flat beam with rounded ends, like a real arm link rather than a bare box:
 * a 2D outline extruded and laid flat, so it has thickness and bevelled
 * edges that catch the light.
 */
function linkGeometry(len, r0, r1, thick, holePitch) {
  const s = new THREE.Shape();
  s.moveTo(0, r0);
  s.lineTo(len, r1);
  s.absarc(len, 0, r1, Math.PI / 2, -Math.PI / 2, true);
  s.lineTo(0, -r0);
  s.absarc(0, 0, r0, -Math.PI / 2, Math.PI / 2, true);

  // Row of holes down the middle, like the slotted channel on the real arm.
  //
  // Explicit octagons rather than absarc: absarc inherits curveSegments, so
  // smooth end caps would also mean 10-segment holes, and the extruded +
  // bevelled walls of ~23 of those cost 54k vertices for detail about 1 mm
  // across. Octagons decouple the two and cost a quarter of that.
  if (holePitch) {
    for (let x = holePitch; x < len - holePitch * 0.4; x += holePitch) {
      const pts = [];
      for (let i = 0; i < 8; i++) {
        const a = -i / 8 * Math.PI * 2;   // clockwise, so it reads as a hole
        pts.push(new THREE.Vector2(x + 0.0024 * Math.cos(a), 0.0024 * Math.sin(a)));
      }
      const h = new THREE.Path();
      h.setFromPoints(pts);
      s.holes.push(h);
    }
  }

  const geo = new THREE.ExtrudeGeometry(s, {
    depth: thick, bevelEnabled: true, bevelSize: 0.0012,
    bevelThickness: 0.0012, bevelSegments: 1, curveSegments: 12,
  });
  // Extrusion runs along +z; centre it, then tip it so the thickness is
  // vertical and the beam's width lies in the horizontal plane.
  geo.translate(0, 0, -thick / 2);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Parallel-jaw gripper. Jaws slide in Z, so they close horizontally. */
function makeGripper(mat, metal) {
  const g = new THREE.Group();

  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.016, 16), metal);
  g.add(wrist);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.013, 0.034), mat);
  body.position.x = 0.013;
  g.add(body);

  const jaws = [];
  for (const side of [-1, 1]) {
    const jaw = new THREE.Group();
    const finger = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.010, 0.007), mat);
    finger.position.x = 0.021;
    jaw.add(finger);
    // Inner pad, so you can see which face actually grips.
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.011, 0.002), metal);
    pad.position.set(0.024, 0, -side * 0.0045);
    jaw.add(pad);
    jaw.position.z = side * JAW_OPEN_Z;
    jaw.userData.side = side;
    g.add(jaw);
    jaws.push(jaw);
  }
  g.userData.jaws = jaws;
  return g;
}

function makeArm(solid) {
  // Arm frame → twin local: arm-x → +x, arm-y → −z, joints rotate about +y.
  // Both joints turn about vertical axes, so the whole assembly — gripper
  // included — stays parallel to the ground by construction.
  const S = TWIN_SCALE;
  const mat = (color) => new THREE.MeshStandardMaterial(
    solid
      ? { color, roughness: 0.42, metalness: 0.25 }
      : { color, transparent: true, opacity: 0.26, depthWrite: false });
  const metal = mat(solid ? 0x9aa6b4 : 0xc4ccd6);
  const motorMat = mat(solid ? 0x23262b : 0x6b7078);
  const gearMat = mat(solid ? 0x6e7681 : 0xaab2bd);

  const pivot = (r, h) => new THREE.Mesh(
    // A cylinder on the rotation axis reads as a hinge; a sphere does not.
    new THREE.CylinderGeometry(r, r, h, 20), metal);

  // Motor + gear pair at a joint, echoing the real build: a black cartridge
  // beside the axis driving a big gear on it. The 84:12 ratio is the whole
  // reason the arm has the torque it does, so it is worth being able to see.
  const drive = (gearR, motorScale) => {
    const g = new THREE.Group();
    const gear = new THREE.Mesh(
      new THREE.CylinderGeometry(gearR, gearR, 0.005, 28), gearMat);
    gear.position.y = 0.014 * motorScale;
    g.add(gear);
    const pinion = new THREE.Mesh(
      new THREE.CylinderGeometry(gearR * (12 / 84), gearR * (12 / 84), 0.005, 14), gearMat);
    pinion.position.set(-(gearR + gearR * (12 / 84)), 0.014 * motorScale, 0);
    g.add(pinion);
    const motor = new THREE.Mesh(
      new THREE.BoxGeometry(0.030 * motorScale, 0.024 * motorScale, 0.022 * motorScale),
      motorMat);
    motor.position.set(-(gearR + gearR * (12 / 84)), 0.030 * motorScale, 0);
    g.add(motor);
    return g;
  };

  const shoulder = new THREE.Group();
  const l1 = new THREE.Mesh(
    linkGeometry(cfg.l1 * S, 0.0145, 0.0115, 0.016, 0.012),
    mat(solid ? 0x3a86ff : 0x9bbcff));
  shoulder.add(l1);
  shoulder.add(pivot(0.017, 0.026));
  if (solid) shoulder.add(drive(0.021, 1.0));

  const elbow = new THREE.Group();
  elbow.position.x = cfg.l1 * S;
  const l2 = new THREE.Mesh(
    linkGeometry(cfg.l2 * S, 0.0115, 0.0085, 0.013, 0.012),
    mat(solid ? 0x34c759 : 0xa5e8b8));
  elbow.add(l2);
  elbow.add(pivot(0.0135, 0.022));
  if (solid) elbow.add(drive(0.016, 0.8));
  shoulder.add(elbow);

  const tip = new THREE.Object3D();
  tip.position.x = cfg.l2 * S;
  elbow.add(tip);

  const gripper = makeGripper(mat(solid ? 0xff6b5a : 0xffb4ae), metal);
  tip.add(gripper);

  // Where the jaw pads actually meet. The IK positions the WRIST, so this
  // sits a little further out -- it is what the carry trail should follow,
  // since that is the point doing the carrying.
  const grasp = new THREE.Object3D();
  grasp.position.x = 0.024;
  gripper.add(grasp);

  return { shoulder, elbow, tip, gripper, grasp };
}

/** @param {number} t 0 = fully shut, 1 = fully open */
function setJaws(arm, t) {
  for (const jaw of arm.gripper.userData.jaws) {
    jaw.position.z = jaw.userData.side * (JAW_SHUT_Z + t * (JAW_OPEN_Z - JAW_SHUT_Z));
  }
}

function buildTwin() {
  const S = TWIN_SCALE;
  const old = twin;
  if (old) scene.remove(old.group);

  const group = new THREE.Group();
  // Float in front of where the user started; move it with LEFT grip,
  // rotate it with the LEFT thumbstick to match the real robot.
  group.position.set(old ? old.group.position.x : 0.35,
                     old ? old.group.position.y : 1.05,
                     old ? old.group.position.z : -0.55);
  group.rotation.y = twinYaw;

  // Pedestal. The real arm is not flat on a table -- it sits on top of a
  // tall tower bolted to a board, so the whole arm sweeps in a plane well
  // above its base. Drawing it flat made the twin read as a different robot.
  const towerH = TWIN_BASE_CM * S;
  const board = new THREE.Mesh(
    // In arm-cm like everything else here, so it tracks TWIN_SCALE.
    new THREE.BoxGeometry(26 * S, 0.006, 20 * S),
    new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.85 }),
  );
  board.position.y = -towerH;
  group.add(board);

  // Four splayed uprights, like the real A-frame.
  const legMat = new THREE.MeshStandardMaterial({ color: 0x7a5c3a, roughness: 0.7 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.010, towerH, 0.010), legMat);
      leg.position.set(sx * 0.022, -towerH / 2, sz * 0.022);
      // Splay outward toward the board so it reads as a tripod, not a box.
      leg.rotation.z = sx * 0.13;
      leg.rotation.x = -sz * 0.13;
      group.add(leg);
    }
  }
  const collar = new THREE.Mesh(
    new THREE.BoxGeometry(0.062, 0.012, 0.062),
    new THREE.MeshStandardMaterial({ color: 0x7a5c3a, roughness: 0.7 }),
  );
  collar.position.y = -0.016;
  group.add(collar);

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

  // Carry trail: preallocated line, grows via drawRange. Traces the tip
  // whenever the gripper is closed, so you can see the path of a carry.
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

  // Jaws. The V5 only reports the commanded open/shut state, not a jaw
  // angle, so ease toward it rather than snapping -- a hard jump reads as a
  // glitch, and the real jaws take ~0.7 s to travel anyway.
  const want = lastTm.grip ? 0 : 1;
  jawT += (want - jawT) * 0.18;
  setJaws(twin.solid, jawT);
  setJaws(twin.ghost, want);

  if (lastTm.grip) {
    twin.solid.grasp.getWorldPosition(_tipWorld);
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

// ── Fixed drawing panel (same proportions as the robot workspace) ───────────

/**
 * Which panel edge sends the arm to its maximum depth, given the server's
 * SWAP_UV / FLIP_U / FLIP_V.
 *
 * Panel axes as sent by panelUV(): u is depth-on-panel (pz = +halfD is u=0,
 * nearest you), v is lateral (px = -halfW is v=0). The server computes
 * robot-depth from `swap ? v : u`, then inverts it if FLIP_U. So the edge we
 * want is wherever that composed expression reaches 1.
 */
function farEdge(halfW, halfD) {
  const flip = !!cfg.fu;
  if (cfg.swap) {
    // Depth is driven by v, i.e. the panel's left-right axis.
    const x = flip ? -halfW : halfW;
    return {
      edge: [new THREE.Vector3(x, 0.003, -halfD), new THREE.Vector3(x, 0.003, halfD)],
      from: new THREE.Vector3(flip ? halfW : -halfW, 0.004, 0),
      dir: new THREE.Vector3(flip ? -1 : 1, 0, 0),
    };
  }
  // Depth is driven by u, i.e. toward/away from you. u = 1 at pz = -halfD.
  const z = flip ? halfD : -halfD;
  return {
    edge: [new THREE.Vector3(-halfW, 0.003, z), new THREE.Vector3(halfW, 0.003, z)],
    from: new THREE.Vector3(0, 0.004, flip ? -halfD : halfD),
    dir: new THREE.Vector3(0, 0, flip ? 1 : -1),
  };
}

function buildPanel() {
  const old = panel;
  if (old) scene.remove(old.group);

  // Panel dimensions mirror what each hand axis actually drives on the arm.
  // Without swap: width = lateral span, depth = forward span. With swap (the
  // server transposes u/v), width drives the forward span and depth drives
  // the lateral one — so the panel is transposed to keep proportions true.
  const [latMin, latMax, fwdMin, fwdMax] = cfg.ws;
  const latSpan = (latMax - latMin) / 100 * PANEL_SCALE; // cm → m, scaled
  const fwdSpan = (fwdMax - fwdMin) / 100 * PANEL_SCALE;
  const w = cfg.swap ? fwdSpan : latSpan;
  const d = cfg.swap ? latSpan : fwdSpan;
  const halfW = w / 2, halfD = d / 2;

  const group = new THREE.Group();
  group.position.set(...(old ? old.group.position.toArray() : PANEL_POS));
  // Keep the alignment you dialled in when cfg changes rebuild the panel.
  const yaw = old ? old.yaw : 0;
  group.rotation.y = yaw;

  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({
      color: 0x38c0ff, transparent: true, opacity: 0.12,
      side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  fill.rotation.x = -Math.PI / 2;
  group.add(fill);

  // Metric grid: one cell per GRID_CM of real workspace, so cells stay SQUARE
  // whatever the workspace aspect, and counting them tells you an actual
  // distance. The old "8 divisions each way" drew the same count on both
  // axes, which on a 48 x 15 cm workspace would stretch cells 3:1 and mean
  // nothing at all.
  const cell = (GRID_CM / 100) * PANEL_SCALE;
  const gpts = [];
  for (let x = 0; x <= halfW + 1e-6; x += cell) {
    for (const sx of (x === 0 ? [0] : [-x, x])) {
      gpts.push(new THREE.Vector3(sx, 0.001, -halfD),
                new THREE.Vector3(sx, 0.001, halfD));
    }
  }
  for (let z = 0; z <= halfD + 1e-6; z += cell) {
    for (const sz of (z === 0 ? [0] : [-z, z])) {
      gpts.push(new THREE.Vector3(-halfW, 0.001, sz),
                new THREE.Vector3(halfW, 0.001, sz));
    }
  }
  group.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(gpts),
    new THREE.LineBasicMaterial({
      color: 0x38c0ff, transparent: true, opacity: 0.35,
    }),
  ));

  // Orientation cue: mark the edge that drives the robot to its FURTHEST
  // reach. The control mapping is transposed and one axis is mirrored
  // (SWAP_UV / FLIP_U / FLIP_V on the server), which is impossible to infer
  // from a bare rectangle -- especially now the panel is not square, so you
  // cannot even see the transpose any more.
  const far = farEdge(halfW, halfD);
  group.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(far.edge),
    new THREE.LineBasicMaterial({ color: 0xff9f0a, linewidth: 2 }),
  ));
  const arrow = new THREE.ArrowHelper(
    far.dir, far.from, Math.min(halfW, halfD) * 0.5, 0xff9f0a, 0.03, 0.02);
  group.add(arrow);

  // Border in the same yellow as the twin's workspace rectangle — it IS that
  // rectangle, scaled up.
  const border = [
    [-halfW, -halfD], [halfW, -halfD], [halfW, halfD],
    [-halfW, halfD], [-halfW, -halfD],
  ].map(([x, z]) => new THREE.Vector3(x, 0.002, z));
  group.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(border),
    new THREE.LineBasicMaterial({ color: 0xffd60a }),
  ));

  // Cursor dot: where the arm is being commanded, projected on the panel.
  const cursor = new THREE.Mesh(
    new THREE.SphereGeometry(0.011, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  cursor.position.y = 0.006;
  group.add(cursor);

  scene.add(group);
  panel = { group, cursor, halfW, halfD, yaw };
}

function movePanelTo(x, y, z) {
  if (panel) panel.group.position.set(x, y, z);
}

function rotatePanel(delta) {
  if (!panel) return;
  panel.yaw += delta;
  panel.group.rotation.y = panel.yaw;
}

/**
 * Controller position in the panel's OWN frame.
 *
 * Must undo the panel's yaw: u/v are fractions along the panel's edges, so
 * once it can be rotated, world-axis deltas are simply the wrong numbers.
 * Skipping this is a silent failure -- the arm keeps moving, just not where
 * your hand says.
 */
function panelLocal() {
  const px = ema.x - panel.group.position.x;
  const pz = ema.z - panel.group.position.z;
  const c = Math.cos(panel.yaw);
  const s = Math.sin(panel.yaw);
  return { x: px * c - pz * s, z: px * s + pz * c };
}

function panelUV() {
  if (!panel || !ema) return null;
  const p = panelLocal();
  // u = depth fraction (near edge 0 → far edge 1), v = lateral (left 0 → right 1)
  const u = clamp01((panel.halfD - p.z) / (2 * panel.halfD));
  const v = clamp01((p.x + panel.halfW) / (2 * panel.halfW));
  return { u, v };
}

function updatePanelCursor() {
  if (!panel || !panel.cursor || !ema) return;
  const p = panelLocal();
  panel.cursor.position.set(
    Math.max(-panel.halfW, Math.min(panel.halfW, p.x)),
    0.006,
    Math.max(-panel.halfD, Math.min(panel.halfD, p.z)));
  panel.cursor.material.color.setHex(
    paused ? 0x8e8e93 : gripNow ? 0xff3b30 : 0xffffff);
}

// ── Pose streaming ───────────────────────────────────────────────────────────

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function risingEdge(hand, idx, pressed) {
  const was = !!prevButtons[hand][idx];
  prevButtons[hand][idx] = pressed;
  return pressed && !was;
}

// Smooth the cursor, stream the pose.
function updateRightCursor(x, z, gripClosed, time) {
  gripNow = gripClosed;
  ema = ema
    ? { x: ema.x + EMA_ALPHA * (x - ema.x),
        z: ema.z + EMA_ALPHA * (z - ema.z) }
    : { x, z };
  lastUV = panelUV();
  if (time - lastSend >= SEND_INTERVAL_MS) {
    lastSend = time;
    const msg = {
      t: 'p', s: ++seq,
      x: round3(ema.x), z: round3(ema.z),
      // Raw trigger state. While paused the server ignores this frame for
      // actuation (u/v are withheld below) and so holds the last grip — don't
      // send 0 here, since for a gripper 0 means "open" i.e. drop the object.
      grip: gripClosed ? 1 : 0,
      ts: Math.round(time * 10) / 10,
    };
    // While paused, u/v are withheld: the server holds position + grip.
    if (lastUV && !paused) { msg.u = round4(lastUV.u); msg.v = round4(lastUV.v); }
    wsSend(msg);
  }
}

// ── Frame loop ───────────────────────────────────────────────────────────────

function onFrame(time, frame) {
  let rightSeen = false;

  if (frame) {
    const ref = renderer.xr.getReferenceSpace();
    markers.left.visible = false;
    markers.right.visible = false;
    if (ctlModels.left) ctlModels.left.group.visible = false;
    if (ctlModels.right) ctlModels.right.group.visible = false;
    if (ctlCards.left) ctlCards.left.sp.visible = false;
    if (ctlCards.right) ctlCards.right.sp.visible = false;

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

      // The body belongs at the GRIP pose, not the target-ray pose — they are
      // different transforms, and using the ray one puts the model out in
      // front of your hand at a tilt.
      const model = ctlModels[hand];
      if (model && model.ready && src.gripSpace) {
        const gp = frame.getPose(src.gripSpace, ref);
        if (gp) {
          model.setFromPose(gp.transform);
          model.group.visible = true;
          model.update(btn);
        }
      }

      if (hand === 'right') {
        rightSeen = true;
        updateRightCursor(p.x, p.z, trigger, time);
        if (risingEdge('right', 4, btn(4))) movePanelTo(p.x, p.y, p.z); // A
        if (risingEdge('right', 3, btn(3))) clearTrail(); // stick click

        // Stick ◄ ► aligns the drawing panel with the real robot. Without
        // this the panel can only be placed, not aimed, which makes matching
        // its axes to the arm's a matter of standing in exactly the right
        // spot.
        const panX = gp.axes[2] || 0;
        if (Math.abs(panX) > 0.15) rotatePanel(-panX * 0.022);

        // 360-camera controls, only while that world is actually showing —
        // otherwise they would silently swallow the right stick in passthrough.
        let zoomY = 0;
        if (panoShown) {
          if (risingEdge('right', 5, btn(5))) pano.recenter(renderer.xr.getCamera()); // B
          zoomY = gp.axes[3] || 0;
          if (Math.abs(zoomY) > 0.3) pano.adjustZoom(-zoomY * 0.02);
        }

        const card = ctlCards.right;
        if (card) {
          card.sp.position.set(p.x, p.y + 0.11, p.z);
          card.sp.visible = true;
          const rows = [
            ['Trigger', gripNow ? 'GRIPPING' : 'close gripper', trigger],
            ['A', 'move panel here', btn(4)],
            ['Stick ◄ ►', 'aim panel', Math.abs(panX) > 0.15],
            ['Stick press', 'clear trail', btn(3)],
          ];
          if (panoShown) {
            rows.push(['B', 'recentre 360 view', btn(5)]);
            rows.push(['Stick ▲ ▼', 'zoom 360', Math.abs(zoomY) > 0.3]);
          }
          drawCtlCard(card, 'RIGHT — the gripper', rows);
        }
      }

      if (hand === 'left') {
        if (risingEdge('left', 4, btn(4))) { // X → pause/resume
          paused = !paused;
          if (!paused) armed = true;
        }
        if (risingEdge('left', 5, btn(5))) toggleWorld(); // Y → passthrough <-> 360
        if (btn(1) && twin) { // grip held → carry the twin
          twin.group.position.set(p.x, p.y, p.z);
        }
        // Thumbstick ◄ ► rotates the twin; holding the trigger makes the same
        // stick turn the 360 feed instead. Both are yaw, so they belong on
        // the same axis -- and the trigger is the only free input left that
        // keeps them there rather than exiling one onto the vertical axis.
        const ax = gp.axes[2] || 0;
        const turningPano = trigger && panoShown;
        if (Math.abs(ax) > 0.15 && turningPano) {
          pano.yaw -= ax * 0.022;
        } else if (Math.abs(ax) > 0.5 && twin) {
          twinYaw -= ax * 0.02; // ~80°/s at 72 fps
          twin.group.rotation.y = twinYaw;
        }

        const card = ctlCards.left;
        if (card) {
          card.sp.position.set(p.x, p.y + 0.11, p.z);
          card.sp.visible = true;
          const lrows = [
            ['X', paused ? 'GO LIVE' : 'pause', btn(4)],
            ['Y', panoShown ? 'back to passthrough' : 'show 360 camera', btn(5)],
            ['Grip (hold)', 'move twin', btn(1)],
            ['Stick ◄ ►', turningPano ? 'TURN 360 VIEW' : 'rotate twin',
              Math.abs(ax) > 0.15],
          ];
          if (panoShown) {
            lrows.push(['Trigger+stick', 'turn 360 view', trigger]);
          }
          drawCtlCard(card, 'LEFT — the twin', lrows);
        }
      }
    }
  }

  updateTwin();
  updatePanelCursor();
  if (pano) pano.update(renderer.xr.getCamera());

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
    grip: gripNow,
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
  } else if (paused && !armed) {
    m.paused = true;
    m.step = 'SAFE START — ARM IS HELD';
    m.lines = [
      'The arm will NOT move until you go live.',
      'Point the blue panel where you want it (A on the right',
      'controller moves it to your hand), then press X to go live.',
    ];
  } else if (paused) {
    m.paused = true;
    m.step = 'PAUSED — ARM AND GRIP HOLDING';
    m.lines = ['Press X (left controller) to resume.'];
  } else {
    m.live = true;
    m.step = m.grip ? 'GRIPPER CLOSED' : 'LIVE — ARM FOLLOWS YOUR HAND';
    m.lines = [
      'The blue panel is the robot’s reachable area.',
      'Trigger = close gripper.  A: move panel to your hand.',
      'X: pause   R-stick: clear trail',
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
  if (panoShown) {
    // A black world is almost always the camera half not running, so say so
    // here rather than leaving you guessing inside the headset.
    chip(830, 'CAM', pano.status === 'live', 'live', pano.status);
  } else if (m.live) {
    ctx.beginPath();
    ctx.arc(830, 52, 13, 0, Math.PI * 2);
    ctx.fillStyle = m.grip ? '#ff453a' : '#8e8e93';
    ctx.fill();
    ctx.fillStyle = '#e8edf2';
    ctx.fillText(`GRIP ${m.grip ? 'CLOSED' : 'open'}`, 858, 54);
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
  foot.push('L-grip: move twin   L-stick: rotate twin');
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
