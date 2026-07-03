// Milestone 1: immersive-ar passthrough session that displays controller
// X/Z position and trigger state. Two HUDs so at least one always works:
//  - an in-scene canvas panel parented to the camera (guaranteed)
//  - the dom-overlay #readout div (if the browser grants dom-overlay)
import * as THREE from 'three';

const startBtn = document.getElementById('start');
const statusEl = document.getElementById('status');
const readoutEl = document.getElementById('readout');
const overlayRoot = document.getElementById('overlay');

const HUD_REDRAW_MS = 100; // 10 Hz is plenty for text

let renderer, scene, camera;
let hudCanvas, hudCtx, hudTexture;
let lastHudDraw = 0;
const markers = { left: null, right: null };

checkSupport();

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

  // In-scene HUD: canvas texture on a plane 0.6 m in front of the camera.
  hudCanvas = document.createElement('canvas');
  hudCanvas.width = 1024;
  hudCanvas.height = 400;
  hudCtx = hudCanvas.getContext('2d');
  hudTexture = new THREE.CanvasTexture(hudCanvas);
  const hudMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.42, 0.164),
    new THREE.MeshBasicMaterial({ map: hudTexture, transparent: true }),
  );
  hudMesh.position.set(0, -0.13, -0.6);
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
}

function onFrame(time, frame) {
  const lines = [];
  if (frame) {
    const ref = renderer.xr.getReferenceSpace();
    markers.left.visible = false;
    markers.right.visible = false;

    for (const src of frame.session.inputSources) {
      const hand = src.handedness;
      if (hand !== 'left' && hand !== 'right') continue;

      const trigger = src.gamepad ? src.gamepad.buttons[0] : null;
      const pressed = !!(trigger && trigger.pressed);
      const pose = frame.getPose(src.targetRaySpace, ref);

      if (pose) {
        const p = pose.transform.position;
        const marker = markers[hand];
        marker.position.set(p.x, p.y, p.z);
        marker.visible = true;
        marker.material.color.setHex(
          pressed ? 0xff3b30 : hand === 'right' ? 0x34c759 : 0x3a86ff,
        );
        lines.push(`${hand === 'right' ? 'R' : 'L'}  x ${fmt(p.x)}  z ${fmt(p.z)}   (y ${fmt(p.y)})`);
      } else {
        lines.push(`${hand === 'right' ? 'R' : 'L'}  tracking lost`);
      }
      lines.push(
        trigger
          ? `   trigger ${pressed ? 'DOWN' : 'up  '}  ${trigger.value.toFixed(2)}`
          : '   no gamepad data',
      );
    }
    if (lines.length === 0) lines.push('No controllers — press any button to wake them.');
  }

  if (time - lastHudDraw > HUD_REDRAW_MS) {
    drawHud(lines);
    lastHudDraw = time;
  }
  renderer.render(scene, camera);
}

function drawHud(lines) {
  const ctx = hudCtx;
  ctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
  ctx.fillStyle = 'rgba(10, 14, 18, 0.72)';
  ctx.beginPath();
  ctx.roundRect(0, 0, hudCanvas.width, hudCanvas.height, 28);
  ctx.fill();
  ctx.font = '44px ui-monospace, monospace';
  ctx.fillStyle = '#e8edf2';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, 36, 30 + i * 58));
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

function setStatus(msg) {
  statusEl.textContent = msg;
}
