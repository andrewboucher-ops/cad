/**
 * PBX gateway — telephony bridge for "dial 9" calls out to the phone network,
 * and for inbound DDI calls ringing a radio.
 *
 * Two drivers:
 *   simulated  — default. Full call lifecycle, NO media. Lets the whole flow be
 *                demonstrated and tested without a PBX. This is what the POC uses.
 *   asterisk   — talks to Asterisk/FreePBX over ARI. The code paths are real, but
 *                they have NOT been run against a live PBX from this build
 *                environment. Treat it as a starting point you will need to debug
 *                against your own FreePBX box, not as working software.
 *
 * Design note: radios never speak SIP. Each radio has a PJSIP extension on the
 * PBX; this gateway originates and bridges channels on their behalf, so the
 * dialplan, trunk credentials, CDR and recording all stay on the PBX where they
 * belong. Radio-to-radio and talkgroup traffic never touches the PBX at all.
 */
'use strict';

class PbxGateway {
  constructor(opts = {}) { this.emit = opts.emit || (() => {}); }
  // Resolve to { channelId } once the call is placed; reject to fail the call.
  async dial() { throw new Error('not implemented'); }
  async hangup() {}
  get mediaCapable() { return false; }
}

class SimulatedGateway extends PbxGateway {
  constructor(opts) { super(opts); this.calls = new Map(); }
  get name() { return 'simulated'; }

  async dial({ callId, number, fromLabel }) {
    const channelId = `sim-${callId}`;
    this.calls.set(callId, channelId);
    // Answer after a short ring, then drop after two minutes like a real trunk would.
    const answer = setTimeout(() => {
      if (this.calls.has(callId)) this.emit('answered', { callId, channelId, number, fromLabel });
    }, 1500);
    const expire = setTimeout(() => {
      if (this.calls.has(callId)) { this.calls.delete(callId); this.emit('hangup', { callId, reason: 'REMOTE_CLEARED' }); }
    }, 120000);
    answer.unref?.(); expire.unref?.();
    return { channelId };
  }

  async hangup({ callId }) { this.calls.delete(callId); }
}

class AsteriskAriGateway extends PbxGateway {
  /**
   * UNVERIFIED against a live PBX. Expect to debug this.
   * Needs on FreePBX: ARI user enabled (Settings > Asterisk REST Interface),
   * and a PJSIP extension per radio. See docs/PBX-FREEPBX.md.
   */
  constructor(opts) {
    super(opts);
    this.base = (opts.url || '').replace(/\/$/, '');       // http://pbx.local:8088
    this.user = opts.user;
    this.pass = opts.pass;
    this.app = opts.app || 'cccs';
    this.trunk = opts.trunk || 'from-internal';            // FreePBX outbound context
    this.channels = new Map();
    this.ws = null;
  }
  get name() { return 'asterisk'; }
  get mediaCapable() { return true; }

  auth() { return 'Basic ' + Buffer.from(`${this.user}:${this.pass}`).toString('base64'); }

  async req(method, path, body) {
    const res = await fetch(`${this.base}/ari${path}`, {
      method,
      headers: { authorization: this.auth(), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ARI ${method} ${path} → ${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Subscribe to ARI events so call state on the PBX drives call state here. */
  connect() {
    if (typeof WebSocket === 'undefined') { console.warn('[pbx] no WebSocket global; ARI events disabled'); return; }
    const url = `${this.base.replace(/^http/, 'ws')}/ari/events?api_key=${encodeURIComponent(this.user + ':' + this.pass)}&app=${this.app}&subscribeAll=true`;
    this.ws = new WebSocket(url);
    this.ws.onopen = () => console.log('[pbx] ARI events connected');
    this.ws.onclose = () => { console.warn('[pbx] ARI events closed, retrying in 5s'); setTimeout(() => this.connect(), 5000); };
    this.ws.onerror = (e) => console.warn('[pbx] ARI error', e.message || e);
    this.ws.onmessage = (e) => {
      let ev; try { ev = JSON.parse(e.data); } catch { return; }
      const callId = [...this.channels].find(([, ch]) => ch.legs.includes(ev.channel?.id))?.[0];
      if (!callId) return;
      if (ev.type === 'ChannelStateChange' && ev.channel.state === 'Up') this.emit('answered', { callId });
      if (ev.type === 'StasisEnd' || ev.type === 'ChannelDestroyed') {
        this.channels.delete(callId);
        this.emit('hangup', { callId, reason: ev.cause_txt || 'REMOTE_CLEARED' });
      }
    };
  }

  /**
   * Originate to the radio's own PJSIP extension, then to the dialled number,
   * and put both legs in a mixing bridge. The radio's audio path is its
   * registered WebRTC/WSS endpoint on the PBX.
   */
  async dial({ callId, number, extension }) {
    if (!extension) throw new Error('radio has no PBX extension configured');
    const bridge = await this.req('POST', '/bridges', { type: 'mixing' });
    const radioLeg = await this.req('POST', `/channels?endpoint=${encodeURIComponent('PJSIP/' + extension)}&app=${this.app}&callerId=${encodeURIComponent('CCCS')}`);
    const outLeg = await this.req('POST', `/channels?endpoint=${encodeURIComponent('PJSIP/' + number + '@' + this.trunk)}&app=${this.app}&callerId=${encodeURIComponent(extension)}`);
    await this.req('POST', `/bridges/${bridge.id}/addChannel?channel=${radioLeg.id},${outLeg.id}`);
    this.channels.set(callId, { bridge: bridge.id, legs: [radioLeg.id, outLeg.id] });
    return { channelId: outLeg.id, bridgeId: bridge.id };
  }

  async hangup({ callId }) {
    const ch = this.channels.get(callId);
    if (!ch) return;
    this.channels.delete(callId);
    for (const leg of ch.legs) await this.req('DELETE', `/channels/${leg}`).catch(() => {});
    await this.req('DELETE', `/bridges/${ch.bridge}`).catch(() => {});
  }
}

function createGateway(emit) {
  const mode = (process.env.PBX_MODE || 'simulated').toLowerCase();
  if (mode === 'asterisk') {
    const gw = new AsteriskAriGateway({
      emit,
      url: process.env.ARI_URL,
      user: process.env.ARI_USER,
      pass: process.env.ARI_PASSWORD,
      app: process.env.ARI_APP,
      trunk: process.env.PBX_OUTBOUND_CONTEXT,
    });
    if (!gw.base || !gw.user || !gw.pass) {
      console.warn('[pbx] PBX_MODE=asterisk but ARI_URL/ARI_USER/ARI_PASSWORD are incomplete — falling back to simulated');
      return new SimulatedGateway({ emit });
    }
    gw.connect();
    return gw;
  }
  return new SimulatedGateway({ emit });
}

module.exports = { PbxGateway, SimulatedGateway, AsteriskAriGateway, createGateway };
