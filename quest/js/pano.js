// Live 360 camera background for ?mode=vr.
//
// In AR mode the world you see is passthrough. In VR mode it is this: a live
// equirectangular feed from an Insta360 X5 (USB -> PC -> WebRTC) painted on
// the inside of a large sphere, with the drawing panel and digital twin
// rendered inside it exactly as before.
//
// Why this is comfortable despite ~150 ms of glass-to-glass latency: the whole
// sphere lives on the headset, so head rotation is rendered on-device at
// display rate. Only the imagery lags, never your viewpoint.
//
// Known limits, so they are not surprises:
//   - Monoscopic. Both eyes get the same frame, so there is no stereo depth
//     and leaning gives no parallax. The X5's lenses are back to back and
//     share no baseline, so this cannot be fixed in software.
//   - ~8 px/degree (2880x1440 over a full sphere) against a headset that
//     resolves ~20. That is the camera's live ceiling, not a bug.
//
// This module owns ONLY the background. Controllers, HUD, panel and twin stay
// in app.js and are identical in both modes.

import * as THREE from 'three';
import { WhepClient } from './whep.js';

const DEFAULTS = {
  // Far enough to read as "the world". With the default head-following
  // anchor this is nearly cosmetic -- the sphere moves with you, so you
  // cannot see its radius. It only bites together with ?anchor=world, which
  // pins the sphere so head movement produces parallax; pair that with a
  // small ?radius (try 3 in a normal room) if you want to experiment. That
  // parallax is invented, though: the remote camera did not move, so nearer
  // and farther objects shift by the wrong amount.
  radius: 500,
  // WebXR framebuffer supersampling; the browser often renders below panel
  // resolution and this recovers detail the video genuinely contains.
  fbScale: 1.3,
  zoomMax: 2.5,
  zoomRate: 0.8,
};

