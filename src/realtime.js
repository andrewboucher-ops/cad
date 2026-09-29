
/* ------------------------------------------------------------------ *
 * WebSocket server (RFC 6455, hand-rolled — no dependencies)
 * ------------------------------------------------------------------ */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sockets = new Set();

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}
function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

class Conn {
  constructor(socket, user) {
    this.socket = socket; this.user = user;
    this.id = crypto.randomUUID();
    this.mdtId = null;
    this.buf = Buffer.alloc(0); this.alive = true;
    this.awaitingPong = false;
    sockets.add(this);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }
  send(type, payload) {
    if (!this.alive) return;
    try { this.socket.write(encodeFrame(JSON.stringify({ type, payload, ts: Date.now() }))); }
    catch { this.close(); }
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) === 0x80;
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); offset = 10; }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) return;
      const mask = masked ? this.buf.subarray(offset, offset + 4) : null;
      const data = Buffer.from(this.buf.subarray(offset + maskLen, offset + maskLen + len));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      this.buf = this.buf.subarray(offset + maskLen + len);
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.socket.write(encodeFrame(data.toString(), 0xa)); continue; }
      if (opcode === 0xa) { this.awaitingPong = false; continue; }
      if (opcode === 0x1) {
        try { handleWsMessage(this, JSON.parse(data.toString())); }
        catch (e) { this.send('error', { message: String(e.message || e) }); }
      }
    }
  }
  close() {
    if (!this.alive) return;
    this.alive = false; sockets.delete(this);
    try { this.socket.destroy(); } catch {}
    if (this.mdtId && !Array.from(sockets).some((c) => c.mdtId === this.mdtId)) {
      const m = db.mdts.find((x) => x.id === this.mdtId);
      if (m) { m.connected = false; m.status = 'OFFLINE'; broadcast('mdt.status_changed', publicMdt(m)); }
    }
  }
}

/* A dead TCP peer (laptop slept, network changed, cable pulled) often gives
 * neither a close nor an error event — the OS just goes quiet. Left alone,
 * that connection lingers in `sockets` forever: still "connected" for
 * presence, still counted as a PTT listener, so a control operator can hear
 * their own voice come back from a ghost session that's actually gone.
 * A plain WS ping/pong (opcode 0x9/0xa) catches this in one round trip —
 * browsers answer server-sent pings at the protocol level with no JS needed
 * on the client, so this is purely a server-side addition. */
const HEARTBEAT_MS = 30000;
setInterval(() => {
  for (const c of sockets) {
    if (!c.alive) continue;
    if (c.awaitingPong) { c.close(); continue; }
    c.awaitingPong = true;
    try { c.socket.write(encodeFrame('', 0x9)); } catch { c.close(); }
  }
}, HEARTBEAT_MS).unref?.();

function broadcast(type, payload, opts = {}) {
  const targeted = Boolean(opts.mdtIds || opts.personnelIds);
  for (const c of sockets) {
    let deliver = !targeted;
    if (targeted) {
      if (opts.mdtIds && c.mdtId && opts.mdtIds.includes(c.mdtId)) deliver = true;
      if (opts.personnelIds && c.user.personnel_id && opts.personnelIds.includes(c.user.personnel_id)) deliver = true;
      if (opts.includeControl !== false && isControlRole(c.user.role)) deliver = true;
    }
    if (deliver) c.send(type, payload);
  }
}
const isControlRole = (role) => ['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'].includes(role);
