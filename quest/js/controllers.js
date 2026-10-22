// Real Meta Quest Touch Plus controller models, with a highlight on whichever
// button you are pressing.
//
// These are the official @webxr-input-profiles assets — the same meshes Unity
// and every other WebXR app uses — vendored into quest/js/vendor/controllers/
// rather than fetched at runtime. three.js's XRControllerModelFactory pulls
// them from a CDN, which is useless here: the rig runs on the PC's Mobile
// Hotspot with no internet, so the models would silently never appear.
//
// The glTF conveniently names its button nodes (a_button, b_button, trigger,
// squeeze, thumbstick), so the press indicators are anchored to the real
// geometry instead of to coordinates guessed from a photo.

import * as THREE from 'three';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';

const MODEL_PATH = './js/vendor/controllers/';

// WebXR standard gamepad index -> the node that button lives on in the glTF.
// Index 4/5 are A/X and B/Y: the same physical buttons on both controllers,
// named a_button / b_button in each model regardless of hand.
const BUTTON_NODES = {
  0: 'trigger',
  1: 'squeeze',
  3: 'thumbstick',
  4: 'a_button',
  5: 'b_button',
};

const IDLE = 0x8e949e;
const PRESSED = 0x34c759;

/**
 * One controller: the real mesh plus press indicators.
 * Falls back to a simple block if the glTF cannot be loaded, so a missing
 * asset degrades to "ugly" rather than "invisible".
 */
export class ControllerModel {
  constructor(hand, onReady) {
    this.hand = hand;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.pips = {};   // gamepad index -> indicator mesh
    this.ready = false;

    new GLTFLoader().load(
      `${MODEL_PATH}${hand}.glb`,
      (gltf) => { this._build(gltf.scene); if (onReady) onReady(this); },
      undefined,
      (err) => {
        console.warn(`[controllers] ${hand}.glb failed, using fallback`, err);
        this._fallback();
        if (onReady) onReady(this);
      },
    );
  }

  _build(root) {
    this.group.add(root);

    // Anchor a small glowing pip over each button's own node, so the labels
    // on the floating card point at something real.
    for (const [idx, nodeName] of Object.entries(BUTTON_NODES)) {
      const node = root.getObjectByName(nodeName);
      if (!node) continue;

      const pip = new THREE.Mesh(
        new THREE.SphereGeometry(0.0045, 12, 10),
        // depthTest off: the pip must stay readable even where the controller
        // body would otherwise occlude it.
        new THREE.MeshBasicMaterial({
          color: IDLE, transparent: true, opacity: 0.9, depthTest: false,
        }),
      );
      pip.renderOrder = 12;
      // Parent to the button node so it tracks any press animation for free.
      node.add(pip);
      this.pips[idx] = pip;
    }
    this.ready = true;
  }

  _fallback() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.55 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.03, 0.09), mat);
    body.position.set(0, -0.01, 0.01);
    this.group.add(body);
    this.ready = true;
  }

  /** @param {(i:number)=>boolean} isPressed */
  update(isPressed) {
    for (const [idx, pip] of Object.entries(this.pips)) {
      pip.material.color.setHex(isPressed(Number(idx)) ? PRESSED : IDLE);
    }
  }

  /** Place at the controller's grip pose (NOT the target-ray pose). */
  setFromPose(transform) {
    const p = transform.position;
    const q = transform.orientation;
    this.group.position.set(p.x, p.y, p.z);
    this.group.quaternion.set(q.x, q.y, q.z, q.w);
  }
}
