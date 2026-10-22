/**
 * Minimal WHEP (WebRTC-HTTP Egress Protocol) client.
 *
 * WHEP is a one-shot HTTP handshake: POST an SDP offer, get an SDP answer
 * back. That is the entire signalling protocol -- no WebSocket, no library.
 *
 * We deliberately gather ICE candidates fully before POSTing (non-trickle)
 * rather than PATCHing them in afterwards. On a single LAN the only candidates
 * that matter are host candidates, which appear in a few milliseconds, so
 * trickle would add complexity and buy nothing.
 */

/** Wait for ICE gathering, but never hang on it. */
function gatherIce(pc, timeoutMs = 2000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    // If a virtual adapter is slow to report, proceed with what we have --
    // a partial candidate list that includes the LAN address still connects.
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

export class WhepClient {
  /**
   * @param {string} url      WHEP endpoint (same-origin /whep via the proxy)
   * @param {object} [opts]
   * @param {boolean} [opts.audio]      also request an audio track
   * @param {(state: string, detail?: string) => void} [opts.onState]
   */
  constructor(url, { audio = false, onState } = {}) {
    // Resolve to absolute immediately. The default endpoint is the relative
    // "/whep", but we later resolve the server's Location header against this
    // value, and the URL constructor rejects a relative base.
    this.url = new URL(url, location.href).href;
    this.wantAudio = audio;
    this.onState = onState || (() => {});
    this.pc = null;
    this.stream = null;
    this.resource = null; // WHEP session URL, for DELETE on teardown
  }

  /** @returns {Promise<MediaStream>} */
  async connect() {
    this.onState('connecting');

    const pc = new RTCPeerConnection({
      // No STUN: same LAN, host candidates only, and no internet dependency.
      iceServers: [],
      bundlePolicy: 'max-bundle',
    });
    this.pc = pc;

    const stream = new MediaStream();
    this.stream = stream;

    pc.addEventListener('track', (ev) => {
      stream.addTrack(ev.track);
    });

    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      if (s === 'connected') this.onState('connected');
      else if (s === 'failed') {
        // Almost always the UDP media port being blocked, since signalling
        // already succeeded by this point.
        this.onState('failed', 'ICE failed - is UDP 8189 open in the firewall?');
      } else if (s === 'disconnected') this.onState('disconnected');
      else if (s === 'closed') this.onState('closed');
    });

    // recvonly: we are a pure consumer. Order matters only in that it must
    // match what we later read out of the answer, which we do not inspect.
    pc.addTransceiver('video', { direction: 'recvonly' });
    if (this.wantAudio) pc.addTransceiver('audio', { direction: 'recvonly' });

    await pc.setLocalDescription(await pc.createOffer());
    await gatherIce(pc);

    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
      });
    } catch (err) {
      pc.close();
      // A failed fetch to our own origin almost always means the certificate
      // was never accepted, or the server is not running.
      throw new Error(`cannot reach ${this.url} (${err.message})`);
    }

    if (!res.ok) {
      pc.close();
      const body = (await res.text()).trim();
      throw new Error(`WHEP ${res.status}: ${body || res.statusText}`);
    }

    // Anything that throws from here on must still close the PeerConnection,
    // or the caller's reconnect loop quietly accumulates live ones.
    try {
      const loc = res.headers.get('Location');
      if (loc) this.resource = new URL(loc, this.url).href;

      const answer = await res.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (err) {
      pc.close();
      this.pc = null;
      throw err;
    }

    return stream;
  }

  /**
   * Snapshot of inbound video stats for the HUD.
   * jitterBufferDelay is the receiver-side buffering component of end-to-end
   * latency -- not the whole story (capture, encode and Wi-Fi are invisible
   * from here) but the part we can actually measure and the part that moves.
   */
  async stats() {
    if (!this.pc) return null;
    const report = await this.pc.getStats();
    let inbound = null;
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = s;
    });
    if (!inbound) return null;

    const now = performance.now();
    const prev = this._prev;
    this._prev = {
      t: now,
      bytes: inbound.bytesReceived || 0,
      frames: inbound.framesDecoded || 0,
    };

    let kbps = null;
    let fps = null;
    if (prev) {
      const dt = (now - prev.t) / 1000;
      if (dt > 0.2) {
        kbps = ((this._prev.bytes - prev.bytes) * 8) / dt / 1000;
        fps = (this._prev.frames - prev.frames) / dt;
      } else {
        this._prev = prev; // too soon to be meaningful; keep the old baseline
      }
    }

    const jbDelay =
      inbound.jitterBufferEmittedCount > 0
        ? (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000
        : null;

    return {
      width: inbound.frameWidth || null,
      height: inbound.frameHeight || null,
      kbps,
      fps,
      jitterBufferMs: jbDelay,
      framesDropped: inbound.framesDropped || 0,
      codec: inbound.codecId || null,
    };
  }

  async close() {
    if (this.resource) {
      // Best effort. MediaMTX also reaps the session when DTLS tears down, so
      // a failure here is not worth surfacing.
      try {
        await fetch(this.resource, { method: 'DELETE' });
      } catch { /* ignore */ }
      this.resource = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this.stream = null;
  }
}