export class Pano {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts] radius / fbScale / yawDeg / rollDeg overrides
   */
  constructor(scene, opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.scene = scene;
    this.whep = null;
    this.status = 'idle';
    this.detail = '';
    this.zoom = 1;
    this.yaw = THREE.MathUtils.degToRad(opts.yawDeg || 0);
    this.roll = THREE.MathUtils.degToRad(opts.rollDeg || 0);
    // Keep the sphere centred on the viewer's eyes. The session uses a
    // local-floor reference space, so the scene origin is on the FLOOR -- a
    // sphere left at the origin puts its centre ~1.6 m below your head and
    // the horizon visibly sinks.
    //
    // Following the head is also the physically honest choice: moving your
    // head here does not move the remote camera, so the view from its optical
    // centre should not change. Any parallax would be invented.
    this.followHead = opts.anchor !== 'world';
    this._anchored = false;
    this._dir = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();

    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    // Must stay in the document and keep playing; display:none lets some
    // browsers stop decoding entirely.
    Object.assign(this.video.style, {
      position: 'fixed', width: '2px', height: '2px',
      top: '0', left: '0', opacity: '0', pointerEvents: 'none',
    });
    document.body.appendChild(this.video);

    const tex = new THREE.VideoTexture(this.video);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    this.texture = tex;

    // Dense tessellation: equirect UVs interpolate linearly across each face,
    // so a coarse sphere visibly warps the image between vertices.
    const geo = new THREE.SphereGeometry(this.cfg.radius, 160, 80);
    // Mirror X so we view the inside with the texture the right way round.
    // (If text in the feed ever reads mirrored, drop this and use BackSide.)
    geo.scale(-1, 1, 1);

    // Magnification is done by displacing vertices away from the viewing
    // axis, NOT by rewriting the texture lookup, so the equirect mapping
    // cannot be disturbed by it. WebXR owns the projection matrix, so a real
    // FOV change is impossible; this is binoculars, and it magnifies without
    // sharpening.
    this.uniforms = {
      uZoom: { value: 1 },
      uForward: { value: new THREE.Vector3(0, 0, -1) },
    };
    const mat = new THREE.MeshBasicMaterial({ map: tex, depthWrite: false });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uZoom = this.uniforms.uZoom;
      shader.uniforms.uForward = this.uniforms.uForward;
      shader.vertexShader =
        'uniform float uZoom;\nuniform vec3 uForward;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', `
        vec3 transformed = vec3( position );
        if ( uZoom > 1.001 ) {
          float r = length( transformed );
          vec3 d = transformed / r;
          float c = clamp( dot( d, uForward ), -1.0, 1.0 );
          vec3 perp = d - c * uForward;
          float pl = length( perp );
          if ( pl > 1e-5 ) {
            float na = min( acos( c ) * uZoom, 3.14159265 );
            transformed = ( uForward * cos( na ) + ( perp / pl ) * sin( na ) ) * r;
          }
        }
        `);
    };

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = -1;      // draw first, never occlude the twin
    this.mesh.frustumCulled = false; // the zoom shader moves vertices
    this.mesh.rotation.order = 'YXZ';
    scene.add(this.mesh);
  }

  /** Apply the framebuffer scale. Must run before the session starts. */
  applyRendererSettings(renderer) {
    // three defaults foveation to maximum, which blurs the periphery -- ruinous
    // when looking around is the point. The scene is cheap enough to skip it.
    renderer.xr.setFoveation(0);
    renderer.xr.setFramebufferScaleFactor(this.cfg.fbScale);
  }

  async connect() {
    this.status = 'connecting';
    if (this.whep) await this.whep.close();
    this.whep = new WhepClient('/whep', {
      onState: (s, detail) => {
        if (s === 'failed' || s === 'disconnected') {
          this.status = 'retrying';
          this.detail = detail || s;
          clearTimeout(this._retry);
          this._retry = setTimeout(() => this.connect(), 2000);
        }
      },
    });
    try {
      this.video.srcObject = await this.whep.connect();
      await this.video.play().catch(() => {});
      this.status = 'live';
      this.detail = '';
    } catch (err) {
      this.status = 'offline';
      this.detail = err.message;
      clearTimeout(this._retry);
      this._retry = setTimeout(() => this.connect(), 2000);
    }
  }

  /** Point the feed's forward direction at wherever the user is looking. */
  recenter(activeCamera) {
    activeCamera.getWorldDirection(this._dir);
    this.yaw = Math.atan2(-this._dir.x, -this._dir.z);
  }

  reset() {
    this.yaw = 0;
    this.roll = 0;
    this.zoom = 1;
  }

  adjustZoom(delta) {
    this.zoom = THREE.MathUtils.clamp(
      this.zoom + delta * this.cfg.zoomRate, 1, this.cfg.zoomMax);
  }

  /** Call once per frame, after any yaw/roll change. */
  update(activeCamera) {
    if (this.followHead) {
      // Centre on the eyes every frame.
      activeCamera.getWorldPosition(this._pos);
      this.mesh.position.copy(this._pos);
    } else if (!this._anchored) {
      // ?anchor=world: pin it once, at head height rather than on the floor,
      // so a small ?radius can produce (approximate, invented) parallax
      // without the horizon starting out below your eyeline.
      activeCamera.getWorldPosition(this._pos);
      this.mesh.position.copy(this._pos);
      this._anchored = true;
    }

    this.mesh.rotation.y = this.yaw;
    this.mesh.rotation.z = this.roll;
    this.uniforms.uZoom.value = this.zoom;
    if (this.zoom <= 1.001) return;
    // The vertex shader works in mesh-local space, and the mesh carries the
    // yaw/roll offsets, so the viewing axis has to be taken into that frame.
    activeCamera.getWorldDirection(this._dir);
    this.mesh.getWorldQuaternion(this._quat).invert();
    this.uniforms.uForward.value
      .copy(this._dir).applyQuaternion(this._quat).normalize();
  }

  async dispose() {
    clearTimeout(this._retry);
    if (this.whep) await this.whep.close();
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    this.video.srcObject = null;
    this.video.remove();
  }
}
